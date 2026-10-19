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

import { sql } from 'drizzle-orm';
import { fromScaled, toScaled } from '../../platform/posting/decimal';

export async function getGlBalanceReport(
  client: string, selection: GlBalanceReportSelection,
): Promise<GlBalanceReportView> {
  const companyCodes = [...new Set(selection.companyCodes.map((c) => c.trim()).filter(Boolean))];
  if (companyCodes.length === 0) {
    throw new GlBalanceError('Enter at least one company code.', 'Name the company codes whose balances to read.');
  }
  const accountFrom = (selection.accountFrom ?? '').trim();
  const accountTo = (selection.accountTo ?? '').trim() || accountFrom;
  if (!accountFrom) throw new GlBalanceError('Enter the G/L account to start from.');
  if (accountFrom > accountTo) throw new GlBalanceError('The account range is inverted.', 'Account from must not exceed account to.');
  if (selection.ledger !== '0L') {
    throw new GlBalanceError(`Ledger ${selection.ledger || '(blank)'} is not configured.`, 'Configured ledgers: 0L.');
  }
  if (!Number.isInteger(selection.fiscalYear) || selection.fiscalYear < 1900 || selection.fiscalYear > 2199) {
    throw new GlBalanceError('A valid fiscal year is required.');
  }
  if (selection.periodFrom < 1 || selection.periodTo > 16 || selection.periodFrom > selection.periodTo) {
    throw new GlBalanceError('The period range is invalid.', 'Period from must not exceed period to; periods run 1–16.');
  }
  const calculatedAt = new Date().toISOString();
  const warnings: string[] = [];
  const effectiveTo = selection.includeSpecialPeriods ? selection.periodTo : Math.min(selection.periodTo, 12);
  if (!selection.includeSpecialPeriods && selection.periodTo > 12) {
    warnings.push(`Period ${selection.periodTo} is a special period; special periods are excluded unless explicitly included. Figures run to period 12.`);
  }

  return withTenant(client, async (tx) => {
    const charts = new Map<string, string>();
    const currencies = new Map<string, string>();
    for (const companyCode of companyCodes) {
      const company = await getCompanyCode(tx, client, companyCode);
      if (!company) {
        throw new GlBalanceError(`Company code ${companyCode} is not configured in this tenant.`, 'Correct the company selection.');
      }
      charts.set(companyCode, company.chartOfAccounts ?? '');
      currencies.set(companyCode, company.currency);
    }

    const figureRows = await tx.execute(sql`
      select l.company_code, l.gl_account as account,
        coalesce(sum(case when e.fiscal_year < ${selection.fiscalYear} and l.debit_credit = 'S' then l.amount_local
                          when e.fiscal_year < ${selection.fiscalYear} then -l.amount_local end), 0)::text as opening,
        coalesce(sum(case when e.fiscal_year = ${selection.fiscalYear} and e.posting_period between ${selection.periodFrom} and ${effectiveTo} and l.debit_credit = 'S' then l.amount_local else 0 end), 0)::text as debit_range,
        coalesce(sum(case when e.fiscal_year = ${selection.fiscalYear} and e.posting_period between ${selection.periodFrom} and ${effectiveTo} and l.debit_credit = 'H' then l.amount_local else 0 end), 0)::text as credit_range,
        coalesce(sum(case when e.fiscal_year = ${selection.fiscalYear} and e.posting_period <= ${effectiveTo} and l.debit_credit = 'S' then l.amount_local else 0 end), 0)::text as debit_to,
        coalesce(sum(case when e.fiscal_year = ${selection.fiscalYear} and e.posting_period <= ${effectiveTo} and l.debit_credit = 'H' then l.amount_local else 0 end), 0)::text as credit_to
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client}
        and l.company_code in (${sql.join(companyCodes.map((c) => sql`${c}`), sql`, `)})
        and l.gl_account between ${accountFrom} and ${accountTo}
        and e.status = 'POSTED'
      group by l.company_code, l.gl_account
      order by l.company_code, l.gl_account
    `) as unknown as Array<Record<string, string>>;

    const masterRows = await tx.execute(sql`
      select account_number, name, account_group, chart_of_accounts from gl_account
      where client = ${client} and account_number between ${accountFrom} and ${accountTo}
      order by account_number
    `) as unknown as Array<{ account_number: string; name: string; account_group: string; chart_of_accounts: string }>;
    const masterByChart = new Map<string, typeof masterRows>();
    for (const row of masterRows) {
      masterByChart.set(row.chart_of_accounts, [...(masterByChart.get(row.chart_of_accounts) ?? []), row]);
    }

    const rows: GlBalanceReportRow[] = [];
    const seen = new Set<string>();
    const toRow = (companyCode: string, account: string, name: string, group: string,
      opening: bigint, debitRange: bigint, creditRange: bigint, debitTo: bigint, creditTo: bigint): GlBalanceReportRow => {
      const closing = opening + debitTo - creditTo;
      return {
        companyCode, glAccount: account, accountName: name, accountGroup: group,
        currency: currencies.get(companyCode) ?? '',
        openingBalance: Number(fromScaled(opening)),
        debitTurnover: Number(fromScaled(debitRange)),
        creditTurnover: Number(fromScaled(creditRange)),
        netChange: Number(fromScaled(debitRange - creditRange)),
        closingBalance: Number(fromScaled(closing)),
        debitBalance: closing > 0n ? Number(fromScaled(closing)) : 0,
        creditBalance: closing < 0n ? Number(fromScaled(-closing)) : 0,
      };
    };
    for (const figure of figureRows) {
      const chart = charts.get(figure.company_code) ?? '';
      const master = (masterByChart.get(chart) ?? []).find((m) => m.account_number === figure.account);
      if (!master) warnings.push(`Account ${figure.account} carries postings in company ${figure.company_code} but does not stand in chart ${chart}.`);
      seen.add(`${figure.company_code}|${figure.account}`);
      rows.push(toRow(figure.company_code, figure.account, master?.name ?? '', master?.account_group ?? '',
        toScaled(figure.opening ?? '0'), toScaled(figure.debit_range ?? '0'), toScaled(figure.credit_range ?? '0'),
        toScaled(figure.debit_to ?? '0'), toScaled(figure.credit_to ?? '0')));
    }
    // Selected accounts without postings stand as zero rows.
    for (const companyCode of companyCodes) {
      for (const master of masterByChart.get(charts.get(companyCode) ?? '') ?? []) {
        if (seen.has(`${companyCode}|${master.account_number}`)) continue;
        rows.push(toRow(companyCode, master.account_number, master.name, master.account_group, 0n, 0n, 0n, 0n, 0n));
      }
    }
    rows.sort((a, b) => a.companyCode.localeCompare(b.companyCode) || a.glAccount.localeCompare(b.glAccount));

    const subtotalMap = new Map<string, GlBalanceGroupSubtotal>();
    for (const row of rows) {
      const key = `${row.accountGroup}|${row.currency}`;
      const subtotal = subtotalMap.get(key) ?? {
        accountGroup: row.accountGroup, currency: row.currency, accountCount: 0,
        debitTurnover: 0, creditTurnover: 0, netChange: 0, closingBalance: 0, debitBalance: 0, creditBalance: 0,
      };
      subtotal.accountCount += 1;
      subtotal.debitTurnover = round2(subtotal.debitTurnover + row.debitTurnover);
      subtotal.creditTurnover = round2(subtotal.creditTurnover + row.creditTurnover);
      subtotal.netChange = round2(subtotal.netChange + row.netChange);
      subtotal.closingBalance = round2(subtotal.closingBalance + row.closingBalance);
      subtotal.debitBalance = round2(subtotal.debitBalance + row.debitBalance);
      subtotal.creditBalance = round2(subtotal.creditBalance + row.creditBalance);
      subtotalMap.set(key, subtotal);
    }

    return {
      ledger: selection.ledger, fiscalYear: selection.fiscalYear,
      periodFrom: selection.periodFrom, periodTo: effectiveTo,
      rows, subtotals: [...subtotalMap.values()].sort((a, b) => a.accountGroup.localeCompare(b.accountGroup)),
      warnings, calculatedAt,
    };
  });
}
