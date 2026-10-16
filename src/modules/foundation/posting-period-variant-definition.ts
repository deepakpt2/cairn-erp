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
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '../../platform/db/client';
import { ACCOUNT_TYPE_LABELS, type AccountType } from '../../platform/periods';
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
