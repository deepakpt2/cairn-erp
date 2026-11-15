/**
 * Payroll phase 1 — what must stand before a payroll run can be created.
 *
 * SAP reference: pay scale group/level (T510) is the salary structure; basic pay infotype 0008
 * (PA30) is the structure assignment; a wage type (T511) is the existing `pay_component`.
 *
 * The rule this file keeps: a component never carries an amount rule. The structure component
 * does — FIXED or PERCENT_OF_BASE — so the same component can be 10 % of base in one structure
 * and a fixed amount in another, and a formula engine is a later, additive kind rather than a
 * rewrite (DV-001: nothing statutory, no formula, no country law).
 *
 * Phase 1 posts nothing and calculates nothing. `validateEmployeeForRun` is its point: it answers,
 * per employee, whether a run may include them, naming every reason it may not. It returns a
 * result and never throws, because a run lists the unready employees rather than stopping.
 *
 * Dates follow every dated people table: `valid_to` is the last day that applies (inclusive).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  AMOUNT_KINDS,
  SALARY_ASSIGNMENT_OBJECT_CLASS,
  SALARY_STRUCTURE_CAPABILITY,
  SALARY_STRUCTURE_OBJECT_CLASS,
  SALARY_STRUCTURE_ROUTE,
  employee,
  payComponent,
  salaryStructure,
  salaryStructureAssignment,
  salaryStructureComponent,
  type AmountKind,
} from './schema';

export {
  AMOUNT_KINDS,
  SALARY_ASSIGNMENT_OBJECT_CLASS,
  SALARY_STRUCTURE_CAPABILITY,
  SALARY_STRUCTURE_OBJECT_CLASS,
  SALARY_STRUCTURE_ROUTE,
};
export type { AmountKind };

/** Where the employee's pay structure is assigned. */
export const EMPLOYEE_ROUTE = '/people/employees';
/** Where a pay component is mapped to accounts. */
export const PAY_COMPONENT_ROUTE = '/config/pay-components';
/** Reading an employee's pay structure: the definer, or whoever may read a payroll result. */
export const PAYROLL_RESULT_CAPABILITY = 'PEOPLE.PAYROLL.RESULT';

// ── Errors ──────────────────────────────────────────────────────────────────

export class PayrollStructureError extends Error {
  remedy?: string;
  /** A stable code a test or caller can branch on. The message is for people. */
  readonly code: string;
  constructor(message: string, remedy?: string, code = 'PAYROLL_STRUCTURE') {
    super(message);
    this.name = 'PayrollStructureError';
    this.remedy = remedy;
    this.code = code;
  }
}

function refuse(code: string, message: string, remedy?: string): never {
  throw new PayrollStructureError(message, remedy, code);
}

function assertCapability(capabilities: readonly string[] | undefined, actor: string): void {
  if (!capabilities || !hasCapability([...capabilities], SALARY_STRUCTURE_CAPABILITY)) {
    refuse(
      'PAYROLL_AUTHORITY',
      `${actor} does not hold ${SALARY_STRUCTURE_CAPABILITY}.`,
      `Ask an administrator for ${SALARY_STRUCTURE_CAPABILITY}. Payroll authority is granted to no role by default.`,
    );
  }
}

// ── Input ───────────────────────────────────────────────────────────────────

const clientField = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, 'A tenant is two to four capitals or digits.');
const codeField = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'A code is two to ten capitals and digits, starting with a letter.');
const personnelField = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,20}$/, 'A personnel number is one to twenty capitals or digits.');
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');
const optionalDate = z.union([z.literal('').transform(() => null), isoDate, z.null()]).optional();
const currencyField = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'A currency is three capitals.');
const amountField = z.union([z.number(), z.string().trim()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^\d{1,19}(\.\d{1,4})?$/, 'An amount is a non-negative number with at most four decimals.'));
const actor = z.string().trim().min(1).max(60);

const structureInput = z.object({
  client: clientField,
  code: codeField,
  name: z.string().trim().min(1, 'A structure needs a name.').max(60),
  currency: currencyField,
  validFrom: isoDate,
  validTo: optionalDate,
  changedBy: actor,
});

const changeStructureInput = z.object({
  client: clientField,
  code: codeField,
  name: z.string().trim().min(1).max(60).optional(),
  validTo: optionalDate,
  isValid: z.boolean().optional(),
  changedBy: actor,
});

const componentInput = z.object({
  client: clientField,
  structureCode: codeField,
  componentCode: codeField,
  amountKind: z.string().trim().toUpperCase(),
  amountValue: amountField,
  changedBy: actor,
});

const assignmentInput = z.object({
  client: clientField,
  personnelNumber: personnelField,
  structureCode: codeField,
  baseAmount: amountField,
  currency: currencyField,
  validFrom: isoDate,
  validTo: optionalDate,
  requestKey: z.string().trim().max(64).optional(),
  changedBy: actor,
});

const endAssignmentInput = z.object({
  client: clientField,
  assignmentId: z.string().trim().min(1).max(36),
  validTo: isoDate,
  changedBy: actor,
});

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse('PAYROLL_INPUT', `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'not valid'}`, 'Correct the field and try again.');
  }
  return parsed.data;
}

export type StructureInput = z.input<typeof structureInput>;
export type ChangeStructureInput = z.input<typeof changeStructureInput>;
export type ComponentInput = z.input<typeof componentInput>;
export type AssignmentInput = z.input<typeof assignmentInput>;
export type EndAssignmentInput = z.input<typeof endAssignmentInput>;

// ── Views ───────────────────────────────────────────────────────────────────

export interface StructureRow {
  code: string;
  name: string;
  currency: string;
  validFrom: string;
  validTo: string | null;
  isValid: boolean;
  components: number;
}

export interface ComponentView {
  structureCode: string;
  componentCode: string;
  componentName: string;
  componentKind: string;
  amountKind: AmountKind;
  /** FIXED: the amount. PERCENT_OF_BASE: the rate (7.5 = 7.5 %). As stored, never rounded here. */
  amountValue: string;
}

export interface StructureView extends Omit<StructureRow, 'components'> {
  components: ComponentView[];
}

export interface AssignmentView {
  assignmentId: string;
  personnelNumber: string;
  structureCode: string;
  structureName: string | null;
  baseAmount: string;
  currency: string;
  validFrom: string;
  validTo: string | null;
}

export interface ReadinessReason {
  code:
    | 'NO_STRUCTURE'
    | 'OVERLAPPING_STRUCTURES'
    | 'STRUCTURE_NOT_VALID'
    | 'STRUCTURE_EMPTY'
    | 'COMPONENT_UNMAPPED'
    | 'NO_POSITION'
    | 'NO_COST_CENTRE'
    | 'NO_COMPANY'
    | 'CURRENCY_DIFFERS';
  message: string;
  remedy?: string;
}

export interface EmployeeRunReadiness {
  personnelNumber: string;
  periodFrom: string;
  periodTo: string;
  /** True when nothing in `reasons` stands in the way. */
  ready: boolean;
  /** What stops the employee being included. Empty when ready. */
  reasons: ReadinessReason[];
  /** Recorded, not refused (phase 1): e.g. paid in a currency other than the company's books. */
  notes: ReadinessReason[];
}

function numberText(value: unknown): string {
  return value === null || value === undefined ? '0' : String(value);
}

// ── Structures ──────────────────────────────────────────────────────────────

async function assertCurrency(tx: Tx, currency: string): Promise<void> {
  const rows = (await tx.execute(sql`select 1 from currency where code = ${currency} limit 1`)) as unknown as unknown[];
  if (rows.length === 0) refuse('PAYROLL_CURRENCY', `Currency ${currency} is not defined.`, 'Choose a currency from the currency table.');
}

async function loadStructure(tx: Tx, client: string, code: string) {
  const [row] = await tx
    .select()
    .from(salaryStructure)
    .where(and(eq(salaryStructure.client, client), eq(salaryStructure.code, code)))
    .limit(1);
  return row ?? null;
}

async function structureView(tx: Tx, client: string, code: string): Promise<StructureView> {
  const row = await loadStructure(tx, client, code);
  if (!row) refuse('STRUCTURE_UNKNOWN', `Salary structure ${code} does not exist.`, `Define it at ${SALARY_STRUCTURE_ROUTE}.`);
  const components = await tx
    .select({
      componentCode: salaryStructureComponent.componentCode,
      amountKind: salaryStructureComponent.amountKind,
      amountValue: salaryStructureComponent.amountValue,
      componentName: payComponent.name,
      componentKind: payComponent.componentKind,
    })
    .from(salaryStructureComponent)
    .innerJoin(
      payComponent,
      and(eq(payComponent.client, salaryStructureComponent.client), eq(payComponent.code, salaryStructureComponent.componentCode)),
    )
    .where(and(eq(salaryStructureComponent.client, client), eq(salaryStructureComponent.structureCode, code)))
    .orderBy(asc(salaryStructureComponent.componentCode));
  return {
    code: row.code,
    name: row.name,
    currency: row.currency,
    validFrom: row.validFrom,
    validTo: row.validTo,
    isValid: row.isValid,
    components: components.map((c) => ({
      structureCode: code,
      componentCode: c.componentCode,
      componentName: c.componentName,
      componentKind: c.componentKind,
      amountKind: c.amountKind as AmountKind,
      amountValue: numberText(c.amountValue),
    })),
  };
}

/** Define a salary structure. It names what is paid; it never names a person. */
export async function defineSalaryStructure(input: StructureInput, capabilities?: readonly string[]): Promise<StructureView> {
  const parsed = parse(structureInput, input);
  assertCapability(capabilities, parsed.changedBy);
  if (parsed.validTo && parsed.validTo < parsed.validFrom) {
    refuse('STRUCTURE_PERIOD', `A structure cannot end (${parsed.validTo}) before it starts (${parsed.validFrom}).`, 'Choose an end date on or after the start.');
  }
  return withTenant(parsed.client, async (tx) => {
    await assertCurrency(tx, parsed.currency);
    if (await loadStructure(tx, parsed.client, parsed.code)) {
      refuse('STRUCTURE_EXISTS', `Salary structure ${parsed.code} already exists.`, 'Change it instead, or choose another code.');
    }
    await tx.insert(salaryStructure).values({
      client: parsed.client,
      code: parsed.code,
      name: parsed.name,
      currency: parsed.currency,
      validFrom: parsed.validFrom,
      validTo: parsed.validTo ?? null,
      isValid: true,
      createdBy: parsed.changedBy,
    });
    await recordChange(tx, {
      client: parsed.client,
      objectClass: SALARY_STRUCTURE_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      transactionCode: SALARY_STRUCTURE_CAPABILITY,
      after: { name: parsed.name, currency: parsed.currency, validFrom: parsed.validFrom, validTo: parsed.validTo ?? null },
    });
    return structureView(tx, parsed.client, parsed.code);
  });
}

/**
 * Rename a structure, move its end, or retire it. Retirement is by validity, never by delete. The
 * currency and start are not changed here: assignments were made against them.
 */
export async function changeSalaryStructure(input: ChangeStructureInput, capabilities?: readonly string[]): Promise<StructureView> {
  const parsed = parse(changeStructureInput, input);
  assertCapability(capabilities, parsed.changedBy);
  return withTenant(parsed.client, async (tx) => {
    const standing = await loadStructure(tx, parsed.client, parsed.code);
    if (!standing) refuse('STRUCTURE_UNKNOWN', `Salary structure ${parsed.code} does not exist.`, `Define it at ${SALARY_STRUCTURE_ROUTE}.`);
    const patch: { name?: string; validTo?: string | null; isValid?: boolean } = {};
    if (parsed.name !== undefined && parsed.name !== standing.name) patch.name = parsed.name;
    if (parsed.validTo !== undefined && parsed.validTo !== standing.validTo) {
      if (parsed.validTo && parsed.validTo < standing.validFrom) {
        refuse('STRUCTURE_PERIOD', `Structure ${parsed.code} starts ${standing.validFrom}; it cannot end on ${parsed.validTo}.`, 'Choose an end date on or after the start.');
      }
      patch.validTo = parsed.validTo;
    }
    if (parsed.isValid !== undefined && parsed.isValid !== standing.isValid) patch.isValid = parsed.isValid;
    if (Object.keys(patch).length === 0) refuse('NOTHING_TO_CHANGE', `Nothing about structure ${parsed.code} would change.`, 'Change the name, the end date or the validity.');
    await tx
      .update(salaryStructure)
      .set({ ...patch, changedBy: parsed.changedBy, changedAt: new Date() })
      .where(and(eq(salaryStructure.client, parsed.client), eq(salaryStructure.code, parsed.code)));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: SALARY_STRUCTURE_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      transactionCode: SALARY_STRUCTURE_CAPABILITY,
      before: { name: standing.name, validTo: standing.validTo, isValid: standing.isValid },
      after: patch,
    });
    return structureView(tx, parsed.client, parsed.code);
  });
}

/**
 * Add a component to a structure, or change its amount rule. The rule lives here and only here;
 * nothing is written to `pay_component`.
 */
export async function setStructureComponent(input: ComponentInput, capabilities?: readonly string[]): Promise<ComponentView> {
  const parsed = parse(componentInput, input);
  assertCapability(capabilities, parsed.changedBy);
  if (!(AMOUNT_KINDS as readonly string[]).includes(parsed.amountKind)) {
    refuse('AMOUNT_KIND', `Amount kind "${parsed.amountKind}" is not one of ${AMOUNT_KINDS.join(', ')}.`, 'A formula is not built; use a fixed amount or a percentage of base.');
  }
  if (parsed.amountKind === 'PERCENT_OF_BASE' && Number(parsed.amountValue) > 100) {
    refuse('PERCENT_OVER_100', `A percentage of base cannot exceed 100; ${parsed.amountValue} was given for ${parsed.componentCode}.`, 'Enter a rate from 0 to 100 (7.5 means 7.5 %).');
  }
  return withTenant(parsed.client, async (tx) => {
    const structure = await loadStructure(tx, parsed.client, parsed.structureCode);
    if (!structure) refuse('STRUCTURE_UNKNOWN', `Salary structure ${parsed.structureCode} does not exist.`, `Define it at ${SALARY_STRUCTURE_ROUTE}.`);
    const [component] = await tx
      .select()
      .from(payComponent)
      .where(and(eq(payComponent.client, parsed.client), eq(payComponent.code, parsed.componentCode)))
      .limit(1);
    if (!component) {
      refuse('COMPONENT_UNKNOWN', `Pay component ${parsed.componentCode} does not exist.`, `Define it at ${PAY_COMPONENT_ROUTE}.`);
    }
    if (!component.isValid) {
      refuse('COMPONENT_RETIRED', `Pay component ${parsed.componentCode} is retired.`, `Choose a valid component, or restore it at ${PAY_COMPONENT_ROUTE}.`);
    }
    const [standing] = await tx
      .select()
      .from(salaryStructureComponent)
      .where(and(
        eq(salaryStructureComponent.client, parsed.client),
        eq(salaryStructureComponent.structureCode, parsed.structureCode),
        eq(salaryStructureComponent.componentCode, parsed.componentCode),
      ))
      .limit(1);
    if (standing) {
      await tx
        .update(salaryStructureComponent)
        .set({ amountKind: parsed.amountKind, amountValue: parsed.amountValue, changedBy: parsed.changedBy, changedAt: new Date() })
        .where(and(
          eq(salaryStructureComponent.client, parsed.client),
          eq(salaryStructureComponent.structureCode, parsed.structureCode),
          eq(salaryStructureComponent.componentCode, parsed.componentCode),
        ));
    } else {
      await tx.insert(salaryStructureComponent).values({
        client: parsed.client,
        structureCode: parsed.structureCode,
        componentCode: parsed.componentCode,
        amountKind: parsed.amountKind,
        amountValue: parsed.amountValue,
        createdBy: parsed.changedBy,
      });
    }
    await recordChange(tx, {
      client: parsed.client,
      objectClass: SALARY_STRUCTURE_OBJECT_CLASS,
      objectKey: `${parsed.structureCode}/${parsed.componentCode}`,
      changeType: standing ? 'CHANGE' : 'CREATE',
      changedBy: parsed.changedBy,
      transactionCode: SALARY_STRUCTURE_CAPABILITY,
      before: standing ? { amountKind: standing.amountKind, amountValue: numberText(standing.amountValue) } : undefined,
      after: { amountKind: parsed.amountKind, amountValue: parsed.amountValue },
    });
    const view = await structureView(tx, parsed.client, parsed.structureCode);
    return view.components.find((c) => c.componentCode === parsed.componentCode)!;
  });
}

/** Every structure in the tenant, with how many components it names. */
export async function listStructures(clientInput: string): Promise<StructureRow[]> {
  const client = parse(clientField, clientInput);
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select s.code, s.name, s.currency, s.valid_from, s.valid_to, s.is_valid,
             (select count(*)::int from salary_structure_component c
               where c.client = s.client and c.structure_code = s.code) as components
        from salary_structure s
       where s.client = ${client}
       order by s.code
    `)) as unknown as Array<{ code: string; name: string; currency: string; valid_from: string | Date; valid_to: string | Date | null; is_valid: boolean; components: number }>;
    const day = (v: string | Date | null) => (v === null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    return rows.map((r) => ({
      code: r.code, name: r.name, currency: r.currency, validFrom: day(r.valid_from)!, validTo: day(r.valid_to),
      isValid: r.is_valid, components: Number(r.components),
    }));
  });
}

/** One structure and its components with their amount rules. */
export async function getStructure(clientInput: string, codeInput: string): Promise<StructureView> {
  const client = parse(clientField, clientInput);
  const code = parse(codeField, codeInput);
  return withTenant(client, (tx) => structureView(tx, client, code));
}

/** The valid pay components a structure can name. */
export async function listAssignableComponents(clientInput: string): Promise<Array<{ code: string; name: string; componentKind: string }>> {
  const client = parse(clientField, clientInput);
  return withTenant(client, (tx) => tx
    .select({ code: payComponent.code, name: payComponent.name, componentKind: payComponent.componentKind })
    .from(payComponent)
    .where(and(eq(payComponent.client, client), eq(payComponent.isValid, true)))
    .orderBy(asc(payComponent.code)));
}

// ── Assignments ─────────────────────────────────────────────────────────────

/** Do two inclusive spans meet? A null end runs forever. */
function spansOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  return aFrom <= (bTo ?? '9999-12-31') && bFrom <= (aTo ?? '9999-12-31');
}

async function assignmentViews(tx: Tx, client: string, personnelNumber: string): Promise<AssignmentView[]> {
  const rows = await tx
    .select({
      assignmentId: salaryStructureAssignment.assignmentId,
      personnelNumber: salaryStructureAssignment.personnelNumber,
      structureCode: salaryStructureAssignment.structureCode,
      structureName: salaryStructure.name,
      baseAmount: salaryStructureAssignment.baseAmount,
      currency: salaryStructureAssignment.currency,
      validFrom: salaryStructureAssignment.validFrom,
      validTo: salaryStructureAssignment.validTo,
    })
    .from(salaryStructureAssignment)
    .leftJoin(
      salaryStructure,
      and(eq(salaryStructure.client, salaryStructureAssignment.client), eq(salaryStructure.code, salaryStructureAssignment.structureCode)),
    )
    .where(and(eq(salaryStructureAssignment.client, client), eq(salaryStructureAssignment.personnelNumber, personnelNumber)))
    .orderBy(desc(salaryStructureAssignment.validFrom));
  return rows.map((r) => ({ ...r, structureName: r.structureName ?? null, baseAmount: numberText(r.baseAmount) }));
}

async function oneAssignment(tx: Tx, client: string, assignmentId: string): Promise<AssignmentView | null> {
  const [row] = await tx
    .select({ personnelNumber: salaryStructureAssignment.personnelNumber })
    .from(salaryStructureAssignment)
    .where(and(eq(salaryStructureAssignment.client, client), eq(salaryStructureAssignment.assignmentId, assignmentId)))
    .limit(1);
  if (!row) return null;
  return (await assignmentViews(tx, client, row.personnelNumber)).find((a) => a.assignmentId === assignmentId) ?? null;
}

/**
 * Assign an employee a structure and a base amount from a date. Overlaps are refused by name, never
 * silently resolved: end the standing assignment first. A resubmitted form (same request key) is
 * handed the assignment it already made.
 */
export async function assignStructure(input: AssignmentInput, capabilities?: readonly string[]): Promise<AssignmentView> {
  const parsed = parse(assignmentInput, input);
  assertCapability(capabilities, parsed.changedBy);
  if (parsed.validTo && parsed.validTo < parsed.validFrom) {
    refuse('ASSIGNMENT_PERIOD', `An assignment cannot end (${parsed.validTo}) before it starts (${parsed.validFrom}).`, 'Choose an end date on or after the start.');
  }
  return withTenant(parsed.client, async (tx) => {
    if (parsed.requestKey) {
      const [again] = await tx
        .select({ assignmentId: salaryStructureAssignment.assignmentId })
        .from(salaryStructureAssignment)
        .where(and(eq(salaryStructureAssignment.client, parsed.client), eq(salaryStructureAssignment.requestKey, parsed.requestKey)))
        .limit(1);
      if (again) return (await oneAssignment(tx, parsed.client, again.assignmentId))!;
    }
    // One writer per employee at a time: the overlap test and the insert stand or fall together.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`salary-assignment:${parsed.client}:${parsed.personnelNumber}`}, 0))`);

    const [person] = await tx
      .select({ isActive: employee.isActive, fullName: employee.fullName })
      .from(employee)
      .where(and(eq(employee.client, parsed.client), eq(employee.personnelNumber, parsed.personnelNumber)))
      .limit(1);
    if (!person) refuse('EMPLOYEE_UNKNOWN', `Employee ${parsed.personnelNumber} does not exist.`, `Create the employee at ${EMPLOYEE_ROUTE}.`);
    if (!person.isActive) refuse('EMPLOYEE_INACTIVE', `Employee ${parsed.personnelNumber} is not active.`, 'Reactivate the employee first.');

    const structure = await loadStructure(tx, parsed.client, parsed.structureCode);
    if (!structure) refuse('STRUCTURE_UNKNOWN', `Salary structure ${parsed.structureCode} does not exist.`, `Define it at ${SALARY_STRUCTURE_ROUTE}.`);
    if (!structure.isValid) refuse('STRUCTURE_RETIRED', `Salary structure ${parsed.structureCode} is retired.`, 'Choose a valid structure.');
    if (parsed.validFrom < structure.validFrom || (structure.validTo !== null && parsed.validFrom > structure.validTo)) {
      refuse(
        'STRUCTURE_NOT_VALID',
        `Structure ${parsed.structureCode} is valid ${structure.validFrom} to ${structure.validTo ?? 'open'}; it does not stand on ${parsed.validFrom}.`,
        'Start the assignment inside the structure’s validity, or extend the structure.',
      );
    }
    await assertCurrency(tx, parsed.currency);

    const standing = await assignmentViews(tx, parsed.client, parsed.personnelNumber);
    const clash = standing.find((a) => spansOverlap(a.validFrom, a.validTo, parsed.validFrom, parsed.validTo ?? null));
    if (clash) {
      refuse(
        'ASSIGNMENT_OVERLAP',
        `Employee ${parsed.personnelNumber} already has structure ${clash.structureCode} from ${clash.validFrom} to ${clash.validTo ?? 'open'}, which overlaps ${parsed.validFrom} to ${parsed.validTo ?? 'open'}. Two pay structures cannot cover one day.`,
        `End the standing assignment the day before ${parsed.validFrom}, then assign the new one.`,
      );
    }

    const assignmentId = randomUUID();
    await tx.insert(salaryStructureAssignment).values({
      client: parsed.client,
      assignmentId,
      personnelNumber: parsed.personnelNumber,
      structureCode: parsed.structureCode,
      baseAmount: parsed.baseAmount,
      currency: parsed.currency,
      validFrom: parsed.validFrom,
      validTo: parsed.validTo ?? null,
      requestKey: parsed.requestKey || null,
      createdBy: parsed.changedBy,
    });
    await recordChange(tx, {
      client: parsed.client,
      objectClass: SALARY_ASSIGNMENT_OBJECT_CLASS,
      objectKey: `${parsed.personnelNumber}/${assignmentId}`,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      transactionCode: SALARY_STRUCTURE_CAPABILITY,
      after: {
        structure: parsed.structureCode, baseAmount: parsed.baseAmount, currency: parsed.currency,
        validFrom: parsed.validFrom, validTo: parsed.validTo ?? null,
      },
      securityRelevantFields: ['baseAmount'],
    });
    return (await oneAssignment(tx, parsed.client, assignmentId))!;
  });
}

/** End an assignment on a date (inclusive). The row stays, so history reads back. */
export async function endAssignment(input: EndAssignmentInput, capabilities?: readonly string[]): Promise<AssignmentView> {
  const parsed = parse(endAssignmentInput, input);
  assertCapability(capabilities, parsed.changedBy);
  return withTenant(parsed.client, async (tx) => {
    const [row] = await tx
      .select()
      .from(salaryStructureAssignment)
      .where(and(eq(salaryStructureAssignment.client, parsed.client), eq(salaryStructureAssignment.assignmentId, parsed.assignmentId)))
      .for('update')
      .limit(1);
    if (!row) refuse('ASSIGNMENT_UNKNOWN', `Assignment ${parsed.assignmentId} does not exist.`, 'Choose an assignment of this employee.');
    if (parsed.validTo < row.validFrom) {
      refuse('ASSIGNMENT_PERIOD', `The assignment starts ${row.validFrom}; it cannot end on ${parsed.validTo}.`, 'Choose an end date on or after the start.');
    }
    if (row.validTo !== null && parsed.validTo > row.validTo) {
      refuse('ASSIGNMENT_EXTEND', `The assignment already ends ${row.validTo}; ending it later would extend it.`, 'Assign a new structure from the next day instead.');
    }
    await tx
      .update(salaryStructureAssignment)
      .set({ validTo: parsed.validTo, changedBy: parsed.changedBy, changedAt: new Date() })
      .where(and(eq(salaryStructureAssignment.client, parsed.client), eq(salaryStructureAssignment.assignmentId, parsed.assignmentId)));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: SALARY_ASSIGNMENT_OBJECT_CLASS,
      objectKey: `${row.personnelNumber}/${row.assignmentId}`,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      transactionCode: SALARY_STRUCTURE_CAPABILITY,
      before: { validTo: row.validTo },
      after: { validTo: parsed.validTo },
    });
    return (await oneAssignment(tx, parsed.client, parsed.assignmentId))!;
  });
}

/** The assignment covering one employee on one date, or null. */
export async function assignmentFor(tx: Tx, client: string, personnelNumber: string, onDate: string): Promise<AssignmentView | null> {
  const all = await assignmentViews(tx, client, personnelNumber);
  return all.find((a) => a.validFrom <= onDate && (a.validTo === null || a.validTo >= onDate)) ?? null;
}

/** Every assignment of one employee, newest first: the history the employee screen shows. */
export async function listAssignments(clientInput: string, personnelInput: string): Promise<AssignmentView[]> {
  const client = parse(clientField, clientInput);
  const personnelNumber = parse(personnelField, personnelInput);
  return withTenant(client, (tx) => assignmentViews(tx, client, personnelNumber));
}

// ── Validation: what must stand before a run ────────────────────────────────

function* daysOf(from: string, to: string): Generator<string> {
  const day = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (day <= end) {
    yield day.toISOString().slice(0, 10);
    day.setUTCDate(day.getUTCDate() + 1);
  }
}

const MAX_PERIOD_DAYS = 366;

/**
 * May a run for this period include this employee? Every reason is named; nothing is thrown for a
 * reason, because a run lists the unready employees rather than stopping on the first.
 *
 * Coverage follows the employee's position: on every day they hold a position in the period, exactly
 * one pay structure must stand (a joiner or leaver is covered for the days they are there — phase 2
 * prorates from the same dates). The company is the position assignment's, or else its cost centre's;
 * its chart of accounts is where every component must be mapped, and its currency is the books'.
 */
export async function validateEmployeeForRun(
  tx: Tx,
  client: string,
  personnelNumber: string,
  periodFrom: string,
  periodTo: string,
): Promise<EmployeeRunReadiness> {
  const result: EmployeeRunReadiness = { personnelNumber, periodFrom, periodTo, ready: false, reasons: [], notes: [] };
  const reason = (code: ReadinessReason['code'], message: string, remedy?: string) => {
    if (!result.reasons.some((r) => r.code === code && r.message === message)) result.reasons.push({ code, message, remedy });
  };
  const days = periodTo >= periodFrom ? [...daysOf(periodFrom, periodTo)] : [];
  if (days.length === 0 || days.length > MAX_PERIOD_DAYS) {
    reason('NO_POSITION', `The period ${periodFrom} to ${periodTo} is not a payroll period.`, 'Give a period that ends on or after it starts, at most a year long.');
    return result;
  }

  // The employee's positions in the period.
  const positions = (await tx.execute(sql`
    select pa.valid_from, pa.valid_to, pa.company_code, pa.controlling_area, pa.cost_center
      from position_assignment pa
     where pa.client = ${client} and pa.personnel_number = ${personnelNumber}
       and pa.valid_from <= ${periodTo}::date
       and (pa.valid_to is null or pa.valid_to >= ${periodFrom}::date)
     order by pa.valid_from
  `)) as unknown as Array<{ valid_from: string | Date; valid_to: string | Date | null; company_code: string | null; controlling_area: string; cost_center: string }>;
  const day = (v: string | Date | null) => (v === null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  if (positions.length === 0) {
    reason('NO_POSITION', `Employee ${personnelNumber} holds no position covering the period ${periodFrom} to ${periodTo}.`, `Assign a position at /people/assignments.`);
    return result;
  }
  const positionOn = (d: string) => positions.find((p) => day(p.valid_from)! <= d && (p.valid_to === null || day(p.valid_to)! >= d));
  const workedDays = days.filter((d) => positionOn(d));

  // The company of each position: its own, or its cost centre's (dated master, valid that day).
  const companyOf = new Map<string, { companyCode: string; chart: string; currency: string } | null>();
  const costCentreStanding = new Map<string, boolean>();
  for (const p of positions) {
    const from = day(p.valid_from)! > periodFrom ? day(p.valid_from)! : periodFrom;
    const centre = (await tx.execute(sql`
      select company_code from cost_center
       where client = ${client} and controlling_area = ${p.controlling_area} and cost_center = ${p.cost_center}
         and valid_from <= ${from}::date and valid_to >= ${from}::date
       order by valid_from desc limit 1
    `)) as unknown as Array<{ company_code: string | null }>;
    costCentreStanding.set(`${p.controlling_area}/${p.cost_center}`, centre.length > 0);
    const companyCode = p.company_code ?? centre[0]?.company_code ?? null;
    let company: { companyCode: string; chart: string; currency: string } | null = null;
    if (companyCode) {
      const cc = (await tx.execute(sql`
        select chart_of_accounts, currency from company_code where client = ${client} and company_code = ${companyCode}
      `)) as unknown as Array<{ chart_of_accounts: string | null; currency: string }>;
      if (cc[0]?.chart_of_accounts) company = { companyCode, chart: cc[0].chart_of_accounts, currency: String(cc[0].currency).trim() };
    }
    companyOf.set(day(p.valid_from)!, company);
    if (!company) {
      reason('NO_COMPANY', `Employee ${personnelNumber}'s position from ${day(p.valid_from)} names no company code, and its cost centre ${p.cost_center} resolves to none with a chart of accounts.`, 'Set the company code on the position assignment, or on the cost centre.');
    }
  }

  // Salary assignments in the period, day by day: exactly one on every worked day.
  const assignments = (await assignmentViews(tx, client, personnelNumber))
    .filter((a) => spansOverlap(a.validFrom, a.validTo, periodFrom, periodTo));
  const firstUncovered = workedDays.find((d) => !assignments.some((a) => a.validFrom <= d && (a.validTo === null || a.validTo >= d)));
  if (firstUncovered) {
    reason('NO_STRUCTURE', `No pay structure stands for employee ${personnelNumber} on ${firstUncovered}.`, `Assign a pay structure at ${EMPLOYEE_ROUTE}?employee=${personnelNumber}.`);
  }
  const firstDouble = days.find((d) => assignments.filter((a) => a.validFrom <= d && (a.validTo === null || a.validTo >= d)).length > 1);
  if (firstDouble) {
    reason('OVERLAPPING_STRUCTURES', `Two pay structures cover employee ${personnelNumber} on ${firstDouble}.`, `End one of them at ${EMPLOYEE_ROUTE}?employee=${personnelNumber}.`);
  }

  // Each structure used: valid for the days it is used, and naming components that are mapped.
  const structureCodes = [...new Set(assignments.map((a) => a.structureCode))];
  for (const code of structureCodes) {
    const structure = await loadStructure(tx, client, code);
    if (!structure) continue;
    const usedFrom = assignments.filter((a) => a.structureCode === code).map((a) => (a.validFrom > periodFrom ? a.validFrom : periodFrom)).sort()[0]!;
    const usedTo = assignments.filter((a) => a.structureCode === code)
      .map((a) => (a.validTo === null || a.validTo > periodTo ? periodTo : a.validTo)).sort().at(-1)!;
    if (!structure.isValid || structure.validFrom > usedFrom || (structure.validTo !== null && structure.validTo < usedTo)) {
      reason('STRUCTURE_NOT_VALID', `Structure ${code} is not valid for the whole period (${structure.isValid ? `valid ${structure.validFrom} to ${structure.validTo ?? 'open'}` : 'retired'}; used ${usedFrom} to ${usedTo}).`, `Extend or restore it at ${SALARY_STRUCTURE_ROUTE}.`);
    }
    const components = (await tx.execute(sql`
      select c.component_code from salary_structure_component c
       where c.client = ${client} and c.structure_code = ${code}
       order by c.component_code
    `)) as unknown as Array<{ component_code: string }>;
    if (components.length === 0) {
      reason('STRUCTURE_EMPTY', `Structure ${code} names no components.`, `Add components at ${SALARY_STRUCTURE_ROUTE}.`);
      continue;
    }
    const charts = [...new Set([...companyOf.values()].filter((c): c is NonNullable<typeof c> => c !== null).map((c) => c.chart))];
    for (const { component_code: component } of components) {
      for (const chart of charts) {
        const mapping = (await tx.execute(sql`
          select cost_receiver_category from pay_component_config
           where client = ${client} and component_code = ${component} and chart_of_accounts = ${chart}
        `)) as unknown as Array<{ cost_receiver_category: string }>;
        if (mapping.length === 0) {
          reason('COMPONENT_UNMAPPED', `Component ${component} is not mapped to an account in chart ${chart}.`, `Map it at ${PAY_COMPONENT_ROUTE}.`);
          continue;
        }
        if (mapping[0]!.cost_receiver_category === 'ASSIGNMENT') {
          const missing = positions.find((p) => !costCentreStanding.get(`${p.controlling_area}/${p.cost_center}`));
          if (missing) {
            reason('NO_COST_CENTRE', `Component ${component} charges to the employee's cost centre, and employee ${personnelNumber} has none (cost centre ${missing.cost_center} does not stand in controlling area ${missing.controlling_area}).`, 'Give the position assignment a cost centre that is valid in the period.');
          }
        }
      }
    }
  }

  // Recorded, not refused in phase 1: paid in a currency other than the books'.
  for (const a of assignments) {
    const company = [...companyOf.values()].find((c) => c !== null) ?? null;
    if (company && a.currency !== company.currency) {
      const note = { code: 'CURRENCY_DIFFERS' as const, message: `Employee ${personnelNumber} is paid in ${a.currency}, the company ${company.companyCode} keeps books in ${company.currency}.` };
      if (!result.notes.some((n) => n.message === note.message)) result.notes.push(note);
    }
  }

  result.ready = result.reasons.length === 0;
  return result;
}

/** `validateEmployeeForRun` in its own transaction, for a screen. */
export async function employeeRunReadiness(
  clientInput: string,
  personnelInput: string,
  periodFrom: string,
  periodTo: string,
): Promise<EmployeeRunReadiness> {
  const client = parse(clientField, clientInput);
  const personnelNumber = parse(personnelField, personnelInput);
  return withTenant(client, (tx) => validateEmployeeForRun(tx, client, personnelNumber, periodFrom, periodTo));
}

/** The currency of the tenant's first company code — the default a new structure is offered. */
export async function defaultPayrollCurrency(clientInput: string): Promise<string | null> {
  const client = parse(clientField, clientInput);
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select currency from company_code where client = ${client} order by company_code limit 1
    `)) as unknown as Array<{ currency: string }>;
    return rows[0] ? String(rows[0].currency).trim() : null;
  });
}
