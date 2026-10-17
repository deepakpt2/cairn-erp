import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { companyCode, employeeToleranceGroup } from './schema';

/**
 * OBA4 Define Employee Tolerance Groups — the read side (SCR-039 stage 1).
 *
 * This activity differs from the define-screens beside it in one structural
 * way: nothing is delivered. There is no package set of tolerance groups —
 * a tenant that has never opened this screen has no ceilings at all, and
 * until journal posting learns to read these rows (later work, stated
 * openly on the screen), the configuration decides nothing at runtime.
 *
 * The contract the owner settled (R-88): the key is (company code, group),
 * and both parts may be blank as deliberate stored values — a blank company
 * code is the tenant-wide scope standing under every company code of the
 * tenant, and a blank group key is the default group of its scope, the
 * baseline for users with no explicit assignment. Where a company code is
 * named it must stand in the tenant. The limits are exact decimals; zero
 * in any of them is a stored meaning — that check imposes no ceiling —
 * and the line-item ceiling is judged against the document ceiling only
 * when both stand non-zero. Removal is deferred whole: groups become
 * deletable when user assignment exists to be checked, so this stage (and
 * the write stage behind it) offers create and change only.
 */
export const ACTIVITY = 'CFG.FIN.TOLERANCE.DEFINE';

export interface EmployeeToleranceGroupRow {
  /** '' = the tenant-wide scope standing under every company code. */
  companyCode: string;
  /** '' = the default group of its scope. */
  groupKey: string;
  maxDocumentAmount: string;
  maxLineAmount: string;
  maxCashDiscountPercent: string;
  paymentDiffRevenueAmount: string;
  paymentDiffExpenseAmount: string;
  paymentDiffRevenuePercent: string;
  paymentDiffExpensePercent: string;
}

export interface CompanyChoice {
  companyCode: string;
  name: string;
}

/** Every tolerance group the tenant holds, scope by scope, in key order. */
export async function listEmployeeToleranceGroups(client: string): Promise<EmployeeToleranceGroupRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(employeeToleranceGroup)
      .where(eq(employeeToleranceGroup.client, client))
      .orderBy(asc(employeeToleranceGroup.companyCode), asc(employeeToleranceGroup.groupKey));

    return rows.map((row) => ({
      companyCode: row.companyCode,
      groupKey: row.groupKey,
      maxDocumentAmount: row.maxDocumentAmount,
      maxLineAmount: row.maxLineAmount,
      maxCashDiscountPercent: row.maxCashDiscountPercent,
      paymentDiffRevenueAmount: row.paymentDiffRevenueAmount,
      paymentDiffExpenseAmount: row.paymentDiffExpenseAmount,
      paymentDiffRevenuePercent: row.paymentDiffRevenuePercent,
      paymentDiffExpensePercent: row.paymentDiffExpensePercent,
    }));
  });
}

/**
 * The company codes the tenant has defined — the value help for the scope a
 * group belongs to, and (behind the blank scope) the list a named code is
 * judged against on write.
 */
export async function listToleranceCompanies(client: string): Promise<CompanyChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ companyCode: companyCode.companyCode, name: companyCode.name })
      .from(companyCode)
      .where(eq(companyCode.client, client))
      .orderBy(asc(companyCode.companyCode));
    return rows;
  });
}

/**
 * OBA4 — maintain the employee tolerance groups (SCR-039 stage 3).
 *
 * One write: create-or-change. There is deliberately no delete and no
 * lifecycle flag (R-88): a group becomes removable when user assignment
 * exists to be checked, and until then a mistaken group is corrected by
 * defining the right one — the screen says this where Delete would sit.
 *
 * The composite key — company code and group — is immutable, and both
 * parts may be blank as stored values: blank company code is the
 * tenant-wide scope, blank group key its scope's default group. A named
 * company code must stand in the tenant. The limits validate at their
 * package widths and ranges; zero in any limit imposes no ceiling, so
 * the line-item ceiling is judged against the document ceiling only
 * when both stand non-zero (the same rule the database check states).
 *
 * A **reason is mandatory on every write**, one change document per
 * write with every limit security-relevant: together they decide what a
 * user may post, and a payment difference that books itself is money
 * moved by a threshold.
 */
export const OBJECT_CLASS = 'employee_tolerance_group';
const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE'] as const;

/** Money and percentages travel as exact decimal strings, never floats. */
function decimal(maxIntegerDigits: number, scale: number, label: string) {
  return z
    .string()
    .trim()
    .regex(
      new RegExp(`^\\d{1,${maxIntegerDigits}}(\\.\\d{1,${scale}})?$`),
      `${label} is a number with up to ${maxIntegerDigits} digits before and ${scale} after the decimal point.`,
    )
    .transform((value) => canonicalDecimal(value, scale));
}

/** The canonical string a numeric column reads back: fixed scale, no stray zeros before it. */
function canonicalDecimal(value: string, scale: number): string {
  const [units, fraction = ''] = value.split('.');
  const scaled = BigInt(units) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
  const digits = scaled.toString().padStart(scale + 1, '0');
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Scaled-integer comparison without a float anywhere near money. */
function scaledValue(value: string, scale: number): bigint {
  const [units, fraction = ''] = canonicalDecimal(value, scale).split('.');
  return BigInt(units) * 10n ** BigInt(scale) + BigInt(fraction || '0');
}

const optionalDecimal = (maxIntegerDigits: number, scale: number, label: string) =>
  z
    .string()
    .trim()
    .transform((value) => (value === '' ? canonicalDecimal('0', scale) : value))
    .pipe(decimal(maxIntegerDigits, scale, label));

export const toleranceGroupValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  companyCode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^([A-Z0-9]{4})?$/, 'The Company Code is four letters or digits, or blank for the tenant-wide scope.')),
  groupKey: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^([A-Z0-9]{1,4})?$/, 'The Tolerance Group is up to four letters or digits, or blank for the default group.')),
  maxDocumentAmount: decimal(13, 2, 'The Maximum Amount per Document'),
  maxLineAmount: decimal(11, 2, 'The Maximum Amount per Line Item'),
  maxCashDiscountPercent: decimal(3, 3, 'The Maximum Cash Discount Percentage')
    .refine((value) => scaledValue(value, 3) <= 100_000n, 'The Maximum Cash Discount Percentage is between 0.000 and 100.000.'),
  paymentDiffRevenueAmount: optionalDecimal(5, 2, 'The Payment Difference Revenue amount'),
  paymentDiffExpenseAmount: optionalDecimal(5, 2, 'The Payment Difference Expense amount'),
  paymentDiffRevenuePercent: optionalDecimal(2, 1, 'The Payment Difference Revenue percentage'),
  paymentDiffExpensePercent: optionalDecimal(2, 1, 'The Payment Difference Expense percentage'),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
};

export const toleranceGroupInputSchema = toleranceGroupValuesSchema.extend(actorFields).strict();
export type ToleranceGroupInput = z.input<typeof toleranceGroupInputSchema>;

export class ToleranceGroupError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the tolerance group and try again.',
  ) {
    super(message);
    this.name = 'ToleranceGroupError';
  }
}

export interface ToleranceGroupSaveResult {
  changed: boolean;
  companyCode: string;
  groupKey: string;
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function assertPrerequisites(tx: Tx, client: string): Promise<void> {
  const rows = await tx
    .select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, client),
      inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(rows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length > 0) {
    throw new ToleranceGroupError(
      `Tolerance group prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define company codes in the configuration workbench first: a tolerance group belongs to a company code (or stands tenant-wide under all of them), and there is nothing to scope it to until they exist.',
    );
  }
}

const FIELD_LABELS = {
  maxDocumentAmount: 'Maximum amount per document',
  maxLineAmount: 'Maximum amount per line item',
  maxCashDiscountPercent: 'Maximum cash discount percentage',
  paymentDiffRevenueAmount: 'Payment difference revenue (amount)',
  paymentDiffExpenseAmount: 'Payment difference expense (amount)',
  paymentDiffRevenuePercent: 'Payment difference revenue (percentage)',
  paymentDiffExpensePercent: 'Payment difference expense (percentage)',
} as const;

const LIMIT_FIELDS = Object.keys(FIELD_LABELS) as Array<keyof typeof FIELD_LABELS>;

/** The key the change documents file under: blanks under their working names. */
function objectKeyFor(companyCodeValue: string, groupKeyValue: string): string {
  return `${companyCodeValue === '' ? 'ALL' : companyCodeValue}/${groupKeyValue === '' ? 'DEFAULT' : groupKeyValue}`;
}

/**
 * Create a tolerance group, or change the limits of one that stands. The
 * key is never a changeable field: the screen says which of create or
 * change it is doing, and renaming a group means defining the new one.
 * Idempotent on change: repeating the stored limits reports
 * `changed: false` and writes nothing but the activity completion.
 */
export async function saveEmployeeToleranceGroup(raw: ToleranceGroupInput): Promise<ToleranceGroupSaveResult> {
  const parsed = toleranceGroupInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ToleranceGroupError(
      parsed.error.issues[0]?.message ?? 'The tolerance group is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  // Judged before any table is read, the way the database check states it:
  // only when both stand non-zero does the document ceiling bind the line.
  if (
    scaledValue(values.maxLineAmount, 2) > 0n
    && scaledValue(values.maxDocumentAmount, 2) > 0n
    && scaledValue(values.maxLineAmount, 2) > scaledValue(values.maxDocumentAmount, 2)
  ) {
    throw new ToleranceGroupError(
      `Maximum Amount per Line Item ${values.maxLineAmount} exceeds Maximum Amount per Document ${values.maxDocumentAmount}.`,
      'A line item is part of a document, so its ceiling cannot stand above the document ceiling while both impose one; lower the line amount or raise the document amount.',
    );
  }

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    if (values.companyCode !== '') {
      const [company] = await tx
        .select({ companyCode: companyCode.companyCode })
        .from(companyCode)
        .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, values.companyCode)))
        .limit(1);
      if (!company) {
        throw new ToleranceGroupError(
          `Company Code ${values.companyCode} is not defined in this tenant.`,
          'Choose a company code that stands, or leave the Company Code blank for the tenant-wide scope.',
        );
      }
    }

    const [existing] = await tx
      .select()
      .from(employeeToleranceGroup)
      .where(and(
        eq(employeeToleranceGroup.client, client),
        eq(employeeToleranceGroup.companyCode, values.companyCode),
        eq(employeeToleranceGroup.groupKey, values.groupKey),
      ))
      .for('update');

    const scope = values.companyCode === '' ? 'the tenant-wide scope' : `Company Code ${values.companyCode}`;
    const group = values.groupKey === '' ? 'The default group' : `Tolerance Group ${values.groupKey}`;
    if (values.mode === 'CREATE' && existing) {
      throw new ToleranceGroupError(
        `${group} is already defined for ${scope}.`,
        'Change the tolerance group that exists, or choose another group or scope.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new ToleranceGroupError(
        `${group} is not defined for ${scope}.`,
        'Create the tolerance group first; a key cannot be changed into existence, because the key is the group and its scope.',
      );
    }

    const stored = {
      maxDocumentAmount: values.maxDocumentAmount,
      maxLineAmount: values.maxLineAmount,
      maxCashDiscountPercent: values.maxCashDiscountPercent,
      paymentDiffRevenueAmount: values.paymentDiffRevenueAmount,
      paymentDiffExpenseAmount: values.paymentDiffExpenseAmount,
      paymentDiffRevenuePercent: values.paymentDiffRevenuePercent,
      paymentDiffExpensePercent: values.paymentDiffExpensePercent,
    };

    const result: ToleranceGroupSaveResult = {
      changed: true,
      companyCode: values.companyCode,
      groupKey: values.groupKey,
    };
    const objectKey = objectKeyFor(values.companyCode, values.groupKey);

    if (values.mode === 'CREATE') {
      await tx.insert(employeeToleranceGroup).values({
        client,
        companyCode: values.companyCode,
        groupKey: values.groupKey,
        ...stored,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey,
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: { companyCode: values.companyCode, groupKey: values.groupKey, ...stored },
        fieldLabels: { companyCode: 'Company code', groupKey: 'Tolerance group', ...FIELD_LABELS },
        securityRelevantFields: [...LIMIT_FIELDS],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return result;
    }

    if (LIMIT_FIELDS.every((field) => existing[field] === stored[field])) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(employeeToleranceGroup)
      .set({ ...stored, changedBy, changedAt: new Date() })
      .where(and(
        eq(employeeToleranceGroup.client, client),
        eq(employeeToleranceGroup.companyCode, values.companyCode),
        eq(employeeToleranceGroup.groupKey, values.groupKey),
      ));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: Object.fromEntries(LIMIT_FIELDS.map((field) => [field, existing[field]])),
      after: { ...stored },
      fieldLabels: FIELD_LABELS,
      securityRelevantFields: [...LIMIT_FIELDS],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}
