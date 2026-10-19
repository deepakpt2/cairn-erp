/**
 * G/L account balances by period — SCR-089 / R-137.
 *
 * Read-only derivation over the canonical journal on the SCR-069
 * precedent: no balance table stands to drift from the ledger.
 * The opening balance is the signed (debit-positive) sum of every
 * earlier year; turnover sums each period's posted lines by the
 * document's stored posting period; closing chains opening plus
 * cumulative net change. Special periods stand apart, only when
 * the caller includes them and the company's variant configures
 * them. Only documents standing POSTED count. Closed periods
 * remain reportable — period locks govern posting, not inquiry.
 *
 * Stage 1 carries the vocabulary only; derivation lands in stage 3.
 */
export const GL_BALANCE_CAPABILITY = 'FIN.GL.BALANCE';

export class GlBalanceError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'GlBalanceError';
    this.remedy = remedy;
  }
}

export interface GlBalancePeriodRow {
  period: number;
  special: boolean;
  opening: number;
  debitTurnover: number;
  creditTurnover: number;
  netChange: number;
  closing: number;
  itemCount: number;
}

export interface GlBalanceView {
  glAccount: string;
  companyCode: string;
  fiscalYear: number;
  currency: string;
  openingBalance: number;
  periods: GlBalancePeriodRow[];
  yearDebit: number;
  yearCredit: number;
  yearClosing: number;
}

import { and, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { getCompanyCode, getVariant } from '../../platform/periods';
import { glAccount, journalEntry, journalEntryLine } from './schema';

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getGlBalances(client: string, input: {
  glAccount: string; companyCode: string; fiscalYear: number;
  currency?: string; includeSpecialPeriods?: boolean;
}): Promise<GlBalanceView> {
  return withTenant(client, async (tx) => {
    const company = await getCompanyCode(tx, client, input.companyCode);
    if (!company?.fiscalYearVariant) {
      throw new GlBalanceError(`Company code ${input.companyCode} is not configured in this tenant.`, 'Correct the company selection.');
    }
    const [account] = await tx.select().from(glAccount).where(and(
      eq(glAccount.client, client), eq(glAccount.accountNumber, input.glAccount),
    ));
    if (!account) {
      throw new GlBalanceError(`G/L account ${input.glAccount} does not stand in this tenant.`, 'Correct the account selection.');
    }
    if (company.chartOfAccounts && account.chartOfAccounts !== company.chartOfAccounts) {
      throw new GlBalanceError(
        `G/L account ${input.glAccount} stands in chart ${account.chartOfAccounts}, not in company ${input.companyCode}'s chart ${company.chartOfAccounts}.`,
      );
    }
    const variant = await getVariant(tx, client, company.fiscalYearVariant);
    const regular = variant.regularPeriods;
    const lastPeriod = input.includeSpecialPeriods ? regular + variant.specialPeriods : regular;

    const rows = await tx.select({
      fiscalYear: journalEntry.fiscalYear,
      period: journalEntry.postingPeriod,
      debitCredit: journalEntryLine.debitCredit,
      amountLocal: journalEntryLine.amountLocal,
      amountDocument: journalEntryLine.amountDocument,
      currency: journalEntryLine.currency,
    }).from(journalEntryLine)
      .innerJoin(journalEntry, and(
        eq(journalEntry.client, journalEntryLine.client),
        eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
        eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
      ))
      .where(and(
        eq(journalEntryLine.client, client),
        eq(journalEntryLine.companyCode, input.companyCode),
        eq(journalEntryLine.glAccount, input.glAccount),
        eq(journalEntry.status, 'POSTED'),
      ));

    const carried = [...new Set(rows.map((r) => r.currency))];
    const display = (input.currency ?? '').toUpperCase();
    let useDocument = false;
    let currency = company.currency;
    if (display && display !== company.currency) {
      if (carried.includes(display) && carried.length === 1) {
        useDocument = true;
        currency = display;
      } else {
        throw new GlBalanceError(
          `Balances cannot display in ${display}: the items stand in ${[...new Set([company.currency, ...carried])].join(' and ')}, and no conversion is performed.`,
          'Display in the company currency or the currency the items stand in.',
        );
      }
    }
    const amount = (r: (typeof rows)[number]) => Number(useDocument ? r.amountDocument : r.amountLocal);

    let opening = 0;
    const byPeriod = new Map<number, { debit: number; credit: number; count: number }>();
    for (const r of rows) {
      const value = amount(r);
      if (r.fiscalYear < input.fiscalYear) {
        opening += r.debitCredit === 'S' ? value : -value;
      } else if (r.fiscalYear === input.fiscalYear) {
        const slot = byPeriod.get(r.period) ?? { debit: 0, credit: 0, count: 0 };
        if (r.debitCredit === 'S') slot.debit += value; else slot.credit += value;
        slot.count += 1;
        byPeriod.set(r.period, slot);
      }
    }

    const periods: GlBalancePeriodRow[] = [];
    let running = round2(opening);
    let yearDebit = 0;
    let yearCredit = 0;
    for (let period = 1; period <= lastPeriod; period += 1) {
      const slot = byPeriod.get(period) ?? { debit: 0, credit: 0, count: 0 };
      const netChange = round2(slot.debit - slot.credit);
      const closing = round2(running + netChange);
      yearDebit = round2(yearDebit + slot.debit);
      yearCredit = round2(yearCredit + slot.credit);
      periods.push({
        period, special: period > regular,
        opening: running,
        debitTurnover: round2(slot.debit), creditTurnover: round2(slot.credit),
        netChange, closing, itemCount: slot.count,
      });
      running = closing;
    }
    return {
      glAccount: input.glAccount, companyCode: input.companyCode,
      fiscalYear: input.fiscalYear, currency,
      openingBalance: round2(opening), periods,
      yearDebit, yearCredit, yearClosing: running,
    };
  });
}

/**
 * Balance report over ranges (SCR-108 / R-156; S_ALR_87012271
 * as a search alias only): many accounts and companies at once,
 * opening from every earlier year, turnover strictly inside the
 * selected period range, closing as opening plus net change
 * through the cutoff, separate debit/credit balance columns and
 * account-group subtotals. Types land in stage 1; the derivation
 * follows in stage 3 on the same posted-journal canon — no
 * balance table stands to drift from the ledger.
 */
export interface GlBalanceReportSelection {
  companyCodes: string[];
  accountFrom: string;
  accountTo: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  includeSpecialPeriods: boolean;
  /** Configured ledger vocabulary; only the leading ledger stands. */
  ledger: string;
}

export interface GlBalanceReportRow {
  companyCode: string;
  glAccount: string;
  accountName: string;
  accountGroup: string;
  currency: string;
  openingBalance: number;
  debitTurnover: number;
  creditTurnover: number;
  netChange: number;
  closingBalance: number;
  /** Closing presented split: the positive side only, else 0. */
  debitBalance: number;
  creditBalance: number;
}

export interface GlBalanceGroupSubtotal {
  accountGroup: string;
  currency: string;
  accountCount: number;
  debitTurnover: number;
  creditTurnover: number;
  netChange: number;
  closingBalance: number;
  debitBalance: number;
  creditBalance: number;
}

export interface GlBalanceReportView {
  ledger: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  rows: GlBalanceReportRow[];
  subtotals: GlBalanceGroupSubtotal[];
  warnings: string[];
  calculatedAt: string;
}
