/**
 * Company-configured payroll additions and deductions (9318).
 *
 * The company reads its own local law and configures what is added to or deducted from an employee's pay and
 * what it contributes separately. This file stores and controls that configuration; it determines no rate,
 * base, threshold or exemption, and certifies nothing. Where a legal base is not a fixed amount or a
 * percentage of the assigned base salary, the company enters an externally calculated fixed amount.
 *
 * Two kinds of entry:
 *
 * - **Recurring** (`employee_pay_component`): an earning, deduction or employer contribution linked to a
 *   configured pay component, effective-dated, fixed per period or a percentage of the employee's ASSIGNED BASE
 *   SALARY (never "taxable gross"). Its mode is explicit — ADD (a separate line beside the structure) or
 *   REPLACE (suppresses that component's structure rule for the covered dates) — and so is its proration policy.
 *   Rows are never rewritten: a change ends the old row (reason, audit) and adds a new one. History that a
 *   released/posted result already covers is frozen: a change touching it is refused, and the correction is a
 *   later-period entry or an approved one-time adjustment.
 * - **One-time** (`payroll_adjustment`): a fixed positive amount for one company, fiscal year and period, with a
 *   mandatory reason, approved by someone other than its creator who reaches the employee. PENDING → APPROVED
 *   → APPLIED (when the run that calculated it is released) or REJECTED/CANCELLED. It is never prorated and never
 *   recurs. An offsetting entry is a separate approved adjustment; negative amounts do not exist, and an
 *   employer-contribution correction is refused because the posting model cannot reverse a contribution safely.
 *
 * Posting is accounting only: it is not proof of a bank transfer, a remittance to an authority or a filing.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { type PayrollAccess, type PayrollGrant, assertCompanyScope, reachesCompany } from './payroll-access';
import { currencyDecimals, EXECUTE, judge, lockPeriod, assertPeriodOpen, parse, refuse } from './payroll-run';
import { EMPLOYEE_ROUTE, EOS_PROVISION_KIND, PAY_COMPONENT_ROUTE, PAYROLL_RESULT_CAPABILITY, assertEmployeeScope, PayrollStructureError } from './payroll-structure';
import {
  ADJUSTMENT_APPROVE_CAPABILITY,
  ADJUSTMENT_ENTER_CAPABILITY,
  COMPONENT_MAINTAIN_CAPABILITY,
  COMPONENT_MODES,
  EMPLOYEE_COMPONENT_OBJECT_CLASS,
  PAYROLL_ADJUSTMENT_OBJECT_CLASS,
  PRORATION_POLICIES,
  SALARY_STRUCTURE_CAPABILITY,
  employeePayComponent,
  payrollAdjustment,
  type AdjustmentStatus,
  type ComponentMode,
  type ProrationPolicy,
} from './schema';

export {
  ADJUSTMENT_APPROVE_CAPABILITY,
  ADJUSTMENT_ENTER_CAPABILITY,
  COMPONENT_MAINTAIN_CAPABILITY,
  COMPONENT_MODES,
  PRORATION_POLICIES,
};

/** The statement every payroll screen shows. */
export const COMPANY_RESPONSIBILITY_NOTICE =
  'Rates, amounts, taxable or insurable bases, remittances and filings are set and kept up to date by the company; the ERP applies what is configured and does not check it against any law. '
  + 'A posted payroll is accounting only: it is not proof of a bank transfer, a remittance to an authority or a filing, which the company completes outside the ERP.';

const MAINTAIN = [COMPONENT_MAINTAIN_CAPABILITY] as const;
const READ_ENTRIES = [COMPONENT_MAINTAIN_CAPABILITY, PAYROLL_RESULT_CAPABILITY, SALARY_STRUCTURE_CAPABILITY] as const;
const ENTER = [ADJUSTMENT_ENTER_CAPABILITY] as const;
const APPROVE = [ADJUSTMENT_APPROVE_CAPABILITY] as const;
const READ_ADJUSTMENTS = [ADJUSTMENT_ENTER_CAPABILITY, ADJUSTMENT_APPROVE_CAPABILITY, PAYROLL_RESULT_CAPABILITY, ...EXECUTE] as const;

// ── Input ───────────────────────────────────────────────────────────────────

const clientField = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'A tenant is two to four capitals or digits.');
const companyField = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, 'A company code is one to four capitals or digits.');
const codeField = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'A component code is two to ten capitals and digits, starting with a letter.');
const personnelField = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,20}$/, 'A personnel number is one to twenty capitals or digits.');
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');
const optionalDate = z.union([z.literal('').transform(() => null), isoDate, z.null()]).optional().transform((v) => v ?? null);
const currencyField = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'A currency is three capitals.');
const amountField = z.union([z.number(), z.string().trim()]).transform((v) => String(v)).pipe(
  z.string().regex(/^\d{1,19}(\.\d{1,4})?$/, 'An amount is a non-negative number with at most four decimals.'),
);
const reasonField = z.string().trim().min(1, 'A reason is required.').max(200);
const actor = z.string().trim().min(1).max(60);
const requestKey = z.string().trim().max(64).optional();

const entryInput = z.object({
  client: clientField,
  personnelNumber: personnelField,
  componentCode: codeField,
  /** Explicit: there is no default. A replacement and an addition are different business decisions. */
  mode: z.enum(COMPONENT_MODES, { message: 'Say whether the entry ADDS to the structure or REPLACES that component’s structure rule.' }),
  amountKind: z.enum(['FIXED', 'PERCENT_OF_BASE'], { message: 'Choose a fixed amount per period or a percentage of the assigned base salary.' }),
  amountValue: amountField,
  currency: currencyField,
  validFrom: isoDate,
  validTo: optionalDate,
  prorationPolicy: z.enum(PRORATION_POLICIES, { message: 'Choose a proration policy.' }),
  reason: reasonField,
  requestKey,
  changedBy: actor,
});
export type AddEmployeeComponentInput = z.input<typeof entryInput>;

const endEntryInput = z.object({ client: clientField, entryId: z.string().trim().min(1).max(36), validTo: isoDate, reason: reasonField, changedBy: actor });
const withdrawEntryInput = z.object({ client: clientField, entryId: z.string().trim().min(1).max(36), reason: reasonField, changedBy: actor });

const adjustmentInput = z.object({
  client: clientField,
  companyCode: companyField,
  fiscalYear: z.coerce.number().int('A fiscal year is a whole number.').min(1900).max(9999),
  period: z.coerce.number().int('A period is a whole number.').min(1, 'A period is 1 to 16.').max(16, 'A period is 1 to 16.'),
  personnelNumber: personnelField,
  componentCode: codeField,
  amount: amountField,
  reason: reasonField,
  sourceReference: z.string().trim().max(100).optional().transform((v) => v || null),
  correctsResultId: z.string().trim().max(36).optional().transform((v) => v || null),
  requestKey,
  changedBy: actor,
});
export type EnterAdjustmentInput = z.input<typeof adjustmentInput>;
const decideInput = z.object({
  client: clientField,
  adjustmentId: z.string().trim().min(1).max(36),
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(200).optional().transform((v) => v || null),
  changedBy: actor,
});
export type DecideAdjustmentInput = z.input<typeof decideInput>;
const cancelAdjustmentInput = z.object({ client: clientField, adjustmentId: z.string().trim().min(1).max(36), reason: reasonField, changedBy: actor });
export type CancelAdjustmentInput = z.input<typeof cancelAdjustmentInput>;

// ── Views ───────────────────────────────────────────────────────────────────

export interface EmployeeComponentView {
  entryId: string;
  personnelNumber: string;
  componentCode: string;
  componentName: string | null;
  componentKind: string | null;
  mode: ComponentMode;
  amountKind: string;
  amountValue: string;
  /** What a percentage is a percentage OF, spelled out on every screen. */
  basisLabel: string;
  currency: string;
  validFrom: string;
  validTo: string | null;
  prorationPolicy: ProrationPolicy;
  status: string;
  reason: string;
  withdrawnReason: string | null;
  createdBy: string;
  createdAt: string;
  changedBy: string | null;
  changedAt: string | null;
}

export interface AdjustmentView {
  adjustmentId: string;
  companyCode: string;
  fiscalYear: number;
  period: number;
  personnelNumber: string;
  employeeName: string | null;
  componentCode: string;
  componentName: string | null;
  componentKind: string;
  amount: string;
  currency: string;
  reason: string;
  sourceReference: string | null;
  correctsResultId: string | null;
  status: AdjustmentStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedRunId: string | null;
  appliedResultId: string | null;
  appliedAt: string | null;
  createdBy: string;
  createdAt: string;
}

const stamp = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const plain = (v: unknown) => (v === null || v === undefined ? '0' : String(v));

export const BASIS_LABEL: Record<string, string> = {
  FIXED: 'fixed amount per payroll period',
  PERCENT_OF_BASE: 'percent of the employee’s assigned base salary (not taxable gross or total earnings)',
};

// ── Shared checks ───────────────────────────────────────────────────────────

const spansMeet = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  aFrom <= (bTo ?? '9999-12-31') && bFrom <= (aTo ?? '9999-12-31');

/** The employee's scope, as a boolean (the structure service's refusal, caught). */
async function reaches(tx: Tx, client: string, grant: PayrollGrant, personnelNumber: string, onDate: string): Promise<boolean> {
  try {
    await assertEmployeeScope(tx, client, grant, personnelNumber, onDate);
    return true;
  } catch (error) {
    if (error instanceof PayrollStructureError) return false;
    throw error;
  }
}

/** Scope, refused in the calling service's own error class. */
async function assertScope(tx: Tx, client: string, grant: PayrollGrant, personnelNumber: string, onDate: string): Promise<void> {
  try {
    await assertEmployeeScope(tx, client, grant, personnelNumber, onDate);
  } catch (error) {
    if (error instanceof PayrollStructureError) refuse(error.code, error.message, error.remedy);
    throw error;
  }
}

/** A released or posted result of this employee whose period meets the span: that history is frozen. */
async function frozenResult(tx: Tx, client: string, personnelNumber: string, from: string, to: string | null) {
  const rows = (await tx.execute(sql`
    select run.run_id, run.period, run.fiscal_year, run.status
      from payroll_result r
      join payroll_run run on run.client = r.client and run.run_id = r.run_id
     where r.client = ${client} and r.personnel_number = ${personnelNumber}
       and run.status in ('RELEASED', 'POSTED')
       and run.period_from <= ${to ?? '9999-12-31'}::date and run.period_to >= ${from}::date
     order by run.period_from limit 1
  `)) as unknown as Array<{ run_id: string; period: number; fiscal_year: number; status: string }>;
  return rows[0] ?? null;
}

async function componentOf(tx: Tx, client: string, code: string) {
  const rows = (await tx.execute(sql`select code, name, component_kind, is_valid from pay_component where client = ${client} and code = ${code}`)) as unknown as
    Array<{ code: string; name: string; component_kind: string; is_valid: boolean }>;
  const c = rows[0];
  if (!c) refuse('COMPONENT_UNKNOWN', `Pay component ${code} does not exist.`, `Define it at ${PAY_COMPONENT_ROUTE}.`);
  if (!c.is_valid) refuse('COMPONENT_RETIRED', `Pay component ${code} is retired.`, `Choose an active component, or re-activate it at ${PAY_COMPONENT_ROUTE}.`);
  if (c.component_kind === EOS_PROVISION_KIND) {
    refuse('EOS_NOT_SUPPORTED', `Pay component ${code} is an end-of-service provision; payroll does not calculate those.`, 'Choose an earning, deduction or employer-contribution component.');
  }
  return c;
}

/** At most the currency's decimals for a fixed amount; a percentage is at most 100 with the four decimals the column holds. */
async function assertValue(tx: Tx, kind: string, value: string, currency: string): Promise<void> {
  const decimals = await currencyDecimals(tx, currency);
  if (kind === 'PERCENT_OF_BASE') {
    if (Number(value) > 100) refuse('PERCENT_RANGE', `A percentage of base cannot exceed 100 (got ${value}).`, 'Enter the rate as a percentage, 0 to 100.');
    return;
  }
  const fraction = (value.split('.')[1] ?? '').replace(/0+$/, '');
  if (fraction.length > decimals) {
    refuse('AMOUNT_PRECISION', `${value} has more than ${decimals} decimals; ${currency} has ${decimals}.`, `Enter the amount to ${decimals} decimals.`);
  }
}

function entryView(r: Record<string, unknown>): EmployeeComponentView {
  return {
    entryId: String(r.entry_id),
    personnelNumber: String(r.personnel_number),
    componentCode: String(r.component_code),
    componentName: (r.name as string | null) ?? null,
    componentKind: (r.component_kind as string | null) ?? null,
    mode: String(r.mode) as ComponentMode,
    amountKind: String(r.amount_kind),
    amountValue: plain(r.amount_value),
    basisLabel: BASIS_LABEL[String(r.amount_kind)] ?? '',
    currency: String(r.currency).trim(),
    validFrom: String(r.valid_from).slice(0, 10),
    validTo: r.valid_to ? String(r.valid_to).slice(0, 10) : null,
    prorationPolicy: String(r.proration_policy) as ProrationPolicy,
    status: String(r.status),
    reason: String(r.reason),
    withdrawnReason: (r.withdrawn_reason as string | null) ?? null,
    createdBy: String(r.created_by),
    createdAt: stamp(r.created_at)!,
    changedBy: (r.changed_by as string | null) ?? null,
    changedAt: stamp(r.changed_at),
  };
}

const ENTRY_SELECT = sql`
  select e.entry_id, e.personnel_number, e.component_code, p.name, p.component_kind, e.mode, e.amount_kind,
         e.amount_value::text as amount_value, e.currency, e.valid_from::text as valid_from, e.valid_to::text as valid_to,
         e.proration_policy, e.status, e.reason, e.withdrawn_reason, e.created_by, e.created_at, e.changed_by, e.changed_at
    from employee_pay_component e
    left join pay_component p on p.client = e.client and p.code = e.component_code`;

async function oneEntry(tx: Tx, client: string, entryId: string): Promise<EmployeeComponentView | null> {
  const rows = (await tx.execute(sql`${ENTRY_SELECT} where e.client = ${client} and e.entry_id = ${entryId}`)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? entryView(rows[0]) : null;
}

const employeeLock = (tx: Tx, client: string, personnelNumber: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`employee-pay:${client}:${personnelNumber}`}, 0))`);

// ── Recurring entries ───────────────────────────────────────────────────────

/**
 * Add an employee-specific recurring component. Works for an employee who has no payroll result yet (onboarding).
 * A REPLACE that overlaps another active REPLACE of the same component is refused by name, under the employee
 * lock, with the database exclusion constraint as the backstop.
 */
export async function addEmployeeComponent(input: AddEmployeeComponentInput, access?: PayrollAccess): Promise<EmployeeComponentView> {
  const p = parse(entryInput, input);
  if (p.validTo && p.validTo < p.validFrom) refuse('ENTRY_PERIOD', `An entry cannot end (${p.validTo}) before it starts (${p.validFrom}).`, 'Choose an end date on or after the start.');
  return withTenant(p.client, async (tx) => {
    const grant = await judge(tx, p.client, access, MAINTAIN);
    if (p.requestKey) {
      const [again] = await tx.select({ id: employeePayComponent.entryId }).from(employeePayComponent)
        .where(and(eq(employeePayComponent.client, p.client), eq(employeePayComponent.requestKey, p.requestKey))).limit(1);
      if (again) return (await oneEntry(tx, p.client, again.id))!;
    }
    await employeeLock(tx, p.client, p.personnelNumber);
    const [person] = (await tx.execute(sql`select is_active from employee where client = ${p.client} and personnel_number = ${p.personnelNumber}`)) as unknown as Array<{ is_active: boolean }>;
    if (!person) refuse('EMPLOYEE_UNKNOWN', `Employee ${p.personnelNumber} does not exist.`, `Create the employee at ${EMPLOYEE_ROUTE}.`);
    await assertScope(tx, p.client, grant, p.personnelNumber, p.validFrom);
    const component = await componentOf(tx, p.client, p.componentCode);
    await assertValue(tx, p.amountKind, p.amountValue, p.currency);
    const frozen = await frozenResult(tx, p.client, p.personnelNumber, p.validFrom, p.validTo);
    if (frozen) {
      refuse(
        'HISTORY_FROZEN',
        `Employee ${p.personnelNumber} already has a ${frozen.status.toLowerCase()} result for period ${frozen.period}/${frozen.fiscal_year} (run ${frozen.run_id}); an entry effective ${p.validFrom} to ${p.validTo ?? 'open'} would change history that is frozen.`,
        'Start the entry after the frozen period, or enter an approved one-time payroll adjustment for a later period.',
      );
    }
    if (p.mode === 'REPLACE') {
      const existing = (await tx.execute(sql`
        select entry_id, valid_from::text as valid_from, valid_to::text as valid_to from employee_pay_component
         where client = ${p.client} and personnel_number = ${p.personnelNumber} and component_code = ${p.componentCode}
           and mode = 'REPLACE' and status = 'ACTIVE'`)) as unknown as Array<{ entry_id: string; valid_from: string; valid_to: string | null }>;
      const clash = existing.find((e) => spansMeet(e.valid_from, e.valid_to, p.validFrom, p.validTo));
      if (clash) {
        refuse(
          'REPLACEMENT_OVERLAP',
          `Employee ${p.personnelNumber} already replaces ${p.componentCode} from ${clash.valid_from} to ${clash.valid_to ?? 'open'}; two replacements cannot cover one day.`,
          `End the standing replacement (${clash.entry_id}) the day before ${p.validFrom}, then add this one.`,
        );
      }
    }
    const entryId = randomUUID();
    try {
      await tx.insert(employeePayComponent).values({
        client: p.client, entryId, personnelNumber: p.personnelNumber, componentCode: p.componentCode, mode: p.mode,
        amountKind: p.amountKind, amountValue: p.amountValue, currency: p.currency, validFrom: p.validFrom, validTo: p.validTo,
        prorationPolicy: p.prorationPolicy, reason: p.reason, requestKey: p.requestKey || null, createdBy: p.changedBy,
        createdAt: sql`clock_timestamp()` as unknown as Date,
      });
    } catch (error) {
      if ((error as { code?: string; cause?: { code?: string } })?.code === '23P01' || (error as { cause?: { code?: string } })?.cause?.code === '23P01') {
        refuse('REPLACEMENT_OVERLAP', `Another replacement of ${p.componentCode} for employee ${p.personnelNumber} was just saved and overlaps these dates.`, 'Reload the employee and end the standing replacement first.');
      }
      throw error;
    }
    await recordChange(tx, {
      client: p.client, objectClass: EMPLOYEE_COMPONENT_OBJECT_CLASS, objectKey: `${p.personnelNumber}/${entryId}`, changeType: 'CREATE',
      changedBy: p.changedBy, transactionCode: COMPONENT_MAINTAIN_CAPABILITY, reason: p.reason,
      after: {
        component: p.componentCode, kind: component.component_kind, mode: p.mode, amountKind: p.amountKind, amountValue: p.amountValue,
        currency: p.currency, validFrom: p.validFrom, validTo: p.validTo, prorationPolicy: p.prorationPolicy,
      },
      securityRelevantFields: ['amountValue'],
    });
    return (await oneEntry(tx, p.client, entryId))!;
  });
}

/** End an active entry on a date (the last day it applies). The removed days must not meet frozen history. */
export async function endEmployeeComponent(input: z.input<typeof endEntryInput>, access?: PayrollAccess): Promise<EmployeeComponentView> {
  const p = parse(endEntryInput, input);
  return withTenant(p.client, async (tx) => {
    const grant = await judge(tx, p.client, access, MAINTAIN);
    const [row] = await tx.select().from(employeePayComponent)
      .where(and(eq(employeePayComponent.client, p.client), eq(employeePayComponent.entryId, p.entryId))).limit(1);
    if (!row) refuse('ENTRY_UNKNOWN', `Entry ${p.entryId} does not exist.`, 'Choose an entry of this employee.');
    await employeeLock(tx, p.client, row.personnelNumber);
    const [current] = await tx.select().from(employeePayComponent)
      .where(and(eq(employeePayComponent.client, p.client), eq(employeePayComponent.entryId, p.entryId))).for('update').limit(1);
    const e = current!;
    await assertScope(tx, p.client, grant, e.personnelNumber, p.validTo);
    if (e.status !== 'ACTIVE') refuse('ENTRY_WITHDRAWN', `Entry ${e.entryId} is withdrawn.`, 'Nothing to end.');
    if (p.validTo < e.validFrom) refuse('ENTRY_PERIOD', `The entry starts ${e.validFrom}; it cannot end on ${p.validTo}.`, 'Withdraw it instead.');
    if (e.validTo !== null && p.validTo >= e.validTo) refuse('ENTRY_EXTEND', `The entry already ends ${e.validTo}; ending it later would extend it.`, 'Add a new entry from the next day instead.');
    const next = new Date(Date.parse(`${p.validTo}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const frozen = await frozenResult(tx, p.client, e.personnelNumber, next, e.validTo);
    if (frozen) {
      refuse('HISTORY_FROZEN', `Ending the entry on ${p.validTo} would change days that period ${frozen.period}/${frozen.fiscal_year} (run ${frozen.run_id}, ${frozen.status.toLowerCase()}) already paid.`, 'End it after the frozen period, or correct it with an approved one-time adjustment in a later period.');
    }
    await tx.update(employeePayComponent)
      .set({ validTo: p.validTo, changedBy: p.changedBy, changedAt: sql`clock_timestamp()` as unknown as Date })
      .where(and(eq(employeePayComponent.client, p.client), eq(employeePayComponent.entryId, p.entryId)));
    await recordChange(tx, {
      client: p.client, objectClass: EMPLOYEE_COMPONENT_OBJECT_CLASS, objectKey: `${e.personnelNumber}/${e.entryId}`, changeType: 'CHANGE',
      changedBy: p.changedBy, transactionCode: COMPONENT_MAINTAIN_CAPABILITY, reason: p.reason,
      before: { validTo: e.validTo }, after: { validTo: p.validTo },
    });
    return (await oneEntry(tx, p.client, p.entryId))!;
  });
}

/** Withdraw an entry whose whole span lies outside frozen history (for example one entered by mistake for the future). */
export async function withdrawEmployeeComponent(input: z.input<typeof withdrawEntryInput>, access?: PayrollAccess): Promise<EmployeeComponentView> {
  const p = parse(withdrawEntryInput, input);
  return withTenant(p.client, async (tx) => {
    const grant = await judge(tx, p.client, access, MAINTAIN);
    const [row] = await tx.select().from(employeePayComponent)
      .where(and(eq(employeePayComponent.client, p.client), eq(employeePayComponent.entryId, p.entryId))).limit(1);
    if (!row) refuse('ENTRY_UNKNOWN', `Entry ${p.entryId} does not exist.`, 'Choose an entry of this employee.');
    await employeeLock(tx, p.client, row.personnelNumber);
    const [current] = await tx.select().from(employeePayComponent)
      .where(and(eq(employeePayComponent.client, p.client), eq(employeePayComponent.entryId, p.entryId))).for('update').limit(1);
    const e = current!;
    await assertScope(tx, p.client, grant, e.personnelNumber, e.validFrom);
    if (e.status !== 'ACTIVE') refuse('ENTRY_WITHDRAWN', `Entry ${e.entryId} is already withdrawn.`);
    const frozen = await frozenResult(tx, p.client, e.personnelNumber, e.validFrom, e.validTo);
    if (frozen) {
      refuse('HISTORY_FROZEN', `Entry ${e.entryId} was used by period ${frozen.period}/${frozen.fiscal_year} (run ${frozen.run_id}, ${frozen.status.toLowerCase()}) and cannot be withdrawn.`, 'End it from a later date instead; correct the past with an approved one-time adjustment in a later period.');
    }
    await tx.update(employeePayComponent)
      .set({ status: 'WITHDRAWN', withdrawnReason: p.reason, changedBy: p.changedBy, changedAt: sql`clock_timestamp()` as unknown as Date })
      .where(and(eq(employeePayComponent.client, p.client), eq(employeePayComponent.entryId, p.entryId)));
    await recordChange(tx, {
      client: p.client, objectClass: EMPLOYEE_COMPONENT_OBJECT_CLASS, objectKey: `${e.personnelNumber}/${e.entryId}`, changeType: 'CHANGE',
      changedBy: p.changedBy, transactionCode: COMPONENT_MAINTAIN_CAPABILITY, reason: p.reason,
      before: { status: 'ACTIVE' }, after: { status: 'WITHDRAWN' },
    });
    return (await oneEntry(tx, p.client, p.entryId))!;
  });
}

/** An employee's recurring entries, newest first. Pay is sensitive: scope and capability are judged here. */
export async function listEmployeeComponents(clientInput: string, personnelInput: string, access?: PayrollAccess): Promise<EmployeeComponentView[]> {
  const client = parse(clientField, clientInput);
  const personnelNumber = parse(personnelField, personnelInput);
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, READ_ENTRIES);
    await assertScope(tx, client, grant, personnelNumber, new Date().toISOString().slice(0, 10));
    const rows = (await tx.execute(sql`${ENTRY_SELECT} where e.client = ${client} and e.personnel_number = ${personnelNumber} order by e.valid_from desc, e.created_at desc`)) as unknown as Array<Record<string, unknown>>;
    return rows.map(entryView);
  });
}

/** Components an entry or adjustment may use: valid earning, deduction or employer-contribution components. */
export async function listEntryComponents(clientInput: string): Promise<Array<{ code: string; name: string; componentKind: string }>> {
  const client = parse(clientField, clientInput);
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select code, name, component_kind from pay_component
       where client = ${client} and is_valid and component_kind <> ${EOS_PROVISION_KIND} order by code`)) as unknown as Array<{ code: string; name: string; component_kind: string }>;
    return rows.map((r) => ({ code: r.code, name: r.name, componentKind: r.component_kind }));
  });
}

// ── One-time adjustments ────────────────────────────────────────────────────

const ADJUSTMENT_SELECT = sql`
  select a.*, a.amount::text as amount_text, p.name as component_name, e.full_name
    from payroll_adjustment a
    left join pay_component p on p.client = a.client and p.code = a.component_code
    left join employee e on e.client = a.client and e.personnel_number = a.personnel_number`;

function adjustmentView(r: Record<string, unknown>): AdjustmentView {
  return {
    adjustmentId: String(r.adjustment_id),
    companyCode: String(r.company_code),
    fiscalYear: Number(r.fiscal_year),
    period: Number(r.period),
    personnelNumber: String(r.personnel_number),
    employeeName: (r.full_name as string | null) ?? null,
    componentCode: String(r.component_code),
    componentName: (r.component_name as string | null) ?? null,
    componentKind: String(r.component_kind),
    amount: plain(r.amount_text),
    currency: String(r.currency).trim(),
    reason: String(r.reason),
    sourceReference: (r.source_reference as string | null) ?? null,
    correctsResultId: (r.corrects_result_id as string | null) ?? null,
    status: String(r.status) as AdjustmentStatus,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: stamp(r.decided_at),
    decisionNote: (r.decision_note as string | null) ?? null,
    appliedRunId: (r.applied_run_id as string | null) ?? null,
    appliedResultId: (r.applied_result_id as string | null) ?? null,
    appliedAt: stamp(r.applied_at),
    createdBy: String(r.created_by),
    createdAt: stamp(r.created_at)!,
  };
}

async function oneAdjustment(tx: Tx, client: string, id: string): Promise<AdjustmentView | null> {
  const rows = (await tx.execute(sql`${ADJUSTMENT_SELECT} where a.client = ${client} and a.adjustment_id = ${id}`)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? adjustmentView(rows[0]) : null;
}

/** Is the employee already paid for the period by a released or posted run? Then only a later period can take the adjustment. */
async function frozenPeriodCover(tx: Tx, client: string, companyCode: string, fiscalYear: number, period: number, personnelNumber: string) {
  const rows = (await tx.execute(sql`
    select run.run_id, run.status from payroll_result r join payroll_run run on run.client = r.client and run.run_id = r.run_id
     where r.client = ${client} and r.personnel_number = ${personnelNumber} and run.company_code = ${companyCode}
       and run.fiscal_year = ${fiscalYear} and run.period = ${period} and run.status in ('RELEASED', 'POSTED') limit 1`)) as unknown as Array<{ run_id: string; status: string }>;
  return rows[0] ?? null;
}

/**
 * Enter a one-time adjustment as a payroll document, PENDING until someone else approves it. Fixed positive amount in
 * the company's payroll currency. A frozen period is refused: the adjustment belongs in a later eligible period.
 */
export async function enterAdjustment(input: EnterAdjustmentInput, access?: PayrollAccess): Promise<AdjustmentView> {
  const p = parse(adjustmentInput, input);
  return withTenant(p.client, async (tx) => {
    const grant = await judge(tx, p.client, access, ENTER);
    assertCompanyScope(grant, p.companyCode, refuse);
    if (p.requestKey) {
      const [again] = await tx.select({ id: payrollAdjustment.adjustmentId }).from(payrollAdjustment)
        .where(and(eq(payrollAdjustment.client, p.client), eq(payrollAdjustment.requestKey, p.requestKey))).limit(1);
      if (again) return (await oneAdjustment(tx, p.client, again.id))!;
    }
    await lockPeriod(tx, p.client, p.companyCode, p.fiscalYear, p.period);
    const { company, dates } = await assertPeriodOpen(tx, p.client, p.companyCode, p.fiscalYear, p.period);
    const currency = String(company.currency).trim();
    const component = await componentOf(tx, p.client, p.componentCode);
    const [person] = (await tx.execute(sql`select 1 as x from employee where client = ${p.client} and personnel_number = ${p.personnelNumber}`)) as unknown as unknown[];
    if (!person) refuse('EMPLOYEE_UNKNOWN', `Employee ${p.personnelNumber} does not exist.`, `Choose an employee at ${EMPLOYEE_ROUTE}.`);
    await assertScope(tx, p.client, grant, p.personnelNumber, dates.to);
    const [held] = (await tx.execute(sql`
      select 1 as x from position_assignment pa
       where pa.client = ${p.client} and pa.personnel_number = ${p.personnelNumber} and pa.valid_from <= ${dates.to}::date
         and (pa.valid_to is null or pa.valid_to >= ${dates.from}::date) and pa.company_code = ${p.companyCode} limit 1`)) as unknown as unknown[];
    const [viaCentre] = held ? [held] : (await tx.execute(sql`
      select 1 as x from position_assignment pa join cost_center cc on cc.client = pa.client and cc.controlling_area = pa.controlling_area and cc.cost_center = pa.cost_center
       where pa.client = ${p.client} and pa.personnel_number = ${p.personnelNumber} and pa.company_code is null and pa.valid_from <= ${dates.to}::date
         and (pa.valid_to is null or pa.valid_to >= ${dates.from}::date) and cc.company_code = ${p.companyCode} limit 1`)) as unknown as unknown[];
    if (!viaCentre) {
      refuse('NOT_IN_COMPANY', `Employee ${p.personnelNumber} holds no position in company ${p.companyCode} in period ${p.period}/${p.fiscalYear}.`, `Check the position assignment at /people/assignments, or choose the company that pays the employee.`);
    }
    const frozen = await frozenPeriodCover(tx, p.client, p.companyCode, p.fiscalYear, p.period, p.personnelNumber);
    if (frozen) {
      refuse(
        'PERIOD_FROZEN',
        `Employee ${p.personnelNumber} is already paid for period ${p.period}/${p.fiscalYear} by ${frozen.status.toLowerCase()} run ${frozen.run_id}; a payroll result is never reopened and an employee is not paid twice for one period.`,
        'Enter the adjustment for a later eligible period. Nothing is corrected retroactively.',
      );
    }
    const decimals = await currencyDecimals(tx, currency);
    const fraction = (p.amount.split('.')[1] ?? '').replace(/0+$/, '');
    if (fraction.length > decimals) refuse('AMOUNT_PRECISION', `${p.amount} has more than ${decimals} decimals; ${currency} has ${decimals}.`, `Enter the amount to ${decimals} decimals.`);
    if (!(Number(p.amount) > 0)) refuse('AMOUNT_NOT_POSITIVE', 'An adjustment amount must be greater than zero.', 'Enter an offsetting adjustment with the opposite component instead of a negative amount.');
    const mapped = (await tx.execute(sql`
      select 1 as x from pay_component_config where client = ${p.client} and component_code = ${p.componentCode} and chart_of_accounts = ${company.chartOfAccounts} limit 1`)) as unknown as unknown[];
    if (mapped.length === 0) refuse('COMPONENT_UNMAPPED', `Component ${p.componentCode} is not mapped to accounts in chart ${company.chartOfAccounts} of company ${p.companyCode}.`, `Map it at ${PAY_COMPONENT_ROUTE} before entering adjustments with it.`);
    if (p.correctsResultId) {
      const [target] = (await tx.execute(sql`
        select r.personnel_number, run.status from payroll_result r join payroll_run run on run.client = r.client and run.run_id = r.run_id
         where r.client = ${p.client} and r.result_id = ${p.correctsResultId}`)) as unknown as Array<{ personnel_number: string; status: string }>;
      if (!target || target.personnel_number !== p.personnelNumber) {
        refuse('CORRECTION_TARGET', `Result ${p.correctsResultId} does not exist for employee ${p.personnelNumber}.`, 'Reference a payroll result of this employee, or leave the field empty.');
      }
      if (component.component_kind === 'EMPLOYER_CONTRIBUTION') {
        refuse(
          'CONTRIBUTION_CORRECTION_UNSUPPORTED',
          'A correction of an employer contribution cannot be posted safely: the payroll posting model has no reversal of a contribution, and an employee deduction is not a substitute for one.',
          'Correct it by a manual journal entry in Finance (debit the contribution payable, credit the contribution expense) and document it; do not enter it as a payroll adjustment.',
        );
      }
    }
    const adjustmentId = randomUUID();
    await tx.insert(payrollAdjustment).values({
      client: p.client, adjustmentId, companyCode: p.companyCode, fiscalYear: p.fiscalYear, period: p.period, personnelNumber: p.personnelNumber,
      componentCode: p.componentCode, componentKind: component.component_kind, amount: p.amount, currency, reason: p.reason,
      sourceReference: p.sourceReference, correctsResultId: p.correctsResultId, requestKey: p.requestKey || null, createdBy: p.changedBy,
    });
    await recordChange(tx, {
      client: p.client, objectClass: PAYROLL_ADJUSTMENT_OBJECT_CLASS, objectKey: adjustmentId, changeType: 'CREATE',
      changedBy: p.changedBy, transactionCode: ADJUSTMENT_ENTER_CAPABILITY, reason: p.reason,
      after: {
        company: p.companyCode, fiscalYear: p.fiscalYear, period: p.period, employee: p.personnelNumber, component: p.componentCode,
        kind: component.component_kind, amount: p.amount, currency, status: 'PENDING', sourceReference: p.sourceReference, correctsResultId: p.correctsResultId,
      },
      securityRelevantFields: ['amount'],
    });
    return (await oneAdjustment(tx, p.client, adjustmentId))!;
  });
}

/**
 * Approve or reject a PENDING adjustment. The approver holds the approve capability, reaches the employee's
 * company and plant, and is not the person who entered it. The transition is one conditional UPDATE from PENDING,
 * so two concurrent decisions can never both win.
 */
export async function decideAdjustment(input: DecideAdjustmentInput, access?: PayrollAccess): Promise<AdjustmentView> {
  const p = parse(decideInput, input);
  if (p.decision === 'REJECT' && !p.note) refuse('DECISION_NOTE', 'Say why the adjustment is rejected.', 'Enter a rejection note.');
  return withTenant(p.client, async (tx) => {
    const grant = await judge(tx, p.client, access, APPROVE);
    const [row] = await tx.select().from(payrollAdjustment)
      .where(and(eq(payrollAdjustment.client, p.client), eq(payrollAdjustment.adjustmentId, p.adjustmentId))).limit(1);
    // Out-of-reach documents answer like unknown ones.
    if (!row || !reachesCompany(grant, row.companyCode) || !(await reaches(tx, p.client, grant, row.personnelNumber, new Date().toISOString().slice(0, 10)))) {
      refuse('ADJUSTMENT_UNKNOWN', `Adjustment ${p.adjustmentId} does not exist, or lies outside your scope.`, 'Choose an adjustment of an employee you reach.');
    }
    if (row.createdBy.toLowerCase() === p.changedBy.toLowerCase()) {
      refuse('SELF_APPROVAL', 'You entered this adjustment; someone else must approve or reject it.', 'Ask another authorised approver.');
    }
    await lockPeriod(tx, p.client, row.companyCode, row.fiscalYear, row.period);
    const [standing] = await tx.select({ status: payrollAdjustment.status }).from(payrollAdjustment)
      .where(and(eq(payrollAdjustment.client, p.client), eq(payrollAdjustment.adjustmentId, p.adjustmentId))).limit(1);
    if (standing?.status !== 'PENDING') {
      refuse('ADJUSTMENT_STATE', `Adjustment ${p.adjustmentId} is ${String(standing?.status ?? row.status).toLowerCase()}; only a pending adjustment can be decided.`, 'Reload the adjustment.');
    }
    if (p.decision === 'APPROVE') {
      await assertPeriodOpen(tx, p.client, row.companyCode, row.fiscalYear, row.period);
      const frozen = await frozenPeriodCover(tx, p.client, row.companyCode, row.fiscalYear, row.period, row.personnelNumber);
      if (frozen) {
        refuse('PERIOD_FROZEN', `Employee ${row.personnelNumber} is already paid for period ${row.period}/${row.fiscalYear} by ${frozen.status.toLowerCase()} run ${frozen.run_id}.`, 'Cancel this adjustment and enter it for a later eligible period.');
      }
    }
    const now = new Date();
    const next: AdjustmentStatus = p.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const updated = await tx.update(payrollAdjustment)
      .set({ status: next, decidedBy: p.changedBy, decidedAt: now, decisionNote: p.note, changedBy: p.changedBy, changedAt: now })
      .where(and(eq(payrollAdjustment.client, p.client), eq(payrollAdjustment.adjustmentId, p.adjustmentId), eq(payrollAdjustment.status, 'PENDING')))
      .returning({ id: payrollAdjustment.adjustmentId });
    if (updated.length === 0) {
      const [now2] = await tx.select({ status: payrollAdjustment.status }).from(payrollAdjustment)
        .where(and(eq(payrollAdjustment.client, p.client), eq(payrollAdjustment.adjustmentId, p.adjustmentId))).limit(1);
      refuse('ADJUSTMENT_STATE', `Adjustment ${p.adjustmentId} is ${String(now2?.status ?? row.status).toLowerCase()}; only a pending adjustment can be decided.`, 'Reload the adjustment.');
    }
    await recordChange(tx, {
      client: p.client, objectClass: PAYROLL_ADJUSTMENT_OBJECT_CLASS, objectKey: p.adjustmentId, changeType: 'CHANGE',
      changedBy: p.changedBy, transactionCode: ADJUSTMENT_APPROVE_CAPABILITY, reason: p.note ?? undefined,
      before: { status: 'PENDING' }, after: { status: next, decidedBy: p.changedBy, decisionNote: p.note },
      securityRelevantFields: ['status'],
    });
    return (await oneAdjustment(tx, p.client, p.adjustmentId))!;
  });
}

/** Cancel a PENDING or APPROVED adjustment. An applied one is part of a released result and is never changed. */
export async function cancelAdjustment(input: CancelAdjustmentInput, access?: PayrollAccess): Promise<AdjustmentView> {
  const p = parse(cancelAdjustmentInput, input);
  return withTenant(p.client, async (tx) => {
    const grant = await judge(tx, p.client, access, [...ENTER, ...APPROVE]);
    const [row] = await tx.select().from(payrollAdjustment)
      .where(and(eq(payrollAdjustment.client, p.client), eq(payrollAdjustment.adjustmentId, p.adjustmentId))).limit(1);
    if (!row || !reachesCompany(grant, row.companyCode) || !(await reaches(tx, p.client, grant, row.personnelNumber, new Date().toISOString().slice(0, 10)))) {
      refuse('ADJUSTMENT_UNKNOWN', `Adjustment ${p.adjustmentId} does not exist, or lies outside your scope.`, 'Choose an adjustment of an employee you reach.');
    }
    await lockPeriod(tx, p.client, row.companyCode, row.fiscalYear, row.period);
    const now = new Date();
    const updated = await tx.update(payrollAdjustment)
      .set({ status: 'CANCELLED', decisionNote: p.reason, changedBy: p.changedBy, changedAt: now })
      .where(and(eq(payrollAdjustment.client, p.client), eq(payrollAdjustment.adjustmentId, p.adjustmentId), sql`${payrollAdjustment.status} in ('PENDING', 'APPROVED')`))
      .returning({ id: payrollAdjustment.adjustmentId });
    if (updated.length === 0) {
      const [cur] = await tx.select({ status: payrollAdjustment.status }).from(payrollAdjustment)
        .where(and(eq(payrollAdjustment.client, p.client), eq(payrollAdjustment.adjustmentId, p.adjustmentId))).limit(1);
      refuse(
        cur?.status === 'APPLIED' ? 'ADJUSTMENT_APPLIED' : 'ADJUSTMENT_STATE',
        `Adjustment ${p.adjustmentId} is ${String(cur?.status ?? row.status).toLowerCase()} and cannot be cancelled.`,
        cur?.status === 'APPLIED' ? 'It is part of a released result. Enter a new approved adjustment in a later period.' : 'Reload the adjustment.',
      );
    }
    await recordChange(tx, {
      client: p.client, objectClass: PAYROLL_ADJUSTMENT_OBJECT_CLASS, objectKey: p.adjustmentId, changeType: 'CHANGE',
      changedBy: p.changedBy, transactionCode: ADJUSTMENT_ENTER_CAPABILITY, reason: p.reason,
      before: { status: row.status }, after: { status: 'CANCELLED' }, securityRelevantFields: ['status'],
    });
    return (await oneAdjustment(tx, p.client, p.adjustmentId))!;
  });
}

export interface AdjustmentFilter {
  companyCode?: string;
  fiscalYear?: number;
  period?: number;
  personnelNumber?: string;
  status?: AdjustmentStatus;
}

/**
 * Adjustments the caller reaches. Amounts are pay data: the list is refused without a payroll capability, and a row
 * outside the caller's company, plant or employee reach is never returned.
 */
export async function listAdjustments(clientInput: string, filter: AdjustmentFilter, access?: PayrollAccess): Promise<AdjustmentView[]> {
  const client = parse(clientField, clientInput);
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, READ_ADJUSTMENTS);
    const rows = (await tx.execute(sql`
      ${ADJUSTMENT_SELECT}
      where a.client = ${client}
        ${filter.companyCode ? sql`and a.company_code = ${filter.companyCode.toUpperCase()}` : sql``}
        ${filter.fiscalYear ? sql`and a.fiscal_year = ${filter.fiscalYear}` : sql``}
        ${filter.period ? sql`and a.period = ${filter.period}` : sql``}
        ${filter.personnelNumber ? sql`and a.personnel_number = ${filter.personnelNumber.toUpperCase()}` : sql``}
        ${filter.status ? sql`and a.status = ${filter.status}` : sql``}
      order by a.created_at desc limit 500`)) as unknown as Array<Record<string, unknown>>;
    const out: AdjustmentView[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Map<string, boolean>();
    for (const r of rows) {
      if (!reachesCompany(grant, String(r.company_code))) continue;
      const pn = String(r.personnel_number);
      if (!seen.has(pn)) seen.set(pn, await reaches(tx, client, grant, pn, today));
      if (seen.get(pn)) out.push(adjustmentView(r));
    }
    return out;
  });
}

