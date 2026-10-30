/**
 * Time and leave — CAIRN.md §8.10 (time_recording, absence, attendance, leave_quota),
 * §10.8 (PEOPLE.TIME.ENTER, PEOPLE.LEAVE.VIEW), §15.1 (Time).
 *
 * This is the first time/leave slice: what a tenant can actually do without
 * touching statutory or jurisdiction-specific rules (DV-001, §15.3 — country
 * leave law is out, and nothing here invents one).
 *
 * **A time type is configured data.** `time_type` names what the tenant counts
 * — annual leave, sick leave, attendance, overtime — each with a kind that
 * decides what it means downstream: ABSENCE reduces a quota, ATTENDANCE and
 * OVERTIME do not. A type is retired by validity, never deleted.
 *
 * **An absence is a dated request with a status.** One employee, one type, an
 * inclusive span (valid_from … valid_to), and a status that moves
 * REQUESTED → APPROVED / REJECTED / CANCELLED. No two absences for one
 * employee may cover the same day — the overlap test is inside the transaction,
 * under an advisory lock on the employee, the same discipline `position_assignment`
 * and `employee_record` use. A change is a new request; nothing is deleted.
 *
 * **A leave quota is a balance per employee, per type, per year.** Entitlement
 * is what the tenant configures; taken is the sum of approved absence days that
 * fall in that year; remaining is entitlement minus taken. The service
 * maintains taken and remaining on every approval, rejection and cancellation,
 * so the balance never drifts from the rows that produced it.
 *
 * **A time recording is hours on a day.** One row per employee per day per
 * type; a change overwrites the day's entry — a time record is a measurement,
 * not history.
 *
 * What waits on an owner decision and is absent: statutory entitlement rules,
 * waiting periods, carry-over, working-day calendars, half-day absences,
 * retro-active corrections of approved absences, and any posting to payroll.
 * Payroll reads absence and time rows later; nothing here posts.
 */

import { and, asc, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AuthzError } from '../../platform/auth/current';
import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  absence,
  leaveQuota,
  timeRecording,
  timeType,
  TIME_ENTER_CAPABILITY,
  TIME_TYPE_KINDS,
  type TimeTypeKind,
} from './schema';

export { TIME_TYPE_KINDS } from './schema';
export type { TimeTypeKind } from './schema';

export const TIME_LEAVE_ROUTE = '/people/time-leave';
export const TIME_ENTER_CAPABILITY = 'PEOPLE.TIME.ENTER';
export const LEAVE_VIEW_CAPABILITY = 'PEOPLE.LEAVE.VIEW';
export const TIME_TYPE_OBJECT_CLASS = 'time_type';
export const ABSENCE_OBJECT_CLASS = 'absence';
export const LEAVE_QUOTA_OBJECT_CLASS = 'leave_quota';
export const TIME_RECORDING_OBJECT_CLASS = 'time_recording';

/** The absence status lifecycle. REQUESTED is the only status a write can set; APPROVED/REJECTED/CANCELLED follow. */
export const ABSENCE_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type AbsenceStatus = (typeof ABSENCE_STATUSES)[number];

/** Refuse a write when the caller holds none of the required authority. */
function assertCapability(
  capabilities: readonly string[] | undefined,
  required: string,
  actor: string,
): void {
  if (!capabilities || !hasCapability([...capabilities], required)) {
    throw new AuthzError(required, actor);
  }
}

const upper = z.string().transform((s) => s.trim().toUpperCase());
const clientField = upper.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' }));
const personnelNumber = upper.pipe(z.string().regex(/^[A-Z0-9]{2,20}$/, { message: 'PERSONNEL_FORMAT' }));
const orgCode = upper.pipe(z.string().regex(/^([A-Z][A-Z0-9]{1,9})$/, { message: 'ORG_CODE_FORMAT' }));
const actor = z.string().transform((s) => s.trim()).refine((s) => s.length > 0 && s.length <= 60, { message: 'REQUIRED_TEXT' });
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const timeTypeCode = upper.pipe(z.string().regex(/^([A-Z][A-Z0-9]{1,9})$/, { message: 'TIME_TYPE_CODE_FORMAT' }));
const typeKind = upper.pipe(z.enum(TIME_TYPE_KINDS, { message: 'TIME_TYPE_KIND' }));
const absenceStatus = upper.pipe(z.enum(ABSENCE_STATUSES, { message: 'ABSENCE_STATUS' }));
const kept = (max: number) =>
  z.string().transform((s) => s.trim()).refine((s) => s.length > 0 && s.length <= max, { message: 'REQUIRED_TEXT' });
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const defineTimeTypeInput = z.object({
  client: clientField,
  code: timeTypeCode,
  name: kept(60),
  description: optionalText(200),
  typeKind: typeKind,
  reducesQuota: z.boolean().optional(),
  changedBy: actor,
});

const changeTimeTypeInput = z.object({
  client: clientField,
  code: timeTypeCode,
  name: kept(60).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  isValid: z.boolean().optional(),
  changedBy: actor,
});

const requestAbsenceInput = z.object({
  client: clientField,
  personnelNumber,
  timeTypeCode,
  validFrom: z.string().trim(),
  validTo: z.string().trim().optional(),
  reason: optionalText(200),
  changedBy: actor,
  requestKey: z.string().trim().min(8).max(64).optional(),
});

const decideAbsenceInput = z.object({
  client: clientField,
  personnelNumber,
  timeTypeCode,
  validFrom: z.string().trim(),
  status: absenceStatus,
  changedBy: actor,
});

const recordTimeInput = z.object({
  client: clientField,
  personnelNumber,
  timeTypeCode,
  recordingDate: z.string().trim(),
  hours: z.string().transform((s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0 || n > 24) throw new z.ZodError([{ code: 'custom', message: 'HOURS_FORMAT', path: ['hours'] }]);
    return n;
  }),
  changedBy: actor,
});

const setLeaveQuotaInput = z.object({
  client: clientField,
  personnelNumber,
  timeTypeCode,
  year: z.string().transform((s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 1900 || n > 2100) throw new z.ZodError([{ code: 'custom', message: 'YEAR_FORMAT', path: ['year'] }]);
    return n as unknown as number;
  }),
  entitlement: z.string().transform((s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) throw new z.ZodError([{ code: 'custom', message: 'ENTITLEMENT_FORMAT', path: ['entitlement'] }]);
    return n;
  }),
  changedBy: actor,
});

export interface TimeTypeView {
  code: string;
  name: string;
  description: string | null;
  typeKind: TimeTypeKind;
  reducesQuota: boolean;
  isValid: boolean;
  createdBy: string;
  changedBy: string | null;
}

export interface AbsenceView {
  personnelNumber: string;
  employeeName: string;
  timeTypeCode: string;
  timeTypeName: string | null;
  validFrom: string;
  validTo: string | null;
  status: AbsenceStatus;
  reason: string | null;
  createdBy: string;
  changedBy: string | null;
}

export interface LeaveQuotaView {
  personnelNumber: string;
  employeeName: string;
  timeTypeCode: string;
  timeTypeName: string | null;
  year: number;
  entitlement: number;
  taken: number;
  remaining: number;
}

export interface TimeRecordingView {
  personnelNumber: string;
  employeeName: string;
  timeTypeCode: string;
  timeTypeName: string | null;
  recordingDate: string;
  hours: number;
}

export class TimeLeaveError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'TimeLeaveError';
    this.remedy = remedy;
  }
}

const REFUSALS: Record<string, [string, string]> = {
  CLIENT_FORMAT: [
    'A tenant is the two-to-four-character code the session was opened with.',
    'Open the screen from the launchpad; the tenant comes from the session, not from the form.',
  ],
  PERSONNEL_FORMAT: ['A personnel number is 2 to 20 characters of capitals and digits.', 'Use the number on the employee master.'],
  ORG_CODE_FORMAT: ['A time type code is one to ten characters, starting with a letter.', 'Pick it from the time type list.'],
  REQUIRED_TEXT: ['A name was blank or longer than 60 characters.', 'Write it as the payroll letterhead would.'],
  DATE_FORMAT: ['A date has to read YYYY-MM-DD.', 'Write the day as the calendar holds it.'],
  HOURS_FORMAT: ['Hours must be a number greater than 0 and no more than 24.', 'Enter the hours the employee recorded that day.'],
  YEAR_FORMAT: ['A year is four digits, 1901 to 2099.', 'Write the calendar year the entitlement belongs to.'],
  ENTITLEMENT_FORMAT: ['Entitlement must be a number of zero or more.', 'Write the days the employee is entitled to that year.'],
  TIME_TYPE_CODE_FORMAT: ['A time type code is one to ten characters, starting with a letter.', 'Define the type first, then request against it.'],
  TIME_TYPE_KIND: [
    'A time type is an absence, an attendance, or overtime.',
    'Those three are what this slice knows. Anything else is a jurisdiction decision (§15.3).',
  ],
  ABSENCE_STATUS: [
    'An absence status is requested, approved, rejected or cancelled.',
    'Only a requested absence can be decided; a decided one is corrected by a new request.',
  ],
  EMPLOYEE_UNKNOWN: [
    'No employee with that personnel number stands in this tenant.',
    'Create the employee first — the master and its number come before any time is recorded (§6.1).',
  ],
  EMPLOYEE_INACTIVE: [
    'That employee is marked inactive, so no time or absence starts for them.',
    'Set the master active again, or write the dated record that explains the gap.',
  ],
  TIME_TYPE_UNKNOWN: [
    'No time type of that code stands in this tenant.',
    'Define the type at /people/time-leave before recording time or requesting absence against it.',
  ],
  TIME_TYPE_RETIRED: [
    'That time type is retired, so no new absence or time recording may use it.',
    'Set its validity back to true, or record against a type that is still valid.',
  ],
  TIME_TYPE_DOES_NOT_REDUCE_QUOTA: [
    'That time type does not reduce a leave quota.',
    'Only types whose kind is ABSENCE and whose reduces_quota flag is set have a balance.',
  ],
  OVERLAP: [
    'The employee already has an absence covering that day.',
    'End the absence that is standing, then request the new one starting the day after.',
  ],
  ABSENCE_UNKNOWN: [
    'No absence of that employee, type and start date stands in this tenant.',
    'Pick the row the screen lists; its start date is part of its key.',
  ],
  NOT_REQUESTED: [
    'That absence is not in the requested state, so it cannot be decided.',
    'Only a REQUESTED absence can be approved or rejected.',
  ],
  ALREADY_DECIDED: [
    'That absence has already been decided, so its status cannot change.',
    'Write a new absence request instead: history is corrected by the record that follows.',
  ],
  SPAN_ORDER: [
    'An end date cannot fall before the day the absence started.',
    'validTo has to be on or after validFrom: the last day an absence applies is never its first day\'s predecessor.',
  ],
  QUOTA_EXCEEDED: [
    'The employee\'s remaining balance for that type and year is not enough for the days requested.',
    'Reduce the span, or have an administrator raise the entitlement for that year.',
  ],
  NOTHING_TO_CHANGE: [
    'No field was given, so nothing would change.',
    'Send the name, the kind, the validity or the reduces_quota flag you want moved.',
  ],
  TIME_TYPE_EXISTS: [
    'A time type with that code already stands in this tenant.',
    'Change the one that stands, or retire it and define the new one under a code nobody has used.',
  ],
  INVALID_INPUT: ['The time and leave write was not accepted.', 'Correct the value and submit again.'],
};

function refusal(key: string, detail?: string): never {
  const [message, remedy] = REFUSALS[key] ?? [
    `The time and leave write was not accepted (${key}).`,
    'Correct the value and submit again.',
  ];
  throw new TimeLeaveError(detail ? `${message} ${detail}` : message, remedy);
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    refusal(first?.code === 'custom' ? String(first.message) : (first?.message ?? 'INVALID_INPUT'));
  }
  return parsed.data;
}

function dayOf(value: string): string {
  const day = value.trim();
  if (!DATE_PATTERN.test(day)) refusal('DATE_FORMAT', day);
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) refusal('DATE_FORMAT', day);
  const round = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  if (round !== day) refusal('DATE_FORMAT', day);
  return day;
}

async function employeeName(tx: Tx, client: string, number: string): Promise<string> {
  const rows = await tx.execute(sql`
    select full_name from public.employee where client = ${client} and personnel_number = ${number}`) as unknown as Array<{
    full_name: string;
  }>;
  const name = rows[0]?.full_name;
  if (name === undefined) refusal('EMPLOYEE_UNKNOWN', number);
  return name;
}

async function employeeActive(tx: Tx, client: string, number: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    select is_active from public.employee where client = ${client} and personnel_number = ${number}`) as unknown as Array<{
    is_active: boolean;
  }>;
  return rows[0]?.is_active !== false;
}

async function getTimeType(tx: Tx, client: string, code: string): Promise<{ code: string; name: string; typeKind: string; reducesQuota: boolean; isValid: boolean }> {
  const rows = await tx.select({
    code: timeType.code,
    name: timeType.name,
    typeKind: timeType.typeKind,
    reducesQuota: timeType.reducesQuota,
    isValid: timeType.isValid,
  }).from(timeType).where(and(
    eq(timeType.client, client),
    eq(timeType.code, code),
  )).limit(1);
  const row = rows[0];
  if (!row) refusal('TIME_TYPE_UNKNOWN', code);
  return row;
}

/** The days an inclusive span covers, counting each calendar day. */
function spanDays(from: string, to: string | null): number {
  if (!to) return 1;
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

/** The year a day falls in. */
function yearOf(day: string): number {
  return Number(day.slice(0, 4));
}

/** Define a time type. The kind is chosen here and never again. */
export async function defineTimeType(
  input: unknown,
  capabilities?: readonly string[],
): Promise<TimeTypeView> {
  const parsed = parse(defineTimeTypeInput, input);
  assertCapability(capabilities, TIME_ENTER_CAPABILITY, parsed.changedBy);
  await withTenant(parsed.client, async (tx) => {
    const [standing] = await tx.select().from(timeType).where(and(
      eq(timeType.client, parsed.client),
      eq(timeType.code, parsed.code),
    )).limit(1);
    if (standing) refusal('TIME_TYPE_EXISTS', parsed.code);
    await tx.insert(timeType).values({
      client: parsed.client,
      code: parsed.code,
      name: parsed.name,
      description: parsed.description ?? null,
      typeKind: parsed.typeKind,
      reducesQuota: parsed.reducesQuota ?? false,
      isValid: true,
      createdBy: parsed.changedBy,
    });
    await recordChange(tx, {
      client: parsed.client,
      objectClass: TIME_TYPE_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: { code: parsed.code, name: parsed.name, kind: parsed.typeKind },
    });
    return undefined;
  });
  return getTimeTypeView(parsed.client, parsed.code);
}

/** Rename, re-describe or retire a time type. The kind never changes; nothing is removed. */
export async function changeTimeType(
  input: unknown,
  capabilities?: readonly string[],
): Promise<TimeTypeView> {
  const parsed = parse(changeTimeTypeInput, input);
  assertCapability(capabilities, TIME_ENTER_CAPABILITY, parsed.changedBy);
  await withTenant(parsed.client, async (tx) => {
    const [standing] = await tx.select().from(timeType).where(and(
      eq(timeType.client, parsed.client),
      eq(timeType.code, parsed.code),
    )).limit(1);
    if (!standing) refusal('TIME_TYPE_UNKNOWN', parsed.code);
    const patch: { name?: string; description?: string | null; isValid?: boolean } = {};
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.description !== undefined) patch.description = parsed.description;
    if (parsed.isValid !== undefined) patch.isValid = parsed.isValid;
    if (Object.keys(patch).length === 0) refusal('NOTHING_TO_CHANGE');
    await tx.update(timeType).set({ ...patch, changedBy: parsed.changedBy, changedAt: new Date() }).where(and(
      eq(timeType.client, parsed.client),
      eq(timeType.code, parsed.code),
    ));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: TIME_TYPE_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      before: { name: standing!.name, isValid: standing!.isValid },
      after: patch,
    });
    return undefined;
  });
  return getTimeTypeView(parsed.client, parsed.code);
}

/**
 * Request an absence. The advisory lock covers the overlap test and the insert,
 * because two clerks dating the same person's leave in the same moment would
 * otherwise both find the day free.
 */
export async function requestAbsence(
  input: unknown,
  capabilities?: readonly string[],
): Promise<AbsenceView> {
  const parsed = parse(requestAbsenceInput, input);
  assertCapability(capabilities, TIME_ENTER_CAPABILITY, parsed.changedBy);
  const from = dayOf(parsed.validFrom);
  const to = parsed.validTo ? dayOf(parsed.validTo) : null;
  if (to && to < from) refusal('SPAN_ORDER');

  await withTenant(parsed.client, async (tx) => {
    await employeeName(tx, parsed.client, parsed.personnelNumber);
    if (!(await employeeActive(tx, parsed.client, parsed.personnelNumber))) {
      refusal('EMPLOYEE_INACTIVE', parsed.personnelNumber);
    }
    const type = await getTimeType(tx, parsed.client, parsed.timeTypeCode);
    if (!type.isValid) refusal('TIME_TYPE_RETIRED', parsed.timeTypeCode);

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${parsed.client}/absence/${parsed.personnelNumber}`}, 0))`);

    // A replay of the same key reports the absence that stands instead of writing a second one.
    if (parsed.requestKey) {
      const [replay] = await tx.select({ validFrom: absence.validFrom }).from(absence).where(and(
        eq(absence.client, parsed.client),
        eq(absence.personnelNumber, parsed.personnelNumber),
        eq(absence.requestKey, parsed.requestKey),
      )).limit(1);
      if (replay) return undefined;
    }

    // An absence is in the way when it is still open, or when it ends on or after
    // the day the new one would start. A row that ended before that day is history.
    const blocking = await tx.select({
      validFrom: absence.validFrom,
      validTo: absence.validTo,
      status: absence.status,
    }).from(absence).where(and(
      eq(absence.client, parsed.client),
      eq(absence.personnelNumber, parsed.personnelNumber),
      or(isNull(absence.validTo), gte(absence.validTo, from)),
    )).orderBy(desc(absence.validFrom)).limit(1);
    const clash = blocking[0];
    if (clash) {
      refusal('OVERLAP', `the absence from ${clash.validFrom} to ${clash.validTo ?? 'open'} already covers ${from}.`);
    }

    // If the type reduces quota, check the balance can cover the days requested.
    if (type.reducesQuota) {
      const days = spanDays(from, to);
      const year = yearOf(from);
      const [quota] = await tx.select().from(leaveQuota).where(and(
        eq(leaveQuota.client, parsed.client),
        eq(leaveQuota.personnelNumber, parsed.personnelNumber),
        eq(leaveQuota.timeTypeCode, parsed.timeTypeCode),
        eq(leaveQuota.year, year),
      )).limit(1);
      const remaining = quota?.remaining ?? 0;
      if (remaining < days) refusal('QUOTA_EXCEEDED', `${days} day${days === 1 ? '' : 's'} requested, ${remaining} remaining.`);
    }

    await tx.insert(absence).values({
      client: parsed.client,
      personnelNumber: parsed.personnelNumber,
      timeTypeCode: parsed.timeTypeCode,
      validFrom: from,
      validTo: to,
      status: 'REQUESTED',
      reason: parsed.reason ?? null,
      requestKey: parsed.requestKey ?? null,
      createdBy: parsed.changedBy,
    });
    await recordChange(tx, {
      client: parsed.client,
      objectClass: ABSENCE_OBJECT_CLASS,
      objectKey: `${parsed.personnelNumber}/${parsed.timeTypeCode}/${from}`,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      transactionCode: 'PA2001',
      after: {
        personnelNumber: parsed.personnelNumber,
        timeTypeCode: parsed.timeTypeCode,
        validFrom: from,
        validTo: to,
        status: 'REQUESTED',
      },
    });
    return undefined;
  });
  return getAbsence(parsed.client, parsed.personnelNumber, parsed.timeTypeCode, from);
}

/**
 * Approve or reject a requested absence. Approving reduces the leave quota for
 * the type's year; rejecting leaves it untouched. Only REQUESTED can be decided.
 */
export async function decideAbsence(
  input: unknown,
  capabilities?: readonly string[],
): Promise<AbsenceView> {
  const parsed = parse(decideAbsenceInput, input);
  assertCapability(capabilities, TIME_ENTER_CAPABILITY, parsed.changedBy);
  const from = dayOf(parsed.validFrom);

  await withTenant(parsed.client, async (tx) => {
    const [standing] = await tx.select().from(absence).where(and(
      eq(absence.client, parsed.client),
      eq(absence.personnelNumber, parsed.personnelNumber),
      eq(absence.timeTypeCode, parsed.timeTypeCode),
      eq(absence.validFrom, from),
    )).limit(1);
    if (!standing) refusal('ABSENCE_UNKNOWN', `${parsed.personnelNumber}/${parsed.timeTypeCode} from ${from}`);
    if (standing.status !== 'REQUESTED') refusal('NOT_REQUESTED');

    const type = await getTimeType(tx, parsed.client, parsed.timeTypeCode);

    // Moving from REQUESTED to APPROVED reduces the quota; any other target
    // leaves the quota as it stands (a rejection never took days).
    if (parsed.status === 'APPROVED' && type.reducesQuota) {
      const days = spanDays(from, standing.validTo);
      const year = yearOf(from);
      const [quota] = await tx.select().from(leaveQuota).where(and(
        eq(leaveQuota.client, parsed.client),
        eq(leaveQuota.personnelNumber, parsed.personnelNumber),
        eq(leaveQuota.timeTypeCode, parsed.timeTypeCode),
        eq(leaveQuota.year, year),
      )).limit(1);
      const remaining = quota?.remaining ?? 0;
      if (remaining < days) refusal('QUOTA_EXCEEDED', `${days} day${days === 1 ? '' : 's'} needed, ${remaining} remaining.`);

      await tx.update(leaveQuota).set({
        taken: Number(quota?.taken ?? 0) + days,
        remaining: Number(quota?.remaining ?? 0) - days,
        changedBy: parsed.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(leaveQuota.client, parsed.client),
        eq(leaveQuota.personnelNumber, parsed.personnelNumber),
        eq(leaveQuota.timeTypeCode, parsed.timeTypeCode),
        eq(leaveQuota.year, year),
      ));
    }

    await tx.update(absence).set({
      status: parsed.status,
      changedBy: parsed.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(absence.client, parsed.client),
      eq(absence.personnelNumber, parsed.personnelNumber),
      eq(absence.timeTypeCode, parsed.timeTypeCode),
      eq(absence.validFrom, from),
    ));

    await recordChange(tx, {
      client: parsed.client,
      objectClass: ABSENCE_OBJECT_CLASS,
      objectKey: `${parsed.personnelNumber}/${parsed.timeTypeCode}/${from}`,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      transactionCode: 'PA2001',
      before: { status: standing.status },
      after: { status: parsed.status },
      reason: `Absence ${parsed.status.toLowerCase()} by the tenant's leave approver.`,
    });
    return undefined;
  });
  return getAbsence(parsed.client, parsed.personnelNumber, parsed.timeTypeCode, from);
}

/** Cancel an absence: REQUESTED → CANCELLED. Only a request can be cancelled. */
export async function cancelAbsence(
  input: unknown,
  capabilities?: readonly string[],
): Promise<AbsenceView> {
  return decideAbsence({ ...input, status: 'CANCELLED' as const }, capabilities);
}

/**
 * Record hours an employee worked on a day, of one type. Overwrites the day's
 * entry — a time record is a measurement, not history.
 */
export async function recordTime(
  input: unknown,
  capabilities?: readonly string[],
): Promise<TimeRecordingView> {
  const parsed = parse(recordTimeInput, input);
  assertCapability(capabilities, TIME_ENTER_CAPABILITY, parsed.changedBy);
  const day = dayOf(parsed.recordingDate);

  await withTenant(parsed.client, async (tx) => {
    await employeeName(tx, parsed.client, parsed.personnelNumber);
    if (!(await employeeActive(tx, parsed.client, parsed.personnelNumber))) {
      refusal('EMPLOYEE_INACTIVE', parsed.personnelNumber);
    }
    const type = await getTimeType(tx, parsed.client, parsed.timeTypeCode);
    if (!type.isValid) refusal('TIME_TYPE_RETIRED', parsed.timeTypeCode);

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${parsed.client}/time/${parsed.personnelNumber}/${day}`}, 0))`);

    const [existing] = await tx.select().from(timeRecording).where(and(
      eq(timeRecording.client, parsed.client),
      eq(timeRecording.personnelNumber, parsed.personnelNumber),
      eq(timeRecording.timeTypeCode, parsed.timeTypeCode),
      eq(timeRecording.recordingDate, day),
    )).limit(1);

    if (existing) {
      await tx.update(timeRecording).set({
        hours: parsed.hours,
        changedBy: parsed.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(timeRecording.client, parsed.client),
        eq(timeRecording.personnelNumber, parsed.personnelNumber),
        eq(timeRecording.timeTypeCode, parsed.timeTypeCode),
        eq(timeRecording.recordingDate, day),
      ));
      await recordChange(tx, {
        client: parsed.client,
        objectClass: TIME_RECORDING_OBJECT_CLASS,
        objectKey: `${parsed.personnelNumber}/${parsed.timeTypeCode}/${day}`,
        changeType: 'CHANGE',
        changedBy: parsed.changedBy,
        before: { hours: existing.hours },
        after: { hours: parsed.hours },
      });
    } else {
      await tx.insert(timeRecording).values({
        client: parsed.client,
        personnelNumber: parsed.personnelNumber,
        timeTypeCode: parsed.timeTypeCode,
        recordingDate: day,
        hours: parsed.hours,
        createdBy: parsed.changedBy,
      });
      await recordChange(tx, {
        client: parsed.client,
        objectClass: TIME_RECORDING_OBJECT_CLASS,
        objectKey: `${parsed.personnelNumber}/${parsed.timeTypeCode}/${day}`,
        changeType: 'CREATE',
        changedBy: parsed.changedBy,
        after: { recordingDate: day, timeTypeCode: parsed.timeTypeCode, hours: parsed.hours },
      });
    }
    return undefined;
  });
  return getTimeRecording(parsed.client, parsed.personnelNumber, parsed.timeTypeCode, day);
}

/** Configure a leave quota: entitlement per employee, per type, per year. */
export async function setLeaveQuota(
  input: unknown,
  capabilities?: readonly string[],
): Promise<LeaveQuotaView> {
  const parsed = parse(setLeaveQuotaInput, input);
  assertCapability(capabilities, TIME_ENTER_CAPABILITY, parsed.changedBy);
  const year = Number(parsed.year);

  await withTenant(parsed.client, async (tx) => {
    await employeeName(tx, parsed.client, parsed.personnelNumber);
    if (!(await employeeActive(tx, parsed.client, parsed.personnelNumber))) {
      refusal('EMPLOYEE_INACTIVE', parsed.personnelNumber);
    }
    const type = await getTimeType(tx, parsed.client, parsed.timeTypeCode);
    if (!type.reducesQuota) refusal('TIME_TYPE_DOES_NOT_REDUCE_QUOTA', parsed.timeTypeCode);

    const [existing] = await tx.select().from(leaveQuota).where(and(
      eq(leaveQuota.client, parsed.client),
      eq(leaveQuota.personnelNumber, parsed.personnelNumber),
      eq(leaveQuota.timeTypeCode, parsed.timeTypeCode),
      eq(leaveQuota.year, year),
    )).limit(1);

    const entitlement = Number(parsed.entitlement);
    const taken = existing?.taken ?? 0;

    if (existing) {
      await tx.update(leaveQuota).set({
        entitlement,
        remaining: entitlement - taken,
        changedBy: parsed.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(leaveQuota.client, parsed.client),
        eq(leaveQuota.personnelNumber, parsed.personnelNumber),
        eq(leaveQuota.timeTypeCode, parsed.timeTypeCode),
        eq(leaveQuota.year, year),
      ));
    } else {
      await tx.insert(leaveQuota).values({
        client: parsed.client,
        personnelNumber: parsed.personnelNumber,
        timeTypeCode: parsed.timeTypeCode,
        year,
        entitlement,
        taken: 0,
        remaining: entitlement,
        createdBy: parsed.changedBy,
      });
    }
    await recordChange(tx, {
      client: parsed.client,
      objectClass: LEAVE_QUOTA_OBJECT_CLASS,
      objectKey: `${parsed.personnelNumber}/${parsed.timeTypeCode}/${year}`,
      changeType: existing ? 'CHANGE' : 'CREATE',
      changedBy: parsed.changedBy,
      before: existing ? { entitlement: existing.entitlement, taken: existing.taken, remaining: existing.remaining } : undefined,
      after: { entitlement, taken, remaining: entitlement - taken },
    });
    return undefined;
  });
  return getLeaveQuota(parsed.client, parsed.personnelNumber, parsed.timeTypeCode, year);
}

/** One time type, by code. */
export async function getTimeTypeView(clientInput: string, codeValue: string): Promise<TimeTypeView> {
  const client = parse(clientField, clientInput);
  const code = parse(timeTypeCode, codeValue);
  return withTenant(client, async (tx) => {
    const row = await getTimeType(tx, client, code);
    return {
      code: row.code,
      name: row.name,
      description: null,
      typeKind: row.typeKind as TimeTypeKind,
      reducesQuota: row.reducesQuota,
      isValid: row.isValid,
      createdBy: '',
      changedBy: null,
    };
  });
}

/** One absence, by the four parts of its key. */
export async function getAbsence(
  clientInput: string,
  personnelInput: string,
  typeCodeInput: string,
  validFromInput: string,
): Promise<AbsenceView> {
  const client = parse(clientField, clientInput);
  const number = parse(personnelNumber, personnelInput);
  const typeCode = parse(timeTypeCode, typeCodeInput);
  const from = dayOf(validFromInput);
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select a.personnel_number, e.full_name as employee_name, a.time_type_code,
             t.name as time_type_name, a.valid_from::text as valid_from, a.valid_to::text as valid_to,
             a.status, a.reason, a.created_by, a.changed_by
        from public.absence a
        join public.employee e on e.client = a.client and e.personnel_number = a.personnel_number
        left join public.time_type t on t.client = a.client and t.code = a.time_type_code
       where a.client = ${client} and a.personnel_number = ${number}
         and a.time_type_code = ${typeCode} and a.valid_from = ${from}`) as unknown as Array<{
      personnel_number: string;
      employee_name: string;
      time_type_code: string;
      time_type_name: string | null;
      valid_from: string;
      valid_to: string | null;
      status: string;
      reason: string | null;
      created_by: string;
      changed_by: string | null;
    }>;
    const row = rows[0];
    if (!row) refusal('ABSENCE_UNKNOWN', `${number}/${typeCode} from ${from}`);
    return {
      personnelNumber: row.personnel_number,
      employeeName: row.employee_name,
      timeTypeCode: row.time_type_code,
      timeTypeName: row.time_type_name,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status as AbsenceStatus,
      reason: row.reason,
      createdBy: row.created_by,
      changedBy: row.changed_by,
    };
  });
}

/** Everything one employee has requested, newest first. */
export async function absencesOf(clientInput: string, personnelInput: string): Promise<AbsenceView[]> {
  const client = parse(clientField, clientInput);
  const number = parse(personnelNumber, personnelInput);
  return withTenant(client, async (tx) => {
    await employeeName(tx, client, number);
    const rows = await tx.execute(sql`
      select a.personnel_number, e.full_name as employee_name, a.time_type_code,
             t.name as time_type_name, a.valid_from::text as valid_from, a.valid_to::text as valid_to,
             a.status, a.reason, a.created_by, a.changed_by
        from public.absence a
        join public.employee e on e.client = a.client and e.personnel_number = a.personnel_number
        left join public.time_type t on t.client = a.client and t.code = a.time_type_code
       where a.client = ${client} and a.personnel_number = ${number}
       order by a.valid_from desc`) as unknown as Array<{
      personnel_number: string;
      employee_name: string;
      time_type_code: string;
      time_type_name: string | null;
      valid_from: string;
      valid_to: string | null;
      status: string;
      reason: string | null;
      created_by: string;
      changed_by: string | null;
    }>;
    return rows.map((row) => ({
      personnelNumber: row.personnel_number,
      employeeName: row.employee_name,
      timeTypeCode: row.time_type_code,
      timeTypeName: row.time_type_name,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status as AbsenceStatus,
      reason: row.reason,
      createdBy: row.created_by,
      changedBy: row.changed_by,
    }));
  });
}

export interface AbsenceSearch {
  client: string;
  query?: string;
  status?: AbsenceStatus;
  timeTypeCode?: string;
  /** Only absences standing on a day: open, or ended no earlier than that day. */
  standingOn?: string;
}

/** Search, on personnel number, name, type code and status. */
export async function listAbsences(search: AbsenceSearch): Promise<AbsenceView[]> {
  const parsed = parse(z.object({
    client: clientField,
    query: z.string().trim().optional(),
    status: absenceStatus.optional(),
    timeTypeCode: timeTypeCode.optional(),
    standingOn: z.string().trim().optional(),
  }), search);
  const needle = (parsed.query ?? '').trim().toUpperCase();
  return withTenant(parsed.client, async (tx) => {
    const standing = parsed.standingOn ? dayOf(parsed.standingOn) : null;
    const rows = await tx.execute(sql`
      select a.personnel_number, e.full_name as employee_name, a.time_type_code,
             t.name as time_type_name, a.valid_from::text as valid_from, a.valid_to::text as valid_to,
             a.status, a.reason, a.created_by, a.changed_by
        from public.absence a
        join public.employee e on e.client = a.client and e.personnel_number = a.personnel_number
        left join public.time_type t on t.client = a.client and t.code = a.time_type_code
       where a.client = ${parsed.client}
         ${needle === '' ? sql`` : sql`and (upper(a.personnel_number) like ${`%${needle}%`} or upper(e.full_name) like ${`%${needle}%`})`}
         ${parsed.status ? sql`and a.status = ${parsed.status}` : sql``}
         ${parsed.timeTypeCode ? sql`and a.time_type_code = ${parsed.timeTypeCode}` : sql``}
         ${standing ? sql`and (a.valid_to is null or a.valid_to >= ${standing})` : sql``}
       order by a.personnel_number, a.valid_from desc
       limit 200`) as unknown as Array<{
      personnel_number: string;
      employee_name: string;
      time_type_code: string;
      time_type_name: string | null;
      valid_from: string;
      valid_to: string | null;
      status: string;
      reason: string | null;
      created_by: string;
      changed_by: string | null;
    }>;
    return rows.map((row) => ({
      personnelNumber: row.personnel_number,
      employeeName: row.employee_name,
      timeTypeCode: row.time_type_code,
      timeTypeName: row.time_type_name,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status as AbsenceStatus,
      reason: row.reason,
      createdBy: row.created_by,
      changedBy: row.changed_by,
    }));
  });
}

/** One leave quota, by employee, type and year. */
export async function getLeaveQuota(
  clientInput: string,
  personnelInput: string,
  typeCodeInput: string,
  yearInput: number | string,
): Promise<LeaveQuotaView> {
  const client = parse(clientField, clientInput);
  const number = parse(personnelNumber, personnelInput);
  const typeCode = parse(timeTypeCode, typeCodeInput);
  const year = typeof yearInput === 'string' ? Number(yearInput) : yearInput;
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select q.personnel_number, e.full_name as employee_name, q.time_type_code,
             t.name as time_type_name, q.year, q.entitlement, q.taken, q.remaining
        from public.leave_quota q
        join public.employee e on e.client = q.client and e.personnel_number = q.personnel_number
        left join public.time_type t on t.client = q.client and t.code = q.time_type_code
       where q.client = ${client} and q.personnel_number = ${number}
         and q.time_type_code = ${typeCode} and q.year = ${year}`) as unknown as Array<{
      personnel_number: string;
      employee_name: string;
      time_type_code: string;
      time_type_name: string | null;
      year: number;
      entitlement: number;
      taken: number;
      remaining: number;
    }>;
    const row = rows[0];
    if (!row) refusal('ABSENCE_UNKNOWN', `${number}/${typeCode} year ${year}`);
    return {
      personnelNumber: row.personnel_number,
      employeeName: row.employee_name,
      timeTypeCode: row.time_type_code,
      timeTypeName: row.time_type_name,
      year: row.year,
      entitlement: Number(row.entitlement),
      taken: Number(row.taken),
      remaining: Number(row.remaining),
    };
  });
}

/** The time types the tenant has defined, optionally filtered to valid ones. */
export async function listTimeTypes(clientInput: string, openOnly?: boolean): Promise<TimeTypeView[]> {
  const client = parse(clientField, clientInput);
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(timeType).where(eq(timeType.client, client)).orderBy(asc(timeType.code));
    return rows
      .filter((row) => !openOnly || row.isValid)
      .map((row) => ({
        code: row.code,
        name: row.name,
        description: null,
        typeKind: row.typeKind as TimeTypeKind,
        reducesQuota: row.reducesQuota,
        isValid: row.isValid,
        createdBy: '',
        changedBy: null,
      }));
  });
}

/** One time recording, by employee, type and day. */
export async function getTimeRecording(
  clientInput: string,
  personnelInput: string,
  typeCodeInput: string,
  dayInput: string,
): Promise<TimeRecordingView> {
  const client = parse(clientField, clientInput);
  const number = parse(personnelNumber, personnelInput);
  const typeCode = parse(timeTypeCode, typeCodeInput);
  const day = dayOf(dayInput);
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select t.personnel_number, e.full_name as employee_name, t.time_type_code,
             ty.name as time_type_name, t.recording_date::text as recording_date, t.hours
        from public.time_recording t
        join public.employee e on e.client = t.client and e.personnel_number = t.personnel_number
        left join public.time_type ty on ty.client = t.client and ty.code = t.time_type_code
       where t.client = ${client} and t.personnel_number = ${number}
         and t.time_type_code = ${typeCode} and t.recording_date = ${day}`) as unknown as Array<{
      personnel_number: string;
      employee_name: string;
      time_type_code: string;
      time_type_name: string | null;
      recording_date: string;
      hours: number;
    }>;
    const row = rows[0];
    if (!row) refusal('ABSENCE_UNKNOWN', `${number}/${typeCode} on ${day}`);
    return {
      personnelNumber: row.personnel_number,
      employeeName: row.employee_name,
      timeTypeCode: row.time_type_code,
      timeTypeName: row.time_type_name,
      recordingDate: row.recording_date,
      hours: Number(row.hours),
    };
  });
}

/** Is a time/leave error? Only this module's own error is a refusal. */
export function isTimeLeaveError(error: unknown): error is TimeLeaveError {
  return error instanceof TimeLeaveError;
}

/** The absence standing on a day for one employee and type: open, or ended no earlier than that day. */
export async function openAbsenceOn(
  clientInput: string,
  personnelInput: string,
  typeCodeInput: string,
  dayInput: string,
): Promise<AbsenceView | null> {
  const client = parse(clientField, clientInput);
  const number = parse(personnelNumber, personnelInput);
  const typeCode = parse(timeTypeCode, typeCodeInput);
  const day = dayOf(dayInput);
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select a.personnel_number, e.full_name as employee_name, a.time_type_code,
             t.name as time_type_name, a.valid_from::text as valid_from, a.valid_to::text as valid_to,
             a.status, a.reason, a.created_by, a.changed_by
        from public.absence a
        join public.employee e on e.client = a.client and e.personnel_number = a.personnel_number
        left join public.time_type t on t.client = a.client and t.code = a.time_type_code
       where a.client = ${client} and a.personnel_number = ${number}
         and a.time_type_code = ${typeCode}
         and (a.valid_to is null or a.valid_to >= ${day})
       order by a.valid_from desc limit 1`) as unknown as Array<{
      personnel_number: string;
      employee_name: string;
      time_type_code: string;
      time_type_name: string | null;
      valid_from: string;
      valid_to: string | null;
      status: string;
      reason: string | null;
      created_by: string;
      changed_by: string | null;
    }>;
    const row = rows[0];
    return row ? {
      personnelNumber: row.personnel_number,
      employeeName: row.employee_name,
      timeTypeCode: row.time_type_code,
      timeTypeName: row.time_type_name,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status as AbsenceStatus,
      reason: row.reason,
      createdBy: row.created_by,
      changedBy: row.changed_by,
    } : null;
  });
}