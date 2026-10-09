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
  const periods = await tx
    .select()
    .from(fiscalYearPeriod)
    .where(
      and(eq(fiscalYearPeriod.client, client), eq(fiscalYearPeriod.variant, variantCode)),
    );

  const regular = periods
    .filter((p) => p.periodType === 'REGULAR')
    .sort((a, b) => a.period - b.period);

  if (regular.length === 0) {
    throw new PeriodError(
      `Fiscal year variant ${variantCode} has no periods defined.`,
      `Define the periods for this variant, or assign a different variant to the company ` +
        `code (CFG.FIN.FYV.DEFINE).`,
    );
  }

  const [yearText, monthText, dayText] = postingDate.split('-');
  const dateYear = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  // The period whose calendar window contains the date. Days beyond a month's end
  // simply never match, so a day-31 window is safe for shorter months.
  const match = regular.find((p) =>
    withinWindow(p.startMonth, p.startDay, p.endMonth, p.endDay, month, day),
  );

  if (!match) {
    throw new PeriodError(
      `Posting date ${postingDate} does not fall in any period of fiscal year variant ` +
        `${variantCode}.`,
      `Check the variant's period definition — the periods must cover the whole year ` +
        `(CFG.FIN.FYV.DEFINE).`,
    );
  }

  // Fiscal year: the calendar year, adjusted when the year is shifted.
  let fiscalYear = dateYear;
  if (!variant.isCalendarYear) {
    const firstStartMonth = regular[0].startMonth;
    if (firstStartMonth > 1 && month >= firstStartMonth) {
      // A year starting in, say, October: Oct–Dec belong to the NEXT fiscal year.
      fiscalYear = dateYear + 1;
    }
  }

  return { fiscalYear, period: match.period, periodType: 'REGULAR' };
}

function withinWindow(
  startMonth: number,
  startDay: number,
  endMonth: number,
  endDay: number,
  month: number,
  day: number,
): boolean {
  const afterStart = month > startMonth || (month === startMonth && day >= startDay);
  const beforeEnd = month < endMonth || (month === endMonth && day <= endDay);
  return afterStart && beforeEnd;
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
        'Maintain the rule in Posting Periods (CFG.FIN.PPV.DEFINE), or assign another ' +
        'posting period variant to the company code.',
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
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
  name: string;
}> {
  const rows: Array<{
    period: number;
    periodType: 'REGULAR' | 'SPECIAL';
    startMonth: number;
    startDay: number;
    endMonth: number;
    endDay: number;
    name: string;
  }> = [];

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  let previousEndMonth = 0;
  for (let i = 0; i < input.regularPeriods; i++) {
    // Months are laid out consecutively from the fiscal year's start month.
    const startMonth = ((input.startMonth - 1 + i) % 12) + 1;
    const endMonth = ((input.startMonth - 1 + i) % 12) + 1;
    rows.push({
      period: i + 1,
      periodType: 'REGULAR',
      startMonth,
      startDay: 1,
      endMonth,
      endDay: 31,
      name: `Period ${i + 1} (${monthNames[startMonth - 1]})`,
    });
    previousEndMonth = endMonth;
  }

  // Special periods sit after the last ordinary period, sharing its calendar
  // window. They are for year-end adjustment only — a distinction period control
  // enforces rather than one users are trusted to remember.
  for (let i = 0; i < input.specialPeriods; i++) {
    rows.push({
      period: input.regularPeriods + i + 1,
      periodType: 'SPECIAL',
      startMonth: previousEndMonth,
      startDay: 1,
      endMonth: previousEndMonth,
      endDay: 31,
      name: `Special period ${i + 1}`,
    });
  }

  return rows;
}
