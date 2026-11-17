/**
 * Factory calendar rules (FOUND-01) — which weekdays work, over dated periods, minus holidays.
 *
 * Reference mapping, for the next reader: period = TFACD, holiday calendar = THOCI, holiday day = THOC
 * (THOCD and THOL are folded in: a holiday here is a dated row). Movable holidays (THOLU) are not
 * modelled; a tenant enters explicit dates for the years it needs, inside the calendar's year range.
 *
 * The one rule this file exists to keep: **a calendar with no rules refuses, it never assumes a
 * five-day week.** `CALENDAR_NO_PERIOD` is thrown for any date no period covers, and every caller
 * decides its own visible fallback. Nothing in MRP or CM01 calls this yet.
 */
import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/pattern';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { factoryCalendar, factoryCalendarPeriod, holidayCalendar, holidayCalendarDay } from './schema';

export const FACTORY_CALENDAR_ROUTE = '/config/factory-calendars';
export const FACTORY_CALENDAR_CAPABILITY = 'CFG.FND.CALENDAR.DEFINE';

export type FactoryCalendarErrorCode =
  | 'CAPABILITY_MISSING' | 'CALENDAR_NO_PERIOD' | 'CALENDAR_NOT_FOUND' | 'HOLIDAY_CALENDAR_NOT_FOUND'
  | 'PERIOD_NOT_FOUND' | 'PERIOD_RANGE' | 'PERIOD_OVERLAP' | 'DATE_INVALID' | 'KEY_INVALID'
  | 'YEAR_RANGE' | 'HOLIDAY_OUT_OF_RANGE' | 'HOLIDAY_DESCRIPTION' | 'HOLIDAY_NOT_FOUND'
  | 'HOLIDAY_CALENDAR_IN_USE' | 'NAME_REQUIRED';

export class FactoryCalendarError extends Error {
  constructor(readonly code: FactoryCalendarErrorCode, message: string, readonly remedy: string) {
    super(message);
    this.name = 'FactoryCalendarError';
  }
}

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type WeekdayFlags = Record<Weekday, boolean>;

// ─────────────────────────────────────────────────────────────────────────────
// Dates — plain calendar arithmetic on YYYY-MM-DD, never through a timezone
// ─────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string): Date | null {
  if (!DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

function requireDate(value: string, label: string): string {
  const v = (value ?? '').trim();
  if (!parseDate(v)) throw new FactoryCalendarError('DATE_INVALID', `${label} “${value}” is not a date.`, 'Enter a date as YYYY-MM-DD.');
  return v;
}

export function addDaysIso(value: string, days: number): string {
  const d = parseDate(value)!;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(value: string): number {
  return (parseDate(value)!.getUTCDay() + 6) % 7;
}

interface PeriodRow extends WeekdayFlags { validFrom: string; validTo: string; holidayCalendarId: string | null }

function noPeriod(calendarId: string, date: string): FactoryCalendarError {
  return new FactoryCalendarError(
    'CALENDAR_NO_PERIOD',
    `Factory calendar \`${calendarId}\` has no rules covering ${date}.`,
    `Maintain a period covering that date at ${FACTORY_CALENDAR_ROUTE}, or use a report that does not need one.`,
  );
}

/**
 * Pure counting over periods already read. Every date in [from, to] must be covered; the first
 * uncovered date refuses. Holidays are keyed `holidayCalendarId|date`.
 */
export function countWorkingDays(
  calendarId: string, periods: PeriodRow[], holidays: ReadonlySet<string>, from: string, to: string,
): number {
  const sorted = [...periods].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  let count = 0;
  let index = 0;
  for (let day = from; day <= to; day = addDaysIso(day, 1)) {
    while (index < sorted.length && sorted[index]!.validTo < day) index += 1;
    const period = sorted[index];
    if (!period || period.validFrom > day) throw noPeriod(calendarId, day);
    const working = period[WEEKDAYS[weekdayIndex(day)]!]
      && !(period.holidayCalendarId && holidays.has(`${period.holidayCalendarId}|${day}`));
    if (working) count += 1;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// The two read functions — and only two
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Working days from `from` to `to`, both inclusive, counted in memory after exactly one query for the
 * periods and (when a period names a holiday calendar) one for the holidays. Never one query per day.
 */
export async function workingDaysBetween(
  tx: Tx, client: string, input: { calendarId: string; from: string; to: string },
): Promise<number> {
  const from = requireDate(input.from, 'From date');
  const to = requireDate(input.to, 'To date');
  if (to < from) throw new FactoryCalendarError('PERIOD_RANGE', `The range ${from} to ${to} ends before it starts.`, 'Put the earlier date first.');
  const periods = await tx.select().from(factoryCalendarPeriod).where(and(
    eq(factoryCalendarPeriod.client, client), eq(factoryCalendarPeriod.calendarId, input.calendarId),
    lte(factoryCalendarPeriod.validFrom, to), gte(factoryCalendarPeriod.validTo, from),
  )).orderBy(asc(factoryCalendarPeriod.validFrom));

  const holidayIds = [...new Set(periods.map((p) => p.holidayCalendarId).filter((v): v is string => !!v))];
  const holidays = new Set<string>();
  if (holidayIds.length > 0) {
    const rows = await tx.select({ id: holidayCalendarDay.holidayCalendarId, date: holidayCalendarDay.date })
      .from(holidayCalendarDay).where(and(
        eq(holidayCalendarDay.client, client), inArray(holidayCalendarDay.holidayCalendarId, holidayIds),
        gte(holidayCalendarDay.date, from), lte(holidayCalendarDay.date, to),
      ));
    for (const r of rows) holidays.add(`${r.id}|${r.date}`);
  }
  return countWorkingDays(input.calendarId, periods, holidays, from, to);
}

export async function isWorkingDay(
  tx: Tx, client: string, input: { calendarId: string; date: string },
): Promise<boolean> {
  return (await workingDaysBetween(tx, client, { calendarId: input.calendarId, from: input.date, to: input.date })) === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// The screen: reading
// ─────────────────────────────────────────────────────────────────────────────

function authorise(capabilities: readonly string[]): void {
  if (!hasCapability(capabilities as string[], FACTORY_CALENDAR_CAPABILITY)) {
    throw new FactoryCalendarError(
      'CAPABILITY_MISSING', `Factory calendars need ${FACTORY_CALENDAR_CAPABILITY}, which this session does not hold.`,
      `Ask an administrator to grant ${FACTORY_CALENDAR_CAPABILITY} to one of your roles.`,
    );
  }
}

export interface PeriodView extends WeekdayFlags {
  calendarId: string; validFrom: string; validTo: string; holidayCalendarId: string | null;
  /** Holiday dates of the period's holiday calendar that fall inside the period. */
  holidayDates: string[];
}
export interface HolidayCalendarView {
  holidayCalendarId: string; name: string; validFromYear: number; validToYear: number;
  days: Array<{ date: string; description: string }>;
}
export interface FactoryCalendarWorkbench {
  calendars: Array<{ calendarId: string; name: string; isActive: boolean; periods: PeriodView[] }>;
  holidayCalendars: HolidayCalendarView[];
}

export async function loadFactoryCalendars(client: string, capabilities: readonly string[]): Promise<FactoryCalendarWorkbench> {
  authorise(capabilities);
  return withTenant(client, async (tx) => {
    const cals = await tx.select().from(factoryCalendar).where(eq(factoryCalendar.client, client)).orderBy(asc(factoryCalendar.calendarId));
    const periods = await tx.select().from(factoryCalendarPeriod).where(eq(factoryCalendarPeriod.client, client))
      .orderBy(asc(factoryCalendarPeriod.calendarId), asc(factoryCalendarPeriod.validFrom));
    const holidayCals = await tx.select().from(holidayCalendar).where(eq(holidayCalendar.client, client)).orderBy(asc(holidayCalendar.holidayCalendarId));
    const days = await tx.select().from(holidayCalendarDay).where(eq(holidayCalendarDay.client, client)).orderBy(asc(holidayCalendarDay.date));
    return {
      calendars: cals.map((c) => ({
        calendarId: c.calendarId, name: c.name, isActive: c.isActive,
        periods: periods.filter((p) => p.calendarId === c.calendarId).map((p) => ({
          calendarId: p.calendarId, validFrom: p.validFrom, validTo: p.validTo, holidayCalendarId: p.holidayCalendarId,
          monday: p.monday, tuesday: p.tuesday, wednesday: p.wednesday, thursday: p.thursday,
          friday: p.friday, saturday: p.saturday, sunday: p.sunday,
          holidayDates: p.holidayCalendarId
            ? days.filter((d) => d.holidayCalendarId === p.holidayCalendarId && d.date >= p.validFrom && d.date <= p.validTo).map((d) => d.date)
            : [],
        })),
      })),
      holidayCalendars: holidayCals.map((h) => ({
        holidayCalendarId: h.holidayCalendarId, name: h.name, validFromYear: h.validFromYear, validToYear: h.validToYear,
        days: days.filter((d) => d.holidayCalendarId === h.holidayCalendarId).map((d) => ({ date: d.date, description: d.description })),
      })),
    };
  });
}

/** The sample month for a period: its first month, each day marked working or not, so a wrong flag shows at once. */
export function sampleMonth(period: PeriodView): { label: string; days: Array<{ date: string; working: boolean; holiday: boolean }>; working: number } {
  const first = period.validFrom;
  const monthStart = `${first.slice(0, 7)}-01`;
  const holidays = new Set(period.holidayDates);
  const days: Array<{ date: string; working: boolean; holiday: boolean }> = [];
  for (let d = monthStart; d.slice(0, 7) === first.slice(0, 7); d = addDaysIso(d, 1)) {
    const inside = d >= period.validFrom && d <= period.validTo;
    const holiday = inside && holidays.has(d);
    days.push({ date: d, holiday, working: inside && period[WEEKDAYS[weekdayIndex(d)]!] && !holiday });
  }
  return { label: first.slice(0, 7), days, working: days.filter((d) => d.working).length };
}

// ─────────────────────────────────────────────────────────────────────────────
// The screen: writing
// ─────────────────────────────────────────────────────────────────────────────

function requireKey(value: string, label: string): string {
  const v = (value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(v)) {
    throw new FactoryCalendarError('KEY_INVALID', `${label} “${value}” must be two letters or digits.`, 'Use exactly two characters, A–Z or 0–9.');
  }
  return v;
}

export interface SavePeriodInput extends WeekdayFlags {
  client: string; changedBy: string; capabilities: readonly string[];
  calendarId: string; validFrom: string; validTo: string; holidayCalendarId?: string | null;
  /** Set when editing an existing period: its current valid-from. */
  originalValidFrom?: string | null;
}

export async function saveCalendarPeriod(input: SavePeriodInput): Promise<{ warnings: string[] }> {
  authorise(input.capabilities);
  const calendarId = requireKey(input.calendarId, 'Calendar');
  const validFrom = requireDate(input.validFrom, 'Valid from');
  const validTo = requireDate(input.validTo, 'Valid to');
  if (validTo < validFrom) {
    throw new FactoryCalendarError('PERIOD_RANGE', `The period ends (${validTo}) before it starts (${validFrom}).`, 'Put the end date on or after the start date.');
  }
  const holidayId = input.holidayCalendarId?.trim() ? requireKey(input.holidayCalendarId, 'Holiday calendar') : null;
  const flags = Object.fromEntries(WEEKDAYS.map((d) => [d, !!input[d]])) as WeekdayFlags;
  const warnings: string[] = [];
  if (!WEEKDAYS.some((d) => flags[d])) {
    warnings.push(`No weekday is working in ${validFrom} to ${validTo}: every day in it will count as non-working.`);
  }

  await withTenant(input.client, async (tx) => {
    const [cal] = await tx.select({ id: factoryCalendar.calendarId }).from(factoryCalendar)
      .where(and(eq(factoryCalendar.client, input.client), eq(factoryCalendar.calendarId, calendarId)));
    if (!cal) throw new FactoryCalendarError('CALENDAR_NOT_FOUND', `Factory calendar \`${calendarId}\` does not exist.`, 'Choose an existing factory calendar.');
    if (holidayId) {
      const [h] = await tx.select({ id: holidayCalendar.holidayCalendarId }).from(holidayCalendar)
        .where(and(eq(holidayCalendar.client, input.client), eq(holidayCalendar.holidayCalendarId, holidayId)));
      if (!h) throw new FactoryCalendarError('HOLIDAY_CALENDAR_NOT_FOUND', `Holiday calendar \`${holidayId}\` does not exist.`, 'Create the holiday calendar first, or leave it empty.');
    }
    const original = input.originalValidFrom?.trim() || null;
    const [before] = original
      ? await tx.select().from(factoryCalendarPeriod).where(and(
        eq(factoryCalendarPeriod.client, input.client), eq(factoryCalendarPeriod.calendarId, calendarId), eq(factoryCalendarPeriod.validFrom, original)))
      : [];
    if (original && !before) throw new FactoryCalendarError('PERIOD_NOT_FOUND', `No period of \`${calendarId}\` starts on ${original}.`, 'Reload the screen and try again.');

    const others = await tx.select().from(factoryCalendarPeriod).where(and(
      eq(factoryCalendarPeriod.client, input.client), eq(factoryCalendarPeriod.calendarId, calendarId),
      lte(factoryCalendarPeriod.validFrom, validTo), gte(factoryCalendarPeriod.validTo, validFrom),
      original ? ne(factoryCalendarPeriod.validFrom, original) : undefined,
    ));
    if (others[0]) {
      throw new FactoryCalendarError(
        'PERIOD_OVERLAP',
        `The period ${validFrom} to ${validTo} overlaps the existing period ${others[0].validFrom} to ${others[0].validTo} of calendar \`${calendarId}\`.`,
        'Shorten one of the two so no date is covered twice.',
      );
    }

    const values = { validFrom, validTo, ...flags, holidayCalendarId: holidayId };
    if (before) {
      await tx.update(factoryCalendarPeriod).set({ ...values, changedBy: input.changedBy, changedAt: sql`now()` as unknown as Date })
        .where(and(eq(factoryCalendarPeriod.client, input.client), eq(factoryCalendarPeriod.calendarId, calendarId), eq(factoryCalendarPeriod.validFrom, original!)));
    } else {
      await tx.insert(factoryCalendarPeriod).values({ client: input.client, calendarId, ...values, createdBy: input.changedBy });
    }
    await recordChange(tx, {
      client: input.client, objectClass: 'factory_calendar_period', objectKey: `${calendarId}/${original ?? validFrom}`,
      changeType: before ? 'CHANGE' : 'CREATE', changedBy: input.changedBy, transactionCode: FACTORY_CALENDAR_CAPABILITY,
      before: before ? periodSnapshot(before) : undefined, after: periodSnapshot({ ...values }),
    });
  });
  return { warnings };
}

function periodSnapshot(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['validFrom', 'validTo', ...WEEKDAYS, 'holidayCalendarId']) out[k] = p[k] ?? null;
  return out;
}

export async function deleteCalendarPeriod(input: {
  client: string; changedBy: string; capabilities: readonly string[]; calendarId: string; validFrom: string;
}): Promise<void> {
  authorise(input.capabilities);
  await withTenant(input.client, async (tx) => {
    const where = and(eq(factoryCalendarPeriod.client, input.client), eq(factoryCalendarPeriod.calendarId, input.calendarId),
      eq(factoryCalendarPeriod.validFrom, input.validFrom));
    const [before] = await tx.select().from(factoryCalendarPeriod).where(where);
    if (!before) throw new FactoryCalendarError('PERIOD_NOT_FOUND', `No period of \`${input.calendarId}\` starts on ${input.validFrom}.`, 'Reload the screen.');
    await tx.delete(factoryCalendarPeriod).where(where);
    await recordChange(tx, {
      client: input.client, objectClass: 'factory_calendar_period', objectKey: `${input.calendarId}/${input.validFrom}`,
      changeType: 'DELETE', changedBy: input.changedBy, transactionCode: FACTORY_CALENDAR_CAPABILITY, before: periodSnapshot(before),
    });
  });
}

export async function saveHolidayCalendar(input: {
  client: string; changedBy: string; capabilities: readonly string[];
  holidayCalendarId: string; name: string; validFromYear: number; validToYear: number;
}): Promise<void> {
  authorise(input.capabilities);
  const id = requireKey(input.holidayCalendarId, 'Holiday calendar');
  const name = (input.name ?? '').trim();
  if (!name) throw new FactoryCalendarError('NAME_REQUIRED', 'A holiday calendar needs a name.', 'Enter a name.');
  const { validFromYear: from, validToYear: to } = input;
  const inRange = (y: number) => Number.isInteger(y) && y >= 1900 && y <= 9999;
  if (!inRange(from) || !inRange(to) || to < from) {
    throw new FactoryCalendarError('YEAR_RANGE', `The years ${from} to ${to} are not a valid range.`, 'Use whole years from 1900 to 9999, the last not before the first.');
  }
  await withTenant(input.client, async (tx) => {
    const [before] = await tx.select().from(holidayCalendar).where(and(eq(holidayCalendar.client, input.client), eq(holidayCalendar.holidayCalendarId, id)));
    if (before) {
      const outside = await tx.select({ date: holidayCalendarDay.date }).from(holidayCalendarDay).where(and(
        eq(holidayCalendarDay.client, input.client), eq(holidayCalendarDay.holidayCalendarId, id),
        sql`(extract(year from ${holidayCalendarDay.date}) < ${from} or extract(year from ${holidayCalendarDay.date}) > ${to})`,
      ));
      if (outside[0]) {
        throw new FactoryCalendarError('HOLIDAY_OUT_OF_RANGE', `Holiday ${outside[0].date} would fall outside the years ${from} to ${to}.`, 'Remove that holiday first, or keep the year range wide enough.');
      }
      await tx.update(holidayCalendar).set({ name, validFromYear: from, validToYear: to, changedBy: input.changedBy, changedAt: sql`now()` as unknown as Date })
        .where(and(eq(holidayCalendar.client, input.client), eq(holidayCalendar.holidayCalendarId, id)));
    } else {
      await tx.insert(holidayCalendar).values({ client: input.client, holidayCalendarId: id, name, validFromYear: from, validToYear: to, createdBy: input.changedBy });
    }
    await recordChange(tx, {
      client: input.client, objectClass: 'holiday_calendar', objectKey: id, changeType: before ? 'CHANGE' : 'CREATE',
      changedBy: input.changedBy, transactionCode: FACTORY_CALENDAR_CAPABILITY,
      before: before ? { name: before.name, validFromYear: before.validFromYear, validToYear: before.validToYear } : undefined,
      after: { name, validFromYear: from, validToYear: to },
    });
  });
}

export async function deleteHolidayCalendar(input: {
  client: string; changedBy: string; capabilities: readonly string[]; holidayCalendarId: string;
}): Promise<void> {
  authorise(input.capabilities);
  await withTenant(input.client, async (tx) => {
    const [before] = await tx.select().from(holidayCalendar).where(and(eq(holidayCalendar.client, input.client), eq(holidayCalendar.holidayCalendarId, input.holidayCalendarId)));
    if (!before) throw new FactoryCalendarError('HOLIDAY_CALENDAR_NOT_FOUND', `Holiday calendar \`${input.holidayCalendarId}\` does not exist.`, 'Reload the screen.');
    const [used] = await tx.select({ calendarId: factoryCalendarPeriod.calendarId, validFrom: factoryCalendarPeriod.validFrom })
      .from(factoryCalendarPeriod).where(and(eq(factoryCalendarPeriod.client, input.client), eq(factoryCalendarPeriod.holidayCalendarId, input.holidayCalendarId)));
    if (used) {
      throw new FactoryCalendarError(
        'HOLIDAY_CALENDAR_IN_USE',
        `Holiday calendar \`${input.holidayCalendarId}\` is named by the period of \`${used.calendarId}\` starting ${used.validFrom}.`,
        'Point that period at another holiday calendar, or remove it, then delete this one.',
      );
    }
    await tx.delete(holidayCalendar).where(and(eq(holidayCalendar.client, input.client), eq(holidayCalendar.holidayCalendarId, input.holidayCalendarId)));
    await recordChange(tx, {
      client: input.client, objectClass: 'holiday_calendar', objectKey: input.holidayCalendarId, changeType: 'DELETE',
      changedBy: input.changedBy, transactionCode: FACTORY_CALENDAR_CAPABILITY,
      before: { name: before.name, validFromYear: before.validFromYear, validToYear: before.validToYear },
    });
  });
}

export async function addHolidayDay(input: {
  client: string; changedBy: string; capabilities: readonly string[];
  holidayCalendarId: string; date: string; description: string;
}): Promise<void> {
  authorise(input.capabilities);
  const id = requireKey(input.holidayCalendarId, 'Holiday calendar');
  const date = requireDate(input.date, 'Holiday date');
  const description = (input.description ?? '').trim();
  if (!description) throw new FactoryCalendarError('HOLIDAY_DESCRIPTION', 'A holiday needs a description.', 'Enter what the holiday is called.');
  await withTenant(input.client, async (tx) => {
    const [cal] = await tx.select().from(holidayCalendar).where(and(eq(holidayCalendar.client, input.client), eq(holidayCalendar.holidayCalendarId, id)));
    if (!cal) throw new FactoryCalendarError('HOLIDAY_CALENDAR_NOT_FOUND', `Holiday calendar \`${id}\` does not exist.`, 'Create the holiday calendar first.');
    const year = Number(date.slice(0, 4));
    if (year < cal.validFromYear || year > cal.validToYear) {
      throw new FactoryCalendarError(
        'HOLIDAY_OUT_OF_RANGE',
        `${date} is outside the years ${cal.validFromYear} to ${cal.validToYear} of holiday calendar \`${id}\`.`,
        'Widen the calendar’s year range first if it should cover that year.',
      );
    }
    await tx.insert(holidayCalendarDay).values({ client: input.client, holidayCalendarId: id, date, description, createdBy: input.changedBy })
      .onConflictDoUpdate({
        target: [holidayCalendarDay.client, holidayCalendarDay.holidayCalendarId, holidayCalendarDay.date],
        set: { description, changedBy: input.changedBy, changedAt: sql`now()` as unknown as Date },
      });
    await recordChange(tx, {
      client: input.client, objectClass: 'holiday_calendar_day', objectKey: `${id}/${date}`, changeType: 'CREATE',
      changedBy: input.changedBy, transactionCode: FACTORY_CALENDAR_CAPABILITY, after: { description },
    });
  });
}

export async function removeHolidayDay(input: {
  client: string; changedBy: string; capabilities: readonly string[]; holidayCalendarId: string; date: string;
}): Promise<void> {
  authorise(input.capabilities);
  await withTenant(input.client, async (tx) => {
    const where = and(eq(holidayCalendarDay.client, input.client), eq(holidayCalendarDay.holidayCalendarId, input.holidayCalendarId), eq(holidayCalendarDay.date, input.date));
    const [before] = await tx.select().from(holidayCalendarDay).where(where);
    if (!before) throw new FactoryCalendarError('HOLIDAY_NOT_FOUND', `Holiday calendar \`${input.holidayCalendarId}\` has no holiday on ${input.date}.`, 'Reload the screen.');
    await tx.delete(holidayCalendarDay).where(where);
    await recordChange(tx, {
      client: input.client, objectClass: 'holiday_calendar_day', objectKey: `${input.holidayCalendarId}/${input.date}`, changeType: 'DELETE',
      changedBy: input.changedBy, transactionCode: FACTORY_CALENDAR_CAPABILITY, before: { description: before.description },
    });
  });
}
