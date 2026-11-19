/**
 * Leave accrual: monthly credits at month end in the tenant's time zone, annual upfront grants, and year-end expiry.
 *
 * ## Rules
 * - A month is credited only once it is complete in `client.timezone` (never the server's clock, never a future month).
 * - The credit of month m is round(E_m) − round(E_{m−1}) of the exact cumulative entitlement (leave-math), so it does not
 *   depend on when the run happens: a catch-up posts exactly what an on-time run would have.
 * - Every credit has a unique source key, so reruns, retries and concurrent runs credit once. An existing entry whose
 *   amount differs from the plan is reported as an exception and never altered.
 * - Year end is expiry: the unused balance of a completed year is written off once (EXPIRY), no carry-over.
 * - A quota still in LEGACY mode is skipped and reported; conversion is an explicit previewed step.
 * - Entitlement is clipped to the person's employment (first position-assignment start to last end). An inactive
 *   employee, or one without a resolvable employment, is reported and gets no credit.
 *
 * ## Windows
 * The scheduled catch-up posts only the last CATCH_UP_MONTHS completed months. Older missing months are counted as
 * `backlog` and shown in the status; the backfill (INTENSIVE queue) has no floor.
 *
 * ## Authority
 * Scheduled runs use the in-process capability list ['PEOPLE.LEAVE.ACCRUE']: it can post accruals and nothing else
 * (it is not a user and cannot read balances, approve or adjust). A manual or backfill run acts as the user who started
 * it, judged against the current database with the job lease, and reaches only employees inside that user's scope.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import { enqueue } from '../../platform/job/queue';
import {
  LEAVE_ACCRUE, type LeaveAccess, type LeaveGrant, actorOf, judgeLeave, reachesEmployee, refuse,
} from './leave-access';
import {
  type LineSegment, addDays, annualGrant, isValidTimezone, lastCompleteMonth, localDate, monthEnd, monthIsComplete,
  monthStart, monthlyCredit,
} from './leave-math';
import { postLedgerEntry, lockEmployeeLeave, tenantToday } from './leave-ledger';
import { resolveLeaveSegments, type ResolvedSegment } from './leave-policy';

export const CATCH_UP_MONTHS = 3;
export const SYSTEM_ACCRUAL_ACCESS: readonly string[] = [LEAVE_ACCRUE];

export type AccrualException =
  | 'INACTIVE_EMPLOYEE' | 'NO_EMPLOYMENT' | 'LEGACY_QUOTA' | 'DIVERGED_ENTRY' | 'RESOLVE_FAILED';

export interface EmployeeAccrual {
  personnelNumber: string;
  posted: number;
  backlog: number;
  exceptions: Array<{ code: AccrualException; detail: string }>;
}

interface Planned {
  key: string; kind: 'MONTHLY_ACCRUAL' | 'ANNUAL_GRANT'; type: string; year: number; month: number;
  effective: string; qty: bigint; policyCode: string; policyVersion: number;
}

const bounds = (m: number) => (m < 10 ? `0${m}` : `${m}`);

/** Plan every credit the employee's policies earn up to `today` (tenant-local), with no reference to the ledger. */
function plan(pn: string, segments: ResolvedSegment[], employment: { from: string; to: string | null }, today: string): Planned[] {
  const cy = Number(today.slice(0, 4));
  const types = new Set<string>();
  for (const s of segments) for (const k of s.lines.keys()) types.add(k);
  const out: Planned[] = [];
  for (const type of types) {
    const monthly: LineSegment[] = [];
    const upfront: Array<{ seg: LineSegment; policyCode: string; policyVersion: number }> = [];
    let startYear = cy;
    for (const s of segments) {
      const line = s.lines.get(type);
      if (!line) continue;
      const from = s.from > employment.from ? s.from : employment.from;
      const to = employment.to !== null && employment.to < s.to ? employment.to : s.to;
      if (from > to) continue;
      startYear = Math.min(startYear, Number(from.slice(0, 4)));
      const seg: LineSegment = { from, to, annualScaled: line.annualScaled, mode: s.partialMonthMode };
      if (line.accrualMode === 'MONTHLY') monthly.push(seg);
      else upfront.push({ seg, policyCode: s.policyCode, policyVersion: s.version });
    }
    for (let y = startYear; y <= cy; y++) {
      for (let m = 1; m <= 12; m++) {
        if (!monthIsComplete(y, m, today)) continue;
        const credit = monthlyCredit(monthly, y, m);
        if (credit <= 0n) continue;
        const end = monthEnd(y, m);
        const owner = [...segments].reverse().find((s) => s.lines.get(type)?.accrualMode === 'MONTHLY' && s.from <= end && s.to >= monthStart(y, m));
        if (!owner) continue;
        out.push({
          key: `ACCR/${pn}/${type}/${y}-${bounds(m)}`, kind: 'MONTHLY_ACCRUAL', type, year: y, month: m,
          effective: end, qty: credit, policyCode: owner.policyCode, policyVersion: owner.version,
        });
      }
      // Upfront: one grant per (employee, type, year), from the first segment eligible in the year, once its day has come.
      const first = upfront
        .filter((u) => u.seg.from <= `${y}-12-31` && (u.seg.to === null || u.seg.to >= `${y}-01-01`))
        .sort((a, b) => a.seg.from.localeCompare(b.seg.from))[0];
      const g = first ? annualGrant(first.seg, y) : null;
      if (first && g && g.amount > 0n && g.effective <= today) {
        out.push({
          key: `GRANT/${pn}/${type}/${y}`, kind: 'ANNUAL_GRANT', type, year: y, month: 0,
          effective: g.effective, qty: g.amount, policyCode: first.policyCode, policyVersion: first.policyVersion,
        });
      }
    }
  }
  return out;
}

/**
 * Accrue one employee through `today` (tenant-local). Judges nothing: the caller has already authorised the employee.
 * `floor` is the first month start the run may post; earlier missing months count as backlog.
 */
export async function accrueEmployee(
  tx: Tx, client: string, personnelNumber: string, today: string, floor: string | null, createdBy: string,
): Promise<EmployeeAccrual> {
  const result: EmployeeAccrual = { personnelNumber, posted: 0, backlog: 0, exceptions: [] };
  await lockEmployeeLeave(tx, client, personnelNumber);

  const emp = (await tx.execute(sql`select is_active from employee where client = ${client} and personnel_number = ${personnelNumber}`)) as unknown as Array<{ is_active: boolean }>;
  if (!emp[0]) return result;
  if (!emp[0].is_active) {
    result.exceptions.push({ code: 'INACTIVE_EMPLOYEE', detail: 'The employee is inactive; no leave was credited.' });
    return result;
  }
  const emps = (await tx.execute(sql`
    select min(valid_from)::text as "from", case when bool_or(valid_to is null) then null else max(valid_to)::text end as "to"
      from position_assignment where client = ${client} and personnel_number = ${personnelNumber}
  `)) as unknown as Array<{ from: string | null; to: string | null }>;
  if (!emps[0]?.from) {
    result.exceptions.push({ code: 'NO_EMPLOYMENT', detail: 'The employee has no position assignment, so no employment dates are known.' });
    return result;
  }
  const employment = { from: emps[0].from, to: emps[0].to };

  // Earliest day any policy could apply to this person.
  const start = (await tx.execute(sql`
    select min(d)::text as d from (
      select valid_from as d from leave_policy_assignment
       where client = ${client} and subject_kind = 'PERSON' and personnel_number = ${personnelNumber}
      union all
      select greatest(a.valid_from, m.valid_from) from leave_policy_assignment a
        join leave_group_member m on m.client = a.client and m.group_code = a.group_code
       where a.client = ${client} and a.subject_kind = 'GROUP' and m.personnel_number = ${personnelNumber}
    ) x
  `)) as unknown as Array<{ d: string | null }>;
  if (!start[0]?.d) return result;

  const [ly, lm] = lastCompleteMonth(today);
  const through = monthEnd(ly, lm);
  const from = start[0].d > employment.from ? start[0].d : employment.from;
  if (from > through) return result;

  let segments: ResolvedSegment[];
  try {
    segments = await resolveLeaveSegments(tx, client, personnelNumber, from, today > through ? today : through);
  } catch (e) {
    result.exceptions.push({ code: 'RESOLVE_FAILED', detail: e instanceof Error ? e.message.slice(0, 200) : 'resolution failed' });
    return result;
  }
  const planned = plan(personnelNumber, segments, employment, today);

  const existing = (await tx.execute(sql`
    select source_key as key, quantity::text as qty from leave_ledger
     where client = ${client} and personnel_number = ${personnelNumber} and source_kind = 'ACCRUAL'
  `)) as unknown as Array<{ key: string; qty: string }>;
  const have = new Map(existing.map((e) => [e.key, e.qty]));
  const modes = (await tx.execute(sql`
    select time_type_code as type, year, mode, accrual_from::text as af from leave_quota
     where client = ${client} and personnel_number = ${personnelNumber}
  `)) as unknown as Array<{ type: string; year: number; mode: string; af: string | null }>;
  const quotaOf = new Map(modes.map((q) => [`${q.type}/${Number(q.year)}`, q]));

  const flagged = new Set<string>();
  const unsettledYears = new Set<string>();
  for (const p of planned) {
    const q = quotaOf.get(`${p.type}/${p.year}`);
    if (q?.mode === 'LEGACY') {
      if (!flagged.has(`${p.type}/${p.year}`)) {
        flagged.add(`${p.type}/${p.year}`);
        result.exceptions.push({ code: 'LEGACY_QUOTA', detail: `${p.type} ${p.year} is a legacy balance; convert it to accrue under the policy.` });
      }
      unsettledYears.add(`${p.type}/${p.year}`);
      continue;
    }
    if (q?.af && p.kind === 'MONTHLY_ACCRUAL' && monthEnd(p.year, p.month) < q.af) continue; // before the cutover
    const known = have.get(p.key);
    if (known !== undefined) {
      if (known !== (Number(p.qty) / 100).toFixed(2)) {
        result.exceptions.push({ code: 'DIVERGED_ENTRY', detail: `${p.key}: posted ${known}, plan ${(Number(p.qty) / 100).toFixed(2)}; left unchanged.` });
        unsettledYears.add(`${p.type}/${p.year}`);
      }
      continue;
    }
    if (floor !== null && p.kind === 'MONTHLY_ACCRUAL' && monthStart(p.year, p.month) < floor) {
      result.backlog += 1;
      unsettledYears.add(`${p.type}/${p.year}`);
      continue;
    }
    const ok = await postLedgerEntry(tx, {
      client, personnelNumber, timeTypeCode: p.type, year: p.year, entryKind: p.kind, effectiveDate: p.effective, quantity: p.qty,
      policyCode: p.policyCode, policyVersion: p.policyVersion, sourceKind: 'ACCRUAL', sourceKey: p.key, createdBy,
    });
    if (ok) result.posted += 1;
  }

  // Year-end expiry of completed years, once, only for a year fully settled by this plan.
  const types = new Set(planned.map((p) => p.type));
  for (const type of types) {
    for (let y = Number(from.slice(0, 4)); y <= ly; y++) {
      if (!monthIsComplete(y, 12, today)) continue;
      if (unsettledYears.has(`${type}/${y}`) || flagged.has(`${type}/${y}`)) continue;
      const q = quotaOf.get(`${type}/${y}`);
      if (q && q.mode === 'LEGACY') continue;
      const bal = (await tx.execute(sql`
        select coalesce(sum(quantity), 0)::text as r from leave_ledger
         where client = ${client} and personnel_number = ${personnelNumber} and time_type_code = ${type} and year = ${y}
      `)) as unknown as Array<{ r: string }>;
      const remaining = Math.round(Number(bal[0]?.r ?? 0) * 100);
      if (remaining <= 0) continue;
      const ok = await postLedgerEntry(tx, {
        client, personnelNumber, timeTypeCode: type, year: y, entryKind: 'EXPIRY', effectiveDate: `${y}-12-31`, quantity: BigInt(-remaining),
        sourceKind: 'YEAR_END', sourceKey: `EXP/${personnelNumber}/${type}/${y}`, note: 'Year-end expiry, no carry-over', createdBy,
      });
      if (ok) result.posted += 1;
    }
  }
  return result;
}

// ── tenant runs (chunked) ────────────────────────────────────────────────────
export interface AccrualChunk {
  done: boolean;
  afterPersonnelNumber: string | null;
  employees: number;
  posted: number;
  backlog: number;
  exceptions: number;
  exceptionDetail: Array<{ personnelNumber: string; code: AccrualException; detail: string }>;
  today: string;
  timezone: string;
}

/** Employees with any policy assignment (person or via group), in personnel-number order, after a cursor. */
async function candidates(tx: Tx, client: string, after: string | null, limit: number): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select personnel_number as pn from (
      select personnel_number from leave_policy_assignment where client = ${client} and subject_kind = 'PERSON'
      union
      select m.personnel_number from leave_group_member m
        join leave_policy_assignment a on a.client = m.client and a.group_code = m.group_code and a.subject_kind = 'GROUP'
       where m.client = ${client}
    ) c
    where (${after}::text is null or personnel_number > ${after}::text)
    order by personnel_number limit ${limit}
  `)) as unknown as Array<{ pn: string }>;
  return rows.map((r) => r.pn);
}

/** One chunk: judge, then accrue up to `limit` employees each in their own savepoint. Employees out of the caller's scope are skipped. */
export async function accrueChunk(
  client: string,
  opts: { access: LeaveAccess; after: string | null; limit: number; window: 'CATCH_UP' | 'ALL'; at?: Date; fence?: (tx: Tx) => Promise<void>; requestedBy?: string },
): Promise<AccrualChunk> {
  return withTenant(client, async (tx) => {
    if (opts.fence) await opts.fence(tx);
    const grant: LeaveGrant = await judgeLeave(tx, client, opts.access, [LEAVE_ACCRUE]);
    const { timezone, today } = await tenantToday(tx, client, opts.at);
    const [ly, lm] = lastCompleteMonth(today);
    let floor: string | null = null;
    if (opts.window === 'CATCH_UP') {
      let y = ly; let m = lm - (CATCH_UP_MONTHS - 1);
      while (m < 1) { m += 12; y -= 1; }
      floor = monthStart(y, m);
    }
    const actor = grant.username ?? opts.requestedBy ?? 'SYSTEM';
    const batch = await candidates(tx, client, opts.after, opts.limit);
    const out: AccrualChunk = {
      done: batch.length < opts.limit, afterPersonnelNumber: batch[batch.length - 1] ?? opts.after,
      employees: 0, posted: 0, backlog: 0, exceptions: 0, exceptionDetail: [], today, timezone,
    };
    for (const pn of batch) {
      if (grant.restrictions !== null && !(await reachesEmployee(tx, client, grant, pn, addDays(today, -365 * 5), today))) continue;
      const r = await tx.transaction((sp) => accrueEmployee(sp as unknown as Tx, client, pn, today, floor, actor));
      out.employees += 1; out.posted += r.posted; out.backlog += r.backlog; out.exceptions += r.exceptions.length;
      for (const e of r.exceptions) out.exceptionDetail.push({ personnelNumber: pn, ...e });
    }
    return out;
  });
}

// ── run log ──────────────────────────────────────────────────────────────────
export async function startAccrualRun(
  tx: Tx, client: string, kind: 'SCHEDULED' | 'MANUAL' | 'BACKFILL', requestedBy: string, jobRunId: string | null,
): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`
    insert into leave_accrual_run (client, id, kind, status, job_run_id, requested_by)
    values (${client}, ${id}, ${kind}, 'RUNNING', ${jobRunId}, ${requestedBy})`);
  return id;
}

export async function recordAccrualChunk(tx: Tx, client: string, runId: string, c: AccrualChunk, finished: boolean): Promise<void> {
  const detail = c.exceptionDetail.slice(0, 50);
  await tx.execute(sql`
    update leave_accrual_run set
      employees_done = employees_done + ${c.employees}, entries_posted = entries_posted + ${c.posted},
      exceptions = exceptions + ${c.exceptions}, through_date = ${c.today}::date,
      detail = jsonb_build_object('backlog', coalesce((detail->>'backlog')::int, 0) + ${c.backlog}, 'timezone', ${c.timezone}::text,
                                  'samples', coalesce(detail->'samples', '[]'::jsonb) || ${JSON.stringify(detail)}::jsonb),
      status = case when ${finished} then (case when exceptions + ${c.exceptions} > 0 then 'PARTIAL' else 'SUCCEEDED' end) else status end,
      finished_at = case when ${finished} then now() else finished_at end
    where client = ${client} and id = ${runId}`);
}

export async function failAccrualRun(client: string, runId: string, reason: string): Promise<void> {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      update leave_accrual_run set status = 'FAILED', finished_at = now(),
             detail = jsonb_build_object('reason', ${reason.slice(0, 300)}::text)
       where client = ${client} and id = ${runId} and status = 'RUNNING'`);
  });
}

// ── manual request ───────────────────────────────────────────────────────────
/**
 * A user asks for an accrual run: CATCH_UP (regular worker) or BACKFILL (INTENSIVE worker, from each assignment start).
 * Needs a live session: the run later acts as this user, so a capability-list caller cannot start one.
 * Submitting the same kind twice on the same tenant-local day returns the run already queued.
 */
export async function requestLeaveAccrual(
  client: string, kind: 'CATCH_UP' | 'BACKFILL', access?: LeaveAccess,
): Promise<{ jobRunId: string; created: boolean }> {
  return withTenant(client, async (tx) => {
    const grant = await judgeLeave(tx, client, access, [LEAVE_ACCRUE]);
    const userId = access && !Array.isArray(access) ? (access as { authorization?: { userId?: string } }).authorization?.userId : undefined;
    if (!userId || grant.username === null) {
      refuse('LEAVE_AUTHORITY', 'A manual accrual run needs a signed-in user: it runs with that user\'s authority.', 'Sign in and try again.');
    }
    const { today } = await tenantToday(tx, client);
    const run = await enqueue(tx, {
      client, jobCode: kind === 'BACKFILL' ? 'LEAVE.ACCRUAL.BACKFILL' : 'LEAVE.ACCRUAL.RUN',
      triggeredBy: userId, triggerType: 'MANUAL', idempotencyKey: `leave-${kind}-${userId}-${today}`,
    });
    return { jobRunId: run.id, created: run.created };
  });
}

// ── status ───────────────────────────────────────────────────────────────────
export interface AccrualStatus {
  timezone: string;
  today: string;
  /** The last month that is complete in the tenant zone, and the day by which it should have been credited. */
  dueThrough: string;
  scheduleEnabled: boolean;
  lastRun: null | { kind: string; status: string; startedAt: string; finishedAt: string | null; throughDate: string | null; employees: number; posted: number; exceptions: number; backlog: number };
  /** Plain-language reasons credits may not have been processed; empty when everything due has run. */
  notProcessed: string[];
  queuedWithoutWorker: number;
}

export async function leaveAccrualStatus(client: string, access?: LeaveAccess, at: Date = new Date()): Promise<AccrualStatus> {
  return withTenant(client, async (tx) => {
    await judgeLeave(tx, client, access, [LEAVE_ACCRUE]);
    const { timezone, today } = await tenantToday(tx, client, at);
    const [ly, lm] = lastCompleteMonth(today);
    const dueThrough = monthEnd(ly, lm);
    const def = (await tx.execute(sql`select is_enabled, is_scheduled from job_definition where code = 'LEAVE.ACCRUAL.RUN'`)) as unknown as Array<{ is_enabled: boolean; is_scheduled: boolean }>;
    const scheduleEnabled = !!def[0]?.is_enabled && !!def[0]?.is_scheduled;
    const last = (await tx.execute(sql`
      select kind, status, started_at::text as "startedAt", finished_at::text as "finishedAt", through_date::text as "throughDate",
             employees_done as employees, entries_posted as posted, exceptions, coalesce((detail->>'backlog')::int, 0) as backlog
        from leave_accrual_run where client = ${client} and status in ('SUCCEEDED', 'PARTIAL') order by started_at desc limit 1
    `)) as unknown as Array<{ kind: string; status: string; startedAt: string; finishedAt: string | null; throughDate: string | null; employees: number; posted: number; exceptions: number; backlog: number }>;
    const stuck = (await tx.execute(sql`
      select count(*)::int as n from job_run
       where client = ${client} and job_code like 'LEAVE.ACCRUAL.%' and status = 'QUEUED' and queued_at < now() - interval '15 minutes'
    `)) as unknown as Array<{ n: number }>;
    const notProcessed: string[] = [];
    if (!def[0]) notProcessed.push('The accrual job is not defined in this environment.');
    else if (!def[0].is_enabled) notProcessed.push('The accrual job is disabled, so month-end credits are not being posted.');
    else if (!def[0].is_scheduled) notProcessed.push('The accrual schedule is off, so month-end credits are not being posted automatically.');
    if (Number(stuck[0]?.n) > 0) notProcessed.push(`${stuck[0]!.n} accrual job(s) have waited over 15 minutes in the queue; no worker may be consuming it.`);
    const l = last[0];
    if (!l) notProcessed.push('No accrual run has completed yet.');
    else if (!l.throughDate || l.throughDate < addDays(dueThrough, 1)) notProcessed.push(`Credits are due through ${dueThrough} but the last completed run only covered ${l.throughDate ?? 'no date'}.`);
    if (l && Number(l.backlog) > 0) notProcessed.push(`${l.backlog} older credit(s) are outside the catch-up window; request a backfill.`);
    return {
      timezone, today, dueThrough, scheduleEnabled,
      lastRun: l ? { ...l, employees: Number(l.employees), posted: Number(l.posted), exceptions: Number(l.exceptions), backlog: Number(l.backlog) } : null,
      notProcessed, queuedWithoutWorker: Number(stuck[0]?.n),
    };
  });
}

export { actorOf, tenantToday };
