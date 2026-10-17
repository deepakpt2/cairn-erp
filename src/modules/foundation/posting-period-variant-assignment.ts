import { z } from 'zod';
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { journalEntry } from '../finance/schema';
import { companyCode, postingPeriodVariant } from './schema';

/**
 * OBBP Assign Company Code to Posting Period Variant — the read side (SCR-033 stage 1).
 *
 * This module exists before the writes for the same reason the OBBO reader does: the
 * screen has to render what the tenant holds before it is worth writing to, and the
 * three questions it answers — which variant each Company Code holds, what the variants
 * are called, and whether a Company Code has posted — must have one answer that the
 * write side then enforces rather than restates. The posted count is read here because
 * the contract's clearing rule turns on it: a variant may be cleared only while the
 * Company Code has no journal entries, so the dialog has to say that before the click.
 */
export const ACTIVITY = 'CFG.FIN.PPV.ASSIGN';

export interface PostingPeriodVariantAssignmentRow {
  companyCode: string;
  name: string;
  isActive: boolean;
  /** The variant the Company Code posts against, or null while unassigned. */
  postingPeriodVariant: string | null;
  /** The assigned variant's description, or null while unassigned (or unresolvable). */
  variantName: string | null;
  /** Journal entries posted under this Company Code; the clearing rule turns on it. */
  postedDocuments: number;
}

export async function listPostingPeriodVariantAssignments(
  client: string,
): Promise<PostingPeriodVariantAssignmentRow[]> {
  return withTenant(client, async (tx) => {
    const [companies, variants, postings] = await Promise.all([
      tx
        .select({
          companyCode: companyCode.companyCode,
          name: companyCode.name,
          isActive: companyCode.isActive,
          postingPeriodVariant: companyCode.postingPeriodVariant,
        })
        .from(companyCode)
        .where(eq(companyCode.client, client))
        .orderBy(asc(companyCode.companyCode)),
      tx
        .select({ variant: postingPeriodVariant.variant, name: postingPeriodVariant.name })
        .from(postingPeriodVariant)
        .where(eq(postingPeriodVariant.client, client))
        .orderBy(asc(postingPeriodVariant.variant)),
      tx
        .select({ companyCode: journalEntry.companyCode, documents: count() })
        .from(journalEntry)
        .where(eq(journalEntry.client, client))
        .groupBy(journalEntry.companyCode),
    ]);

    const variantNames = new Map(variants.map((row) => [row.variant, row.name]));
    const posted = new Map(postings.map((row) => [row.companyCode, Number(row.documents)]));

    return companies.map((row) => ({
      companyCode: row.companyCode,
      name: row.name,
      isActive: row.isActive,
      postingPeriodVariant: row.postingPeriodVariant,
      variantName: row.postingPeriodVariant
        ? (variantNames.get(row.postingPeriodVariant) ?? null)
        : null,
      postedDocuments: posted.get(row.companyCode) ?? 0,
    }));
  });
}

const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.FIN.PPV.DEFINE'] as const;

/**
 * OBBP — assign the posting period variant a Company Code posts against (SCR-033 stage 3).
 *
 * The variant lived on the Company Code from the first schema, written once by the standard
 * package's builder; this is the write that lets somebody choose it. Four rules shape it, and
 * the owner settled each.
 *
 * The assignment is **nullable and fully reassignable**: a Company Code may hold any defined
 * variant or none. Repeating the variant already held — or clearing an assignment that does
 * not exist — changes nothing and writes nothing but the activity completion.
 *
 * A variant may be **cleared only while the Company Code has no journal entries**. That is the
 * decidable form of the package's "no clearing under open transactional locks or pending
 * postings": a later journal entry was posted against the intervals the variant holds, so the
 * variant may move to another but may not disappear from under it. The count is the same one
 * the list reads — every journal entry under the Company Code, the measure the dialog states.
 *
 * A **reason is mandatory on every write**. And one change document is filed on the Company
 * Code with the variant security-relevant, because the variant decides which periods are
 * open for everything the Company Code posts from then on.
 */
export const postingPeriodVariantAssignmentValuesSchema = z.object({
  companyCode: z.string().trim().min(1, 'A Company Code is required.').max(10, 'A Company Code is at most ten characters.'),
  /** An empty value clears the assignment, subject to the clearing rule. */
  postingPeriodVariant: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value.toUpperCase()))
    .pipe(
      z
        .string()
        .regex(/^[A-Z0-9]{4}$/, 'The Posting Period Variant is exactly four letters or digits.')
        .nullable(),
    ),
  /**
   * The variant the screen opened against, or an empty string when the Company Code had none.
   * Required rather than defaulted: a caller that does not say what it saw cannot be told that
   * somebody else moved first.
   */
  expectedVariant: z
    .string()
    .trim()
    .max(4, 'The Posting Period Variant is exactly four letters or digits.')
    .transform((value) => (value === '' ? null : value.toUpperCase())),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

export const postingPeriodVariantAssignmentInputSchema = postingPeriodVariantAssignmentValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type PostingPeriodVariantAssignmentInput = z.input<typeof postingPeriodVariantAssignmentInputSchema>;

export class PostingPeriodVariantAssignmentError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Company Code and the Posting Period Variant, then try again.',
  ) {
    super(message);
    this.name = 'PostingPeriodVariantAssignmentError';
  }
}

export interface PostingPeriodVariantAssignmentResult {
  /** False when the Company Code already held the requested state and nothing was written. */
  assigned: boolean;
  companyCode: string;
  /** The variant now held, or null when the assignment was cleared (or was already empty). */
  postingPeriodVariant: string | null;
  previousVariant: string | null;
  /** Journal entries under the Company Code at the moment of the change. */
  postedDocuments: number;
}

/**
 * Assign a posting period variant to a Company Code, or clear the assignment.
 *
 * Idempotent: requesting the state the Company Code already holds reports `assigned: false`
 * and writes nothing but the activity completion.
 */
export async function assignPostingPeriodVariant(
  raw: PostingPeriodVariantAssignmentInput,
): Promise<PostingPeriodVariantAssignmentResult> {
  const parsed = postingPeriodVariantAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PostingPeriodVariantAssignmentError(
      parsed.error.issues[0]?.message ?? 'The Posting Period Variant assignment is not valid.',
      'Correct the indicated value and submit the assignment again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    const [current] = await tx
      .select()
      .from(companyCode)
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, values.companyCode)))
      .for('update');
    if (!current) {
      throw new PostingPeriodVariantAssignmentError(
        `Company Code ${values.companyCode} does not exist in this tenant.`,
        'Define the Company Code first (CFG.ORG.COMPANYCODE.DEFINE).',
      );
    }
    if (!current.isActive) {
      throw new PostingPeriodVariantAssignmentError(
        `Company Code ${values.companyCode} is deactivated.`,
        'Reactivate the Company Code before changing the variant it posts against.',
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
      throw new PostingPeriodVariantAssignmentError(
        `Posting Period Variant assignment prerequisites are incomplete: ${missing.join(', ')}.`,
        'Define the Company Code and the Posting Period Variant in the configuration workbench first.',
      );
    }

    if (values.postingPeriodVariant !== null) {
      const [variant] = await tx
        .select({ variant: postingPeriodVariant.variant })
        .from(postingPeriodVariant)
        .where(and(
          eq(postingPeriodVariant.client, client),
          eq(postingPeriodVariant.variant, values.postingPeriodVariant),
        ))
        .limit(1)
        .for('share');
      if (!variant) {
        throw new PostingPeriodVariantAssignmentError(
          `Posting Period Variant ${values.postingPeriodVariant} is not defined in this tenant.`,
          'Define the Posting Period Variant first (CFG.FIN.PPV.DEFINE).',
        );
      }
    }

    if (current.postingPeriodVariant !== values.expectedVariant) {
      throw new PostingPeriodVariantAssignmentError(
        `Company Code ${values.companyCode} changed after it was opened.`,
        `It now posts against ${current.postingPeriodVariant ?? 'no Posting Period Variant'}; reload the assignment screen before changing it.`,
      );
    }

    // The same count the list states, read again under the row lock: the clearing rule turns
    // on it, and a figure read on an earlier screen is not a figure to enforce by.
    const [postings] = await tx
      .select({ documents: count() })
      .from(journalEntry)
      .where(and(
        eq(journalEntry.client, client),
        eq(journalEntry.companyCode, values.companyCode),
      ));
    const postedDocuments = postings?.documents ?? 0;

    if (current.postingPeriodVariant === values.postingPeriodVariant) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return {
        assigned: false,
        companyCode: values.companyCode,
        postingPeriodVariant: values.postingPeriodVariant,
        previousVariant: current.postingPeriodVariant,
        postedDocuments,
      };
    }

    if (values.postingPeriodVariant === null && postedDocuments > 0) {
      throw new PostingPeriodVariantAssignmentError(
        `Company Code ${values.companyCode} has ${postedDocuments} journal entries and cannot be left unassigned.`,
        'Assign another Posting Period Variant instead. A variant may be cleared only while the Company Code has no journal entries, because the entries already posted were posted against its open periods.',
      );
    }

    const [updated] = await tx
      .update(companyCode)
      .set({
        postingPeriodVariant: values.postingPeriodVariant,
        changedBy,
        changedAt: new Date(),
      })
      .where(and(
        eq(companyCode.client, client),
        eq(companyCode.companyCode, values.companyCode),
        // Guarded on the value the caller saw, so a concurrent assignment cannot be overwritten
        // by a request that was already stale when it arrived.
        values.expectedVariant === null
          ? isNull(companyCode.postingPeriodVariant)
          : eq(companyCode.postingPeriodVariant, values.expectedVariant),
      ))
      .returning({ postingPeriodVariant: companyCode.postingPeriodVariant });
    if (!updated) {
      throw new PostingPeriodVariantAssignmentError(
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
      before: { postingPeriodVariant: current.postingPeriodVariant },
      after: { postingPeriodVariant: values.postingPeriodVariant, postedDocuments },
      fieldLabels: {
        postingPeriodVariant: 'Posting period variant',
        postedDocuments: 'Journal entries at the change',
      },
      // The variant decides which periods are open for everything posted next, so it is
      // flagged for the auditor rather than buried among cosmetic fields (§16.3).
      securityRelevantFields: ['postingPeriodVariant'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);

    return {
      assigned: true,
      companyCode: values.companyCode,
      postingPeriodVariant: values.postingPeriodVariant,
      previousVariant: current.postingPeriodVariant,
      postedDocuments,
    };
  });
}
