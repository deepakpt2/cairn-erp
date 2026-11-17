/** Factory calendar rules (FOUND-01): counting, the refusal when there are no rules, and the master-data guards. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  addHolidayDay, deleteCalendarPeriod, deleteHolidayCalendar, FACTORY_CALENDAR_CAPABILITY, FactoryCalendarError,
  isWorkingDay, loadFactoryCalendars, removeHolidayDay, saveCalendarPeriod, saveHolidayCalendar, workingDaysBetween,
  type SavePeriodInput,
} from '../src/modules/foundation/factory-calendar';
import { withTenant } from '../src/platform/db/client';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const CAPS = [FACTORY_CALENDAR_CAPABILITY];
let a: TestTenant;
let b: TestTenant;
let client = '';

const MF = { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false };
const base = (over: Partial<SavePeriodInput> = {}): SavePeriodInput => ({
  client, changedBy: 'T', capabilities: CAPS, calendarId: '01', validFrom: '2026-01-01', validTo: '2026-12-31', holidayCalendarId: null, ...MF, ...over,
});
const count = (calendarId: string, from: string, to: string, c = client) =>
  withTenant(c, (tx) => workingDaysBetween(tx, c, { calendarId, from, to }));
const refusal = async (p: Promise<unknown>): Promise<FactoryCalendarError> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(FactoryCalendarError); return e as FactoryCalendarError; }
  throw new Error('expected a refusal');
};
const clear = (c: string) => withTenant(c, async (tx) => {
  await tx.execute(sql`delete from factory_calendar_period where client = ${c}`);
  await tx.execute(sql`delete from holiday_calendar where client = ${c}`);
});

beforeAll(async () => {
  a = await createTenant('FC-A');
  b = await createTenant('FC-B');
  client = a.client;
  for (const t of [a, b]) {
    await withTenant(t.client, (tx) => tx.execute(sql`
      insert into factory_calendar (client, calendar_id, name) values (${t.client}, '01', 'Main'), (${t.client}, '02', 'Second')`));
  }
});
afterAll(async () => {
  await destroyTenant(a.client);
  await destroyTenant(b.client);
  await closeDb();
});

describe('counting', () => {
  it('Mon–Fri over a full week is 5; with Saturday it is 6', async () => {
    await clear(client);
    await saveCalendarPeriod(base());
    expect(await count('01', '2026-06-01', '2026-06-07')).toBe(5);
    await saveCalendarPeriod(base({ saturday: true, originalValidFrom: '2026-01-01' }));
    expect(await count('01', '2026-06-01', '2026-06-07')).toBe(6);
  });

  it('a holiday on a working day removes exactly that day; one on a Saturday removes nothing', async () => {
    await clear(client);
    await saveHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', name: 'Holidays', validFromYear: 2026, validToYear: 2026 });
    await addHolidayDay({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', date: '2026-06-03', description: 'Midweek' });
    await addHolidayDay({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', date: '2026-06-06', description: 'Saturday' });
    await saveCalendarPeriod(base({ holidayCalendarId: 'H1' }));
    expect(await count('01', '2026-06-01', '2026-06-07')).toBe(4);
  });

  it('a range over two periods counts each part by its own pattern', async () => {
    await clear(client);
    await saveCalendarPeriod(base({ validFrom: '2026-06-01', validTo: '2026-06-03' })); // Mon–Wed, Mon–Fri
    await saveCalendarPeriod(base({ validFrom: '2026-06-04', validTo: '2026-06-30', monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: true }));
    // Mon, Tue, Wed work (3); Thu, Fri do not; Sat 6th and Sun 7th work (2)
    expect(await count('01', '2026-06-01', '2026-06-07')).toBe(5);
  });

  it('isWorkingDay: false on a holiday, true on a working weekday', async () => {
    await clear(client);
    await saveHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', name: 'Holidays', validFromYear: 2026, validToYear: 2026 });
    await addHolidayDay({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', date: '2026-06-03', description: 'Midweek' });
    await saveCalendarPeriod(base({ holidayCalendarId: 'H1' }));
    expect(await withTenant(client, (tx) => isWorkingDay(tx, client, { calendarId: '01', date: '2026-06-03' }))).toBe(false);
    expect(await withTenant(client, (tx) => isWorkingDay(tx, client, { calendarId: '01', date: '2026-06-02' }))).toBe(true);
  });

  it('no covering period refuses CALENDAR_NO_PERIOD, naming calendar and date', async () => {
    await clear(client);
    await saveCalendarPeriod(base());
    const e = await refusal(withTenant(client, (tx) => isWorkingDay(tx, client, { calendarId: '01', date: '2027-03-15' })));
    expect(e.code).toBe('CALENDAR_NO_PERIOD');
    expect(e.message).toContain('`01`');
    expect(e.message).toContain('2027-03-15');
    expect(e.remedy).toContain('/config/factory-calendars');
    expect((await refusal(count('02', '2026-06-01', '2026-06-07'))).code).toBe('CALENDAR_NO_PERIOD');
  });

  it('a range partly uncovered refuses rather than counting the covered part', async () => {
    const e = await refusal(count('01', '2026-12-28', '2027-01-04'));
    expect(e.code).toBe('CALENDAR_NO_PERIOD');
    expect(e.message).toContain('2027-01-01');
  });

  it('a year-long range issues one query for periods and one for holidays', async () => {
    await clear(client);
    await saveHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', name: 'Holidays', validFromYear: 2026, validToYear: 2026 });
    await saveCalendarPeriod(base({ holidayCalendarId: 'H1' }));
    const queries = await withTenant(client, async (tx) => {
      const spy = vi.spyOn(tx, 'select');
      const days = await workingDaysBetween(tx, client, { calendarId: '01', from: '2026-01-01', to: '2026-12-31' });
      expect(days).toBe(261);
      return spy.mock.calls.length;
    });
    expect(queries).toBe(2);
  });
});

describe('master data', () => {
  it('refuses overlapping periods, naming the existing one', async () => {
    await clear(client);
    await saveCalendarPeriod(base({ validFrom: '2026-01-01', validTo: '2026-06-30' }));
    const e = await refusal(saveCalendarPeriod(base({ validFrom: '2026-06-30', validTo: '2026-12-31' })));
    expect(e.code).toBe('PERIOD_OVERLAP');
    expect(e.message).toContain('2026-01-01 to 2026-06-30');
    await saveCalendarPeriod(base({ validFrom: '2026-07-01', validTo: '2026-12-31' }));
  });

  it('refuses validTo before validFrom', async () => {
    expect((await refusal(saveCalendarPeriod(base({ validFrom: '2026-05-02', validTo: '2026-05-01' })))).code).toBe('PERIOD_RANGE');
  });

  it('accepts a period with no working day and warns', async () => {
    await clear(client);
    const none = { monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: false };
    const { warnings } = await saveCalendarPeriod(base({ ...none }));
    expect(warnings).toHaveLength(1);
    expect(await count('01', '2026-06-01', '2026-06-07')).toBe(0);
  });

  it('refuses a holiday outside its calendar’s years, and shrinking years over an existing holiday', async () => {
    await clear(client);
    await saveHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', name: 'Holidays', validFromYear: 2026, validToYear: 2026 });
    const e = await refusal(addHolidayDay({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', date: '2027-01-01', description: 'New year' }));
    expect(e.code).toBe('HOLIDAY_OUT_OF_RANGE');
    await addHolidayDay({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', date: '2026-12-25', description: 'Christmas' });
    await saveHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', name: 'Holidays', validFromYear: 2025, validToYear: 2026 });
    expect((await refusal(saveHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', name: 'Holidays', validFromYear: 2027, validToYear: 2027 }))).code).toBe('HOLIDAY_OUT_OF_RANGE');
    expect((await refusal(addHolidayDay({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', date: '2026-01-01', description: '  ' }))).code).toBe('HOLIDAY_DESCRIPTION');
  });

  it('cascades: deleting a calendar removes its periods, deleting a holiday calendar removes its days', async () => {
    await clear(client);
    await saveCalendarPeriod(base());
    await saveHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H2', name: 'Other', validFromYear: 2026, validToYear: 2026 });
    await addHolidayDay({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H2', date: '2026-05-01', description: 'Labour' });
    await deleteHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H2' });
    const days = await withTenant(client, (tx) => tx.execute(sql`select 1 from holiday_calendar_day where client = ${client}`));
    expect(days.length).toBe(0);
    await withTenant(client, (tx) => tx.execute(sql`delete from factory_calendar where client = ${client} and calendar_id = '01'`));
    const periods = await withTenant(client, (tx) => tx.execute(sql`select 1 from factory_calendar_period where client = ${client}`));
    expect(periods.length).toBe(0);
    await withTenant(client, (tx) => tx.execute(sql`insert into factory_calendar (client, calendar_id, name) values (${client}, '01', 'Main')`));
  });

  it('refuses to delete a holiday calendar a period names', async () => {
    await clear(client);
    await saveHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', name: 'Holidays', validFromYear: 2026, validToYear: 2026 });
    await saveCalendarPeriod(base({ holidayCalendarId: 'H1' }));
    const e = await refusal(deleteHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1' }));
    expect(e.code).toBe('HOLIDAY_CALENDAR_IN_USE');
    await deleteCalendarPeriod({ client, changedBy: 'T', capabilities: CAPS, calendarId: '01', validFrom: '2026-01-01' });
    await deleteHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1' });
  });

  it('records a change document for each write', async () => {
    await clear(client);
    await saveCalendarPeriod(base());
    await saveHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', name: 'Holidays', validFromYear: 2026, validToYear: 2026 });
    await addHolidayDay({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', date: '2026-05-01', description: 'Labour' });
    await removeHolidayDay({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', date: '2026-05-01' });
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select distinct object_class from change_document where client = ${client}
       and object_class in ('factory_calendar_period','holiday_calendar','holiday_calendar_day')`));
    expect(rows.length).toBe(3);
  });

  it('isolates tenants', async () => {
    await clear(client);
    await saveCalendarPeriod(base());
    await saveHolidayCalendar({ client, changedBy: 'T', capabilities: CAPS, holidayCalendarId: 'H1', name: 'Holidays', validFromYear: 2026, validToYear: 2026 });
    const other = await loadFactoryCalendars(b.client, CAPS);
    expect(other.holidayCalendars).toHaveLength(0);
    expect(other.calendars.flatMap((c) => c.periods)).toHaveLength(0);
    expect((await refusal(count('01', '2026-06-01', '2026-06-07', b.client))).code).toBe('CALENDAR_NO_PERIOD');
  });

  it('refuses before any read without the capability', async () => {
    const e = await refusal(loadFactoryCalendars(client, []));
    expect(e.code).toBe('CAPABILITY_MISSING');
    expect((await refusal(saveCalendarPeriod(base({ capabilities: ['PROD.MRP.EXCEPTION'] })))).code).toBe('CAPABILITY_MISSING');
    expect((await refusal(deleteHolidayCalendar({ client, changedBy: 'T', capabilities: [], holidayCalendarId: 'H1' }))).code).toBe('CAPABILITY_MISSING');
  });
});
