/**
 * Leave policy configuration: policies and their versions, groups with dated membership, and policy
 * assignment to a group or directly to one person. Configuration only — no balance is written here
 * (accrual is `leave-accrual.ts`, absences are `leave-absence.ts`).
 *
 * **Precedence.** A policy assigned directly to a PERSON overrides the policy of the person's GROUP for
 * the dates they overlap; where there is no direct assignment, the group's applies. The two are never
 * added. After a direct assignment ends the group policy resumes. A person is in at most one group at
 * a time and a subject has at most one policy at a time (database triggers), so the resolver can never
 * have to choose between two candidates; if it ever found two it refuses instead of picking one.
 *
 * **Guardrails (documented, enforced).**
 * - A policy version starts on the first of a month, and is immutable once written. A new version must
 *   start after the latest one, and not on or before any month that already has a posted accrual under
 *   the policy; a correction to posted months is a ledger adjustment, not an edit of history.
 * - The partial-month rule is chosen explicitly on every version; there is no default.
 * - Only calendar-day counting and year-end expiry (no carry-over) exist, and only those are accepted.
 * - A line's type must be a valid ABSENCE type that reduces quota. A fallback must be another line of
 *   the same version; chains are acyclic.
 * - Starting or ending a membership/assignment inside a month that already has a posted accrual for
 *   that person is refused: post an adjustment instead.
 * - Eligibility comes only from these explicit dates. No hire date is invented from the employee master.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import {
  LEAVE_ASSIGN, LEAVE_CONFIGURE, LEAVE_VIEW, actorOf, assertReachesEmployee, judgeLeave, refuse,
  reachesEmployee, type LeaveAccess, type LeaveGrant,
} from './leave-access';
import { addDays, dayNumber, fromScaled, toScaled, type PartialMonthMode } from './leave-math';

const clientF = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'CLIENT_FORMAT');
const codeF = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'CODE_FORMAT');
const personF = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,20}$/, 'PERSONNEL_FORMAT');
const dayF = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'DATE_FORMAT').refine((d) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}, 'DATE_FORMAT');
const optDay = z.union([z.literal('').transform(() => null), dayF, z.null(), z.undefined().transform(() => null)]);
const text = (max: number) => z.string().trim().min(1).max(max);
const actorF = z.string().trim().max(60).optional();

const MODE_MESSAGES: Record<string, [string, string]> = {
  CLIENT_FORMAT: ['A tenant is two to four capitals or digits.', 'Open the screen from the launchpad.'],
  CODE_FORMAT: ['A code is two to ten capitals or digits, starting with a letter.', 'Use letters and digits only.'],
  PERSONNEL_FORMAT: ['A personnel number is two to twenty capitals or digits.', 'Use the number on the employee master.'],
  DATE_FORMAT: ['A date has to be a real day written YYYY-MM-DD.', 'Write the day as the calendar holds it.'],
  PARTIAL_MONTH_MODE: [
    'The partial-month rule must be chosen: PRORATE_DAYS or FULL_IF_ANY.',
    'There is no default. Choose how a month entered or left part-way is credited.',
  ],
};

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const key = String(r.error.issues[0]?.message ?? 'INVALID_INPUT');
    const [m, rem] = MODE_MESSAGES[key] ?? [`The input was not accepted (${key}).`, 'Correct the value and submit again.'];
    refuse(key, m, rem);
  }
  return r.data;
}

/** The pg error code of a (possibly wrapped) driver error, with its message. */
function pgError(e: unknown): { code?: string; message: string } {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const o = cur as { code?: string; message?: string; cause?: unknown };
    if (typeof o.code === 'string' && o.code.length === 5) return { code: o.code, message: String(o.message ?? '') };
    cur = o.cause;
  }
  return { message: String((e as Error)?.message ?? e) };
}

function monthStartOf(day: string): boolean {
  return day.endsWith('-01');
}

// ── shapes ───────────────────────────────────────────────────────────────────
export interface PolicyLineView {
  timeTypeCode: string;
  annualDays: string;
  accrualMode: 'MONTHLY' | 'ANNUAL_UPFRONT';
  fallbackTypeCode: string | null;
}
export interface PolicyVersionView {
  version: number;
  validFrom: string;
  partialMonthMode: PartialMonthMode;
  dayCountMode: string;
  yearEndMode: string;
  lines: PolicyLineView[];
}
export interface PolicyView {
  code: string;
  name: string;
  description: string | null;
  isValid: boolean;
  versions: PolicyVersionView[];
}
export interface GroupMemberView {
  id: string;
  personnelNumber: string;
  employeeName: string;
  validFrom: string;
  validTo: string | null;
}
export interface GroupView {
  code: string;
  name: string;
  description: string | null;
  isValid: boolean;
  members: GroupMemberView[];
  /** Members the caller may not see are counted, never named. */
  hiddenMembers: number;
}
export interface AssignmentView {
  id: string;
  subjectKind: 'GROUP' | 'PERSON';
  groupCode: string | null;
  personnelNumber: string | null;
  employeeName: string | null;
  policyCode: string;
  validFrom: string;
  validTo: string | null;
}

// ── policy definition ────────────────────────────────────────────────────────
const lineF = z.object({
  timeTypeCode: codeF,
  annualDays: z.string().trim().regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/, 'ANNUAL_DAYS'),
  accrualMode: z.enum(['MONTHLY', 'ANNUAL_UPFRONT'], { message: 'ACCRUAL_MODE' }),
  fallbackTypeCode: z.union([codeF, z.literal('').transform(() => null), z.null(), z.undefined().transform(() => null)]),
});
const versionBody = {
  validFrom: dayF,
  partialMonthMode: z.enum(['PRORATE_DAYS', 'FULL_IF_ANY'], { message: 'PARTIAL_MONTH_MODE' }),
  lines: z.array(lineF).min(1, 'NO_LINES').max(40),
  changedBy: actorF,
};
const definePolicyInput = z.object({ client: clientF, code: codeF, name: text(60), description: z.string().trim().max(200).nullish(), ...versionBody });
const addVersionInput = z.object({ client: clientF, policyCode: codeF, ...versionBody });

async function validateLines(tx: Tx, client: string, lines: ReadonlyArray<z.infer<typeof lineF>>): Promise<void> {
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.timeTypeCode)) refuse('DUPLICATE_LINE', `Time type ${l.timeTypeCode} appears twice in the policy.`, 'One line per time type.');
    seen.add(l.timeTypeCode);
  }
  for (const l of lines) {
    const [t] = (await tx.execute(sql`
      select type_kind, reduces_quota, is_valid from time_type where client = ${client} and code = ${l.timeTypeCode}
    `)) as unknown as Array<{ type_kind: string; reduces_quota: boolean; is_valid: boolean }>;
    if (!t) refuse('TIME_TYPE_UNKNOWN', `Time type ${l.timeTypeCode} does not exist.`, 'Define it on the configuration screen first.');
    if (!t.is_valid) refuse('TIME_TYPE_RETIRED', `Time type ${l.timeTypeCode} is retired.`, 'Use a valid type.');
    if (t.type_kind !== 'ABSENCE' || !t.reduces_quota) {
      refuse('TIME_TYPE_NO_QUOTA', `Time type ${l.timeTypeCode} is not an absence type that reduces a quota.`, 'A policy line gives an entitlement, so its type must be an ABSENCE type with reduces-quota set.');
    }
    if (l.fallbackTypeCode && !seen.has(l.fallbackTypeCode)) {
      refuse('FALLBACK_NOT_IN_POLICY', `${l.timeTypeCode} falls back to ${l.fallbackTypeCode}, which has no line in this version.`, 'Add a line for the fallback type (for example with its own balance) or remove the fallback.');
    }
  }
  const fb = new Map(lines.map((l) => [l.timeTypeCode, l.fallbackTypeCode]));
  for (const l of lines) {
    const path = new Set<string>([l.timeTypeCode]);
    for (let cur = fb.get(l.timeTypeCode); cur; cur = fb.get(cur)) {
      if (path.has(cur)) refuse('FALLBACK_CYCLE', `The fallback chain from ${l.timeTypeCode} loops back to ${cur}.`, 'Break the cycle: a fallback chain must end.');
      path.add(cur);
    }
  }
}

async function insertVersion(
  tx: Tx, client: string, policyCode: string, version: number, v: z.infer<z.ZodObject<typeof versionBody>>, actor: string,
): Promise<void> {
  if (!monthStartOf(v.validFrom)) {
    refuse('VERSION_MONTH_START', `A policy version starts on the first of a month, not ${v.validFrom}.`, 'Use the first day of a month. Mid-month policy changes are made by assigning a different policy to the person or group from that date.');
  }
  await validateLines(tx, client, v.lines);
  await tx.execute(sql`
    insert into leave_policy_version (client, policy_code, version, valid_from, partial_month_mode, created_by)
    values (${client}, ${policyCode}, ${version}, ${v.validFrom}, ${v.partialMonthMode}, ${actor})
  `);
  // Fallback targets are lines of the same version: insert targets first so the FK is satisfied.
  const order = [...v.lines].sort((a, b) => Number(a.fallbackTypeCode !== null) - Number(b.fallbackTypeCode !== null));
  const done = new Set<string>();
  let guard = 0;
  while (done.size < order.length && guard++ < 100) {
    for (const l of order) {
      if (done.has(l.timeTypeCode)) continue;
      if (l.fallbackTypeCode && !done.has(l.fallbackTypeCode)) continue;
      await tx.execute(sql`
        insert into leave_policy_line (client, policy_code, version, time_type_code, annual_days, accrual_mode, fallback_type_code, created_by)
        values (${client}, ${policyCode}, ${version}, ${l.timeTypeCode}, ${l.annualDays}, ${l.accrualMode}, ${l.fallbackTypeCode}, ${actor})
      `);
      done.add(l.timeTypeCode);
    }
  }
}

export async function defineLeavePolicy(input: unknown, access: LeaveAccess | undefined): Promise<PolicyView> {
  const p = parse(definePolicyInput, input);
  await withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_CONFIGURE]);
    const actor = actorOf(grant, p.changedBy);
    const [standing] = (await tx.execute(sql`select 1 as x from leave_policy where client = ${p.client} and code = ${p.code}`)) as unknown as unknown[];
    if (standing) refuse('POLICY_EXISTS', `Policy ${p.code} already exists.`, 'Add a new version to it, or choose another code.');
    await tx.execute(sql`
      insert into leave_policy (client, code, name, description, created_by)
      values (${p.client}, ${p.code}, ${p.name}, ${p.description ?? null}, ${actor})
    `);
    await insertVersion(tx, p.client, p.code, 1, p, actor);
    await recordChange(tx, {
      client: p.client, objectClass: 'leave_policy', objectKey: p.code, changeType: 'CREATE', changedBy: actor,
      after: { name: p.name, version: 1, validFrom: p.validFrom, partialMonthMode: p.partialMonthMode, lines: p.lines.length },
    });
  });
  return getPolicy(p.client, p.code, access);
}

export async function addLeavePolicyVersion(input: unknown, access: LeaveAccess | undefined): Promise<PolicyView> {
  const p = parse(addVersionInput, input);
  await withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_CONFIGURE]);
    const actor = actorOf(grant, p.changedBy);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${p.client}/leave-policy/${p.policyCode}`}, 0))`);
    const [head] = (await tx.execute(sql`select is_valid from leave_policy where client = ${p.client} and code = ${p.policyCode} for update`)) as unknown as Array<{ is_valid: boolean }>;
    if (!head) refuse('POLICY_UNKNOWN', `Policy ${p.policyCode} does not exist.`, 'Define it first.');
    if (!head.is_valid) refuse('POLICY_RETIRED', `Policy ${p.policyCode} is retired.`, 'Re-activate it, or define a new policy.');
    const [latest] = (await tx.execute(sql`
      select version, valid_from::text as valid_from from leave_policy_version
       where client = ${p.client} and policy_code = ${p.policyCode} order by version desc limit 1
    `)) as unknown as Array<{ version: number; valid_from: string }>;
    if (latest && p.validFrom <= latest.valid_from) {
      refuse('VERSION_NOT_LATER', `Version ${latest.version} already starts ${latest.valid_from}; a new version must start later.`, 'A version is history once written. Choose a later first-of-month.');
    }
    const [posted] = (await tx.execute(sql`
      select max(effective_date)::text as last from leave_ledger
       where client = ${p.client} and policy_code = ${p.policyCode} and entry_kind in ('MONTHLY_ACCRUAL', 'ANNUAL_GRANT')
    `)) as unknown as Array<{ last: string | null }>;
    if (posted?.last && p.validFrom <= posted.last) {
      refuse('VERSION_AFFECTS_POSTED', `Credits under policy ${p.policyCode} are already posted through ${posted.last}; a version starting ${p.validFrom} would rewrite them.`, `Start the new version after ${posted.last}, or correct earlier months with a quota adjustment.`);
    }
    await insertVersion(tx, p.client, p.policyCode, (latest?.version ?? 0) + 1, p, actor);
    await recordChange(tx, {
      client: p.client, objectClass: 'leave_policy', objectKey: p.policyCode, changeType: 'CHANGE', changedBy: actor,
      after: { version: (latest?.version ?? 0) + 1, validFrom: p.validFrom, partialMonthMode: p.partialMonthMode, lines: p.lines.length },
    });
  });
  return getPolicy(p.client, p.policyCode, access);
}

const changePolicyInput = z.object({
  client: clientF, code: codeF, name: text(60).optional(), description: z.string().trim().max(200).nullish(),
  isValid: z.boolean().optional(), changedBy: actorF,
});
/** Rename, re-describe or retire a policy header. Versions are never touched. */
export async function changeLeavePolicy(input: unknown, access: LeaveAccess | undefined): Promise<PolicyView> {
  const p = parse(changePolicyInput, input);
  await withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_CONFIGURE]);
    const actor = actorOf(grant, p.changedBy);
    const [cur] = (await tx.execute(sql`select name, is_valid from leave_policy where client = ${p.client} and code = ${p.code} for update`)) as unknown as Array<{ name: string; is_valid: boolean }>;
    if (!cur) refuse('POLICY_UNKNOWN', `Policy ${p.code} does not exist.`, 'Define it first.');
    if (p.name === undefined && p.description === undefined && p.isValid === undefined) refuse('NOTHING_TO_CHANGE', 'No field was given.', 'Send a name, description or validity.');
    await tx.execute(sql`
      update leave_policy set name = ${p.name ?? cur.name},
             description = case when ${p.description === undefined} then description else ${p.description ?? null} end,
             is_valid = ${p.isValid ?? cur.is_valid}, changed_by = ${actor}, changed_at = now()
       where client = ${p.client} and code = ${p.code}
    `);
    await recordChange(tx, {
      client: p.client, objectClass: 'leave_policy', objectKey: p.code, changeType: 'CHANGE', changedBy: actor,
      before: { name: cur.name, isValid: cur.is_valid }, after: { name: p.name ?? cur.name, isValid: p.isValid ?? cur.is_valid },
    });
  });
  return getPolicy(p.client, p.code, access);
}

// ── groups and membership ────────────────────────────────────────────────────
const groupInput = z.object({ client: clientF, code: codeF, name: text(60), description: z.string().trim().max(200).nullish(), changedBy: actorF });
export async function defineLeaveGroup(input: unknown, access: LeaveAccess | undefined): Promise<void> {
  const p = parse(groupInput, input);
  await withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_ASSIGN]);
    const actor = actorOf(grant, p.changedBy);
    const [standing] = (await tx.execute(sql`select 1 as x from leave_group where client = ${p.client} and code = ${p.code}`)) as unknown as unknown[];
    if (standing) refuse('GROUP_EXISTS', `Group ${p.code} already exists.`, 'Choose another code.');
    await tx.execute(sql`insert into leave_group (client, code, name, description, created_by) values (${p.client}, ${p.code}, ${p.name}, ${p.description ?? null}, ${actor})`);
    await recordChange(tx, { client: p.client, objectClass: 'leave_group', objectKey: p.code, changeType: 'CREATE', changedBy: actor, after: { name: p.name } });
  });
}

/** Earliest day on which a new/ended interval of this employee may start without rewriting a posted month. */
async function assertNoPostedAccrualOnOrAfter(tx: Tx, client: string, personnelNumber: string, day: string, what: string): Promise<void> {
  const [row] = (await tx.execute(sql`
    select max(effective_date)::text as last from leave_ledger
     where client = ${client} and personnel_number = ${personnelNumber} and entry_kind in ('MONTHLY_ACCRUAL', 'ANNUAL_GRANT')
  `)) as unknown as Array<{ last: string | null }>;
  if (row?.last && day.slice(0, 7) <= row.last.slice(0, 7)) {
    refuse('CHANGE_AFFECTS_POSTED', `${what} would take effect in ${day.slice(0, 7)}, but credits for ${personnelNumber} are already posted through ${row.last}.`, 'Start in a month with no posted accrual, or correct the earlier months with a quota adjustment (an auditable ledger entry).');
  }
}

const memberInput = z.object({ client: clientF, groupCode: codeF, personnelNumber: personF, validFrom: dayF, validTo: optDay, changedBy: actorF });
export async function addGroupMember(input: unknown, access: LeaveAccess | undefined): Promise<string> {
  const p = parse(memberInput, input);
  if (p.validTo && p.validTo < p.validFrom) refuse('SPAN_ORDER', 'The end date is before the start date.', 'Write the end on or after the start.');
  const id = randomUUID();
  await withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_ASSIGN]);
    const actor = actorOf(grant, p.changedBy);
    await assertReachesEmployee(tx, p.client, grant, p.personnelNumber, p.validFrom, p.validTo ?? p.validFrom);
    const [g] = (await tx.execute(sql`select is_valid from leave_group where client = ${p.client} and code = ${p.groupCode}`)) as unknown as Array<{ is_valid: boolean }>;
    if (!g) refuse('GROUP_UNKNOWN', `Group ${p.groupCode} does not exist.`, 'Define it first.');
    if (!g.is_valid) refuse('GROUP_RETIRED', `Group ${p.groupCode} is retired.`, 'Use a valid group.');
    const [e] = (await tx.execute(sql`select is_active from employee where client = ${p.client} and personnel_number = ${p.personnelNumber}`)) as unknown as Array<{ is_active: boolean }>;
    if (!e) refuse('EMPLOYEE_UNKNOWN', `Employee ${p.personnelNumber} is not available to you.`, 'Check the personnel number.');
    if (!e.is_active) refuse('EMPLOYEE_INACTIVE', `Employee ${p.personnelNumber} is inactive.`, 'Reactivate the employee, or record the membership only for dates they were active.');
    await assertNoPostedAccrualOnOrAfter(tx, p.client, p.personnelNumber, p.validFrom, 'This membership');
    try {
      await tx.execute(sql`
        insert into leave_group_member (client, id, group_code, personnel_number, valid_from, valid_to, created_by)
        values (${p.client}, ${id}, ${p.groupCode}, ${p.personnelNumber}, ${p.validFrom}, ${p.validTo}, ${actor})
      `);
    } catch (e2) {
      const pe = pgError(e2);
      if (pe.code === '23P01') refuse('MEMBERSHIP_OVERLAP', `Employee ${p.personnelNumber} already belongs to a leave group in that interval.`, 'End the existing membership first. A person is in one leave group at a time, so a group policy is never ambiguous.');
      throw e2;
    }
    await recordChange(tx, { client: p.client, objectClass: 'leave_group_member', objectKey: `${p.groupCode}/${p.personnelNumber}/${p.validFrom}`, changeType: 'CREATE', changedBy: actor, after: { validFrom: p.validFrom, validTo: p.validTo } });
  });
  return id;
}

const endInput = z.object({ client: clientF, id: z.string().trim().min(8).max(36), validTo: dayF, changedBy: actorF });
export async function endGroupMember(input: unknown, access: LeaveAccess | undefined): Promise<void> {
  const p = parse(endInput, input);
  await withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_ASSIGN]);
    const actor = actorOf(grant, p.changedBy);
    const [m] = (await tx.execute(sql`
      select personnel_number, group_code, valid_from::text as valid_from, valid_to::text as valid_to
        from leave_group_member where client = ${p.client} and id = ${p.id} for update
    `)) as unknown as Array<{ personnel_number: string; group_code: string; valid_from: string; valid_to: string | null }>;
    if (!m) refuse('MEMBERSHIP_UNKNOWN', 'No such membership.', 'Pick one from the group list.');
    await assertReachesEmployee(tx, p.client, grant, m.personnel_number, m.valid_from, m.valid_to ?? p.validTo);
    if (p.validTo < m.valid_from) refuse('SPAN_ORDER', 'The end date is before the membership start.', 'Write the end on or after the start.');
    await assertNoPostedAccrualOnOrAfter(tx, p.client, m.personnel_number, addDays(p.validTo, 1), 'Ending this membership');
    await tx.execute(sql`update leave_group_member set valid_to = ${p.validTo}, changed_by = ${actor}, changed_at = now() where client = ${p.client} and id = ${p.id}`);
    await recordChange(tx, { client: p.client, objectClass: 'leave_group_member', objectKey: `${m.group_code}/${m.personnel_number}/${m.valid_from}`, changeType: 'CHANGE', changedBy: actor, before: { validTo: m.valid_to }, after: { validTo: p.validTo } });
  });
}

// ── assignment ───────────────────────────────────────────────────────────────
const assignInput = z.object({
  client: clientF,
  subjectKind: z.enum(['GROUP', 'PERSON'], { message: 'SUBJECT_KIND' }),
  subject: z.string().trim().toUpperCase().min(2).max(20),
  policyCode: codeF,
  validFrom: dayF,
  validTo: optDay,
  changedBy: actorF,
});
export async function assignLeavePolicy(input: unknown, access: LeaveAccess | undefined): Promise<string> {
  const p = parse(assignInput, input);
  if (p.validTo && p.validTo < p.validFrom) refuse('SPAN_ORDER', 'The end date is before the start date.', 'Write the end on or after the start.');
  const id = randomUUID();
  await withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_ASSIGN]);
    const actor = actorOf(grant, p.changedBy);
    const [pol] = (await tx.execute(sql`
      select p.is_valid, (select min(valid_from)::text from leave_policy_version v where v.client = p.client and v.policy_code = p.code) as first_from
        from leave_policy p where p.client = ${p.client} and p.code = ${p.policyCode}
    `)) as unknown as Array<{ is_valid: boolean; first_from: string | null }>;
    if (!pol) refuse('POLICY_UNKNOWN', `Policy ${p.policyCode} does not exist.`, 'Define it on the configuration screen.');
    if (!pol.is_valid) refuse('POLICY_RETIRED', `Policy ${p.policyCode} is retired.`, 'Use a valid policy.');
    if (!pol.first_from || p.validFrom < pol.first_from) {
      refuse('BEFORE_FIRST_VERSION', `Policy ${p.policyCode} has no version before ${pol.first_from}.`, 'Start the assignment on or after the policy\'s first version.');
    }
    let members: string[] = [];
    if (p.subjectKind === 'PERSON') {
      await assertReachesEmployee(tx, p.client, grant, p.subject, p.validFrom, p.validTo ?? p.validFrom);
      const [e] = (await tx.execute(sql`select is_active from employee where client = ${p.client} and personnel_number = ${p.subject}`)) as unknown as Array<{ is_active: boolean }>;
      if (!e) refuse('EMPLOYEE_UNKNOWN', `Employee ${p.subject} is not available to you.`, 'Check the personnel number.');
      if (!e.is_active) refuse('EMPLOYEE_INACTIVE', `Employee ${p.subject} is inactive.`, 'Reactivate the employee first.');
      members = [p.subject];
    } else {
      const [g] = (await tx.execute(sql`select is_valid from leave_group where client = ${p.client} and code = ${p.subject}`)) as unknown as Array<{ is_valid: boolean }>;
      if (!g) refuse('GROUP_UNKNOWN', `Group ${p.subject} does not exist.`, 'Define it first.');
      if (!g.is_valid) refuse('GROUP_RETIRED', `Group ${p.subject} is retired.`, 'Use a valid group.');
      const rows = (await tx.execute(sql`
        select distinct personnel_number from leave_group_member
         where client = ${p.client} and group_code = ${p.subject}
           and valid_from <= coalesce(${p.validTo}::date, date '9999-12-31') and coalesce(valid_to, date '9999-12-31') >= ${p.validFrom}::date
      `)) as unknown as Array<{ personnel_number: string }>;
      members = rows.map((r) => r.personnel_number);
      // A scoped caller may only assign a policy to a group whose members all lie inside their scope.
      for (const m of members) await assertReachesEmployee(tx, p.client, grant, m, p.validFrom, p.validTo ?? p.validFrom);
    }
    for (const m of members) await assertNoPostedAccrualOnOrAfter(tx, p.client, m, p.validFrom, 'This assignment');
    try {
      await tx.execute(sql`
        insert into leave_policy_assignment (client, id, subject_kind, group_code, personnel_number, policy_code, valid_from, valid_to, created_by)
        values (${p.client}, ${id}, ${p.subjectKind}, ${p.subjectKind === 'GROUP' ? p.subject : null}, ${p.subjectKind === 'PERSON' ? p.subject : null},
                ${p.policyCode}, ${p.validFrom}, ${p.validTo}, ${actor})
      `);
    } catch (e2) {
      if (pgError(e2).code === '23P01') {
        refuse('ASSIGNMENT_OVERLAP', `${p.subjectKind === 'GROUP' ? 'Group' : 'Employee'} ${p.subject} already has a leave policy in that interval.`, 'End the standing assignment first. (A direct employee assignment may overlap its group\'s: it overrides it. Two assignments to the same subject may not overlap.)');
      }
      throw e2;
    }
    await recordChange(tx, { client: p.client, objectClass: 'leave_policy_assignment', objectKey: `${p.subjectKind}/${p.subject}/${p.validFrom}`, changeType: 'CREATE', changedBy: actor, after: { policy: p.policyCode, validFrom: p.validFrom, validTo: p.validTo } });
  });
  return id;
}

export async function endLeavePolicyAssignment(input: unknown, access: LeaveAccess | undefined): Promise<void> {
  const p = parse(endInput, input);
  await withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_ASSIGN]);
    const actor = actorOf(grant, p.changedBy);
    const [a] = (await tx.execute(sql`
      select subject_kind, group_code, personnel_number, policy_code, valid_from::text as valid_from, valid_to::text as valid_to
        from leave_policy_assignment where client = ${p.client} and id = ${p.id} for update
    `)) as unknown as Array<{ subject_kind: string; group_code: string | null; personnel_number: string | null; policy_code: string; valid_from: string; valid_to: string | null }>;
    if (!a) refuse('ASSIGNMENT_UNKNOWN', 'No such assignment.', 'Pick one from the list.');
    if (p.validTo < a.valid_from) refuse('SPAN_ORDER', 'The end date is before the assignment start.', 'Write the end on or after the start.');
    const people = a.personnel_number ? [a.personnel_number] : ((await tx.execute(sql`
      select distinct personnel_number from leave_group_member where client = ${p.client} and group_code = ${a.group_code}
    `)) as unknown as Array<{ personnel_number: string }>).map((r) => r.personnel_number);
    for (const m of people) {
      await assertReachesEmployee(tx, p.client, grant, m, a.valid_from, a.valid_to ?? p.validTo);
      await assertNoPostedAccrualOnOrAfter(tx, p.client, m, addDays(p.validTo, 1), 'Ending this assignment');
    }
    await tx.execute(sql`update leave_policy_assignment set valid_to = ${p.validTo}, changed_by = ${actor}, changed_at = now() where client = ${p.client} and id = ${p.id}`);
    await recordChange(tx, { client: p.client, objectClass: 'leave_policy_assignment', objectKey: `${a.subject_kind}/${a.group_code ?? a.personnel_number}/${a.valid_from}`, changeType: 'CHANGE', changedBy: actor, before: { validTo: a.valid_to }, after: { validTo: p.validTo } });
  });
}

// ── resolution ───────────────────────────────────────────────────────────────
export interface ResolvedLine {
  timeTypeCode: string;
  annualScaled: bigint;
  accrualMode: 'MONTHLY' | 'ANNUAL_UPFRONT';
  fallbackTypeCode: string | null;
}
export interface ResolvedSegment {
  from: string;
  to: string;
  policyCode: string;
  version: number;
  partialMonthMode: PartialMonthMode;
  source: 'PERSON' | 'GROUP';
  groupCode: string | null;
  assignmentId: string;
  lines: Map<string, ResolvedLine>;
}

const FAR = '9999-12-31';

/**
 * Which policy (and version) applies to a person on each day of [from, to]. Direct person assignment
 * beats group assignment; gaps stay gaps. Pure read: no authority check — callers judge first.
 */
export async function resolveLeaveSegments(tx: Tx, client: string, personnelNumber: string, from: string, to: string): Promise<ResolvedSegment[]> {
  type Iv = { id: string; from: string; to: string | null; policy: string; group: string | null };
  const persons = (await tx.execute(sql`
    select id, policy_code as policy, valid_from::text as "from", valid_to::text as "to"
      from leave_policy_assignment
     where client = ${client} and subject_kind = 'PERSON' and personnel_number = ${personnelNumber}
       and valid_from <= ${to}::date and coalesce(valid_to, date '9999-12-31') >= ${from}::date
  `)) as unknown as Iv[];
  const groups = (await tx.execute(sql`
    select a.id, a.policy_code as policy, m.group_code as "group",
           greatest(a.valid_from, m.valid_from)::text as "from",
           case when a.valid_to is null then m.valid_to
                when m.valid_to is null then a.valid_to
                else least(a.valid_to, m.valid_to) end::text as "to"
      from leave_group_member m
      join leave_policy_assignment a on a.client = m.client and a.subject_kind = 'GROUP' and a.group_code = m.group_code
     where m.client = ${client} and m.personnel_number = ${personnelNumber}
       and greatest(a.valid_from, m.valid_from) <= ${to}::date
       and coalesce(least(a.valid_to, m.valid_to), a.valid_to, m.valid_to, date '9999-12-31') >= ${from}::date
       and greatest(a.valid_from, m.valid_from) <= coalesce(least(a.valid_to, m.valid_to), a.valid_to, m.valid_to, date '9999-12-31')
  `)) as unknown as Iv[];
  if (persons.length + groups.length === 0) return [];
  const policyList = [...new Set([...persons, ...groups].map((i) => i.policy))];
  const versions = (await tx.execute(sql`
    select v.policy_code, v.version, v.valid_from::text as valid_from, v.partial_month_mode
      from leave_policy_version v
     where v.client = ${client} and v.policy_code in (${sql.join(policyList.map((x) => sql`${x}`), sql`, `)})
     order by v.policy_code, v.valid_from
  `)) as unknown as Array<{ policy_code: string; version: number; valid_from: string; partial_month_mode: PartialMonthMode }>;

  const bounds = new Set<string>([from]);
  for (const i of [...persons, ...groups]) {
    if (i.from > from && i.from <= to) bounds.add(i.from);
    if (i.to && i.to >= from && addDays(i.to, 1) <= to) bounds.add(addDays(i.to, 1));
  }
  for (const v of versions) if (v.valid_from > from && v.valid_from <= to) bounds.add(v.valid_from);
  const starts = [...bounds].sort();

  const lineCache = new Map<string, Map<string, ResolvedLine>>();
  const linesOf = async (policy: string, version: number) => {
    const key = `${policy}/${version}`;
    if (!lineCache.has(key)) {
      const rows = (await tx.execute(sql`
        select time_type_code, annual_days::text as annual_days, accrual_mode, fallback_type_code
          from leave_policy_line where client = ${client} and policy_code = ${policy} and version = ${version}
      `)) as unknown as Array<{ time_type_code: string; annual_days: string; accrual_mode: 'MONTHLY' | 'ANNUAL_UPFRONT'; fallback_type_code: string | null }>;
      lineCache.set(key, new Map(rows.map((r) => [r.time_type_code, {
        timeTypeCode: r.time_type_code, annualScaled: toScaled(r.annual_days), accrualMode: r.accrual_mode, fallbackTypeCode: r.fallback_type_code,
      }])));
    }
    return lineCache.get(key)!;
  };

  const out: ResolvedSegment[] = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k]!;
    const e = k + 1 < starts.length ? addDays(starts[k + 1]!, -1) : to;
    const covers = (i: Iv) => i.from <= s && (i.to ?? FAR) >= s;
    const direct = persons.filter(covers);
    const viaGroup = groups.filter(covers);
    if (direct.length > 1 || (direct.length === 0 && viaGroup.length > 1)) {
      refuse('AMBIGUOUS_POLICY', `Employee ${personnelNumber} has more than one applicable leave policy on ${s}.`, 'End one of the overlapping assignments or memberships.');
    }
    const pick = direct[0] ?? viaGroup[0];
    if (!pick) continue;
    const vs = versions.filter((v) => v.policy_code === pick.policy && v.valid_from <= s);
    const ver = vs[vs.length - 1];
    if (!ver) continue; // before the policy's first version: no entitlement, never invented
    const seg: ResolvedSegment = {
      from: s, to: e, policyCode: pick.policy, version: ver.version, partialMonthMode: ver.partial_month_mode,
      source: direct[0] ? 'PERSON' : 'GROUP', groupCode: direct[0] ? null : pick.group, assignmentId: pick.id,
      lines: await linesOf(pick.policy, ver.version),
    };
    const prev = out[out.length - 1];
    if (prev && prev.policyCode === seg.policyCode && prev.version === seg.version && prev.assignmentId === seg.assignmentId
      && dayNumber(prev.to) + 1 === dayNumber(seg.from)) prev.to = seg.to;
    else out.push(seg);
  }
  return out;
}

// ── reads ────────────────────────────────────────────────────────────────────
async function loadPolicies(tx: Tx, client: string, code?: string): Promise<PolicyView[]> {
  const heads = (await tx.execute(sql`
    select code, name, description, is_valid from leave_policy
     where client = ${client} ${code ? sql`and code = ${code}` : sql``} order by code
  `)) as unknown as Array<{ code: string; name: string; description: string | null; is_valid: boolean }>;
  const vers = (await tx.execute(sql`
    select policy_code, version, valid_from::text as valid_from, partial_month_mode, day_count_mode, year_end_mode
      from leave_policy_version where client = ${client} ${code ? sql`and policy_code = ${code}` : sql``} order by policy_code, version
  `)) as unknown as Array<{ policy_code: string; version: number; valid_from: string; partial_month_mode: PartialMonthMode; day_count_mode: string; year_end_mode: string }>;
  const lines = (await tx.execute(sql`
    select policy_code, version, time_type_code, annual_days::text as annual_days, accrual_mode, fallback_type_code
      from leave_policy_line where client = ${client} ${code ? sql`and policy_code = ${code}` : sql``} order by policy_code, version, time_type_code
  `)) as unknown as Array<{ policy_code: string; version: number; time_type_code: string; annual_days: string; accrual_mode: 'MONTHLY' | 'ANNUAL_UPFRONT'; fallback_type_code: string | null }>;
  return heads.map((h) => ({
    code: h.code, name: h.name, description: h.description, isValid: h.is_valid,
    versions: vers.filter((v) => v.policy_code === h.code).map((v) => ({
      version: v.version, validFrom: v.valid_from, partialMonthMode: v.partial_month_mode,
      dayCountMode: v.day_count_mode, yearEndMode: v.year_end_mode,
      lines: lines.filter((l) => l.policy_code === h.code && l.version === v.version).map((l) => ({
        timeTypeCode: l.time_type_code, annualDays: fromScaled(toScaled(l.annual_days)), accrualMode: l.accrual_mode, fallbackTypeCode: l.fallback_type_code,
      })),
    })),
  }));
}

export async function getPolicy(client: string, code: string, access: LeaveAccess | undefined): Promise<PolicyView> {
  const c = parse(clientF, client);
  return withTenant(c, async (tx) => {
    await judgeLeave(tx, c, access, [LEAVE_CONFIGURE, LEAVE_ASSIGN]);
    const [p] = await loadPolicies(tx, c, parse(codeF, code));
    if (!p) refuse('POLICY_UNKNOWN', `Policy ${code} does not exist.`, 'Define it first.');
    return p;
  });
}

export async function listLeavePolicies(client: string, access: LeaveAccess | undefined): Promise<PolicyView[]> {
  const c = parse(clientF, client);
  return withTenant(c, async (tx) => {
    await judgeLeave(tx, c, access, [LEAVE_CONFIGURE, LEAVE_ASSIGN]);
    return loadPolicies(tx, c);
  });
}

export async function listLeaveGroups(client: string, access: LeaveAccess | undefined): Promise<GroupView[]> {
  const c = parse(clientF, client);
  return withTenant(c, async (tx) => {
    const grant = await judgeLeave(tx, c, access, [LEAVE_ASSIGN, LEAVE_CONFIGURE]);
    const groups = (await tx.execute(sql`select code, name, description, is_valid from leave_group where client = ${c} order by code`)) as unknown as Array<{ code: string; name: string; description: string | null; is_valid: boolean }>;
    const members = (await tx.execute(sql`
      select m.id, m.group_code, m.personnel_number, e.full_name, m.valid_from::text as valid_from, m.valid_to::text as valid_to
        from leave_group_member m join employee e on e.client = m.client and e.personnel_number = m.personnel_number
       where m.client = ${c} order by m.group_code, m.personnel_number, m.valid_from
    `)) as unknown as Array<{ id: string; group_code: string; personnel_number: string; full_name: string; valid_from: string; valid_to: string | null }>;
    const visible = new Map<string, boolean>();
    for (const m of members) {
      const k = `${m.personnel_number}/${m.valid_from}/${m.valid_to ?? ''}`;
      if (!visible.has(k)) visible.set(k, await reachesEmployee(tx, c, grant, m.personnel_number, m.valid_from, m.valid_to ?? m.valid_from));
    }
    return groups.map((g) => {
      const all = members.filter((m) => m.group_code === g.code);
      const seen = all.filter((m) => visible.get(`${m.personnel_number}/${m.valid_from}/${m.valid_to ?? ''}`));
      return {
        code: g.code, name: g.name, description: g.description, isValid: g.is_valid,
        members: seen.map((m) => ({ id: m.id, personnelNumber: m.personnel_number, employeeName: m.full_name, validFrom: m.valid_from, validTo: m.valid_to })),
        hiddenMembers: all.length - seen.length,
      };
    });
  });
}

export async function listLeaveAssignments(client: string, access: LeaveAccess | undefined): Promise<AssignmentView[]> {
  const c = parse(clientF, client);
  return withTenant(c, async (tx) => {
    const grant = await judgeLeave(tx, c, access, [LEAVE_ASSIGN, LEAVE_CONFIGURE]);
    const rows = (await tx.execute(sql`
      select a.id, a.subject_kind, a.group_code, a.personnel_number, e.full_name, a.policy_code,
             a.valid_from::text as valid_from, a.valid_to::text as valid_to
        from leave_policy_assignment a
        left join employee e on e.client = a.client and e.personnel_number = a.personnel_number
       where a.client = ${c} order by a.subject_kind, coalesce(a.group_code, a.personnel_number), a.valid_from
    `)) as unknown as Array<{ id: string; subject_kind: 'GROUP' | 'PERSON'; group_code: string | null; personnel_number: string | null; full_name: string | null; policy_code: string; valid_from: string; valid_to: string | null }>;
    const out: AssignmentView[] = [];
    for (const r of rows) {
      if (r.personnel_number && !(await reachesEmployee(tx, c, grant, r.personnel_number, r.valid_from, r.valid_to ?? r.valid_from))) continue;
      out.push({ id: r.id, subjectKind: r.subject_kind, groupCode: r.group_code, personnelNumber: r.personnel_number, employeeName: r.full_name, policyCode: r.policy_code, validFrom: r.valid_from, validTo: r.valid_to });
    }
    return out;
  });
}

export type { LeaveGrant };
export { LEAVE_VIEW };
