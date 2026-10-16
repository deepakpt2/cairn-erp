/**
 * SCR-030 / OB37 — assign the fiscal year variant a Company Code posts in.
 *
 * The variant has been a column on the Company Code since the record was designed and was
 * written by the Company Code service, but nothing let anybody choose it: a new Company Code
 * was created without one and stayed unassigned. This is the write that OB37 exists for, and
 * it is a separate activity from OB29 because it changes a book rather than a calendar.
 *
 * Three rules the owner settled shape it.
 *
 * A Company Code linked to a Controlling Area shares that area's variant with the area's other
 * Company Codes, so a reassignment that would break the sharing is **refused** naming the area
 * and the siblings that would disagree. That is not a new rule: it reuses the OX19 lock order
 * and the compatibility assertion the chart-of-accounts assignment already uses, because a
 * second implementation of the same invariant is how two screens come to disagree about it.
 *
 * A Company Code that has already posted **may** still change calendar, but only with a reason,
 * and the answer names what the reason has to cover. Documents already posted keep the period
 * they were posted in — nothing re-dates history — so from the change onward one variant means
 * a different set of dates than it did before, and the change document records how many
 * documents and which fiscal years were on the other side of that line.
 *
 * The variant itself must exist and be active. There is no unassign: the column stays nullable
 * for a Company Code that has never been given one, but clearing an existing assignment would
 * create, on purpose, the state this screen shows as "Not assigned" and that cannot post.
 */
import { z } from 'zod';
import { and, count, eq, inArray, isNull, max, min } from 'drizzle-orm';
import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { companyCode, fiscalYearVariant } from './schema';
import { journalEntry } from '../finance/schema';
import {
  assertCompanyCodeFinancialSettingsCompatible,
  ControllingAreaCompanyCompatibilityError,
  lockCompanyCodeOxxAssignments,
} from './controlling-area-company-compatibility';

const ACTIVITY = 'CFG.FIN.FYV.ASSIGN';
const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.FIN.FYV.DEFINE'] as const;

/**
 * What counts as posted, for the exposure this change creates. The same two statuses the
 * Controlling Area guard uses: a reversed document still occupied a period, and a draft never
 * did. One definition, read at two scopes — the screen counts every Company Code for its grid,
 * this counts the one being changed and records it in the audit trail.
 */
const POSTED_STATUSES = ['POSTED', 'REVERSED'] as const;

export const fiscalYearVariantAssignmentValuesSchema = z.object({
  companyCode: z.string().trim().min(1, 'A Company Code is required.').max(10, 'A Company Code is at most ten characters.'),
  fiscalYearVariant: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{2}$/, 'The Fiscal Year Variant is exactly two letters or digits.')),
  /**
   * The variant the screen opened against, or an empty string when the Company Code had none.
   * Required rather than defaulted: a caller that does not say what it saw cannot be told that
   * somebody else moved first.
   */
  expectedVariant: z
    .string()
    .trim()
    .max(2, 'The Fiscal Year Variant is exactly two letters or digits.')
    .transform((value) => (value === '' ? null : value.toUpperCase())),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

export const fiscalYearVariantAssignmentInputSchema = fiscalYearVariantAssignmentValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type FiscalYearVariantAssignmentInput = z.input<typeof fiscalYearVariantAssignmentInputSchema>;

export class FiscalYearVariantAssignmentError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Company Code and the Fiscal Year Variant, then try again.',
  ) {
    super(message);
    this.name = 'FiscalYearVariantAssignmentError';
  }
}

export interface FiscalYearVariantAssignmentResult {
  /** False when the Company Code already posted in this variant and nothing was written. */
  assigned: boolean;
  companyCode: string;
  fiscalYearVariant: string;
  previousVariant: string | null;
  /** Posted and reversed documents at the moment of the change, and the years they span. */
  postedDocuments: number;
  firstPostedYear: number | null;
  lastPostedYear: number | null;
  /** Controlling Areas whose shared variant had to agree with this one. */
  controllingAreas: string[];
}

/**
 * Assign a fiscal year variant to a Company Code.
 *
 * Idempotent: assigning the variant the Company Code already holds reports `assigned: false`
 * and writes nothing but the activity completion, the way the chart-of-accounts assignment
 * does. Every other path writes one change document against the Company Code, with the variant
 * flagged security-relevant, because it decides which period every later document lands in.
 */
export async function assignFiscalYearVariant(
  raw: FiscalYearVariantAssignmentInput,
): Promise<FiscalYearVariantAssignmentResult> {
  const parsed = fiscalYearVariantAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FiscalYearVariantAssignmentError(
      parsed.error.issues[0]?.message ?? 'The Fiscal Year Variant assignment is not valid.',
      'Correct the indicated value and submit the assignment again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    // The OX19 lock order, before reading the row: Controlling Area links first, then the
    // Company Code. Taking them the other way round is how two assignments deadlock.
    const linkedAreas = await lockCompanyCodeOxxAssignments(tx, client, values.companyCode);

    const [current] = await tx
      .select()
      .from(companyCode)
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, values.companyCode)))
      .for('update');
    if (!current) {
      throw new FiscalYearVariantAssignmentError(
        `Company Code ${values.companyCode} does not exist in this tenant.`,
        'Define the Company Code first (CFG.ORG.COMPANYCODE.DEFINE).',
      );
    }
    if (!current.isActive) {
      throw new FiscalYearVariantAssignmentError(
        `Company Code ${values.companyCode} is deactivated.`,
        'Reactivate the Company Code before changing the calendar it posts in.',
      );
    }

    const completedPrerequisites = await tx
      .select({ activityCode: configActivityStatus.activityCode })
      .from(configActivityStatus)
      .where(and(
        eq(configActivityStatus.client, client),
        inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
        eq(configActivityStatus.status, 'COMPLETED'),
      ));
    const completed = new Set(completedPrerequisites.map((row) => row.activityCode));
    const missing = PREREQUISITES.filter((code) => !completed.has(code));
    if (missing.length > 0) {
      throw new FiscalYearVariantAssignmentError(
        `Fiscal Year Variant assignment prerequisites are incomplete: ${missing.join(', ')}.`,
        'Define the Company Code and the Fiscal Year Variant in the configuration workbench first.',
      );
    }

    const [variant] = await tx
      .select({
        variant: fiscalYearVariant.variant,
        name: fiscalYearVariant.name,
        isActive: fiscalYearVariant.isActive,
      })
      .from(fiscalYearVariant)
      .where(and(
        eq(fiscalYearVariant.client, client),
        eq(fiscalYearVariant.variant, values.fiscalYearVariant),
      ))
      .limit(1)
      .for('share');
    if (!variant) {
      throw new FiscalYearVariantAssignmentError(
        `Fiscal Year Variant ${values.fiscalYearVariant} is not defined in this tenant.`,
        'Define the Fiscal Year Variant first (CFG.FIN.FYV.DEFINE).',
      );
    }
    if (!variant.isActive) {
      throw new FiscalYearVariantAssignmentError(
        `Fiscal Year Variant ${values.fiscalYearVariant} is deactivated.`,
        'Reactivate the variant, or choose one that is active. A variant in use cannot be retired, so an assignment never points at a deactivated one for long.',
      );
    }

    if (current.fiscalYearVariant !== values.expectedVariant) {
      throw new FiscalYearVariantAssignmentError(
        `Company Code ${values.companyCode} changed after it was opened.`,
        `It now posts in ${current.fiscalYearVariant ?? 'no Fiscal Year Variant'}; reload the assignment screen before changing it.`,
      );
    }

    const [postings] = await tx
      .select({
        documents: count(),
        firstYear: min(journalEntry.fiscalYear),
        lastYear: max(journalEntry.fiscalYear),
      })
      .from(journalEntry)
      .where(and(
        eq(journalEntry.client, client),
        eq(journalEntry.companyCode, values.companyCode),
        inArray(journalEntry.status, [...POSTED_STATUSES]),
      ));
    const postedDocuments = postings?.documents ?? 0;
    const firstPostedYear = postings?.firstYear ?? null;
    const lastPostedYear = postings?.lastYear ?? null;

    if (current.fiscalYearVariant === values.fiscalYearVariant) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return {
        assigned: false,
        companyCode: values.companyCode,
        fiscalYearVariant: values.fiscalYearVariant,
        previousVariant: current.fiscalYearVariant,
        postedDocuments,
        firstPostedYear,
        lastPostedYear,
        controllingAreas: linkedAreas,
      };
    }

    // The Controlling Area's shared variant, its scope and its currency all have to survive the
    // change. Reused rather than restated, and its own error is translated so this screen has
    // one error type to catch.
    try {
      await assertCompanyCodeFinancialSettingsCompatible(tx, client, values.companyCode, {
        chartOfAccounts: current.chartOfAccounts,
        fiscalYearVariant: values.fiscalYearVariant,
        currency: current.currency,
      }, linkedAreas);
    } catch (error) {
      if (error instanceof ControllingAreaCompanyCompatibilityError) {
        throw new FiscalYearVariantAssignmentError(error.message, error.remedy);
      }
      throw error;
    }

    const [updated] = await tx
      .update(companyCode)
      .set({
        fiscalYearVariant: values.fiscalYearVariant,
        changedBy,
        changedAt: new Date(),
      })
      .where(and(
        eq(companyCode.client, client),
        eq(companyCode.companyCode, values.companyCode),
        // Guarded on the value the caller saw, so a concurrent assignment cannot be overwritten
        // by a request that was already stale when it arrived.
        values.expectedVariant === null
          ? isNull(companyCode.fiscalYearVariant)
          : eq(companyCode.fiscalYearVariant, values.expectedVariant),
      ))
      .returning({ fiscalYearVariant: companyCode.fiscalYearVariant });
    if (!updated) {
      throw new FiscalYearVariantAssignmentError(
        `Company Code ${values.companyCode} changed while the assignment was being saved.`,
        'Reload the assignment screen and review the current variant before trying again.',
      );
    }

    await recordChange(tx, {
      client,
      objectClass: 'company_code',
      objectKey: values.companyCode,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason: values.reason,
      before: {
        fiscalYearVariant: current.fiscalYearVariant,
        postedDocuments,
        postedYears: describeYears(firstPostedYear, lastPostedYear),
      },
      after: {
        fiscalYearVariant: values.fiscalYearVariant,
        postedDocuments,
        postedYears: describeYears(firstPostedYear, lastPostedYear),
      },
      fieldLabels: {
        fiscalYearVariant: 'Fiscal year variant',
        postedDocuments: 'Posted documents at the change',
        postedYears: 'Fiscal years already posted',
      },
      // Changing the calendar changes which period every later document lands in, so it is
      // flagged for the auditor rather than buried among cosmetic fields (§16.3).
      securityRelevantFields: ['fiscalYearVariant'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);

    return {
      assigned: true,
      companyCode: values.companyCode,
      fiscalYearVariant: values.fiscalYearVariant,
      previousVariant: current.fiscalYearVariant,
      postedDocuments,
      firstPostedYear,
      lastPostedYear,
      controllingAreas: linkedAreas,
    };
  });
}

/** "2026", "2025–2027", or "none" — the years on the other side of this change. */
function describeYears(first: number | null, last: number | null): string {
  if (first === null || last === null) return 'none';
  return first === last ? String(first) : `${first}–${last}`;
}

export { describeYears as describePostedYears };
