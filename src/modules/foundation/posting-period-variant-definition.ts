/**
 * SCR-031 / OBBO — the Posting Period Variant registry: the read side.
 *
 * A posting period variant is the interval set a Company Code posts against: one row per
 * account type, holding which periods of the fiscal year are open. The variant itself is
 * two things and nothing else — a four-character key and a description — because the
 * intervals belong to it and are maintained where they are used.
 *
 * This module exists before the writes for the same reason the fiscal year variant reader
 * does: the screen has to render the registry to be worth looking at, and the questions the
 * registry answers (how many intervals does this variant hold, who is posting against it,
 * what would deleting it take away) must have one answer that the write side then enforces
 * rather than restates.
 *
 * The interval labels come from the posting engine. A screen that named the account types
 * itself would be a second implementation of the same vocabulary, and the two would drift.
 */
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { ACCOUNT_TYPE_LABELS, type AccountType } from '../../platform/periods';
import { configActivityStatus } from '../../platform/tables/registry';
import { markActivityComplete } from '../../platform/tenancy';
import { companyCode, postingPeriodRule, postingPeriodVariant } from './schema';

export const ACTIVITY = 'CFG.FIN.PPV.DEFINE';
export const OBJECT_CLASS = 'posting_period_variant';
export const INTERVAL_OBJECT_CLASS = 'posting_period_rule';

/** How many referencing keys a refusal names before falling back to a count. */
const NAMED_LIMIT = 5;

/**
 * The order intervals are read in. It is the order the standard package writes them, so a
 * screen and a seeded tenant agree without either of them sorting by letter.
 */
const ACCOUNT_TYPE_ORDER: AccountType[] = ['S', 'K', 'D', 'A', 'M'];

const ACCOUNT_TYPES: string[] = ACCOUNT_TYPE_ORDER;

const clientSchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);

/**
 * What the registry declares must be done first. A posting period variant says which periods
 * of a fiscal year are open, so a tenant that has not put a fiscal year variant on a Company
 * Code yet has nothing for it to open.
 */
const PREREQUISITES = ['CFG.FIN.FYV.ASSIGN'] as const;

export type PostingPeriodIntervalRow = {
  accountType: AccountType;
  accountTypeLabel: string;
  /** What the interval allows, in the engine's own words. Rendered, never recomputed. */
  summary: string;
  periodFrom: number;
  periodTo: number;
  yearShiftPast: number;
  yearShiftFuture: number;
  allowSpecialPeriods: boolean;
};

export type PostingPeriodVariantRow = {
  variant: string;
  name: string;
  isActive: boolean;
  /** Every interval the variant holds, in account-type order. */
  intervals: PostingPeriodIntervalRow[];
  /** Company Codes posting against this variant, in key order. */
  usedByCompanyCodes: string[];
  /** The same list as one display string, named up to the limit and counted beyond it. */
  usedByLabel: string;
  createdBy: string;
  createdAt: Date;
  changedBy: string | null;
  changedAt: Date | null;
};

function isAccountType(value: string): value is AccountType {
  return ACCOUNT_TYPES.includes(value);
}

/** Where an account type sits in the reading order. Unknown types sort last, together. */
function rankAccountType(accountType: string): number {
  const rank = ACCOUNT_TYPE_ORDER.indexOf(accountType as AccountType);
  return rank === -1 ? ACCOUNT_TYPE_ORDER.length : rank;
}

export type PostingPeriodIntervalDefault = PostingPeriodIntervalRow;

/**
 * The interval rows a newly defined variant is created with: one per account type, open for
 * the whole fiscal year, special periods permitted where the standard package permits them,
 * and next-year postings allowed so an accrual can be raised before the year turns.
 *
 * One definition, read by the screen's note and by the writer. A variant created wide open
 * is a deliberate choice rather than an oversight: it is what the standard package ships,
 * and the alternative — a variant that cannot post until somebody finds the screen that
 * opens it — leaves a new Company Code stuck with a message it cannot act on.
 */
export const DEFAULT_INTERVALS: PostingPeriodIntervalDefault[] = (
  [
    { accountType: 'S', periodFrom: 1, periodTo: 12, yearShiftPast: 0, yearShiftFuture: 1, allowSpecialPeriods: true },
    { accountType: 'K', periodFrom: 1, periodTo: 12, yearShiftPast: 0, yearShiftFuture: 1, allowSpecialPeriods: false },
    { accountType: 'D', periodFrom: 1, periodTo: 12, yearShiftPast: 0, yearShiftFuture: 1, allowSpecialPeriods: false },
    { accountType: 'A', periodFrom: 1, periodTo: 12, yearShiftPast: 0, yearShiftFuture: 1, allowSpecialPeriods: true },
    { accountType: 'M', periodFrom: 1, periodTo: 12, yearShiftPast: 0, yearShiftFuture: 1, allowSpecialPeriods: false },
  ] satisfies Array<Omit<PostingPeriodIntervalRow, 'accountTypeLabel' | 'summary'>>
).map((interval) => ({
  ...interval,
  accountTypeLabel: ACCOUNT_TYPE_LABELS[interval.accountType],
  summary: describeInterval(interval),
}));

/**
 * What an interval allows, in words. A range whose end precedes its start admits no period
 * at all, and saying "closed" is truer than printing the numbers that produce it.
 */
export function describeInterval(interval: {
  periodFrom: number;
  periodTo: number;
  allowSpecialPeriods: boolean;
}): string {
  const range =
    interval.periodTo < interval.periodFrom
      ? 'no period open'
      : interval.periodFrom === interval.periodTo
        ? `period ${interval.periodFrom} only`
        : `periods ${interval.periodFrom} to ${interval.periodTo}`;
  return interval.allowSpecialPeriods ? `${range}, special periods permitted` : range;
}

/** The referencing Company Codes, named up to the limit and counted beyond it. */
export function describeUsedBy(codes: string[]): string {
  if (codes.length === 0) return '';
  if (codes.length <= NAMED_LIMIT) return codes.join(', ');
  return `${codes.slice(0, NAMED_LIMIT).join(', ')} and ${codes.length - NAMED_LIMIT} more`;
}

/**
 * Every posting period variant in the tenant, with its intervals and its Company Codes.
 *
 * Three reads in one transaction: the variants, the intervals, and the assignments. Reading
 * them together is what lets the screen say whether a variant can be deleted, instead of
 * offering a button that the write side then refuses.
 */
export async function listPostingPeriodVariants(client: string): Promise<PostingPeriodVariantRow[]> {
  const parsed = clientSchema.safeParse(client);
  if (!parsed.success) {
    throw new Error('The tenant key is not valid.');
  }
  const tenant = parsed.data;

  return withTenant(tenant, async (tx) => {
    const [variants, rules, companies] = await Promise.all([
      tx
        .select()
        .from(postingPeriodVariant)
        .where(eq(postingPeriodVariant.client, tenant))
        .orderBy(asc(postingPeriodVariant.variant)),
      tx
        .select()
        .from(postingPeriodRule)
        .where(eq(postingPeriodRule.client, tenant))
        .orderBy(asc(postingPeriodRule.variant), asc(postingPeriodRule.accountType)),
      tx
        .select({
          companyCode: companyCode.companyCode,
          postingPeriodVariant: companyCode.postingPeriodVariant,
        })
        .from(companyCode)
        .where(and(eq(companyCode.client, tenant), isNotNull(companyCode.postingPeriodVariant)))
        .orderBy(asc(companyCode.companyCode)),
    ]);

    return variants.map((variant) => {
      const intervals = rules
        .filter((rule) => rule.variant === variant.variant)
        .map((rule) => ({
          accountType: isAccountType(rule.accountType) ? rule.accountType : ('S' as AccountType),
          accountTypeLabel: isAccountType(rule.accountType)
            ? ACCOUNT_TYPE_LABELS[rule.accountType]
            : rule.accountType,
          summary: describeInterval(rule),
          periodFrom: rule.periodFrom,
          periodTo: rule.periodTo,
          yearShiftPast: rule.yearShiftPast,
          yearShiftFuture: rule.yearShiftFuture,
          allowSpecialPeriods: rule.allowSpecialPeriods,
        }))
        .sort(
          (left, right) =>
            ACCOUNT_TYPE_ORDER.indexOf(left.accountType) - ACCOUNT_TYPE_ORDER.indexOf(right.accountType),
        );

      const usedByCompanyCodes = companies
        .filter((company) => company.postingPeriodVariant === variant.variant)
        .map((company) => company.companyCode);

      return {
        variant: variant.variant,
        name: variant.name,
        isActive: variant.isActive,
        intervals,
        usedByCompanyCodes,
        usedByLabel: describeUsedBy(usedByCompanyCodes),
        createdBy: variant.createdBy,
        createdAt: variant.createdAt,
        changedBy: variant.changedBy,
        changedAt: variant.changedAt,
      };
    });
  });
}

/** The contract's key rule (owner package, 2026-10-17): exactly four letters or digits. */
const variantKeySchema = z
  .string()
  .trim()
  .min(1, 'A Posting Period Variant is required.')
  .min(4, 'The Posting Period Variant is exactly four characters.')
  .max(4, 'The Posting Period Variant is exactly four characters.')
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z0-9]{4}$/.test(value), {
    message: 'The Posting Period Variant is exactly four letters or digits.',
  });

const descriptionSchema = z
  .string()
  .trim()
  .min(1, 'A description is required.')
  .max(30, 'The description is at most thirty characters.');

export const postingPeriodVariantValuesSchema = z.object({
  /**
   * The screen says which of the two it is doing. New Entries and editing a row ask the same
   * two questions, and a service that inferred the answer from whether the key exists would
   * turn a mistyped key on a new entry into somebody else's description change.
   */
  mode: z.enum(['CREATE', 'CHANGE']),
  variant: variantKeySchema,
  name: descriptionSchema,
});

export const postingPeriodVariantInputSchema = postingPeriodVariantValuesSchema.extend({
  client: clientSchema,
  changedBy: z.string().trim().min(1, 'The user making the change is required.'),
});

export type PostingPeriodVariantInput = z.input<typeof postingPeriodVariantInputSchema>;

export const postingPeriodVariantDeleteInputSchema = z.object({
  client: clientSchema,
  changedBy: z.string().trim().min(1, 'The user making the change is required.'),
  variant: variantKeySchema,
});

export type PostingPeriodVariantDeleteInput = z.input<typeof postingPeriodVariantDeleteInputSchema>;

export class PostingPeriodVariantError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Posting Period Variant and try again.',
  ) {
    super(message);
    this.name = 'PostingPeriodVariantError';
  }
}

export interface PostingPeriodVariantSaveResult {
  variant: string;
  name: string;
  mode: 'CREATED' | 'CHANGED' | 'UNCHANGED';
  /** Interval rows written alongside a new variant. Zero on change: the intervals are not edited here. */
  intervalsCreated: number;
}

export interface PostingPeriodVariantDeleteResult {
  deleted: boolean;
  variant: string;
  name: string;
  intervalsRemoved: number;
  /** Always empty when `deleted` is true: anything posting against the variant refuses it. */
  companyCodes: string[];
}

/**
 * The interval set as one line, so a change document can carry what a definition created or
 * a deletion removed. Compact the way the fiscal year variant's period ends are: an auditor
 * reads the set, not a join.
 */
export function describeIntervalSet(
  intervals: Array<{
    accountType: string;
    periodFrom: number;
    periodTo: number;
    allowSpecialPeriods: boolean;
  }>,
): string {
  // Sorted, because the rows come back in whatever order the table held them. Two identical
  // deletions must file an identical sentence, or an auditor comparing them is reading noise.
  return [...intervals]
    .sort((left, right) => rankAccountType(left.accountType) - rankAccountType(right.accountType))
    .map(
      (interval) =>
        `${interval.accountType} ${interval.periodFrom}-${interval.periodTo}` +
        (interval.allowSpecialPeriods ? ' +special' : ''),
    )
    .join(', ');
}

async function assertPrerequisites(tx: Tx, client: string): Promise<void> {
  const rows = await tx
    .select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(
      and(
        eq(configActivityStatus.client, client),
        inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
        eq(configActivityStatus.status, 'COMPLETED'),
      ),
    );
  const completed = new Set(rows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length > 0) {
    throw new PostingPeriodVariantError(
      `Posting period variant prerequisites are incomplete: ${missing.join(', ')}.`,
      'Assign a fiscal year variant to a Company Code first (CFG.FIN.FYV.ASSIGN). A posting ' +
        'period variant says which periods of a fiscal year are open, so there is nothing for ' +
        'it to open until a Company Code has one.',
    );
  }
}

/**
 * Define a posting period variant, or change the description of one that exists.
 *
 * One function serves both because they are the same two questions, and a registry that
 * validated one and not the other is how a screen ends up accepting what the database
 * refuses. The caller says which of the two it means, because a mistyped key on a new entry
 * must be refused rather than read as a change to the variant that happens to hold it. The
 * key is never changed: a variant is the identity its Company Codes point at, so a different
 * key is a different variant.
 *
 * A new variant is created with its interval set, because a variant with no intervals cannot
 * post and nothing else in the product creates them. Saving the description a variant already
 * has reports `UNCHANGED` and writes nothing — not even a version — because an empty change
 * document is a document that says something happened when it did not.
 */
export async function savePostingPeriodVariant(
  raw: PostingPeriodVariantInput,
): Promise<PostingPeriodVariantSaveResult> {
  const parsed = postingPeriodVariantInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PostingPeriodVariantError(
      parsed.error.issues[0]?.message ?? 'The Posting Period Variant is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, mode, variant, name } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(postingPeriodVariant)
      .where(and(eq(postingPeriodVariant.client, client), eq(postingPeriodVariant.variant, variant)))
      .for('update');

    if (mode === 'CREATE' && existing) {
      throw new PostingPeriodVariantError(
        `Posting Period Variant ${variant} is already defined in this tenant.`,
        'Change the description of the variant that exists, or choose another key.',
      );
    }
    if (mode === 'CHANGE' && !existing) {
      throw new PostingPeriodVariantError(
        `Posting Period Variant ${variant} is not defined in this tenant.`,
        'Define it first (CFG.FIN.PPV.DEFINE), or reload the registry.',
      );
    }

    if (!existing) {
      try {
        await tx.insert(postingPeriodVariant).values({
          client,
          variant,
          name,
          createdBy: changedBy,
        });
      } catch (error) {
        // Two configurators can both read an empty registry. The key settles it, and the
        // second one gets the same sentence the screen would have shown.
        if (error instanceof Error && /duplicate key/i.test(error.message)) {
          throw new PostingPeriodVariantError(
            `Posting Period Variant ${variant} is already defined in this tenant.`,
            'Choose another key, or change the description of the variant that exists.',
          );
        }
        throw error;
      }

      await tx.insert(postingPeriodRule).values(
        DEFAULT_INTERVALS.map((interval) => ({
          client,
          variant,
          accountType: interval.accountType,
          periodFrom: interval.periodFrom,
          periodTo: interval.periodTo,
          yearShiftPast: interval.yearShiftPast,
          yearShiftFuture: interval.yearShiftFuture,
          allowSpecialPeriods: interval.allowSpecialPeriods,
          createdBy: changedBy,
        })),
      );

      const documentId = await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: variant,
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        after: {
          variant,
          name,
          intervalCount: DEFAULT_INTERVALS.length,
          intervals: describeIntervalSet(DEFAULT_INTERVALS),
        },
        fieldLabels: {
          variant: 'Posting Period Variant',
          name: 'Description',
          intervalCount: 'Intervals created',
          intervals: 'Interval set',
        },
        // A variant decides what the books will accept, and it is born wide open. Both halves
        // of that are worth an auditor's attention.
        securityRelevantFields: ['variant', 'intervals'],
      });
      if (!documentId) {
        throw new PostingPeriodVariantError(
          `Posting Period Variant ${variant} was written but the change could not be recorded in the change history.`,
          'Nothing further was saved. Ask an administrator to check the change log before defining it again.',
        );
      }

      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { variant, name, mode: 'CREATED', intervalsCreated: DEFAULT_INTERVALS.length };
    }

    if (existing.name === name) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { variant, name, mode: 'UNCHANGED', intervalsCreated: 0 };
    }

    await tx
      .update(postingPeriodVariant)
      .set({ name, changedBy, changedAt: new Date() })
      .where(and(eq(postingPeriodVariant.client, client), eq(postingPeriodVariant.variant, variant)));

    const documentId = await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: variant,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      before: { variant, name: existing.name },
      after: { variant, name },
      fieldLabels: {
        variant: 'Posting Period Variant',
        name: 'Description',
      },
    });
    if (!documentId) {
      throw new PostingPeriodVariantError(
        `The description of Posting Period Variant ${variant} was saved but the change could not be recorded in the change history.`,
        'Ask an administrator to check the change log.',
      );
    }

    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { variant, name, mode: 'CHANGED', intervalsCreated: 0 };
  });
}

/**
 * Delete a posting period variant (owner package, 2026-10-17: deletion is blocked while
 * intervals exist, reversing the earlier rule that intervals were removed with it).
 *
 * Two things may not be taken with it. A Company Code's posting control, so a variant
 * anything posts against is refused and the refusal names every Company Code holding it.
 * And the intervals it holds: they are the open/close rules the books run on, so they must
 * be removed first and on purpose, never as a side effect of deleting their owner. A
 * variant that clears both checks holds nothing, and deleting it removes one row.
 *
 * There is no undelete; the change document is what makes the deletion reviewable.
 */
export async function deletePostingPeriodVariant(
  raw: PostingPeriodVariantDeleteInput,
): Promise<PostingPeriodVariantDeleteResult> {
  const parsed = postingPeriodVariantDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PostingPeriodVariantError(
      parsed.error.issues[0]?.message ?? 'The Posting Period Variant is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, variant } = parsed.data;

  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(postingPeriodVariant)
      .where(and(eq(postingPeriodVariant.client, client), eq(postingPeriodVariant.variant, variant)))
      .for('update');

    if (!existing) {
      throw new PostingPeriodVariantError(
        `Posting Period Variant ${variant} is not defined in this tenant.`,
        'Reload the registry, or define the variant first (CFG.FIN.PPV.DEFINE).',
      );
    }

    const referencing = await tx
      .select({ companyCode: companyCode.companyCode })
      .from(companyCode)
      .where(and(eq(companyCode.client, client), eq(companyCode.postingPeriodVariant, variant)))
      .orderBy(asc(companyCode.companyCode));

    if (referencing.length > 0) {
      const codes = referencing.map((row) => row.companyCode);
      throw new PostingPeriodVariantError(
        `Posting Period Variant ${variant} cannot be deleted: Company Code ${describeUsedBy(codes)} ` +
          `${codes.length === 1 ? 'posts' : 'post'} against it.`,
        // The same sentence the screen shows before the click, so an operator reads one
        // instruction rather than two that happen to agree today.
        'Assign them to another posting period variant in Company Codes (CFG.ORG.COMPANYCODE.DEFINE), ' +
          'then delete this one.',
      );
    }

    const intervals = await tx
      .select({ accountType: postingPeriodRule.accountType })
      .from(postingPeriodRule)
      .where(and(eq(postingPeriodRule.client, client), eq(postingPeriodRule.variant, variant)));

    if (intervals.length > 0) {
      throw new PostingPeriodVariantError(
        `Posting Period Variant ${variant} cannot be deleted: ${intervals.length} ` +
          `${intervals.length === 1 ? 'interval still exists' : 'intervals still exist'} for it.`,
        'Remove the intervals it holds first, then delete this one.',
      );
    }

    await tx
      .delete(postingPeriodVariant)
      .where(and(eq(postingPeriodVariant.client, client), eq(postingPeriodVariant.variant, variant)));

    const documentId = await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: variant,
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      before: {
        variant,
        name: existing.name,
      },
      fieldLabels: {
        variant: 'Posting Period Variant',
        name: 'Description',
      },
      securityRelevantFields: ['variant'],
    });
    if (!documentId) {
      throw new PostingPeriodVariantError(
        `Posting Period Variant ${variant} was deleted but the change could not be recorded in the change history.`,
        'Ask an administrator to check the change log.',
      );
    }

    return {
      deleted: true,
      variant,
      name: existing.name,
      intervalsRemoved: 0,
      companyCodes: [],
    };
  });
}
