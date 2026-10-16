/**
 * Fiscal year and posting period engine — CAIRN.md §14.3
 *
 * Lives in platform rather than in the foundation module because every posting
 * path needs it: goods receipts, billing, payroll and journals all have to answer
 * "is this period open?" before they write anything. It is infrastructure, sitting
 * alongside numbering and locking.
 *
 * Layering note (§20.2): this engine reads configuration tables owned by the
 * foundation module. That direction — a platform engine reading the configuration
 * it serves — is allowed and deliberate. What remains forbidden is a *module*
 * reaching into another module's internals, which is what keeps modules
 * independent as the system grows.
 *
 * Two questions this answers, and both are easy to get subtly wrong:
 *   1. Given a posting date, which fiscal year and period does it fall in?
 *   2. Given an account type and a period, is posting allowed?
 *
 * Where this module is deliberately unforgiving: a fiscal year variant whose
 * periods do not cover the whole year is refused at definition time. A gap would
 * otherwise surface months later as "no period found for 15 March", which tells
 * the user nothing useful.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  fiscalYearPeriod,
  fiscalYearVariant,
  postingPeriodRule,
  postingPeriodVariant,
  companyCode,
} from '../../modules/foundation/schema';
import {
  describeMissingCompanyCodeAssignments,
  hasCompanyCodeAssignments,
  missingCompanyCodeAssignments,
} from '../../modules/foundation/company-code-assignments';

/** Account type classification, matching the reference model's distinction (§14.3). */
export type AccountType = 'S' | 'K' | 'D' | 'A' | 'M';

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  S: 'General ledger',
  K: 'Vendor',
  D: 'Customer',
  A: 'Asset',
  M: 'Material',
};

export interface PeriodPosition {
  fiscalYear: number;
  period: number;
  periodType: 'REGULAR' | 'SPECIAL';
}

export class PeriodError extends Error {
  readonly code = 'CAIRN_PERIOD';
  constructor(message: string, readonly remedy: string) {
    super(message);
    this.name = 'PeriodError';
  }
}

/**
 * Derive the fiscal year and period a posting date falls in.
 *
 * For a calendar-year variant this is trivial. For a shifted year, the date may
 * belong to the previous or next fiscal year, which is exactly where hand-rolled
 * date arithmetic goes wrong.
 */
export async function derivePosition(
  tx: Tx,
  client: string,
  variantCode: string,
  postingDate: string,
): Promise<PeriodPosition> {
  const variant = await getVariant(tx, client, variantCode);

  const [yearText, monthText, dayText] = postingDate.split('-');
  const dateYear = Number(yearText);
  const posted = Date.UTC(dateYear, Number(monthText) - 1, Number(dayText));

  // A date near a year boundary can belong to the fiscal year that started in the previous
  // calendar year or to the one starting in this, so both are tested rather than guessed
  // from a start month. A year-dependent variant reads the row set of the fiscal year being
  // tested, because that is the whole point of maintaining periods per year.
  for (const fiscalYear of [dateYear, dateYear + 1]) {
    const regular = await regularPeriods(tx, client, variantCode, variant.isYearDependent, fiscalYear);
    if (regular.length === 0) {
      throw new PeriodError(
        `Fiscal year variant ${variantCode} has no periods defined.`,
        `Define the periods for this variant, or assign a different variant to the company ` +
          `code (CFG.FIN.FYV.DEFINE).`,
      );
    }
    const match = periodWindows(regular, fiscalYear).find((w) => posted >= w.start && posted <= w.end);
    if (match) return { fiscalYear, period: match.period, periodType: 'REGULAR' };
  }

  throw new PeriodError(
    `Posting date ${postingDate} does not fall in any period of fiscal year variant ` +
      `${variantCode}.`,
    `Check the variant's period definition — the periods must cover the whole year ` +
      `(CFG.FIN.FYV.DEFINE).`,
  );
}

/**
 * The ordinary periods that apply to one fiscal year, in period order.
 *
 * A year-dependent variant keeps a row set per calendar year; every other variant's rows
 * hold for all years, which `calendar_year` 0 records. A year-dependent variant with no rows
 * for the year asked about falls back to its year-independent rows rather than reporting a
 * gap, because a partly maintained variant still has to answer where a date falls.
 */
async function regularPeriods(
  tx: Tx,
  client: string,
  variantCode: string,
  isYearDependent: boolean,
  fiscalYear: number,
) {
  const load = async (calendarYear: number) => {
    const rows = await tx
      .select()
      .from(fiscalYearPeriod)
      .where(and(
        eq(fiscalYearPeriod.client, client),
        eq(fiscalYearPeriod.variant, variantCode),
        eq(fiscalYearPeriod.calendarYear, calendarYear),
      ));
    return rows.filter((row) => row.periodType === 'REGULAR').sort((a, b) => a.period - b.period);
  };

  if (!isYearDependent) return load(0);
  const forYear = await load(fiscalYear);
  return forYear.length > 0 ? forYear : load(0);
}

/**
 * Each period's calendar window, derived from the ends that are stored.
 *
 * A period starts the day after the one before it ends, and the first period starts the day
 * after the last period of the fiscal year before it — which is what makes a shifted year
 * work without storing a start that could disagree with its neighbour. `day` 31 means the
 * last day of the month, so a period ending in February ends on the 28th or 29th.
 */
export function periodWindows(
  regular: Array<{ period: number; month: number; day: number; yearShift: number }>,
  fiscalYear: number,
): Array<{ period: number; start: number; end: number }> {
  const endOf = (period: { month: number; day: number; yearShift: number }, year: number) => {
    const calendarYear = year + period.yearShift;
    const lastDay = new Date(Date.UTC(calendarYear, period.month, 0)).getUTCDate();
    return Date.UTC(calendarYear, period.month - 1, Math.min(period.day, lastDay));
  };

  return regular.map((period, index) => {
    const previous = index === 0 ? regular[regular.length - 1]! : regular[index - 1]!;
    const previousEnd = endOf(previous, index === 0 ? fiscalYear - 1 : fiscalYear);
    return {
      period: period.period,
      start: previousEnd + 86_400_000,
      end: endOf(period, fiscalYear),
    };
  });
}

/**
 * Whether posting is allowed for an account type in a period.
 *
 * Returns rather than throws, so the caller can collect every problem in the
 * document and report them together — a user correcting three lines should not
 * have to post three times to discover three separate issues.
 */
export async function checkPostingAllowed(
  tx: Tx,
  client: string,
  variantCode: string,
  accountType: AccountType,
  position: PeriodPosition,
): Promise<{ allowed: boolean; reason?: string; remedy?: string }> {
  const rules = await tx
    .select()
    .from(postingPeriodRule)
    .where(
      and(
        eq(postingPeriodRule.client, client),
        eq(postingPeriodRule.variant, variantCode),
        eq(postingPeriodRule.accountType, accountType),
      ),
    )
    .limit(1);

  if (rules.length === 0) {
    // A missing rule is a configuration gap, not a closed period. Say so
    // precisely, because the remedy is different.
    return {
      allowed: false,
      reason:
        `No posting period rule exists for account type ${accountType} ` +
        `(${ACCOUNT_TYPE_LABELS[accountType]}) in posting period variant ${variantCode}.`,
      remedy:
        'Maintain the interval in Posting periods (FIN.CLOSE.PERIOD), or give the Company ' +
        'Code another posting period variant in Company Codes (CFG.ORG.COMPANYCODE.DEFINE). ' +
        'Defining variants is CFG.FIN.PPV.DEFINE, which does not maintain their intervals.',
    };
  }

  const rule = rules[0];

  if (position.periodType === 'SPECIAL' && !rule.allowSpecialPeriods) {
    return {
      allowed: false,
      reason:
        `Special period ${position.period} cannot be used for account type ` +
        `${ACCOUNT_TYPE_LABELS[accountType]}.`,
      remedy:
        'Special periods are for year-end adjustment only. Post to an ordinary period, or ' +
        'permit special periods on the rule.',
    };
  }

  if (position.period < rule.periodFrom || position.period > rule.periodTo) {
    return {
      allowed: false,
      reason:
        `Period ${position.period} of fiscal year ${position.fiscalYear} is closed for ` +
        `account type ${ACCOUNT_TYPE_LABELS[accountType]}. ` +
        `Open periods are ${rule.periodFrom} to ${rule.periodTo}.`,
      remedy:
        `Post to an open period, or reopen the period in Posting Periods ` +
        `(FIN.CLOSE.PERIOD). Reopening is recorded in the change log.`,
    };
  }

  return { allowed: true };
}

/** The full open-period picture for a company code. Drives the close cockpit (§14.3). */
export async function periodStatus(
  tx: Tx,
  client: string,
  companyCodeKey: string,
  fiscalYear: number,
) {
  const company = await getCompanyCode(tx, client, companyCodeKey);
  if (!company) {
    throw new PeriodError(
      `Company code ${companyCodeKey} does not exist.`,
      'Create it in Company Codes (CFG.ORG.COMPANYCODE.DEFINE).',
    );
  }

  if (!hasCompanyCodeAssignments(company)) {
    const missing = missingCompanyCodeAssignments(company);
    throw new PeriodError(
      `Company code ${companyCodeKey} is missing ${describeMissingCompanyCodeAssignments(missing)}.`,
      'Complete the Company Code assignment steps in §6.2 before opening posting periods.',
    );
  }

  const rules = await tx
    .select()
    .from(postingPeriodRule)
    .where(
      and(
        eq(postingPeriodRule.client, client),
        eq(postingPeriodRule.variant, company.postingPeriodVariant),
      ),
    )
    .orderBy(postingPeriodRule.accountType);

  const variant = await getVariant(tx, client, company.fiscalYearVariant);

  return {
    companyCode: company.companyCode,
    fiscalYear,
    fiscalYearVariant: company.fiscalYearVariant,
    postingPeriodVariant: company.postingPeriodVariant,
    regularPeriods: variant.regularPeriods,
    specialPeriods: variant.specialPeriods,
    rules: rules.map((rule) => ({
      accountType: rule.accountType as AccountType,
      accountTypeLabel: ACCOUNT_TYPE_LABELS[rule.accountType as AccountType],
      periodFrom: rule.periodFrom,
      periodTo: rule.periodTo,
      allowSpecialPeriods: rule.allowSpecialPeriods,
    })),
  };
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

export async function getVariant(tx: Tx, client: string, variantCode: string) {
  const rows = await tx
    .select()
    .from(fiscalYearVariant)
    .where(
      and(eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, variantCode)),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new PeriodError(
      `Fiscal year variant ${variantCode} does not exist.`,
      'Create it in Fiscal Year Variants (CFG.FIN.FYV.DEFINE).',
    );
  }
  return rows[0];
}

export async function getCompanyCode(tx: Tx, client: string, companyCodeKey: string) {
  const rows = await tx
    .select()
    .from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, companyCodeKey)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPostingPeriodVariant(
  tx: Tx,
  client: string,
  variantCode: string,
) {
  const rows = await tx
    .select()
    .from(postingPeriodVariant)
    .where(
      and(
        eq(postingPeriodVariant.client, client),
        eq(postingPeriodVariant.variant, variantCode),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Build the period rows for a fiscal year variant. Called when a variant is
 * defined, so the variant and its periods can never disagree.
 */
export function buildPeriodRows(input: {
  regularPeriods: number;
  specialPeriods: number;
  /** Month the fiscal year starts, 1–12. */
  startMonth: number;
}): Array<{
  period: number;
  periodType: 'REGULAR' | 'SPECIAL';
  month: number;
  day: number;
  yearShift: number;
}> {
  const rows: Array<{
    period: number;
    periodType: 'REGULAR' | 'SPECIAL';
    month: number;
    day: number;
    yearShift: number;
  }> = [];

  let lastMonth = input.startMonth;
  let lastShift = 0;
  for (let i = 0; i < input.regularPeriods; i++) {
    // Months are laid out consecutively from the fiscal year's start month; each wrap past
    // December moves the period's end into the next calendar year.
    const month = ((input.startMonth - 1 + i) % 12) + 1;
    const yearShift = Math.floor((input.startMonth - 1 + i) / 12);
    if (yearShift > 1) {
      throw new PeriodError(
        `A fiscal year of ${input.regularPeriods} periods starting in month ${input.startMonth} ` +
          `runs more than a year past its own start.`,
        'Maintain the periods per calendar year with Year Dependent switched on, or use 12 ' +
          'periods for a shifted year (CFG.FIN.FYV.DEFINE).',
      );
    }
    rows.push({ period: i + 1, periodType: 'REGULAR', month, day: 31, yearShift });
    lastMonth = month;
    lastShift = yearShift;
  }

  // Special periods sit after the last ordinary period, sharing its calendar window. They
  // are for year-end adjustment only — a distinction period control enforces rather than one
  // users are trusted to remember.
  for (let i = 0; i < input.specialPeriods; i++) {
    rows.push({
      period: input.regularPeriods + i + 1,
      periodType: 'SPECIAL',
      month: lastMonth,
      day: 31,
      yearShift: lastShift,
    });
  }

  return rows;
}
