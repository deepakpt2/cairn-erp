/**
 * Absence requests against the leave ledger: preview, request, approve, reject, cancel.
 *
 * - **Policy-managed absence.** When a leave policy covers every day of the request and the policy has a
 *   line for the requested type, the days are charged to that type's balance and, for what it cannot cover,
 *   to its configured fallback (annual → the shared unpaid balance). The split is computed here, shown by
 *   `previewAbsence`, confirmed by the requester when any day is unpaid, rechecked and enforced at approval
 *   under the per-employee lock, and kept as `absence_allocation` rows + immutable ledger debits.
 * - **Balance rule.** A day is covered only by a whole day of balance that is already earned: credits count
 *   up to today (tenant timezone); every debit counts whatever its date, so two future leaves cannot spend
 *   the same day. No future unearned month funds a request.
 * - **Legacy absence.** An employee with no policy over the span keeps the old behaviour (hand-set quota,
 *   `time_type.is_paid`). `policy_managed` is false on those rows and payroll reads them as before.
 * - **Authority.** Every service judges its caller in its own transaction (leave-access) and checks that the
 *   caller reaches the employee. Request needs PEOPLE.TIME.ENTER; approve/reject/cancel-approved need
 *   PEOPLE.LEAVE.APPROVE.
 */
import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  LEAVE_APPROVE, LEAVE_ENTER, LEAVE_VIEW, type LeaveAccess, actorOf, assertReachesEmployee, judgeLeave, refuse,
} from './leave-access';
import { tenantToday } from './leave-accrual';
import { lockEmployeeLeave, postLedgerEntry } from './leave-ledger';
import {
  type AllocRange, type AllocSpan, SCALE, addDays, allocate, dayNumber, fromScaled, isoOf, toScaled,
} from './leave-math';
import { resolveLeaveSegments } from './leave-policy';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const upper = z.string().transform((s) => s.trim().toUpperCase());
const day = z.string().trim().refine((s) => DAY.test(s) && isoOf(dayNumber(s)) === s, { message: 'DATE_FORMAT' });
const ref = z.object({
  client: upper.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/)),
  absenceId: z.string().trim().min(1).max(36).optional(),
  personnelNumber: upper.pipe(z.string().regex(/^[A-Z0-9]{2,20}$/)).optional(),
  timeTypeCode: upper.pipe(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/)).optional(),
  validFrom: day.optional(),
});
const requestSchema = z.object({
  client: upper.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/)),
  personnelNumber: upper.pipe(z.string().regex(/^[A-Z0-9]{2,20}$/)),
  timeTypeCode: upper.pipe(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/)),
  validFrom: day,
  validTo: day.optional(),
  reason: z.string().trim().max(200).nullable().optional(),
  changedBy: z.string().trim().max(60).optional(),
  requestKey: z.string().trim().min(8).max(64).optional(),
  /** The unpaid days the requester saw in the preview and accepts. Required whenever the split has unpaid days. */
  confirmUnpaidDays: z.union([z.number(), z.string()]).optional(),
});
const decideSchema = ref.extend({
  changedBy: z.string().trim().max(60).optional(),
  /** Needed at approval when the unpaid days have grown since the requester confirmed. */
  confirmUnpaidDays: z.union([z.number(), z.string()]).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const i = r.error.issues[0];
    refuse(String(i?.message) === 'DATE_FORMAT' ? 'DATE_FORMAT' : 'INVALID_INPUT', `The absence input is not valid${i ? ` (${i.path.join('.') || 'input'}: ${i.message})` : ''}.`);
  }
  return r.data;
}

// ── planning ─────────────────────────────────────────────────────────────────
export interface PlannedSpan extends AllocSpan { typeName: string }
export interface AbsencePlan {
  /** False: no policy governs the request; the legacy rules apply. */
  managed: boolean;
  policyCode: string | null;
  spans: PlannedSpan[];
  paidDays: number;
  unpaidDays: number;
  uncovered: string[];
  requiresConfirmation: boolean;
  /** What each balance in the chain can give for the request's years, in days. */
  available: Array<{ typeCode: string; year: number; days: string }>;
}

interface TypeRow { code: string; name: string; isPaid: boolean; reducesQuota: boolean; isValid: boolean }

async function typesOf(tx: Tx, client: string): Promise<Map<string, TypeRow>> {
  const rows = (await tx.execute(sql`
    select code, name, is_paid, reduces_quota, is_valid from time_type where client = ${client}
  `)) as unknown as Array<{ code: string; name: string; is_paid: boolean; reduces_quota: boolean; is_valid: boolean }>;
  return new Map(rows.map((r) => [r.code, { code: r.code, name: r.name, isPaid: r.is_paid, reducesQuota: r.reduces_quota, isValid: r.is_valid }]));
}

/** Plan an absence over [from, to] for one employee. Pure read; the caller holds the lock when it will write. */
export async function planAbsence(
  tx: Tx, client: string, personnelNumber: string, typeCode: string, from: string, to: string, today: string,
): Promise<AbsencePlan> {
  const types = await typesOf(tx, client);
  const type = types.get(typeCode);
  if (!type) refuse('TIME_TYPE_UNKNOWN', `Time type ${typeCode} does not exist.`, 'Pick a time type from the configured list.');
  const segments = await resolveLeaveSegments(tx, client, personnelNumber, from, to);
  const none: AbsencePlan = { managed: false, policyCode: null, spans: [], paidDays: 0, unpaidDays: 0, uncovered: [], requiresConfirmation: false, available: [] };
  if (segments.length === 0 || !type.reducesQuota) return none;

  // Every day must be inside a policy segment that has a line for the type; a half-covered request is ambiguous.
  const ranges: AllocRange[] = [];
  let covered = 0;
  for (const seg of segments) {
    const a = seg.from > from ? seg.from : from;
    const b = seg.to < to ? seg.to : to;
    if (a > b) continue;
    covered += dayNumber(b) - dayNumber(a) + 1;
    const line = seg.lines.get(typeCode);
    if (!line) {
      refuse('TYPE_NOT_IN_POLICY', `Policy ${seg.policyCode} (version ${seg.version}) has no line for ${typeCode} from ${a}.`,
        `Add a ${typeCode} line to the policy or pick a type the policy grants.`);
    }
    const chain: Array<{ typeCode: string; isPaid: boolean }> = [];
    const seen = new Set<string>();
    for (let c: string | null = typeCode; c && !seen.has(c); ) {
      seen.add(c);
      chain.push({ typeCode: c, isPaid: types.get(c)?.isPaid ?? true });
      c = seg.lines.get(c)?.fallbackTypeCode ?? null;
    }
    ranges.push({ from: a, to: b, policyCode: seg.policyCode, policyVersion: seg.version, chain });
  }
  const wanted = dayNumber(to) - dayNumber(from) + 1;
  if (covered !== wanted) {
    refuse('POLICY_GAP', `A leave policy covers only ${covered} of the ${wanted} days of this request.`,
      'Split the request at the day the policy starts or ends, or fix the policy assignment.');
  }

  const chainTypes = [...new Set(ranges.flatMap((r) => r.chain.map((s) => s.typeCode)))];
  const years = [...new Set([Number(from.slice(0, 4)), Number(to.slice(0, 4))])];
  const legacy = (await tx.execute(sql`
    select time_type_code as type, year from leave_quota
     where client = ${client} and personnel_number = ${personnelNumber} and mode = 'LEGACY'
       and time_type_code in (${sql.join(chainTypes.map((t) => sql`${t}`), sql`, `)}) and year in (${sql.join(years.map((y) => sql`${y}`), sql`, `)})
  `)) as unknown as Array<{ type: string; year: number }>;
  if (legacy.length > 0) {
    refuse('QUOTA_LEGACY', `The ${legacy[0]!.type} balance for ${legacy[0]!.year} is still a legacy quota.`, 'Convert the legacy balances first (cutover preview), then request again.');
  }
  const rows = (await tx.execute(sql`
    select time_type_code as type, year,
           coalesce(sum(quantity) filter (where effective_date <= ${today}::date or entry_kind in ('ABSENCE_DEBIT', 'REVERSAL')), 0) * 100 as scaled
      from leave_ledger
     where client = ${client} and personnel_number = ${personnelNumber}
       and time_type_code in (${sql.join(chainTypes.map((t) => sql`${t}`), sql`, `)}) and year in (${sql.join(years.map((y) => sql`${y}`), sql`, `)})
     group by time_type_code, year
  `)) as unknown as Array<{ type: string; year: number; scaled: string }>;
  const remaining = new Map<string, bigint>();
  for (const r of rows) remaining.set(`${r.type}/${r.year}`, BigInt(String(r.scaled).split('.')[0]!));
  const result = allocate(ranges, remaining);

  const spans: PlannedSpan[] = result.spans.map((s) => ({ ...s, typeName: types.get(s.typeCode)?.name ?? s.typeCode }));
  const paid = spans.filter((s) => s.isPaid).reduce((n, s) => n + s.days, 0);
  const unpaid = spans.filter((s) => !s.isPaid).reduce((n, s) => n + s.days, 0);
  return {
    managed: true,
    policyCode: ranges[0]!.policyCode,
    spans, paidDays: paid, unpaidDays: unpaid, uncovered: result.uncovered,
    requiresConfirmation: unpaid > 0,
    available: [...remaining.entries()].map(([k, v]) => {
      const [t, y] = k.split('/');
      return { typeCode: t!, year: Number(y), days: fromScaled(v) };
    }),
  };
}

function fingerprint(parts: Array<string | number | null>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function describe(plan: AbsencePlan): string {
  return plan.spans.map((s) => `${s.days} ${s.isPaid ? 'paid' : 'unpaid'} (${s.typeCode}${s.from === s.to ? ` ${s.from}` : ` ${s.from}–${s.to}`})`).join(', ');
}

function sameDays(value: number | string | undefined, days: number): boolean {
  if (value === undefined || value === '') return false;
  try { return toScaled(String(value)) === BigInt(days) * SCALE; } catch { return false; }
}

// ── preview ──────────────────────────────────────────────────────────────────
const previewSchema = z.object({
  client: upper.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/)),
  personnelNumber: upper.pipe(z.string().regex(/^[A-Z0-9]{2,20}$/)),
  timeTypeCode: upper.pipe(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/)),
  validFrom: day,
  validTo: day.optional(),
});
export type PreviewAbsenceInput = z.input<typeof previewSchema>;

/** The paid/unpaid split a request would get right now. Writes nothing. */
export async function previewAbsence(input: PreviewAbsenceInput, access: LeaveAccess | undefined, at: Date = new Date()): Promise<AbsencePlan> {
  const p = parse(previewSchema, input);
  const to = p.validTo ?? p.validFrom;
  if (to < p.validFrom) refuse('SPAN_ORDER', 'The end date is before the start date.');
  return withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_ENTER, LEAVE_APPROVE, LEAVE_VIEW]);
    await assertReachesEmployee(tx, p.client, grant, p.personnelNumber, p.validFrom, to);
    const { today } = await tenantToday(tx, p.client, at);
    return planAbsence(tx, p.client, p.personnelNumber, p.timeTypeCode, p.validFrom, to, today);
  });
}

// ── request ──────────────────────────────────────────────────────────────────
export type RequestAbsenceInput = z.input<typeof requestSchema>;
export interface AbsenceOutcome {
  absenceId: string;
  personnelNumber: string;
  timeTypeCode: string;
  validFrom: string;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  managed: boolean;
  unpaidDays: number;
  replayed: boolean;
}

export async function requestLeaveAbsence(input: RequestAbsenceInput, access: LeaveAccess | undefined, at: Date = new Date()): Promise<AbsenceOutcome> {
  const p = parse(requestSchema, input);
  const to = p.validTo ?? null;
  if (to && to < p.validFrom) refuse('SPAN_ORDER', 'The end date is before the start date.');
  return withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_ENTER]);
    await assertReachesEmployee(tx, p.client, grant, p.personnelNumber, p.validFrom, to ?? p.validFrom);
    const actor = actorOf(grant, p.changedBy);
    await lockEmployeeLeave(tx, p.client, p.personnelNumber);

    const emp = (await tx.execute(sql`select is_active from employee where client = ${p.client} and personnel_number = ${p.personnelNumber}`)) as unknown as Array<{ is_active: boolean }>;
    if (!emp[0]) refuse('EMPLOYEE_UNKNOWN', `Employee ${p.personnelNumber} does not exist.`);
    if (emp[0].is_active === false) refuse('EMPLOYEE_INACTIVE', `Employee ${p.personnelNumber} is not active.`);
    const type = (await typesOf(tx, p.client)).get(p.timeTypeCode);
    if (!type) refuse('TIME_TYPE_UNKNOWN', `Time type ${p.timeTypeCode} does not exist.`);
    if (!type.isValid) refuse('TIME_TYPE_RETIRED', `Time type ${p.timeTypeCode} is retired.`);

    const print = fingerprint([p.client, p.personnelNumber, p.timeTypeCode, p.validFrom, to, p.reason ?? null, p.confirmUnpaidDays === undefined ? null : String(p.confirmUnpaidDays)]);
    if (p.requestKey) {
      const [replay] = (await tx.execute(sql`
        select id, time_type_code, valid_from::text as valid_from, status, policy_managed, confirmed_unpaid_days::text as unpaid, request_fingerprint
          from absence where client = ${p.client} and personnel_number = ${p.personnelNumber} and request_key = ${p.requestKey}
      `)) as unknown as Array<{ id: string; time_type_code: string; valid_from: string; status: AbsenceOutcome['status']; policy_managed: boolean; unpaid: string | null; request_fingerprint: string | null }>;
      if (replay) {
        if (replay.request_fingerprint !== print) {
          refuse('REQUEST_KEY_REUSED', 'That request key was already used for a different absence request.', 'Use a new request key, or repeat the original request unchanged.');
        }
        return {
          absenceId: replay.id, personnelNumber: p.personnelNumber, timeTypeCode: replay.time_type_code, validFrom: replay.valid_from,
          status: replay.status, managed: replay.policy_managed, unpaidDays: Number(replay.unpaid ?? 0), replayed: true,
        };
      }
    }

    const end = to ?? '9999-12-31';
    const clash = (await tx.execute(sql`
      select valid_from::text as valid_from, valid_to::text as valid_to, time_type_code, status from absence
       where client = ${p.client} and personnel_number = ${p.personnelNumber} and status in ('REQUESTED', 'APPROVED')
         and valid_from <= ${end}::date and coalesce(valid_to, date '9999-12-31') >= ${p.validFrom}::date
       limit 1
    `)) as unknown as Array<{ valid_from: string; valid_to: string | null; time_type_code: string; status: string }>;
    if (clash[0]) {
      refuse('OVERLAP', `The ${clash[0].status.toLowerCase()} absence ${clash[0].time_type_code} from ${clash[0].valid_from} to ${clash[0].valid_to ?? 'open'} already covers part of this request.`,
        'Pick dates that do not overlap, or cancel the other request first.');
    }
    const taken = (await tx.execute(sql`
      select status from absence where client = ${p.client} and personnel_number = ${p.personnelNumber}
         and time_type_code = ${p.timeTypeCode} and valid_from = ${p.validFrom}::date
    `)) as unknown as Array<{ status: string }>;
    if (taken[0]) {
      refuse('START_TAKEN', `A ${taken[0].status.toLowerCase()} ${p.timeTypeCode} absence already starts on ${p.validFrom}.`,
        'Start the new request on a different day.');
    }

    const { today } = await tenantToday(tx, p.client, at);
    let unpaid = 0;
    let managed = false;
    if (to) {
      const plan = await planAbsence(tx, p.client, p.personnelNumber, p.timeTypeCode, p.validFrom, to, today);
      managed = plan.managed;
      if (plan.managed) {
        if (plan.uncovered.length > 0) {
          refuse('INSUFFICIENT_BALANCE', `${plan.uncovered.length} day(s) are covered by no balance (first: ${plan.uncovered[0]}). Only earned days count; paid ${plan.paidDays}, unpaid ${plan.unpaidDays}.`,
            'Shorten the request or wait until more leave is earned.');
        }
        unpaid = plan.unpaidDays;
        if (unpaid > 0 && p.confirmUnpaidDays === undefined) {
          refuse('UNPAID_NOT_CONFIRMED', `This request would use ${plan.paidDays} paid and ${unpaid} unpaid day(s): ${describe(plan)}.`,
            `Confirm the ${unpaid} unpaid day(s) to submit it.`);
        }
        if (unpaid > 0 && !sameDays(p.confirmUnpaidDays, unpaid)) {
          refuse('SPLIT_CHANGED', `The split is now ${plan.paidDays} paid and ${unpaid} unpaid day(s), not the ${p.confirmUnpaidDays} unpaid you confirmed.`,
            'Check the new split and confirm it.');
        }
        if (unpaid === 0 && p.confirmUnpaidDays !== undefined && !sameDays(p.confirmUnpaidDays, 0)) {
          refuse('SPLIT_CHANGED', 'The request is now fully paid; the unpaid days you confirmed no longer apply.', 'Check the split and submit again.');
        }
      }
    } else {
      // Open-ended leave cannot be policy-managed; refuse it when a policy would otherwise govern the start day.
      const segs = await resolveLeaveSegments(tx, p.client, p.personnelNumber, p.validFrom, p.validFrom);
      if (segs.length > 0 && type.reducesQuota) refuse('OPEN_END_NOT_ALLOWED', 'A leave request under a leave policy needs an end date.', 'Enter the last day of leave.');
    }

    if (!managed && type.reducesQuota && to) {
      const year = Number(p.validFrom.slice(0, 4));
      const [q] = (await tx.execute(sql`
        select remaining::text as remaining, mode from leave_quota
         where client = ${p.client} and personnel_number = ${p.personnelNumber} and time_type_code = ${p.timeTypeCode} and year = ${year}
      `)) as unknown as Array<{ remaining: string; mode: string }>;
      if (q?.mode === 'POLICY') refuse('QUOTA_POLICY_OWNED', `The ${p.timeTypeCode} balance for ${year} is policy-owned but no policy covers these dates.`, 'Assign the leave policy for these dates first.');
      const need = BigInt(Math.round((dayNumber(to) - dayNumber(p.validFrom) + 1) * 100));
      if (toScaled(q?.remaining ?? '0') < need) refuse('QUOTA_EXCEEDED', `${(Number(need) / 100)} day(s) requested, ${q?.remaining ?? '0'} remaining.`, 'Shorten the request.');
    }

    const id = randomUUID();
    await tx.execute(sql`
      insert into absence (client, id, personnel_number, time_type_code, valid_from, valid_to, status, reason, request_key,
                           policy_managed, confirmed_unpaid_days, request_fingerprint, created_by)
      values (${p.client}, ${id}, ${p.personnelNumber}, ${p.timeTypeCode}, ${p.validFrom}::date, ${to}::date, 'REQUESTED', ${p.reason ?? null}, ${p.requestKey ?? null},
              ${managed}, ${managed ? fromScaled(BigInt(unpaid) * SCALE) : null}::numeric, ${print}, ${actor})
    `);
    await recordChange(tx, {
      client: p.client, objectClass: 'absence', objectKey: `${p.personnelNumber}/${p.timeTypeCode}/${p.validFrom}`, changeType: 'CREATE',
      changedBy: actor, transactionCode: 'PA2001',
      after: { id, personnelNumber: p.personnelNumber, timeTypeCode: p.timeTypeCode, validFrom: p.validFrom, validTo: to, status: 'REQUESTED', policyManaged: managed, unpaidDays: unpaid },
    });
    return { absenceId: id, personnelNumber: p.personnelNumber, timeTypeCode: p.timeTypeCode, validFrom: p.validFrom, status: 'REQUESTED' as const, managed, unpaidDays: unpaid, replayed: false };
  });
}

// ── decide ───────────────────────────────────────────────────────────────────
interface Standing {
  id: string; personnel_number: string; time_type_code: string; valid_from: string; valid_to: string | null;
  status: AbsenceOutcome['status']; policy_managed: boolean; confirmed: string | null;
}

async function standing(tx: Tx, p: z.infer<typeof decideSchema>): Promise<Standing> {
  const rows = (await tx.execute(
    p.absenceId
      ? sql`select id, personnel_number, time_type_code, valid_from::text as valid_from, valid_to::text as valid_to, status, policy_managed, confirmed_unpaid_days::text as confirmed
              from absence where client = ${p.client} and id = ${p.absenceId}`
      : sql`select id, personnel_number, time_type_code, valid_from::text as valid_from, valid_to::text as valid_to, status, policy_managed, confirmed_unpaid_days::text as confirmed
              from absence where client = ${p.client} and personnel_number = ${p.personnelNumber ?? ''} and time_type_code = ${p.timeTypeCode ?? ''} and valid_from = ${p.validFrom ?? '1900-01-01'}::date`,
  )) as unknown as Standing[];
  if (!rows[0]) refuse('ABSENCE_UNKNOWN', 'That absence request does not exist.', 'Reload the list and pick the request again.');
  return rows[0];
}

/** A released or posted payroll run already paid this employee for a day in [from, to]. */
async function frozenPayroll(tx: Tx, client: string, pn: string, from: string, to: string): Promise<string | null> {
  const r = (await tx.execute(sql`
    select run.run_id from payroll_result res join payroll_run run on run.client = res.client and run.run_id = res.run_id
     where res.client = ${client} and res.personnel_number = ${pn} and run.status in ('RELEASED', 'POSTED')
       and run.period_from <= ${to}::date and run.period_to >= ${from}::date limit 1
  `)) as unknown as Array<{ run_id: string }>;
  return r[0]?.run_id ?? null;
}

type Decision = 'APPROVED' | 'REJECTED' | 'CANCELLED';

async function decide(input: unknown, decision: Decision, access: LeaveAccess | undefined, at: Date): Promise<AbsenceOutcome> {
  const p = parse(decideSchema, input);
  return withTenant(p.client, async (tx) => {
    const first = await standing(tx, p);
    const caps = decision === 'CANCELLED' && first.status === 'REQUESTED' ? [LEAVE_APPROVE, LEAVE_ENTER] : [LEAVE_APPROVE];
    const grant = await judgeLeave(tx, p.client, access, caps);
    const pn = first.personnel_number;
    await assertReachesEmployee(tx, p.client, grant, pn, first.valid_from, first.valid_to ?? first.valid_from);
    const actor = actorOf(grant, p.changedBy);
    await lockEmployeeLeave(tx, p.client, pn);
    const row = await standing(tx, { ...p, absenceId: first.id });   // re-read under the lock
    const key = `${pn}/${row.time_type_code}/${row.valid_from}`;
    const outcome = (status: AbsenceOutcome['status'], unpaid: number): AbsenceOutcome => ({
      absenceId: row.id, personnelNumber: pn, timeTypeCode: row.time_type_code, validFrom: row.valid_from, status,
      managed: row.policy_managed, unpaidDays: unpaid, replayed: false,
    });
    const setStatus = async (status: Decision, confirmed?: number) => {
      await tx.execute(sql`
        update absence set status = ${status}, changed_by = ${actor}, changed_at = now()
          ${confirmed === undefined ? sql`` : sql`, confirmed_unpaid_days = ${fromScaled(BigInt(confirmed) * SCALE)}::numeric`}
         where client = ${p.client} and id = ${row.id}`);
    };

    if (decision === 'CANCELLED' && row.status === 'APPROVED') {
      if (!row.policy_managed) refuse('NOT_REQUESTED', 'An approved absence without a leave policy cannot be cancelled here.', 'Contact the administrator.');
      const allocs = (await tx.execute(sql`
        select id, seq, alloc_from::text as alloc_from, alloc_to::text as alloc_to, days::text as days, quota_type_code, quota_year, is_paid, policy_code, policy_version
          from absence_allocation where client = ${p.client} and absence_id = ${row.id} and reversed_at is null order by seq
      `)) as unknown as Array<{ id: string; seq: number; alloc_from: string; alloc_to: string; days: string; quota_type_code: string; quota_year: number; is_paid: boolean; policy_code: string; policy_version: number }>;
      const unpaidSpans = allocs.filter((a) => !a.is_paid);
      for (const a of unpaidSpans) {
        const run = await frozenPayroll(tx, p.client, pn, a.alloc_from, a.alloc_to);
        if (run) refuse('PAYROLL_FROZEN', `Payroll run ${run} already covers unpaid leave from ${a.alloc_from} to ${a.alloc_to}; a released run is frozen.`, 'Correct it in a later payroll period.');
      }
      for (const a of allocs) {
        const closed = (await tx.execute(sql`
          select 1 from leave_ledger where client = ${p.client} and personnel_number = ${pn} and time_type_code = ${a.quota_type_code}
             and year = ${a.quota_year} and entry_kind = 'EXPIRY' limit 1
        `)) as unknown as unknown[];
        if (closed.length > 0) refuse('YEAR_CLOSED', `The ${a.quota_type_code} balance for ${a.quota_year} has already expired; its days cannot be given back.`, 'Record an adjustment in the current year instead.');
      }
      for (const a of allocs) {
        await postLedgerEntry(tx, {
          client: p.client, personnelNumber: pn, timeTypeCode: a.quota_type_code, year: a.quota_year, entryKind: 'REVERSAL',
          effectiveDate: a.alloc_from, quantity: toScaled(a.days), policyCode: a.policy_code, policyVersion: a.policy_version,
          sourceKind: 'ABSENCE', sourceKey: `REV/${row.id}/${a.seq}`, absenceId: row.id, note: 'Approved absence cancelled', createdBy: actor,
        });
        await tx.execute(sql`update absence_allocation set reversed_at = now(), reversed_by = ${actor} where client = ${p.client} and id = ${a.id}`);
      }
      await setStatus('CANCELLED');
      await recordChange(tx, { client: p.client, objectClass: 'absence', objectKey: key, changeType: 'CHANGE', changedBy: actor, transactionCode: 'PA2001', before: { status: 'APPROVED' }, after: { status: 'CANCELLED', reversedSpans: allocs.length } });
      return outcome('CANCELLED', 0);
    }

    if (row.status !== 'REQUESTED') refuse('NOT_REQUESTED', `Only a requested absence can be ${decision.toLowerCase()}; this one is ${row.status.toLowerCase()}.`, 'Reload the list.');

    if (decision !== 'APPROVED') {
      await setStatus(decision);
      await recordChange(tx, { client: p.client, objectClass: 'absence', objectKey: key, changeType: 'CHANGE', changedBy: actor, transactionCode: 'PA2001', before: { status: 'REQUESTED' }, after: { status: decision } });
      return outcome(decision, 0);
    }

    // ── approve ──
    const type = (await typesOf(tx, p.client)).get(row.time_type_code);
    if (!type) refuse('TIME_TYPE_UNKNOWN', `Time type ${row.time_type_code} does not exist.`);
    const { today } = await tenantToday(tx, p.client, at);
    const to = row.valid_to;

    if (!row.policy_managed) {
      // Legacy behaviour: hand-set quota, time_type.is_paid.
      if (!type.isPaid) {
        const run = await frozenPayroll(tx, p.client, pn, row.valid_from, to ?? row.valid_from);
        if (run) refuse('PAYROLL_FROZEN', `Payroll run ${run} already covers these dates; a released run is frozen.`, 'Correct it in a later payroll period.');
      }
      if (type.reducesQuota) {
        const days = BigInt((to ? dayNumber(to) : dayNumber(row.valid_from)) - dayNumber(row.valid_from) + 1) * SCALE;
        const year = Number(row.valid_from.slice(0, 4));
        const [q] = (await tx.execute(sql`
          select remaining::text as remaining, taken::text as taken, mode from leave_quota
           where client = ${p.client} and personnel_number = ${pn} and time_type_code = ${row.time_type_code} and year = ${year}
        `)) as unknown as Array<{ remaining: string; taken: string; mode: string }>;
        if (q?.mode === 'POLICY') refuse('QUOTA_POLICY_OWNED', `The ${row.time_type_code} balance for ${year} is policy-owned, but this request was made without a policy.`, 'Cancel it and request again.');
        if (toScaled(q?.remaining ?? '0') < days) refuse('QUOTA_EXCEEDED', `${fromScaled(days)} day(s) needed, ${q?.remaining ?? '0'} remaining.`, 'Reject the request or adjust the quota.');
        await tx.execute(sql`
          update leave_quota set taken = ${fromScaled(toScaled(q!.taken) + days)}::numeric, remaining = ${fromScaled(toScaled(q!.remaining) - days)}::numeric,
                 changed_by = ${actor}, changed_at = now()
           where client = ${p.client} and personnel_number = ${pn} and time_type_code = ${row.time_type_code} and year = ${year}`);
      }
      await setStatus('APPROVED');
      await recordChange(tx, { client: p.client, objectClass: 'absence', objectKey: key, changeType: 'CHANGE', changedBy: actor, transactionCode: 'PA2001', before: { status: 'REQUESTED' }, after: { status: 'APPROVED' }, reason: 'Absence approved.' });
      return outcome('APPROVED', 0);
    }

    const plan = await planAbsence(tx, p.client, pn, row.time_type_code, row.valid_from, to!, today);
    if (!plan.managed) refuse('POLICY_CHANGED', 'The leave policy that governed this request no longer applies to these dates.', 'Reject the request and ask for it again.');
    if (plan.uncovered.length > 0) {
      refuse('INSUFFICIENT_BALANCE', `${plan.uncovered.length} day(s) are no longer covered by any balance (first: ${plan.uncovered[0]}).`, 'Reject the request, or record an adjustment first.');
    }
    const confirmed = toScaled(row.confirmed ?? '0');
    const now = BigInt(plan.unpaidDays) * SCALE;
    if (now > confirmed && !sameDays(p.confirmUnpaidDays, plan.unpaidDays)) {
      refuse('SPLIT_CHANGED', `The requester accepted ${fromScaled(confirmed)} unpaid day(s); the split is now ${plan.paidDays} paid and ${plan.unpaidDays} unpaid: ${describe(plan)}.`,
        `Approve again confirming ${plan.unpaidDays} unpaid day(s), or reject the request.`);
    }
    for (const s of plan.spans.filter((x) => !x.isPaid)) {
      const run = await frozenPayroll(tx, p.client, pn, s.from, s.to);
      if (run) refuse('PAYROLL_FROZEN', `Payroll run ${run} already covers unpaid leave from ${s.from} to ${s.to}; a released run is frozen.`, 'Correct it in a later payroll period.');
    }
    let seq = 0;
    for (const s of plan.spans) {
      seq += 1;
      const sourceKey = `ABS/${row.id}/${seq}`;
      await postLedgerEntry(tx, {
        client: p.client, personnelNumber: pn, timeTypeCode: s.typeCode, year: s.year, entryKind: 'ABSENCE_DEBIT', effectiveDate: s.from,
        quantity: -(BigInt(s.days) * SCALE), policyCode: s.policyCode, policyVersion: s.policyVersion, sourceKind: 'ABSENCE', sourceKey,
        absenceId: row.id, note: `${row.time_type_code} ${s.from}–${s.to}`, createdBy: actor,
      });
      const [ledger] = (await tx.execute(sql`select id from leave_ledger where client = ${p.client} and source_key = ${sourceKey}`)) as unknown as Array<{ id: string }>;
      await tx.execute(sql`
        insert into absence_allocation (client, id, absence_id, personnel_number, seq, alloc_from, alloc_to, days, quota_type_code, quota_year,
                                        is_paid, policy_code, policy_version, debit_ledger_id, created_by)
        values (${p.client}, ${randomUUID()}, ${row.id}, ${pn}, ${seq}, ${s.from}::date, ${s.to}::date, ${s.days}, ${s.typeCode}, ${s.year},
                ${s.isPaid}, ${s.policyCode}, ${s.policyVersion}, ${ledger!.id}, ${actor})
      `);
    }
    await setStatus('APPROVED', plan.unpaidDays);
    await recordChange(tx, {
      client: p.client, objectClass: 'absence', objectKey: key, changeType: 'CHANGE', changedBy: actor, transactionCode: 'PA2001',
      before: { status: 'REQUESTED', confirmedUnpaidDays: row.confirmed }, after: { status: 'APPROVED', paidDays: plan.paidDays, unpaidDays: plan.unpaidDays, split: describe(plan) },
    });
    return outcome('APPROVED', plan.unpaidDays);
  });
}

export const approveLeaveAbsence = (input: z.input<typeof decideSchema>, access: LeaveAccess | undefined, at: Date = new Date()) => decide(input, 'APPROVED', access, at);
export const rejectLeaveAbsence = (input: z.input<typeof decideSchema>, access: LeaveAccess | undefined, at: Date = new Date()) => decide(input, 'REJECTED', access, at);
export const cancelLeaveAbsence = (input: z.input<typeof decideSchema>, access: LeaveAccess | undefined, at: Date = new Date()) => decide(input, 'CANCELLED', access, at);

/** The stored split of one absence (what the approved record kept). */
export async function absenceAllocations(
  client: string, absenceId: string, access: LeaveAccess | undefined,
): Promise<Array<{ seq: number; from: string; to: string; days: string; typeCode: string; year: number; isPaid: boolean; reversed: boolean }>> {
  return withTenant(client, async (tx) => {
    const grant = await judgeLeave(tx, client, access, [LEAVE_VIEW, LEAVE_APPROVE, LEAVE_ENTER]);
    const [a] = (await tx.execute(sql`select personnel_number, valid_from::text as valid_from, valid_to::text as valid_to from absence where client = ${client} and id = ${absenceId}`)) as unknown as Array<{ personnel_number: string; valid_from: string; valid_to: string | null }>;
    if (!a) refuse('ABSENCE_UNKNOWN', 'That absence request does not exist.');
    await assertReachesEmployee(tx, client, grant, a.personnel_number, a.valid_from, a.valid_to ?? a.valid_from);
    const rows = (await tx.execute(sql`
      select seq, alloc_from::text as f, alloc_to::text as t, days::text as days, quota_type_code as type, quota_year as year, is_paid, (reversed_at is not null) as reversed
        from absence_allocation where client = ${client} and absence_id = ${absenceId} order by seq
    `)) as unknown as Array<{ seq: number; f: string; t: string; days: string; type: string; year: number; is_paid: boolean; reversed: boolean }>;
    return rows.map((r) => ({ seq: r.seq, from: r.f, to: r.t, days: r.days, typeCode: r.type, year: Number(r.year), isPaid: r.is_paid, reversed: r.reversed }));
  });
}

export { addDays };
