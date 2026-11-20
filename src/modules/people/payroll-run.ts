/**
 * Payroll phase 2 — the run and its calculation.
 *
 * SAP reference: the payroll driver (PC00_M99_CALC) run for one payroll area and period, and the
 * payroll result cluster (RX) it writes per employee. A run here is one company code and one fiscal
 * period: PROPOSED → RELEASED → (phase 3) POSTED, or CANCELLED, which frees the period.
 *
 * The rules this file keeps:
 * - **Nothing posts.** No journal, no clearing — phase 3 posts a released run.
 * - **Readiness is phase 1's.** `validateEmployeeForRun` decides who may be included; an employee it
 *   refuses is recorded on the run as a named exception, never dropped. A run with exceptions cannot
 *   be released: fix the data, then recalculate the proposed run.
 * - **A released result is frozen.** It is never recalculated; a correction is a new run in a later
 *   period (DV-001: no retroactive accounting).
 * - **Proration is by days.** Each day the employee holds a position in the run's company counts,
 *   less days inside an APPROVED absence whose time type is unpaid. The factor is
 *   payable days / calendar days in the period.
 * - **Segments.** A mid-period transfer (another position assignment) or raise (another salary
 *   assignment) splits the period into contiguous segments; each component is calculated per
 *   segment with its own rule, base and cost centre.
 * - **Round once.** A line's amount is the exact rule × factor, rounded once to the currency's
 *   decimals. Totals are sums of the rounded lines, so a slip always adds up.
 * - **Snapshot.** Each line carries the accounts and the cost receiver from the company's chart at
 *   calculation time; posting never re-reads configuration.
 *
 * Nothing statutory ships: no tax, no social-insurance rate, no country leave law. End-of-service
 * provisions are out of scope for v1 and refused.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type PayrollAccess, assertCompanyScope, judgePayrollAccess, reachesCompany } from './payroll-access';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { PeriodError, checkPostingAllowed, derivePosition, getCompanyCode, periodDates } from '../../platform/periods';
import {
  EMPLOYEE_ROUTE,
  EOS_PROVISION_KIND,
  PAY_COMPONENT_ROUTE,
  PAYROLL_RESULT_CAPABILITY,
  SALARY_STRUCTURE_ROUTE,
  validateEmployeeForRun,
} from './payroll-structure';
import {
  PAYROLL_ADJUSTMENT_OBJECT_CLASS,
  PAYROLL_RESULT_ROUTE,
  PAYROLL_RUN_CAPABILITY,
  PAYROLL_RUN_OBJECT_CLASS,
  PAYROLL_RUN_ROUTE,
  employee,
  payrollResult,
  payrollResultLine,
  payrollRun,
  payrollRunException,
  type LineSource,
  type PayrollRunStatus,
} from './schema';

export { PAYROLL_RESULT_CAPABILITY, PAYROLL_RESULT_ROUTE, PAYROLL_RUN_CAPABILITY, PAYROLL_RUN_ROUTE };
export type { PayrollRunStatus, PayrollAccess };

// ── Errors ──────────────────────────────────────────────────────────────────

export class PayrollRunError extends Error {
  remedy?: string;
  /** A stable code a test or caller can branch on. The message is for people. */
  readonly code: string;
  constructor(message: string, remedy?: string, code = 'PAYROLL_RUN') {
    super(message);
    this.name = 'PayrollRunError';
    this.remedy = remedy;
    this.code = code;
  }
}

export function refuse(code: string, message: string, remedy?: string): never {
  throw new PayrollRunError(message, remedy, code);
}

/** Proposing, recalculating, releasing and cancelling a run. */
export const EXECUTE = [PAYROLL_RUN_CAPABILITY] as const;
/** Reading runs and results: whoever runs payroll, or whoever may read a payroll result. */
const READ = [PAYROLL_RUN_CAPABILITY, PAYROLL_RESULT_CAPABILITY] as const;
export const judge = (tx: Tx, client: string, access: PayrollAccess | undefined, capabilities: readonly string[]) =>
  judgePayrollAccess(tx, client, access, capabilities, refuse);

/** Exception codes that inform rather than block: the employee is already paid by another run. */
export const INFORMATIONAL_EXCEPTIONS: ReadonlySet<string> = new Set(['ALREADY_COVERED']);

/** A database refusal from the coverage or immutability trigger (9281), in payroll's words. */
export function translateTrigger(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  if (code === '23505' && /already covered by payroll run/.test(String((error as Error).message))) {
    refuse('RUN_RACE', 'Another run has just covered one or more of these employees. Propose the run again.', 'Reload the runs; the employees are paid by the run that covered them.');
  }
  if (code === '23514' && /a released result is never deleted/.test(String((error as Error).message))) {
    refuse('RESULT_FROZEN', 'That payroll result belongs to a released run and cannot be deleted.', 'A released result is frozen; a correction is a new run in a later period.');
  }
  throw error;
}

// ── Input ───────────────────────────────────────────────────────────────────

const clientField = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'A tenant is two to four capitals or digits.');
const companyField = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, 'A company code is one to four capitals or digits.');
const runIdField = z.string().trim().min(1).max(36);
const actor = z.string().trim().min(1).max(60);

export const proposeInput = z.object({
  client: clientField,
  companyCode: companyField,
  fiscalYear: z.coerce.number().int('A fiscal year is a whole number.').min(1900).max(9999),
  period: z.coerce.number().int('A period is a whole number.').min(1, 'A period is 1 to 16.').max(16, 'A period is 1 to 16.'),
  requestKey: z.string().trim().max(64).optional(),
  changedBy: actor,
});
export const runActionInput = z.object({ client: clientField, runId: runIdField, changedBy: actor });
const cancelInput = runActionInput.extend({
  reason: z.string().trim().min(1, 'Say why the run is cancelled.').max(200),
});

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse('PAYROLL_INPUT', `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'not valid'}`, 'Correct the field and try again.');
  }
  return parsed.data;
}

/** Year and period may come straight from a form as text; they are coerced and checked. */
export type ProposeRunInput = Omit<z.input<typeof proposeInput>, 'fiscalYear' | 'period'> & { fiscalYear: number | string; period: number | string };
export type RecalculateRunInput = z.input<typeof runActionInput>;
export const releaseInput = runActionInput.extend({
  /** The releaser has seen the pending one-time adjustments of this period and releases without them. */
  acknowledgePending: z.boolean().optional(),
});
export type ReleaseRunInput = z.input<typeof releaseInput>;
export type CancelRunInput = z.input<typeof cancelInput>;

// ── Dates and money: pure helpers ───────────────────────────────────────────

const DAY_MS = 86_400_000;
const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS;
const isoOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** Inclusive calendar days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from) + 1;
}
function day(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

/** A decimal text as an integer of 10^-scale units. Truncation never happens: inputs carry ≤ scale decimals. */
function scaled(text: string, scale: number): bigint {
  const [whole, frac = ''] = String(text).trim().split('.');
  const negative = whole!.startsWith('-');
  const units = BigInt((negative ? whole!.slice(1) : whole) || '0') * 10n ** BigInt(scale) + BigInt((frac + '0'.repeat(scale)).slice(0, scale) || '0');
  return negative ? -units : units;
}
function unscaled(units: bigint, scale: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const text = abs.toString().padStart(scale + 1, '0');
  const body = scale === 0 ? text : `${text.slice(0, -scale)}.${text.slice(-scale)}`;
  return negative ? `-${body}` : body;
}
/** numerator / denominator, rounded half away from zero (both positive here). */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export interface AbsenceSpan {
  validFrom: string;
  /** Null: open-ended. */
  validTo: string | null;
  status: string;
  /** The time type's `is_paid`. */
  isPaid: boolean;
}

export interface PayableDaysInput {
  periodFrom: string;
  periodTo: string;
  /** The span the employee is covered (position and salary assignment). Null end: open. */
  assignmentFrom: string;
  assignmentTo: string | null;
  absences: readonly AbsenceSpan[];
}

export interface PayableDaysResult {
  /** False when the assignment covers no day of the period. */
  covered: boolean;
  coveredFrom: string | null;
  coveredTo: string | null;
  coveredDays: number;
  unpaidLeaveDays: number;
  payableDays: number;
  totalDays: number;
  /** payableDays / totalDays — for display; amounts use the exact fraction. */
  factor: number;
}

/**
 * Payable days for one covered span in one period. Pure: no database.
 *
 * Unpaid days are the days of the covered span that fall inside an APPROVED absence of an unpaid time
 * type. Absences are clipped to the span, and overlapping absences count a shared day once (the spans
 * are merged before counting). REQUESTED, REJECTED and CANCELLED absences never count.
 */
export function payableDaysFor(input: PayableDaysInput): PayableDaysResult {
  const totalDays = daysBetween(input.periodFrom, input.periodTo);
  const from = Math.max(dayNumber(input.periodFrom), dayNumber(input.assignmentFrom));
  const to = Math.min(dayNumber(input.periodTo), input.assignmentTo ? dayNumber(input.assignmentTo) : Infinity);
  if (from > to) {
    return { covered: false, coveredFrom: null, coveredTo: null, coveredDays: 0, unpaidLeaveDays: 0, payableDays: 0, totalDays, factor: 0 };
  }
  const spans = input.absences
    .filter((a) => a.status === 'APPROVED' && !a.isPaid)
    .map((a) => [Math.max(from, dayNumber(a.validFrom)), Math.min(to, a.validTo ? dayNumber(a.validTo) : Infinity)] as const)
    .filter(([a, b]) => a <= b)
    .sort((x, y) => x[0] - y[0]);
  let unpaid = 0;
  let open: [number, number] | null = null;
  for (const [a, b] of spans) {
    if (open && a <= open[1] + 1) {
      open[1] = Math.max(open[1], b);
    } else {
      if (open) unpaid += open[1] - open[0] + 1;
      open = [a, b];
    }
  }
  if (open) unpaid += open[1] - open[0] + 1;
  const coveredDays = to - from + 1;
  const payableDays = coveredDays - unpaid;
  return {
    covered: true,
    coveredFrom: isoOf(from),
    coveredTo: isoOf(to),
    coveredDays,
    unpaidLeaveDays: unpaid,
    payableDays,
    totalDays,
    factor: payableDays / totalDays,
  };
}

/**
 * The sub-ranges of [from, to] that no cut covers, in order. Pure. A cut with a null end runs forever.
 * Used to suppress a structure rule only on the days an employee-specific replacement covers.
 */
export function daysOutside(from: string, to: string, cuts: ReadonlyArray<readonly [string, string | null]>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let cursor = dayNumber(from);
  const end = dayNumber(to);
  const sorted = [...cuts].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [cf, ct] of sorted) {
    const cutFrom = dayNumber(cf);
    const cutTo = ct === null ? Infinity : dayNumber(ct);
    if (cutTo < cursor || cutFrom > end) continue;
    if (cutFrom > cursor) out.push([isoOf(cursor), isoOf(cutFrom - 1)]);
    cursor = Math.max(cursor, cutTo + 1);
    if (cursor > end) break;
  }
  if (cursor <= end) out.push([isoOf(cursor), isoOf(end)]);
  return out;
}

export interface ComponentCalcInput {
  amountKind: 'FIXED' | 'PERCENT_OF_BASE';
  /** FIXED: the monthly amount. PERCENT_OF_BASE: the rate (7.5 = 7.5 %). At most 4 decimals. */
  amountValue: string;
  /** The assignment's base. At most 4 decimals. */
  baseAmount: string;
  payableDays: number;
  totalDays: number;
  /** The currency's decimals. */
  decimals: number;
}

/**
 * One component's amount for one segment. Pure, exact: the rule and the proration factor are applied
 * in integer arithmetic and the result is rounded **once** (half away from zero) to the currency's
 * decimals.
 *
 * FIXED: amountValue × payable / total. PERCENT_OF_BASE: base × amountValue / 100 × payable / total.
 */
export function calculateComponent(input: ComponentCalcInput): string {
  if (input.totalDays <= 0) refuse('PAYROLL_PERIOD', 'A period has at least one day.');
  if (input.payableDays < 0 || input.payableDays > input.totalDays) {
    refuse('PAYROLL_DAYS', `Payable days ${input.payableDays} lie outside 0 to ${input.totalDays}.`);
  }
  const value = scaled(input.amountValue, 4);
  const payable = scaled(String(input.payableDays), 2);
  const total = scaled(String(input.totalDays), 2);
  const out = 10n ** BigInt(input.decimals);
  let numerator: bigint;
  let denominator: bigint;
  if (input.amountKind === 'FIXED') {
    numerator = value * payable * out;
    denominator = 10n ** 4n * total;
  } else {
    numerator = scaled(input.baseAmount, 4) * value * payable * out;
    denominator = 10n ** 4n * 10n ** 4n * 100n * total;
  }
  return unscaled(divideRounded(numerator, denominator), input.decimals);
}

// ── Views ───────────────────────────────────────────────────────────────────

export interface RunRow {
  runId: string;
  companyCode: string;
  fiscalYear: number;
  period: number;
  periodFrom: string;
  periodTo: string;
  totalDays: number;
  currency: string;
  status: PayrollRunStatus;
}

export interface PayrollRunRow extends RunRow {
  employeeCount: number;
  exceptionCount: number;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  employerCost: string;
  calculatedBy: string;
  calculatedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** The run this off-cycle run follows (it excluded employees that run covers); null otherwise. */
  predecessorRunId: string | null;
}

export interface RunException {
  personnelNumber: string;
  employeeName: string | null;
  reasonCode: string;
  message: string;
  remedy: string | null;
  /** True when the exception only informs (ALREADY_COVERED) and does not block release. */
  informational: boolean;
}

export interface PayrollRunView extends PayrollRunRow {
  exceptions: RunException[];
  /** PROPOSED only: why the calculation no longer matches the data (empty = current). Recalculate before release. */
  staleReasons: string[];
  /** One-time adjustments of this company and period still awaiting approval. */
  pendingAdjustments: number;
  /** Approved adjustments of this period for employees this run does not pay (covered elsewhere, or an exception). */
  unpickedAdjustments: number;
}

export interface EmployeeRunInput {
  personnelNumber: string;
}

export interface ResultRow {
  resultId: string;
  runId: string;
  personnelNumber: string;
  employeeName: string | null;
  origin: string;
  currency: string;
  payableDays: string;
  totalDays: string;
  coveredDays: string;
  unpaidLeaveDays: string;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  employerCost: string;
  costCenter: string | null;
  controllingArea: string | null;
}

export interface ResultLineRow {
  lineId: string;
  lineNo: number;
  segmentFrom: string;
  segmentTo: string;
  payableDays: string;
  structureCode: string;
  baseAmount: string;
  componentCode: string;
  componentKind: string;
  amountKind: string | null;
  amountValue: string | null;
  amount: string;
  debitAccount: string | null;
  creditAccount: string | null;
  costReceiverCategory: string;
  costCenter: string | null;
  controllingArea: string | null;
  /** 9318: where the line came from and the basis it was calculated on. */
  sourceType: string;
  sourceId: string | null;
  prorationPolicy: string | null;
  calcBasis: string | null;
}

const text = (v: unknown) => (v === null || v === undefined ? '0' : String(v));
const stamp = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

// ── Reading ─────────────────────────────────────────────────────────────────

const RUN_SELECT = sql`
  select r.run_id, r.company_code, r.fiscal_year, r.period, r.period_from::text as period_from,
         r.period_to::text as period_to, r.total_days, r.currency, r.status, r.employee_count,
         r.exception_count, r.calculated_by, r.calculated_at, r.released_by, r.released_at,
         r.cancelled_by, r.cancelled_at, r.cancel_reason, r.predecessor_run_id,
         coalesce(t.gross, 0)::text as gross_pay, coalesce(t.deductions, 0)::text as total_deductions,
         coalesce(t.net, 0)::text as net_pay, coalesce(t.employer, 0)::text as employer_cost
    from payroll_run r
    left join lateral (
      select sum(p.gross_pay) as gross, sum(p.total_deductions) as deductions,
             sum(p.net_pay) as net, sum(p.employer_cost) as employer
        from payroll_result p where p.client = r.client and p.run_id = r.run_id
    ) t on true`;

type RunSqlRow = Record<string, unknown>;
function runRowOf(r: RunSqlRow): PayrollRunRow {
  return {
    runId: String(r.run_id),
    companyCode: String(r.company_code),
    fiscalYear: Number(r.fiscal_year),
    period: Number(r.period),
    periodFrom: day(r.period_from)!,
    periodTo: day(r.period_to)!,
    totalDays: Number(r.total_days),
    currency: String(r.currency),
    status: String(r.status) as PayrollRunStatus,
    employeeCount: Number(r.employee_count),
    exceptionCount: Number(r.exception_count),
    grossPay: text(r.gross_pay),
    totalDeductions: text(r.total_deductions),
    netPay: text(r.net_pay),
    employerCost: text(r.employer_cost),
    calculatedBy: String(r.calculated_by),
    calculatedAt: stamp(r.calculated_at)!,
    releasedBy: (r.released_by as string | null) ?? null,
    releasedAt: stamp(r.released_at),
    cancelledBy: (r.cancelled_by as string | null) ?? null,
    cancelledAt: stamp(r.cancelled_at),
    cancelReason: (r.cancel_reason as string | null) ?? null,
    predecessorRunId: (r.predecessor_run_id as string | null) ?? null,
  };
}

export async function runView(tx: Tx, client: string, runId: string): Promise<PayrollRunView | null> {
  const rows = (await tx.execute(sql`${RUN_SELECT} where r.client = ${client} and r.run_id = ${runId}`)) as unknown as RunSqlRow[];
  if (!rows[0]) return null;
  const exceptions = await tx
    .select({
      personnelNumber: payrollRunException.personnelNumber,
      employeeName: employee.fullName,
      reasonCode: payrollRunException.reasonCode,
      message: payrollRunException.message,
      remedy: payrollRunException.remedy,
    })
    .from(payrollRunException)
    .leftJoin(employee, and(eq(employee.client, payrollRunException.client), eq(employee.personnelNumber, payrollRunException.personnelNumber)))
    .where(and(eq(payrollRunException.client, client), eq(payrollRunException.runId, runId)))
    .orderBy(asc(payrollRunException.personnelNumber), asc(payrollRunException.seq));
  const base = runRowOf(rows[0]);
  const standing = await adjustmentStanding(tx, client, base);
  return {
    ...base,
    exceptions: exceptions.map((e) => ({ ...e, employeeName: e.employeeName ?? null, remedy: e.remedy ?? null, informational: INFORMATIONAL_EXCEPTIONS.has(e.reasonCode) })),
    staleReasons: base.status === 'PROPOSED' ? await staleReasonsOf(tx, client, base) : [],
    pendingAdjustments: standing.pending,
    unpickedAdjustments: standing.unpicked,
  };
}

/** Pending adjustments of the run's company and period, and approved ones for employees the run does not pay. */
async function adjustmentStanding(tx: Tx, client: string, run: RunRow): Promise<{ pending: number; unpicked: number }> {
  const rows = (await tx.execute(sql`
    select count(*) filter (where a.status = 'PENDING')::int as pending,
           count(*) filter (where a.status = 'APPROVED' and not exists (
             select 1 from payroll_result r where r.client = a.client and r.run_id = ${run.runId} and r.personnel_number = a.personnel_number))::int as unpicked
      from payroll_adjustment a
     where a.client = ${client} and a.company_code = ${run.companyCode} and a.fiscal_year = ${run.fiscalYear} and a.period = ${run.period}
  `)) as unknown as Array<{ pending: number; unpicked: number }>;
  return { pending: Number(rows[0]?.pending ?? 0), unpicked: Number(rows[0]?.unpicked ?? 0) };
}

/**
 * Why a PROPOSED run's results no longer match the data it was calculated from. Exact for one-time adjustments
 * (the approved set must equal the set the lines carry); by timestamp for recurring entries (any entry written
 * after the calculation, for an employee of the run). Empty when the calculation is current.
 */
export async function staleReasonsOf(tx: Tx, client: string, run: RunRow & { calculatedAt?: string }): Promise<string[]> {
  const reasons: string[] = [];
  const mismatched = (await tx.execute(sql`
    select a.adjustment_id, 'approved after calculation' as why
      from payroll_adjustment a
     where a.client = ${client} and a.company_code = ${run.companyCode} and a.fiscal_year = ${run.fiscalYear}
       and a.period = ${run.period} and a.status = 'APPROVED'
       and exists (select 1 from payroll_result r where r.client = a.client and r.run_id = ${run.runId} and r.personnel_number = a.personnel_number)
       and not exists (select 1 from payroll_result_line l join payroll_result r on r.client = l.client and r.result_id = l.result_id
                        where l.client = a.client and r.run_id = ${run.runId} and l.source_type = 'ONE_TIME' and l.source_id = a.adjustment_id)
    union all
    select l.source_id, 'no longer approved'
      from payroll_result_line l join payroll_result r on r.client = l.client and r.result_id = l.result_id
     where l.client = ${client} and r.run_id = ${run.runId} and l.source_type = 'ONE_TIME'
       and not exists (select 1 from payroll_adjustment a where a.client = l.client and a.adjustment_id = l.source_id and a.status = 'APPROVED')
  `)) as unknown as Array<{ adjustment_id: string; why: string }>;
  for (const m of mismatched) reasons.push(`One-time adjustment ${m.adjustment_id} was ${m.why}.`);
  {
    const changed = (await tx.execute(sql`
      select distinct e.personnel_number
        from employee_pay_component e
       where e.client = ${client}
         and greatest(e.created_at, coalesce(e.changed_at, e.created_at)) > (select calculated_at from payroll_run where client = ${client} and run_id = ${run.runId})
         and e.personnel_number in (
           select personnel_number from payroll_result where client = ${client} and run_id = ${run.runId}
           union select personnel_number from payroll_run_exception where client = ${client} and run_id = ${run.runId})
       order by 1
    `)) as unknown as Array<{ personnel_number: string }>;
    if (changed.length) reasons.push(`Recurring pay components changed after the calculation for ${changed.map((c) => c.personnel_number).join(', ')}.`);
  }
  return reasons;
}

/** One run with its exceptions. Refused when the run's company lies outside the caller's scope. */
export async function getPayrollRun(clientInput: string, runIdInput: string, access?: PayrollAccess): Promise<PayrollRunView | null> {
  const client = parse(clientField, clientInput);
  const runId = parse(runIdField, runIdInput);
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, READ);
    const view = await runView(tx, client, runId);
    if (view) assertCompanyScope(grant, view.companyCode, refuse);
    return view;
  });
}

/** Every run of the tenant, newest period first. */
/** The runs in the caller's Company Code scope, newest period first. A list filters; it never refuses a run. */
export async function listPayrollRuns(clientInput: string, access?: PayrollAccess): Promise<PayrollRunRow[]> {
  const client = parse(clientField, clientInput);
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, READ);
    const rows = (await tx.execute(sql`${RUN_SELECT} where r.client = ${client}
      order by r.fiscal_year desc, r.period desc, r.company_code, r.calculated_at desc`)) as unknown as RunSqlRow[];
    return rows.map(runRowOf).filter((r) => reachesCompany(grant, r.companyCode));
  });
}

/** The company a run pays, for the read services' scope check. */
async function companyOfRun(tx: Tx, client: string, runId: string): Promise<string | null> {
  const [row] = await tx.select({ companyCode: payrollRun.companyCode }).from(payrollRun)
    .where(and(eq(payrollRun.client, client), eq(payrollRun.runId, runId))).limit(1);
  return row?.companyCode ?? null;
}

async function resultRows(tx: Tx, client: string, where: ReturnType<typeof and>): Promise<ResultRow[]> {
  const rows = await tx
    .select({ r: payrollResult, employeeName: employee.fullName })
    .from(payrollResult)
    .leftJoin(employee, and(eq(employee.client, payrollResult.client), eq(employee.personnelNumber, payrollResult.personnelNumber)))
    .where(where)
    .orderBy(asc(payrollResult.personnelNumber));
  return rows.map(({ r, employeeName }) => ({
    resultId: r.resultId,
    runId: r.runId,
    personnelNumber: r.personnelNumber,
    employeeName: employeeName ?? null,
    origin: r.origin,
    currency: r.currency,
    payableDays: text(r.payableDays),
    totalDays: text(r.totalDays),
    coveredDays: text(r.coveredDays),
    unpaidLeaveDays: text(r.unpaidLeaveDays),
    grossPay: text(r.grossPay),
    totalDeductions: text(r.totalDeductions),
    netPay: text(r.netPay),
    employerCost: text(r.employerCost),
    costCenter: r.costCenter ?? null,
    controllingArea: r.controllingArea ?? null,
  }));
}

/** The results of one run, optionally for one employee. */
export async function listResults(clientInput: string, runIdInput: string, personnelNumber?: string, access?: PayrollAccess): Promise<ResultRow[]> {
  const client = parse(clientField, clientInput);
  const runId = parse(runIdField, runIdInput);
  const person = personnelNumber?.trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, READ);
    const company = await companyOfRun(tx, client, runId);
    if (company) assertCompanyScope(grant, company, refuse);
    return resultRows(tx, client, and(
      eq(payrollResult.client, client),
      eq(payrollResult.runId, runId),
      person ? eq(payrollResult.personnelNumber, person) : undefined,
    ));
  });
}

async function linesOf(tx: Tx, client: string, resultId: string): Promise<ResultLineRow[]> {
  const rows = await tx
    .select()
    .from(payrollResultLine)
    .where(and(eq(payrollResultLine.client, client), eq(payrollResultLine.resultId, resultId)))
    .orderBy(asc(payrollResultLine.lineNo));
  return rows.map((l) => ({
    lineId: l.lineId,
    lineNo: l.lineNo,
    segmentFrom: l.segmentFrom,
    segmentTo: l.segmentTo,
    payableDays: text(l.payableDays),
    structureCode: l.structureCode,
    baseAmount: text(l.baseAmount),
    componentCode: l.componentCode,
    componentKind: l.componentKind,
    amountKind: l.amountKind ?? null,
    amountValue: l.amountValue === null ? null : text(l.amountValue),
    amount: text(l.amount),
    debitAccount: l.debitAccount ?? null,
    creditAccount: l.creditAccount ?? null,
    costReceiverCategory: l.costReceiverCategory,
    costCenter: l.costCenter ?? null,
    controllingArea: l.controllingArea ?? null,
    sourceType: l.sourceType,
    sourceId: l.sourceId ?? null,
    prorationPolicy: l.prorationPolicy ?? null,
    calcBasis: l.calcBasis ?? null,
  }));
}

export async function getResultWithLines(
  clientInput: string,
  resultIdInput: string,
  access?: PayrollAccess,
): Promise<{ result: ResultRow; lines: ResultLineRow[] } | null> {
  const client = parse(clientField, clientInput);
  const resultId = parse(runIdField, resultIdInput);
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, READ);
    const [result] = await resultRows(tx, client, and(eq(payrollResult.client, client), eq(payrollResult.resultId, resultId)));
    if (!result) return null;
    const company = await companyOfRun(tx, client, result.runId);
    if (company) assertCompanyScope(grant, company, refuse);
    return { result, lines: await linesOf(tx, client, resultId) };
  });
}

// ── The calculation ─────────────────────────────────────────────────────────

export async function currencyDecimals(tx: Tx, currency: string): Promise<number> {
  const rows = (await tx.execute(sql`select decimal_places from currency where code = ${currency} limit 1`)) as unknown as Array<{ decimal_places: number }>;
  if (!rows[0]) refuse('PAYROLL_CURRENCY', `Currency ${currency} is not defined.`, 'Maintain it in the currency table.');
  return Number(rows[0].decimal_places);
}

export async function loadRun(tx: Tx, client: string, runId: string) {
  const [row] = await tx.select().from(payrollRun).where(and(eq(payrollRun.client, client), eq(payrollRun.runId, runId))).limit(1);
  if (!row) refuse('RUN_UNKNOWN', `Payroll run ${runId} does not exist.`, `Choose a run at ${PAYROLL_RUN_ROUTE}.`);
  return row;
}

export function runRowFrom(row: typeof payrollRun.$inferSelect): RunRow {
  return {
    runId: row.runId,
    companyCode: row.companyCode,
    fiscalYear: row.fiscalYear,
    period: row.period,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    totalDays: row.totalDays,
    currency: row.currency,
    status: row.status as PayrollRunStatus,
  };
}

/** The company of a position on a day: its own, or else its cost centre's (the phase 1 rule). */
const POSITIONS_IN_PERIOD = (client: string, personnelNumber: string | null, from: string, to: string) => sql`
  select pa.personnel_number, pa.valid_from::text as valid_from, pa.valid_to::text as valid_to,
         pa.controlling_area, pa.cost_center,
         coalesce(pa.company_code, (
           select cc.company_code from cost_center cc
            where cc.client = pa.client and cc.controlling_area = pa.controlling_area and cc.cost_center = pa.cost_center
              and cc.valid_from <= greatest(pa.valid_from, ${from}::date) and cc.valid_to >= greatest(pa.valid_from, ${from}::date)
            order by cc.valid_from desc limit 1)) as company_code
    from position_assignment pa
   where pa.client = ${client}
     ${personnelNumber === null ? sql`` : sql`and pa.personnel_number = ${personnelNumber}`}
     and pa.valid_from <= ${to}::date
     and (pa.valid_to is null or pa.valid_to >= ${from}::date)
   order by pa.personnel_number, pa.valid_from`;

type PositionSqlRow = { personnel_number: string; valid_from: string; valid_to: string | null; controlling_area: string; cost_center: string; company_code: string | null };

/** The employees a run for this company and period selects: a position overlapping it, in the company. */
export async function selectEmployees(tx: Tx, client: string, run: RunRow): Promise<string[]> {
  const rows = (await tx.execute(POSITIONS_IN_PERIOD(client, null, run.periodFrom, run.periodTo))) as unknown as PositionSqlRow[];
  return [...new Set(rows.filter((r) => r.company_code === run.companyCode).map((r) => r.personnel_number))].sort();
}

interface Segment {
  from: string;
  to: string;
  controllingArea: string;
  costCenter: string;
  assignment: { assignmentId: string; structureCode: string; baseAmount: string; currency: string };
}

/**
 * Calculate one employee's result for a run and write it with its lines. Throws a named
 * `PayrollRunError` for anything that stops the employee being paid; `calculateRun` records that as
 * an exception. Readiness is assumed to have been checked by `validateEmployeeForRun`; what is
 * refused here is what the calculation itself depends on.
 */
export interface ResultDraft {
  result: typeof payrollResult.$inferInsert;
  lines: Array<typeof payrollResultLine.$inferInsert>;
}

export async function calculateResult(tx: Tx, client: string, run: RunRow, person: EmployeeRunInput, changedBy = 'SYSTEM'): Promise<ResultRow> {
  const draft = await computeResultDraft(tx, client, run, person, changedBy);
  await tx.insert(payrollResult).values(draft.result);
  if (draft.lines.length) await tx.insert(payrollResultLine).values(draft.lines);
  const [row] = await resultRows(tx, client, and(eq(payrollResult.client, client), eq(payrollResult.resultId, draft.result.resultId!)));
  return row!;
}

/**
 * Everything `calculateResult` decides, without writing: the result row and its lines as they would be
 * stored. Reads only, so a background run can stage it and publish it later in one transaction. Throws
 * a named `PayrollRunError` for anything that stops the employee being paid.
 */
export async function computeResultDraft(tx: Tx, client: string, run: RunRow, person: EmployeeRunInput, changedBy = 'SYSTEM'): Promise<ResultDraft> {
  const pn = person.personnelNumber;
  const positions = ((await tx.execute(POSITIONS_IN_PERIOD(client, pn, run.periodFrom, run.periodTo))) as unknown as PositionSqlRow[])
    .filter((p) => p.company_code === run.companyCode)
    .map((p) => ({ ...p, valid_from: day(p.valid_from)!, valid_to: day(p.valid_to) }));
  const assignments = ((await tx.execute(sql`
    select assignment_id, structure_code, base_amount::text as base_amount, currency,
           valid_from::text as valid_from, valid_to::text as valid_to
      from salary_structure_assignment
     where client = ${client} and personnel_number = ${pn}
       and valid_from <= ${run.periodTo}::date and (valid_to is null or valid_to >= ${run.periodFrom}::date)
  `)) as unknown as Array<{ assignment_id: string; structure_code: string; base_amount: string; currency: string; valid_from: string; valid_to: string | null }>)
    .map((a) => ({ ...a, valid_from: day(a.valid_from)!, valid_to: day(a.valid_to) }));

  // Day by day: the position in this company and the salary assignment, folded into segments.
  const segments: Segment[] = [];
  for (let n = dayNumber(run.periodFrom); n <= dayNumber(run.periodTo); n++) {
    const d = isoOf(n);
    const position = positions.find((p) => p.valid_from <= d && (p.valid_to === null || p.valid_to >= d));
    if (!position) continue;
    const standing = assignments.filter((a) => a.valid_from <= d && (a.valid_to === null || a.valid_to >= d));
    if (standing.length !== 1) {
      refuse(
        standing.length === 0 ? 'NO_STRUCTURE' : 'OVERLAPPING_STRUCTURES',
        `Employee ${pn} has ${standing.length === 0 ? 'no pay structure' : 'two pay structures'} on ${d}.`,
        `Correct the assignment at ${EMPLOYEE_ROUTE}?employee=${pn}, then recalculate the run.`,
      );
    }
    const a = standing[0]!;
    const last = segments.at(-1);
    if (
      last && dayNumber(last.to) === n - 1 && last.assignment.assignmentId === a.assignment_id &&
      last.costCenter === position.cost_center && last.controllingArea === position.controlling_area
    ) {
      last.to = d;
    } else {
      segments.push({
        from: d, to: d, controllingArea: position.controlling_area, costCenter: position.cost_center,
        assignment: { assignmentId: a.assignment_id, structureCode: a.structure_code, baseAmount: a.base_amount, currency: String(a.currency).trim() },
      });
    }
  }
  if (segments.length === 0) {
    refuse(
      'NOT_COVERED',
      `Employee ${pn} holds no position in company ${run.companyCode} on any day from ${run.periodFrom} to ${run.periodTo}; nothing can be paid.`,
      `Check the position assignment at ${EMPLOYEE_ROUTE}?employee=${pn}.`,
    );
  }
  for (const s of segments) {
    if (s.assignment.currency !== run.currency) {
      refuse(
        'CURRENCY_DIFFERS',
        `Employee ${pn} is paid in ${s.assignment.currency} from ${s.from}, and the run for company ${run.companyCode} is in ${run.currency}; a run does not convert currencies.`,
        `Assign the pay structure in ${run.currency} at ${EMPLOYEE_ROUTE}?employee=${pn}.`,
      );
    }
  }

  const company = await getCompanyCode(tx, client, run.companyCode);
  const chart = company?.chartOfAccounts ?? null;
  if (!chart) refuse('NO_CHART', `Company code ${run.companyCode} has no chart of accounts.`, 'Assign one in Company Codes (CFG.ORG.COMPANYCODE.DEFINE).');

  // Unpaid time comes from two disjoint sources, so nothing is counted twice:
  //  - legacy absences (policy_managed = false): approved, of an unpaid time type;
  //  - policy-managed absences: the unpaid spans of their active allocations (the split kept at approval).
  const absences = ((await tx.execute(sql`
    select a.valid_from::text as valid_from, a.valid_to::text as valid_to, a.status, t.is_paid
      from absence a
      join time_type t on t.client = a.client and t.code = a.time_type_code
     where a.client = ${client} and a.personnel_number = ${pn}
       and a.status = 'APPROVED' and t.is_paid = false and a.policy_managed = false
       and a.valid_from <= ${run.periodTo}::date and (a.valid_to is null or a.valid_to >= ${run.periodFrom}::date)
    union all
    select al.alloc_from::text, al.alloc_to::text, a.status, false as is_paid
      from absence_allocation al
      join absence a on a.client = al.client and a.id = al.absence_id
     where al.client = ${client} and al.personnel_number = ${pn}
       and a.status = 'APPROVED' and a.policy_managed = true
       and al.is_paid = false and al.reversed_at is null
       and al.alloc_from <= ${run.periodTo}::date and al.alloc_to >= ${run.periodFrom}::date
  `)) as unknown as Array<{ valid_from: string; valid_to: string | null; status: string; is_paid: boolean }>)
    .map((a) => ({ validFrom: day(a.valid_from)!, validTo: day(a.valid_to), status: a.status, isPaid: a.is_paid }));

  const decimals = await currencyDecimals(tx, run.currency);
  // One writer per employee: a recurring entry is not written while this employee is being calculated, and the
  // calculation reads only what was committed before it started (staleness is judged against that).
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`employee-pay:${client}:${pn}`}, 0))`);
  const entries = ((await tx.execute(sql`
    select entry_id, component_code, mode, amount_kind, amount_value::text as amount_value, currency,
           valid_from::text as valid_from, valid_to::text as valid_to, proration_policy
      from employee_pay_component
     where client = ${client} and personnel_number = ${pn} and status = 'ACTIVE'
       and valid_from <= ${run.periodTo}::date and (valid_to is null or valid_to >= ${run.periodFrom}::date)
     order by valid_from, component_code, entry_id
  `)) as unknown as Array<{ entry_id: string; component_code: string; mode: 'ADD' | 'REPLACE'; amount_kind: 'FIXED' | 'PERCENT_OF_BASE'; amount_value: string; currency: string; valid_from: string; valid_to: string | null; proration_policy: string }>)
    .map((e) => ({ ...e, valid_from: day(e.valid_from)!, valid_to: day(e.valid_to), currency: String(e.currency).trim() }));
  const adjustments = (await tx.execute(sql`
    select adjustment_id, component_code, component_kind, amount::text as amount, currency, reason, source_reference
      from payroll_adjustment
     where client = ${client} and company_code = ${run.companyCode} and fiscal_year = ${run.fiscalYear}
       and period = ${run.period} and personnel_number = ${pn} and status = 'APPROVED'
     order by created_at, adjustment_id
  `)) as unknown as Array<{ adjustment_id: string; component_code: string; component_kind: string; amount: string; currency: string; reason: string; source_reference: string | null }>;

  const mappingCache = new Map<string, Record<string, unknown> | null>();
  const mappingOf = async (code: string) => {
    if (!mappingCache.has(code)) {
      const rows = (await tx.execute(sql`
        select p.code as component_code, p.component_kind, p.is_valid, m.debit_account, m.credit_account,
               m.cost_receiver_category, m.controlling_area as fixed_area, m.cost_center as fixed_centre,
               (m.component_code is not null) as mapped
          from pay_component p
          left join pay_component_config m
            on m.client = p.client and m.component_code = p.code and m.chart_of_accounts = ${chart}
         where p.client = ${client} and p.code = ${code}
      `)) as unknown as Array<Record<string, unknown>>;
      mappingCache.set(code, rows[0] ?? null);
    }
    return mappingCache.get(code) ?? null;
  };
  const componentCache = new Map<string, Array<Record<string, unknown>>>();
  const componentsOf = async (structureCode: string) => {
    if (!componentCache.has(structureCode)) {
      componentCache.set(structureCode, (await tx.execute(sql`
        select c.component_code, c.amount_kind, c.amount_value::text as amount_value, p.component_kind,
               m.debit_account, m.credit_account, m.cost_receiver_category, m.controlling_area as fixed_area,
               m.cost_center as fixed_centre, (m.component_code is not null) as mapped
          from salary_structure_component c
          join pay_component p on p.client = c.client and p.code = c.component_code
          left join pay_component_config m
            on m.client = c.client and m.component_code = c.component_code and m.chart_of_accounts = ${chart}
         where c.client = ${client} and c.structure_code = ${structureCode}
         order by c.component_code
      `)) as unknown as Array<Record<string, unknown>>);
    }
    return componentCache.get(structureCode)!;
  };

  const resultId = randomUUID();
  const lines: Array<typeof payrollResultLine.$inferInsert> = [];
  const totals = { EARNING: 0n, DEDUCTION: 0n, EMPLOYER_CONTRIBUTION: 0n } as Record<string, bigint>;

  /** A mapping row that a line may be written from: the component exists, is not an EOS provision and is mapped. */
  const usable = (c: Record<string, unknown> | null, code: string, where: string) => {
    if (!c) refuse('COMPONENT_UNKNOWN', `Component ${code} (${where}) does not exist.`, `Define it at ${PAY_COMPONENT_ROUTE}.`);
    if (String(c.component_kind) === EOS_PROVISION_KIND) {
      refuse('EOS_NOT_SUPPORTED', `${where} names end-of-service provision component ${code}; a run does not calculate those yet.`, `Remove ${code} from ${where}.`);
    }
    if (!c.mapped) {
      refuse('COMPONENT_UNMAPPED', `Component ${code} is not mapped to an account in chart ${chart} of company ${run.companyCode}.`, `Map it at ${PAY_COMPONENT_ROUTE}.`);
    }
    return c;
  };
  const addLine = async (o: {
    segment: Segment; c: Record<string, unknown>; code: string; from: string; to: string; payableDays: string;
    amountKind: 'FIXED' | 'PERCENT_OF_BASE'; amountValue: string; amount: string; source: LineSource;
    sourceId: string | null; policy: string | null; basis: string;
  }) => {
    const kind = String(o.c.component_kind);
    const receiver = String(o.c.cost_receiver_category);
    let costCenter: string | null = null;
    let controllingArea: string | null = null;
    if (receiver === 'ASSIGNMENT') {
      const standing = (await tx.execute(sql`
        select 1 from cost_center where client = ${client} and controlling_area = ${o.segment.controllingArea}
           and cost_center = ${o.segment.costCenter} and valid_from <= ${o.segment.from}::date and valid_to >= ${o.segment.from}::date limit 1
      `)) as unknown as unknown[];
      if (standing.length === 0) {
        refuse('NO_COST_CENTRE', `Component ${o.code} charges to employee ${pn}'s cost centre, and cost centre ${o.segment.costCenter} does not stand in controlling area ${o.segment.controllingArea} on ${o.segment.from}.`, `Give the position assignment a valid cost centre at ${EMPLOYEE_ROUTE}?employee=${pn}.`);
      }
      costCenter = o.segment.costCenter;
      controllingArea = o.segment.controllingArea;
    } else if (receiver === 'FIXED') {
      costCenter = (o.c.fixed_centre as string | null) ?? null;
      controllingArea = (o.c.fixed_area as string | null) ?? null;
    }
    totals[kind] = (totals[kind] ?? 0n) + scaled(o.amount, decimals);
    lines.push({
      client, resultId, lineId: randomUUID(), lineNo: lines.length + 1,
      segmentFrom: o.from, segmentTo: o.to, payableDays: o.payableDays,
      structureCode: o.segment.assignment.structureCode, baseAmount: o.segment.assignment.baseAmount,
      componentCode: o.code, componentKind: kind, amountKind: o.amountKind, amountValue: o.amountValue, amount: o.amount,
      debitAccount: (o.c.debit_account as string | null) ?? null, creditAccount: (o.c.credit_account as string | null) ?? null,
      costReceiverCategory: receiver, costCenter, controllingArea, createdBy: changedBy,
      sourceType: o.source, sourceId: o.sourceId, prorationPolicy: o.policy, calcBasis: o.basis.slice(0, 240),
    });
  };
  const trimmed = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
  const rule = (kind: 'FIXED' | 'PERCENT_OF_BASE', value: string, base: string) =>
    kind === 'FIXED' ? `fixed ${value} per period` : `${trimmed(value)}% of the assigned base salary ${base} (not taxable gross)`;
  const prorated = (payable: number, total: number) => `× ${payable}/${total} payable days`;

  let coveredDays = 0;
  let unpaidDays = 0;
  let payableDays = 0;
  for (const segment of segments) {
    const days = payableDaysFor({
      periodFrom: run.periodFrom, periodTo: run.periodTo,
      assignmentFrom: segment.from, assignmentTo: segment.to, absences,
    });
    coveredDays += days.coveredDays;
    unpaidDays += days.unpaidLeaveDays;
    payableDays += days.payableDays;
    const components = await componentsOf(segment.assignment.structureCode);
    if (components.length === 0) {
      refuse('STRUCTURE_EMPTY', `Structure ${segment.assignment.structureCode} names no components.`, `Add components at ${SALARY_STRUCTURE_ROUTE}.`);
    }
    for (const c of components) {
      const code = String(c.component_code);
      const kind = String(c.component_kind);
      if (kind === EOS_PROVISION_KIND) {
        refuse('EOS_NOT_SUPPORTED', `Structure ${segment.assignment.structureCode} names end-of-service provision component ${code}; a run does not calculate those yet.`, `Remove ${code} from the structure at ${SALARY_STRUCTURE_ROUTE}?structure=${segment.assignment.structureCode}.`);
      }
      if (!c.mapped) {
        refuse('COMPONENT_UNMAPPED', `Component ${code} is not mapped to an account in chart ${chart} of company ${run.companyCode}.`, `Map it at ${PAY_COMPONENT_ROUTE}.`);
      }
      const amountKind = String(c.amount_kind) as 'FIXED' | 'PERCENT_OF_BASE';
      // A REPLACE entry suppresses this structure rule on the days it covers; the rule runs on the rest.
      const cuts = entries.filter((e) => e.mode === 'REPLACE' && e.component_code === code);
      for (const [from, to] of daysOutside(segment.from, segment.to, cuts.map((e) => [e.valid_from, e.valid_to] as const))) {
        const whole = from === segment.from && to === segment.to;
        const sub = whole ? days : payableDaysFor({ periodFrom: run.periodFrom, periodTo: run.periodTo, assignmentFrom: from, assignmentTo: to, absences });
        const amount = calculateComponent({
          amountKind, amountValue: String(c.amount_value), baseAmount: segment.assignment.baseAmount,
          payableDays: sub.payableDays, totalDays: sub.totalDays, decimals,
        });
        await addLine({
          segment, c, code, from, to, payableDays: String(sub.payableDays), amountKind, amountValue: String(c.amount_value), amount,
          source: 'STRUCTURE', sourceId: null, policy: null,
          basis: `Structure ${segment.assignment.structureCode}: ${rule(amountKind, String(c.amount_value), segment.assignment.baseAmount)} ${prorated(sub.payableDays, sub.totalDays)}`,
        });
      }
    }
    // Employee recurring entries (not FULL_PERIOD), for the part of this segment they cover.
    for (const e of entries.filter((x) => x.proration_policy !== 'FULL_PERIOD')) {
      const from = e.valid_from > segment.from ? e.valid_from : segment.from;
      const to = e.valid_to !== null && e.valid_to < segment.to ? e.valid_to : segment.to;
      if (from > to) continue;
      const c = usable(await mappingOf(e.component_code), e.component_code, `employee entry ${e.entry_id}`);
      if (!c.is_valid) refuse('COMPONENT_RETIRED', `Component ${e.component_code} is retired; employee ${pn} still has an entry for it.`, `Withdraw or end the entry at ${EMPLOYEE_ROUTE}?employee=${pn}.`);
      if (e.currency !== run.currency) {
        refuse('CURRENCY_DIFFERS', `Employee ${pn}'s entry for ${e.component_code} is in ${e.currency}, and the run for company ${run.companyCode} is in ${run.currency}; a run does not convert currencies.`, `Withdraw it and enter it in ${run.currency} at ${EMPLOYEE_ROUTE}?employee=${pn}.`);
      }
      const unreduced = e.proration_policy === 'NO_UNPAID_LEAVE_REDUCTION';
      const sub = payableDaysFor({ periodFrom: run.periodFrom, periodTo: run.periodTo, assignmentFrom: from, assignmentTo: to, absences: unreduced ? [] : absences });
      const amount = calculateComponent({
        amountKind: e.amount_kind, amountValue: e.amount_value, baseAmount: segment.assignment.baseAmount,
        payableDays: sub.payableDays, totalDays: sub.totalDays, decimals,
      });
      await addLine({
        segment, c, code: e.component_code, from, to, payableDays: String(sub.payableDays), amountKind: e.amount_kind, amountValue: e.amount_value, amount,
        source: e.mode === 'REPLACE' ? 'EMPLOYEE_REPLACE' : 'EMPLOYEE_ADD', sourceId: e.entry_id, policy: e.proration_policy,
        basis: `Employee ${e.mode === 'REPLACE' ? 'replacement' : 'addition'} ${e.valid_from}..${e.valid_to ?? 'open'}: ${rule(e.amount_kind, e.amount_value, segment.assignment.baseAmount)} ${prorated(sub.payableDays, sub.totalDays)}${unreduced ? ' (unpaid leave not deducted)' : ''}`,
      });
    }
  }

  // FULL_PERIOD entries: once per employee and period, never once per segment.
  const full = entries.filter((e) => e.proration_policy === 'FULL_PERIOD');
  if (full.length > 0) {
    const first = segments[0]!;
    const last = segments.at(-1)!;
    for (const e of full) {
      const ambiguous = (why: string): never => refuse(
        'FULL_PERIOD_AMBIGUOUS',
        `Employee ${pn}'s full-period entry for ${e.component_code} (${e.entry_id}) is ambiguous in ${run.periodFrom} to ${run.periodTo}: ${why}.`,
        `Use "payable calendar days" for this entry, end/start entries on period boundaries, or enter a one-time payroll adjustment for ${run.period}/${run.fiscalYear}. Then recalculate the run.`,
      );
      if (new Set(segments.map((s) => s.assignment.assignmentId)).size > 1) ambiguous('the employee has more than one salary assignment, so the percentage base is not unique');
      if (e.valid_from > first.from || (e.valid_to !== null && e.valid_to < last.to)) ambiguous(`the entry does not cover the employee's whole employment in the period (${first.from} to ${last.to})`);
      if (entries.some((o) => o.entry_id !== e.entry_id && o.component_code === e.component_code && o.mode === e.mode)) ambiguous('another entry for the same component and mode overlaps the period');
      const c = usable(await mappingOf(e.component_code), e.component_code, `employee entry ${e.entry_id}`);
      if (!c.is_valid) refuse('COMPONENT_RETIRED', `Component ${e.component_code} is retired; employee ${pn} still has an entry for it.`, `Withdraw or end the entry at ${EMPLOYEE_ROUTE}?employee=${pn}.`);
      if (e.currency !== run.currency) {
        refuse('CURRENCY_DIFFERS', `Employee ${pn}'s entry for ${e.component_code} is in ${e.currency}, and the run for company ${run.companyCode} is in ${run.currency}; a run does not convert currencies.`, `Withdraw it and enter it in ${run.currency} at ${EMPLOYEE_ROUTE}?employee=${pn}.`);
      }
      const amount = calculateComponent({
        amountKind: e.amount_kind, amountValue: e.amount_value, baseAmount: last.assignment.baseAmount,
        payableDays: run.totalDays, totalDays: run.totalDays, decimals,
      });
      await addLine({
        segment: last, c, code: e.component_code, from: first.from, to: last.to, payableDays: String(run.totalDays),
        amountKind: e.amount_kind, amountValue: e.amount_value, amount,
        source: e.mode === 'REPLACE' ? 'EMPLOYEE_REPLACE' : 'EMPLOYEE_ADD', sourceId: e.entry_id, policy: 'FULL_PERIOD',
        basis: `Employee ${e.mode === 'REPLACE' ? 'replacement' : 'addition'}, full period, applied once: ${rule(e.amount_kind, e.amount_value, last.assignment.baseAmount)}`,
      });
    }
  }

  // Approved one-time adjustments of this company, year and period: fixed, not prorated, applied once at release.
  const lastSegment = segments.at(-1)!;
  for (const a of adjustments) {
    const c = usable(await mappingOf(a.component_code), a.component_code, `adjustment ${a.adjustment_id}`);
    if (String(c.component_kind) !== a.component_kind) {
      refuse('ADJUSTMENT_KIND_CHANGED', `Adjustment ${a.adjustment_id} was entered as ${a.component_kind}, and component ${a.component_code} is now ${String(c.component_kind)}.`, 'Cancel the adjustment and enter it again.');
    }
    if (String(a.currency).trim() !== run.currency) {
      refuse('CURRENCY_DIFFERS', `Adjustment ${a.adjustment_id} is in ${String(a.currency).trim()}, and the run is in ${run.currency}.`, 'Cancel it and enter it in the payroll currency.');
    }
    const fraction = (String(a.amount).split('.')[1] ?? '').replace(/0+$/, '');
    if (fraction.length > decimals) {
      refuse('ADJUSTMENT_PRECISION', `Adjustment ${a.adjustment_id} (${a.amount}) has more than ${decimals} decimals; ${run.currency} has ${decimals}.`, 'Cancel it and enter an amount the currency can pay.');
    }
    const amount = unscaled(scaled(a.amount, decimals), decimals);
    await addLine({
      segment: lastSegment, c, code: a.component_code, from: segments[0]!.from, to: lastSegment.to, payableDays: String(run.totalDays),
      amountKind: 'FIXED', amountValue: a.amount, amount, source: 'ONE_TIME', sourceId: a.adjustment_id, policy: null,
      basis: `One-time adjustment ${a.adjustment_id}: fixed ${amount}, not prorated and not recurring. Reason: ${a.reason}${a.source_reference ? ` (ref ${a.source_reference})` : ''}`,
    });
  }

  const gross = totals.EARNING ?? 0n;
  const deductions = totals.DEDUCTION ?? 0n;
  if (deductions > gross) {
    refuse(
      'NEGATIVE_NET_PAY',
      `Employee ${pn}'s deductions ${unscaled(deductions, decimals)} exceed their earnings ${unscaled(gross, decimals)} in period ${run.period}/${run.fiscalYear}; net pay would be negative. Nothing is capped, carried forward or netted automatically.`,
      `Correct the employee's deductions at ${EMPLOYEE_ROUTE}?employee=${pn} or the pending adjustments, then recalculate the run.`,
    );
  }
  const last = segments.at(-1)!;
  return {
    result: {
      client, resultId, runId: run.runId, personnelNumber: pn, origin: 'CALCULATED', currency: run.currency,
      payableDays: String(payableDays), totalDays: String(run.totalDays), coveredDays: String(coveredDays),
      unpaidLeaveDays: String(unpaidDays),
      grossPay: unscaled(gross, decimals), totalDeductions: unscaled(deductions, decimals),
      netPay: unscaled(gross - deductions, decimals), employerCost: unscaled(totals.EMPLOYER_CONTRIBUTION ?? 0n, decimals),
      costCenter: last.costCenter, controllingArea: last.controllingArea, createdBy: changedBy,
    },
    lines,
  };
}

/**
 * Select, check and calculate every employee of a run, replacing whatever a previous calculation of
 * the same (proposed) run wrote. Unready employees become exceptions with phase 1's named reasons.
 */
async function calculateRun(tx: Tx, client: string, run: RunRow, changedBy: string): Promise<{ selected: number; covered: Map<string, string> }> {
  try {
    await tx.delete(payrollResult).where(and(eq(payrollResult.client, client), eq(payrollResult.runId, run.runId)));
  } catch (error) {
    translateTrigger(error);
  }
  await tx.delete(payrollRunException).where(and(eq(payrollRunException.client, client), eq(payrollRunException.runId, run.runId)));
  let included = 0;
  let excepted = 0;
  const selected = await selectEmployees(tx, client, run);
  // Off-cycle: an employee another live run of this period already covers is not paid again. They are
  // listed on this run as information, naming the covering run, and the run that covered the most
  // becomes this run's predecessor.
  const covered = await coverageOf(tx, client, run, run.runId);
  const byRun = new Map<string, number>();
  for (const pn of selected.filter((p) => covered.has(p))) {
    const other = covered.get(pn)!;
    byRun.set(other, (byRun.get(other) ?? 0) + 1);
    await tx.insert(payrollRunException).values({
      client, runId: run.runId, personnelNumber: pn, seq: 1, reasonCode: 'ALREADY_COVERED',
      message: `Already covered by run ${other} — an off-cycle run pays only employees no live run covers.`,
      remedy: `Nothing to do: run ${other} pays this employee for the period.`, createdBy: changedBy,
    });
  }
  const predecessor = [...byRun.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  for (const pn of selected.filter((p) => !covered.has(p))) {
    const readiness = await validateEmployeeForRun(tx, client, pn, run.periodFrom, run.periodTo);
    let reasons: Array<{ code: string; message: string; remedy?: string }> = readiness.reasons;
    if (readiness.ready) {
      try {
        await tx.transaction(async (inner) => {
          await calculateResult(inner, client, run, { personnelNumber: pn }, changedBy);
        });
        included++;
        continue;
      } catch (error) {
        if (!(error instanceof PayrollRunError)) throw error;
        reasons = [{ code: error.code, message: error.message, remedy: error.remedy }];
      }
    }
    excepted++;
    await tx.insert(payrollRunException).values(reasons.map((r, i) => ({
      client, runId: run.runId, personnelNumber: pn, seq: i + 1, reasonCode: r.code,
      message: r.message.slice(0, 400), remedy: r.remedy?.slice(0, 400) ?? null, createdBy: changedBy,
    })));
  }
  await tx.update(payrollRun)
    .set({ employeeCount: included, exceptionCount: excepted, predecessorRunId: predecessor, calculatedBy: changedBy, calculatedAt: new Date() })
    .where(and(eq(payrollRun.client, client), eq(payrollRun.runId, run.runId)));
  return { selected: selected.length, covered: new Map(selected.filter((p) => covered.has(p)).map((p) => [p, covered.get(p)!])) };
}

/** Personnel number → the other live run of this company and period whose result covers them. */
export async function coverageOf(tx: Tx, client: string, run: RunRow, exceptRunId: string): Promise<Map<string, string>> {
  const rows = (await tx.execute(sql`
    select r.personnel_number, r.run_id
      from payroll_result r
      join payroll_run run on run.client = r.client and run.run_id = r.run_id
     where r.client = ${client}
       and run.status <> 'CANCELLED'
       and run.company_code = ${run.companyCode} and run.fiscal_year = ${run.fiscalYear} and run.period = ${run.period}
       and r.run_id <> ${exceptRunId}
  `)) as unknown as Array<{ personnel_number: string; run_id: string }>;
  return new Map(rows.map((r) => [r.personnel_number, r.run_id]));
}

export async function lockPeriod(tx: Tx, client: string, companyCode: string, fiscalYear: number, period: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-run:${client}:${companyCode}:${fiscalYear}:${period}`}, 0))`);
}

/** The period must still be open for G/L posting: a run is paid into it. */
export async function assertPeriodOpen(tx: Tx, client: string, companyCode: string, fiscalYear: number, period: number) {
  const company = await getCompanyCode(tx, client, companyCode);
  if (!company) refuse('COMPANY_UNKNOWN', `Company code ${companyCode} does not exist.`, 'Choose a company code from Company Codes.');
  if (!company.fiscalYearVariant || !company.postingPeriodVariant) {
    refuse(
      'PERIOD_UNRESOLVED',
      `Company code ${companyCode} has no ${company.fiscalYearVariant ? 'posting period variant' : 'fiscal year variant'}, so period ${period} of ${fiscalYear} cannot be resolved.`,
      'Complete the company code assignments in Company Codes (CFG.ORG.COMPANYCODE.DEFINE).',
    );
  }
  let dates: { from: string; to: string };
  try {
    dates = await periodDates(tx, client, company.fiscalYearVariant, fiscalYear, period);
  } catch (error) {
    if (error instanceof PeriodError) refuse('PERIOD_UNRESOLVED', error.message, error.remedy);
    throw error;
  }
  const open = await checkPostingAllowed(tx, client, company.postingPeriodVariant, 'S', { fiscalYear, period, periodType: 'REGULAR' });
  if (!open.allowed) {
    refuse('PERIOD_CLOSED', `Period ${period} of fiscal year ${fiscalYear} for company ${companyCode} is not open: ${open.reason}`, open.remedy);
  }
  return { company, dates };
}

// ── The run ─────────────────────────────────────────────────────────────────

/**
 * Propose a run for one company and one fiscal period: resolve the period's dates from the company's
 * fiscal year variant, refuse a closed period or a second live run, then select, check and calculate
 * every employee. A resubmitted form (same request key) is handed the run it already made.
 */
export async function proposePayrollRun(input: ProposeRunInput, access?: PayrollAccess): Promise<PayrollRunView> {
  const parsed = parse(proposeInput, input);
  return withTenant(parsed.client, async (tx) => {
    const grant = await judge(tx, parsed.client, access, EXECUTE);
    assertCompanyScope(grant, parsed.companyCode, refuse);
    if (parsed.requestKey) {
      const [replay] = await tx.select({ runId: payrollRun.runId }).from(payrollRun)
        .where(and(eq(payrollRun.client, parsed.client), eq(payrollRun.requestKey, parsed.requestKey))).limit(1);
      if (replay) return (await runView(tx, parsed.client, replay.runId))!;
    }
    await lockPeriod(tx, parsed.client, parsed.companyCode, parsed.fiscalYear, parsed.period);
    const { company, dates } = await assertPeriodOpen(tx, parsed.client, parsed.companyCode, parsed.fiscalYear, parsed.period);
    const runId = randomUUID();
    const run: RunRow = {
      runId, companyCode: parsed.companyCode, fiscalYear: parsed.fiscalYear, period: parsed.period,
      periodFrom: dates.from, periodTo: dates.to, totalDays: daysBetween(dates.from, dates.to),
      currency: String(company.currency).trim(), status: 'PROPOSED',
    };
    await tx.insert(payrollRun).values({
      client: parsed.client, ...run, calculatedBy: parsed.changedBy,
      requestKey: parsed.requestKey || null, createdBy: parsed.changedBy,
    });
    let outcome: Awaited<ReturnType<typeof calculateRun>>;
    try {
      outcome = await calculateRun(tx, parsed.client, run, parsed.changedBy);
    } catch (error) {
      if (error instanceof PayrollRunError) throw error;
      translateTrigger(error);
    }
    // Every employee this run would have paid is already paid by another run: nothing for it to do.
    // (A run whose candidates are merely unready still stands — it records the named reasons.)
    if (outcome.covered.size > 0 && outcome.covered.size === outcome.selected) {
      const covering = [...new Set(outcome.covered.values())].sort();
      refuse(
        'ALL_COVERED',
        `Run ${covering.join(', ')} already covers every employee for period ${parsed.period}/${parsed.fiscalYear} of company ${parsed.companyCode}; there is nothing for another run to pay.`,
        `Open run ${covering[0]} at ${PAYROLL_RUN_ROUTE}?run=${covering[0]}.`,
      );
    }
    const view = (await runView(tx, parsed.client, runId))!;
    await recordChange(tx, {
      client: parsed.client,
      objectClass: PAYROLL_RUN_OBJECT_CLASS,
      objectKey: runId,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      transactionCode: PAYROLL_RUN_CAPABILITY,
      after: {
        companyCode: run.companyCode, fiscalYear: run.fiscalYear, period: run.period, periodFrom: run.periodFrom,
        periodTo: run.periodTo, employees: view.employeeCount, exceptions: view.exceptionCount, netPay: view.netPay,
        predecessorRunId: view.predecessorRunId,
      },
    });
    return view;
  });
}

/**
 * Recalculate a PROPOSED run from the data as it now stands — after an exception's cause is fixed, or
 * an assignment, absence or rule changed. A released, posted or cancelled run is refused: a released
 * result is frozen, and a correction is a new run in a later period.
 */
export async function recalculatePayrollRun(input: RecalculateRunInput, access?: PayrollAccess): Promise<PayrollRunView> {
  const parsed = parse(runActionInput, input);
  return withTenant(parsed.client, async (tx) => {
    const grant = await judge(tx, parsed.client, access, EXECUTE);
    const standing = await loadRun(tx, parsed.client, parsed.runId);
    assertCompanyScope(grant, standing.companyCode, refuse);
    await lockPeriod(tx, parsed.client, standing.companyCode, standing.fiscalYear, standing.period);
    const row = await loadRun(tx, parsed.client, parsed.runId);
    assertProposed(row, 'recalculated');
    await assertNoActiveOperation(tx, parsed.client, row.runId, 'recalculated');
    await assertPeriodOpen(tx, parsed.client, row.companyCode, row.fiscalYear, row.period);
    const before = (await runView(tx, parsed.client, row.runId))!;
    try {
      await calculateRun(tx, parsed.client, runRowFrom(row), parsed.changedBy);
    } catch (error) {
      if (error instanceof PayrollRunError) throw error;
      translateTrigger(error);
    }
    await tx.update(payrollRun).set({ changedBy: parsed.changedBy, changedAt: new Date() })
      .where(and(eq(payrollRun.client, parsed.client), eq(payrollRun.runId, row.runId)));
    const view = (await runView(tx, parsed.client, row.runId))!;
    await recordChange(tx, {
      client: parsed.client,
      objectClass: PAYROLL_RUN_OBJECT_CLASS,
      objectKey: row.runId,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      transactionCode: PAYROLL_RUN_CAPABILITY,
      before: { employees: before.employeeCount, exceptions: before.exceptionCount, netPay: before.netPay },
      after: { recalculated: true, employees: view.employeeCount, exceptions: view.exceptionCount, netPay: view.netPay },
    });
    return view;
  });
}

/** The operation currently queued or running for a run, if any. At most one can exist (unique index). */
export async function activeOperation(tx: Tx, client: string, runId: string): Promise<{ operationId: string; kind: string; status: string } | null> {
  const rows = (await tx.execute(sql`
    select operation_id, kind, status from payroll_run_operation
     where client = ${client} and run_id = ${runId} and status in ('QUEUED', 'RUNNING')
     limit 1
  `)) as unknown as Array<{ operation_id: string; kind: string; status: string }>;
  return rows[0] ? { operationId: rows[0].operation_id, kind: rows[0].kind, status: rows[0].status } : null;
}

/** Refuse while a background operation is queued or running for this run. */
export async function assertNoActiveOperation(tx: Tx, client: string, runId: string, verb: string, exceptOperationId?: string): Promise<void> {
  const active = await activeOperation(tx, client, runId);
  if (active && active.operationId !== exceptOperationId) {
    refuse(
      'OPERATION_ACTIVE',
      `Payroll run ${runId} cannot be ${verb} while a background ${active.kind.toLowerCase()} is ${active.status.toLowerCase()}.`,
      `Wait for it to finish, or cancel it at ${PAYROLL_RUN_ROUTE}?run=${runId}.`,
    );
  }
}

/**
 * A run is releasable only when its latest calculation finished and published. A background
 * calculation that failed or was cancelled leaves the previous proposal in place for review, but that
 * proposal is not offered for release until a calculation has completed after the failure.
 */
export async function assertCalculationSettled(tx: Tx, client: string, runId: string): Promise<void> {
  const rows = (await tx.execute(sql`
    select kind, status from payroll_run_operation
     where client = ${client} and run_id = ${runId} and kind in ('PROPOSE', 'RECALCULATE')
     order by created_at desc limit 1
  `)) as unknown as Array<{ kind: string; status: string }>;
  const latest = rows[0];
  if (latest && latest.status !== 'SUCCEEDED') {
    refuse(
      'CALCULATION_INCOMPLETE',
      `The latest background ${latest.kind.toLowerCase()} of run ${runId} is ${latest.status.toLowerCase()}; its results are ${latest.status === 'FAILED' || latest.status === 'CANCELLED' ? 'not a finished calculation' : 'not complete yet'}.`,
      `Recalculate the run at ${PAYROLL_RUN_ROUTE}?run=${runId}, then release it.`,
    );
  }
}

export function assertProposed(row: typeof payrollRun.$inferSelect, verb: string): void {
  if (row.status === 'PROPOSED') return;
  if (row.status === 'CANCELLED') {
    refuse('RUN_CANCELLED', `Payroll run ${row.runId} is cancelled and cannot be ${verb}.`, `Propose a new run at ${PAYROLL_RUN_ROUTE}.`);
  }
  refuse(
    'RUN_FROZEN',
    `Payroll run ${row.runId} is ${row.status} and cannot be ${verb}: a released result is frozen.`,
    'A correction is a new run in a later period; past periods are never recalculated (DV-001).',
  );
}

/**
 * Release a PROPOSED run. Refused while any employee stands as an exception, while any included
 * employee is no longer ready, or while the selection has changed since the calculation (recalculate
 * first). A released run is frozen.
 */
export async function releasePayrollRun(input: ReleaseRunInput, access?: PayrollAccess): Promise<PayrollRunView> {
  const parsed = parse(releaseInput, input);
  return withTenant(parsed.client, async (tx) => {
    const grant = await judge(tx, parsed.client, access, EXECUTE);
    const standing = await loadRun(tx, parsed.client, parsed.runId);
    assertCompanyScope(grant, standing.companyCode, refuse);
    await lockPeriod(tx, parsed.client, standing.companyCode, standing.fiscalYear, standing.period);
    const row = await loadRun(tx, parsed.client, parsed.runId);
    assertProposed(row, 'released');
    await assertNoActiveOperation(tx, parsed.client, row.runId, 'released');
    await assertCalculationSettled(tx, parsed.client, row.runId);
    await assertPeriodOpen(tx, parsed.client, row.companyCode, row.fiscalYear, row.period);

    const view = (await runView(tx, parsed.client, row.runId))!;
    const blocking = view.exceptions.filter((e) => !e.informational);
    if (blocking.length > 0) {
      const named = [...new Map(blocking.map((e) => [e.personnelNumber, e])).values()]
        .map((e) => `${e.personnelNumber} (${e.reasonCode}: ${e.message})`).join('; ');
      refuse('RELEASE_EXCEPTIONS', `Payroll run ${row.runId} cannot be released while employees stand as exceptions: ${named}`, `Fix each, then recalculate the run at ${PAYROLL_RUN_ROUTE}?run=${row.runId}.`);
    }
    const results = await resultRows(tx, parsed.client, and(eq(payrollResult.client, parsed.client), eq(payrollResult.runId, row.runId)));
    // An off-cycle run never pays an employee another live run of the period covers.
    const coveredElsewhere = await coverageOf(tx, parsed.client, runRowFrom(row), row.runId);
    const twice = results.filter((r) => coveredElsewhere.has(r.personnelNumber));
    if (twice.length > 0) {
      refuse(
        'COVERED_ELSEWHERE',
        `Payroll run ${row.runId} cannot be released: ${twice.map((r) => `${r.personnelNumber} is already covered by run ${coveredElsewhere.get(r.personnelNumber)}`).join('; ')}.`,
        `Recalculate the run at ${PAYROLL_RUN_ROUTE}?run=${row.runId}; it then leaves those employees to the run that covers them.`,
      );
    }
    if (results.length === 0) {
      refuse('RUN_EMPTY', `Payroll run ${row.runId} includes no employee; there is nothing to release.`, 'Cancel it, or recalculate it once employees are assigned.');
    }
    const unready: string[] = [];
    for (const r of results) {
      const readiness = await validateEmployeeForRun(tx, parsed.client, r.personnelNumber, row.periodFrom, row.periodTo);
      for (const reason of readiness.reasons) unready.push(`${r.personnelNumber} (${reason.code}: ${reason.message})`);
    }
    if (unready.length > 0) {
      refuse('RELEASE_UNREADY', `Payroll run ${row.runId} cannot be released; included employees are no longer ready: ${unready.join('; ')}`, `Fix each, then recalculate the run at ${PAYROLL_RUN_ROUTE}?run=${row.runId}.`);
    }
    const calculated = new Set(results.map((r) => r.personnelNumber));
    const missing = (await selectEmployees(tx, parsed.client, runRowFrom(row)))
      .filter((pn) => !calculated.has(pn) && !coveredElsewhere.has(pn));
    if (missing.length > 0) {
      refuse('RUN_STALE', `Payroll run ${row.runId} was calculated before employee${missing.length > 1 ? 's' : ''} ${missing.join(', ')} joined the period's selection.`, `Recalculate the run at ${PAYROLL_RUN_ROUTE}?run=${row.runId}, then release it.`);
    }

    const stale = await staleReasonsOf(tx, parsed.client, runRowFrom(row));
    if (stale.length > 0) {
      refuse('RUN_STALE_INPUTS', `Payroll run ${row.runId} was calculated before the pay data changed: ${stale.join(' ')}`, `Recalculate the run at ${PAYROLL_RUN_ROUTE}?run=${row.runId}, then release it.`);
    }
    const waiting = await adjustmentStanding(tx, parsed.client, runRowFrom(row));
    if (waiting.pending > 0 && !parsed.acknowledgePending) {
      refuse(
        'PENDING_ADJUSTMENTS',
        `${waiting.pending} one-time adjustment${waiting.pending > 1 ? 's' : ''} for company ${row.companyCode}, period ${row.period}/${row.fiscalYear} still await approval and are NOT in this run.`,
        'Have them approved and recalculate the run, or release again and confirm that you release without them (a frozen period is corrected in a later period).',
      );
    }

    const now = new Date();
    await tx.update(payrollRun)
      .set({ status: 'RELEASED', releasedBy: parsed.changedBy, releasedAt: now, changedBy: parsed.changedBy, changedAt: now })
      .where(and(eq(payrollRun.client, parsed.client), eq(payrollRun.runId, row.runId)));
    // Applied exactly once: the approved adjustments this run's lines carry become APPLIED, under the period lock,
    // and only from APPROVED. A line whose adjustment is no longer approved was caught as stale above.
    const applied = (await tx.execute(sql`
      update payroll_adjustment a
         set status = 'APPLIED', applied_run_id = ${row.runId}, applied_at = ${now.toISOString()}::timestamptz, changed_by = ${parsed.changedBy}, changed_at = ${now.toISOString()}::timestamptz,
             applied_result_id = (select r.result_id from payroll_result r where r.client = a.client and r.run_id = ${row.runId} and r.personnel_number = a.personnel_number)
       where a.client = ${parsed.client} and a.status = 'APPROVED'
         and a.adjustment_id in (select l.source_id from payroll_result_line l join payroll_result r on r.client = l.client and r.result_id = l.result_id
                                  where l.client = ${parsed.client} and r.run_id = ${row.runId} and l.source_type = 'ONE_TIME')
      returning a.adjustment_id
    `)) as unknown as Array<{ adjustment_id: string }>;
    for (const a of applied) {
      await recordChange(tx, {
        client: parsed.client, objectClass: PAYROLL_ADJUSTMENT_OBJECT_CLASS, objectKey: a.adjustment_id, changeType: 'CHANGE',
        changedBy: parsed.changedBy, transactionCode: PAYROLL_RUN_CAPABILITY,
        before: { status: 'APPROVED' }, after: { status: 'APPLIED', runId: row.runId }, securityRelevantFields: ['status'],
      });
    }
    await recordChange(tx, {
      client: parsed.client,
      objectClass: PAYROLL_RUN_OBJECT_CLASS,
      objectKey: row.runId,
      changeType: 'RELEASE',
      changedBy: parsed.changedBy,
      transactionCode: PAYROLL_RUN_CAPABILITY,
      before: { status: 'PROPOSED' },
      after: { status: 'RELEASED', employees: view.employeeCount, netPay: view.netPay, adjustmentsApplied: applied.length, releasedWithPendingAdjustments: waiting.pending },
    });
    return (await runView(tx, parsed.client, row.runId))!;
  });
}

/**
 * Cancel a PROPOSED or RELEASED run, with a reason. Its results stay as history; the period is free
 * for a new run. A POSTED run is refused: reverse the posting first.
 */
export async function cancelPayrollRun(input: CancelRunInput, access?: PayrollAccess): Promise<PayrollRunView> {
  const parsed = parse(cancelInput, input);
  return withTenant(parsed.client, async (tx) => {
    const grant = await judge(tx, parsed.client, access, EXECUTE);
    const standing = await loadRun(tx, parsed.client, parsed.runId);
    assertCompanyScope(grant, standing.companyCode, refuse);
    await lockPeriod(tx, parsed.client, standing.companyCode, standing.fiscalYear, standing.period);
    const row = await loadRun(tx, parsed.client, parsed.runId);
    if (row.status === 'POSTED') {
      refuse('RUN_POSTED', `Payroll run ${row.runId} is posted and cannot be cancelled.`, 'Reverse the payroll posting first.');
    }
    await assertNoActiveOperation(tx, parsed.client, row.runId, 'cancelled');
    if (row.status === 'CANCELLED') {
      refuse('RUN_CANCELLED', `Payroll run ${row.runId} is already cancelled (${row.cancelReason ?? 'no reason'}).`);
    }
    const now = new Date();
    // A cancelled released run gives its adjustments back, so a re-proposal picks them up again — never twice.
    const returned = (await tx.execute(sql`
      update payroll_adjustment
         set status = 'APPROVED', applied_run_id = null, applied_result_id = null, applied_at = null, changed_by = ${parsed.changedBy}, changed_at = ${now.toISOString()}::timestamptz
       where client = ${parsed.client} and applied_run_id = ${row.runId} and status = 'APPLIED'
      returning adjustment_id
    `)) as unknown as Array<{ adjustment_id: string }>;
    for (const a of returned) {
      await recordChange(tx, {
        client: parsed.client, objectClass: PAYROLL_ADJUSTMENT_OBJECT_CLASS, objectKey: a.adjustment_id, changeType: 'CHANGE',
        changedBy: parsed.changedBy, transactionCode: PAYROLL_RUN_CAPABILITY,
        before: { status: 'APPLIED', runId: row.runId }, after: { status: 'APPROVED', reason: `run ${row.runId} cancelled` }, securityRelevantFields: ['status'],
      });
    }
    await tx.update(payrollRun)
      .set({ status: 'CANCELLED', cancelledBy: parsed.changedBy, cancelledAt: now, cancelReason: parsed.reason, changedBy: parsed.changedBy, changedAt: now })
      .where(and(eq(payrollRun.client, parsed.client), eq(payrollRun.runId, row.runId)));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: PAYROLL_RUN_OBJECT_CLASS,
      objectKey: row.runId,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      transactionCode: PAYROLL_RUN_CAPABILITY,
      before: { status: row.status },
      after: { status: 'CANCELLED', reason: parsed.reason },
    });
    return (await runView(tx, parsed.client, row.runId))!;
  });
}

/** The company codes a run may be proposed for, with their currency, for the propose form. */
export async function listPayrollCompanies(clientInput: string): Promise<Array<{ companyCode: string; name: string; currency: string }>> {
  const client = parse(clientField, clientInput);
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select company_code, name, currency from company_code where client = ${client} order by company_code
    `)) as unknown as Array<{ company_code: string; name: string; currency: string }>;
    return rows.map((r) => ({ companyCode: r.company_code, name: r.name, currency: String(r.currency).trim() }));
  });
}

/** The fiscal year and period a date falls in for a company — the propose form's default. */
export async function currentPayrollPeriod(clientInput: string, companyCodeInput: string, date: string): Promise<{ fiscalYear: number; period: number } | null> {
  const client = parse(clientField, clientInput);
  const companyCode = parse(companyField, companyCodeInput);
  return withTenant(client, async (tx) => {
    const company = await getCompanyCode(tx, client, companyCode);
    if (!company?.fiscalYearVariant) return null;
    try {
      const position = await derivePosition(tx, client, company.fiscalYearVariant, date);
      return { fiscalYear: position.fiscalYear, period: position.period };
    } catch (error) {
      if (error instanceof PeriodError) return null;
      throw error;
    }
  });
}
