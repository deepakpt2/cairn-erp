/**
 * Balance sheet / profit and loss statement (SCR-107 /
 * FIN.RPT.BALANCESHEET; SAP S_ALR_87012284 alias). A second
 * read-only statement over the SCR-106 FSV canon: same
 * financial-statement-version tables, same posted-journal
 * snapshot, no persisted totals. What differs is presentation
 * semantics — the balance calculation type (accumulated,
 * movement, combined), the summary report level folding, and
 * the opening-balance column. Calculation lands in stage 3.
 */
import type { StatementAccountRow, StatementNodeRow, TrialBalanceSelection } from './trial-balance';

export const BALANCE_SHEET_CAPABILITY = 'FIN.RPT.BALANCESHEET';

/**
 * Type 1 ACCUMULATED: closing = opening + movements through the
 * cutoff. Type 2 MOVEMENT: net movement strictly inside the
 * selected range, opening excluded. Type 3 COMBINED:
 * balance-sheet accounts take closing logic, P&L accounts take
 * range movement, and the net P&L movement is reported as the
 * explicit current-year result.
 */
export const BALANCE_CALCULATION_TYPES = ['ACCUMULATED', 'MOVEMENT', 'COMBINED'] as const;
export type BalanceCalculationType = (typeof BALANCE_CALCULATION_TYPES)[number];
export const DEFAULT_BALANCE_CALCULATION_TYPE: BalanceCalculationType = 'ACCUMULATED';

export const MIN_SUMMARY_LEVEL = 1;
export const MAX_SUMMARY_LEVEL = 9;
export const DEFAULT_SUMMARY_LEVEL = 1;

export interface BalanceSheetSelection extends TrialBalanceSelection {
  calculationType: BalanceCalculationType;
  /** Presentation-only folding depth; never changes the calculation. */
  summaryLevel: number;
}

export interface BalanceSheetAccountRow extends StatementAccountRow {
  openingBalance: number;
}

export interface BalanceSheetNodeRow extends Omit<StatementNodeRow, 'accounts'> {
  openingBalance: number;
  accounts: BalanceSheetAccountRow[];
}

export interface BalanceSheetResult {
  companyCode: string;
  chartOfAccounts: string;
  statementVersion: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  comparisonFiscalYear: number | null;
  currency: string;
  conversionMissing: boolean;
  calculationType: BalanceCalculationType;
  summaryLevel: number;
  ledger: string;
  /** Net P&L movement under COMBINED; null for other types. */
  currentYearResult: number | null;
  nodes: BalanceSheetNodeRow[];
  warnings: string[];
  unassigned: BalanceSheetAccountRow[];
  totalDebitTurnover: number;
  totalCreditTurnover: number;
  calculatedAt: string;
}

import { sql } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { fromScaled, toScaled } from '@/platform/posting/decimal';
import { getCompanyCode } from '@/platform/periods';
import { STATEMENT_LEDGERS, TrialBalanceError } from './trial-balance';

function fail(message: string, remedy?: string): never {
  throw new TrialBalanceError(message, remedy);
}

interface AccountFigures {
  account: string;
  opening: bigint;
  debitRange: bigint;
  creditRange: bigint;
  debitTo: bigint;
  creditTo: bigint;
  compOpening: bigint;
  compDebitRange: bigint;
  compCreditRange: bigint;
  compDebitTo: bigint;
  compCreditTo: bigint;
}

/**
 * One snapshot over the posted journal, aggregated before the
 * FSV mapping (no row multiplication): opening from every
 * earlier year, range turnover, turnover through the cutoff,
 * and the comparative equivalents. The calculation type then
 * decides, per account, what "balance" means — accumulated
 * closing, range movement, or combined (closing for
 * balance-sheet accounts, movement for P&L accounts). Summary
 * level folding is presentation-only and happens after the
 * roll-up, so it can never change a figure.
 */
export async function calculateBalanceSheet(input: {
  client: string; selection: BalanceSheetSelection;
}): Promise<BalanceSheetResult> {
  const { client } = input;
  const s = { ...input.selection };
  if (!STATEMENT_LEDGERS.includes(s.ledger as (typeof STATEMENT_LEDGERS)[number])) {
    fail(`Ledger ${s.ledger || '(blank)'} is not configured.`, `Configured ledgers: ${STATEMENT_LEDGERS.join(', ')}.`);
  }
  if (!BALANCE_CALCULATION_TYPES.includes(s.calculationType)) {
    fail(`Balance calculation type ${s.calculationType || '(blank)'} is not configured.`, `Configured types: ${BALANCE_CALCULATION_TYPES.join(', ')}.`);
  }
  if (!Number.isInteger(s.summaryLevel) || s.summaryLevel < MIN_SUMMARY_LEVEL || s.summaryLevel > MAX_SUMMARY_LEVEL) {
    fail(`Summary report level must run ${MIN_SUMMARY_LEVEL}–${MAX_SUMMARY_LEVEL}.`);
  }
  if (!Number.isInteger(s.fiscalYear) || s.fiscalYear < 1900 || s.fiscalYear > 2199) fail('A valid fiscal year is required.');
  if (s.periodFrom < 1 || s.periodTo > 16 || s.periodFrom > s.periodTo) {
    fail('The period range is invalid.', 'Period from must not exceed period to; periods run 1–16.');
  }
  const compYear = s.comparisonFiscalYear;
  if (compYear !== undefined) {
    const cf = s.comparisonPeriodFrom ?? s.periodFrom;
    const ct = s.comparisonPeriodTo ?? s.periodTo;
    if (!Number.isInteger(compYear) || compYear < 1900 || compYear > 2199 || cf < 1 || ct > 16 || cf > ct) {
      fail('The comparison range is invalid.', 'Validate the comparison fiscal year and its period range independently of the reporting range.');
    }
  }
  const calculatedAt = new Date().toISOString();
  const today = calculatedAt.slice(0, 10);

  return withTenant(client, async (tx) => {
    const company = await getCompanyCode(tx, client, s.companyCode);
    if (!company) fail(`Company code ${s.companyCode} does not stand.`);
    const chart = company.chartOfAccounts ?? '';
    const companyCurrency = company.currency;

    const versionRows = await tx.execute(sql`
      select chart_of_accounts, is_active from financial_statement_version
      where client = ${client} and version = ${s.statementVersion}
    `);
    const version = (versionRows as unknown as Array<{ chart_of_accounts: string; is_active: boolean }>)[0];
    if (!version) fail(`Financial statement version ${s.statementVersion} does not stand.`, 'Configure the FSV first.');
    if (!version.is_active) fail(`Financial statement version ${s.statementVersion} stands inactive.`);
    if (version.chart_of_accounts !== chart) {
      fail(`Statement version ${s.statementVersion} binds to chart ${version.chart_of_accounts}, but company ${s.companyCode} uses ${chart}.`);
    }

    const nodeRows = await tx.execute(sql`
      select node, description, parent_node, sequence from financial_statement_node
      where client = ${client} and version = ${s.statementVersion} order by sequence, node
    `);
    const nodes = nodeRows as unknown as Array<{ node: string; description: string; parent_node: string | null; sequence: number }>;
    if (nodes.length === 0) fail(`Statement version ${s.statementVersion} has no nodes.`);
    const assignmentRows = await tx.execute(sql`
      select node, account_from, account_to, presentation_sign from financial_statement_assignment
      where client = ${client} and version = ${s.statementVersion} order by account_from
    `);
    const assignments = assignmentRows as unknown as Array<{ node: string; account_from: string; account_to: string; presentation_sign: string }>;

    const warnings: string[] = [];
    const effectiveTo = s.includeSpecialPeriods ? s.periodTo : Math.min(s.periodTo, 12);
    if (!s.includeSpecialPeriods && s.periodTo > 12) {
      warnings.push(`Period ${s.periodTo} is a special period; special periods are excluded unless explicitly included. Figures run to period 12.`);
    }
    const compFrom = compYear ? (s.comparisonPeriodFrom ?? s.periodFrom) : s.periodFrom;
    const compToRaw = compYear ? (s.comparisonPeriodTo ?? s.periodTo) : effectiveTo;
    const compTo = s.includeSpecialPeriods ? compToRaw : Math.min(compToRaw, 12);

    const figureRows = await tx.execute(sql`
      select l.gl_account as account,
        coalesce(sum(case when e.fiscal_year < ${s.fiscalYear} and l.debit_credit = 'S' then l.amount_local
                          when e.fiscal_year < ${s.fiscalYear} then -l.amount_local end), 0)::text as opening,
        coalesce(sum(case when e.fiscal_year = ${s.fiscalYear} and e.posting_period between ${s.periodFrom} and ${effectiveTo} and l.debit_credit = 'S' then l.amount_local else 0 end), 0)::text as debit_range,
        coalesce(sum(case when e.fiscal_year = ${s.fiscalYear} and e.posting_period between ${s.periodFrom} and ${effectiveTo} and l.debit_credit = 'H' then l.amount_local else 0 end), 0)::text as credit_range,
        coalesce(sum(case when e.fiscal_year = ${s.fiscalYear} and e.posting_period <= ${effectiveTo} and l.debit_credit = 'S' then l.amount_local else 0 end), 0)::text as debit_to,
        coalesce(sum(case when e.fiscal_year = ${s.fiscalYear} and e.posting_period <= ${effectiveTo} and l.debit_credit = 'H' then l.amount_local else 0 end), 0)::text as credit_to
        ${compYear ? sql`,
        coalesce(sum(case when e.fiscal_year < ${compYear} and l.debit_credit = 'S' then l.amount_local
                          when e.fiscal_year < ${compYear} then -l.amount_local end), 0)::text as comp_opening,
        coalesce(sum(case when e.fiscal_year = ${compYear} and e.posting_period between ${compFrom} and ${compTo} and l.debit_credit = 'S' then l.amount_local else 0 end), 0)::text as comp_debit_range,
        coalesce(sum(case when e.fiscal_year = ${compYear} and e.posting_period between ${compFrom} and ${compTo} and l.debit_credit = 'H' then l.amount_local else 0 end), 0)::text as comp_credit_range,
        coalesce(sum(case when e.fiscal_year = ${compYear} and e.posting_period <= ${compTo} and l.debit_credit = 'S' then l.amount_local else 0 end), 0)::text as comp_debit_to,
        coalesce(sum(case when e.fiscal_year = ${compYear} and e.posting_period <= ${compTo} and l.debit_credit = 'H' then l.amount_local else 0 end), 0)::text as comp_credit_to` : sql`,
        '0'::text as comp_opening, '0'::text as comp_debit_range, '0'::text as comp_credit_range, '0'::text as comp_debit_to, '0'::text as comp_credit_to`}
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client} and e.company_code = ${s.companyCode} and e.status = 'POSTED'
      group by l.gl_account
      order by l.gl_account
    `);

    const nameRows = await tx.execute(sql`
      select account_number, name, is_balance_sheet from gl_account where client = ${client} and chart_of_accounts = ${chart}
    `);
    const accountInfo = new Map((nameRows as unknown as Array<{ account_number: string; name: string; is_balance_sheet: boolean }>)
      .map((r) => [r.account_number, r]));

    const figures: AccountFigures[] = (figureRows as unknown as Array<Record<string, string>>).map((r) => ({
      account: r.account,
      opening: toScaled(r.opening ?? '0'),
      debitRange: toScaled(r.debit_range ?? '0'), creditRange: toScaled(r.credit_range ?? '0'),
      debitTo: toScaled(r.debit_to ?? '0'), creditTo: toScaled(r.credit_to ?? '0'),
      compOpening: toScaled(r.comp_opening ?? '0'),
      compDebitRange: toScaled(r.comp_debit_range ?? '0'), compCreditRange: toScaled(r.comp_credit_range ?? '0'),
      compDebitTo: toScaled(r.comp_debit_to ?? '0'), compCreditTo: toScaled(r.comp_credit_to ?? '0'),
    }));

    // First assignment in statement order wins; duplicates warn.
    const nodeOrder = new Map(nodes.map((n, i) => [n.node, i]));
    const sortedAssignments = [...assignments].sort((a, b) =>
      (nodeOrder.get(a.node) ?? 999) - (nodeOrder.get(b.node) ?? 999) || a.account_from.localeCompare(b.account_from));
    const assignmentOf = new Map<string, { node: string; inverted: boolean }>();
    for (const assignment of sortedAssignments) {
      for (const figure of figures) {
        if (figure.account >= assignment.account_from && figure.account <= assignment.account_to) {
          const existing = assignmentOf.get(figure.account);
          if (existing && existing.node !== assignment.node) {
            warnings.push(`Account ${figure.account} is assigned to both ${existing.node} and ${assignment.node}; counted under ${existing.node} only.`);
          } else if (!existing) {
            assignmentOf.set(figure.account, { node: assignment.node, inverted: assignment.presentation_sign === 'INVERTED' });
          }
        }
      }
    }

    const isBalanceSheet = (account: string) => accountInfo.get(account)?.is_balance_sheet ?? true;
    const usesClosing = (account: string) =>
      s.calculationType === 'ACCUMULATED' || (s.calculationType === 'COMBINED' && isBalanceSheet(account));
    const openingOf = (f: AccountFigures) => (usesClosing(f.account) ? f.opening : 0n);
    const closingOf = (f: AccountFigures) => (usesClosing(f.account)
      ? f.opening + f.debitTo - f.creditTo
      : f.debitRange - f.creditRange);
    const comparativeOf = (f: AccountFigures) => (usesClosing(f.account)
      ? f.compOpening + f.compDebitTo - f.compCreditTo
      : f.compDebitRange - f.compCreditRange);

    const accountsByNode = new Map<string, BalanceSheetAccountRow[]>();
    const unassigned: BalanceSheetAccountRow[] = [];
    let totalDebit = 0n;
    let totalCredit = 0n;
    let resultScaled = 0n;
    for (const figure of figures) {
      totalDebit += figure.debitRange;
      totalCredit += figure.creditRange;
      if (!isBalanceSheet(figure.account)) resultScaled += figure.creditRange - figure.debitRange;
      const info = accountInfo.get(figure.account);
      if (info === undefined) {
        warnings.push(`Account ${figure.account} carries postings but does not stand in chart ${chart}.`);
      }
      const assignment = assignmentOf.get(figure.account);
      const sign = assignment?.inverted ? -1 : 1;
      const row: BalanceSheetAccountRow = {
        accountNumber: figure.account, accountName: info?.name ?? '',
        openingBalance: Number(fromScaled(openingOf(figure))) * sign,
        debitTurnover: Number(fromScaled(figure.debitRange)),
        creditTurnover: Number(fromScaled(figure.creditRange)),
        balance: Number(fromScaled(closingOf(figure))) * sign,
        comparativeBalance: compYear ? Number(fromScaled(comparativeOf(figure))) * sign : null,
      };
      if (!assignment) {
        if (figure.opening !== 0n || figure.debitRange !== 0n || figure.creditRange !== 0n) unassigned.push(row);
        continue;
      }
      accountsByNode.set(assignment.node, [...(accountsByNode.get(assignment.node) ?? []), row]);
    }
    if (unassigned.length > 0) {
      warnings.push(`${unassigned.length} account(s) with balances stand outside every FSV assignment and are listed below the statement.`);
    }

    const childrenOf = new Map<string, typeof nodes>();
    for (const node of nodes) {
      if (node.parent_node) childrenOf.set(node.parent_node, [...(childrenOf.get(node.parent_node) ?? []), node]);
    }
    const flat: BalanceSheetNodeRow[] = [];
    const visit = (node: (typeof nodes)[number], depth: number): { opening: number; balance: number; debit: number; credit: number; comparative: number | null } => {
      const accounts = accountsByNode.get(node.node) ?? [];
      const row: BalanceSheetNodeRow = {
        node: node.node, description: node.description, depth,
        openingBalance: accounts.reduce((sum, a) => sum + a.openingBalance, 0),
        balance: accounts.reduce((sum, a) => sum + a.balance, 0),
        debitTurnover: accounts.reduce((sum, a) => sum + a.debitTurnover, 0),
        creditTurnover: accounts.reduce((sum, a) => sum + a.creditTurnover, 0),
        comparativeBalance: accounts.some((a) => a.comparativeBalance !== null)
          ? accounts.reduce((sum, a) => sum + (a.comparativeBalance ?? 0), 0) : null,
        variance: null, variancePercent: null,
        accounts,
      };
      flat.push(row);
      let comparative: number | null = row.comparativeBalance;
      for (const child of childrenOf.get(node.node) ?? []) {
        const totals = visit(child, depth + 1);
        row.openingBalance += totals.opening;
        row.balance += totals.balance;
        row.debitTurnover += totals.debit;
        row.creditTurnover += totals.credit;
        if (totals.comparative !== null) comparative = (comparative ?? 0) + totals.comparative;
      }
      row.comparativeBalance = compYear ? comparative : null;
      if (compYear && row.comparativeBalance !== null) {
        row.variance = row.balance - row.comparativeBalance;
        row.variancePercent = row.comparativeBalance === 0 ? null : row.variance / Math.abs(row.comparativeBalance) * 100;
      }
      return { opening: row.openingBalance, balance: row.balance, debit: row.debitTurnover, credit: row.creditTurnover, comparative: row.comparativeBalance };
    };
    for (const root of nodes.filter((n) => !n.parent_node)) visit(root, 0);

    // Summary-level folding: deeper nodes merge their account
    // rows into the deepest displayed ancestor. Totals already
    // include descendants, so no figure changes.
    const displayed: BalanceSheetNodeRow[] = [];
    const folderAt: BalanceSheetNodeRow[] = [];
    for (const row of flat) {
      if (row.depth < s.summaryLevel) {
        displayed.push(row);
        folderAt[row.depth] = row;
        folderAt.length = row.depth + 1;
      } else {
        const target = folderAt[s.summaryLevel - 1] ?? displayed[displayed.length - 1];
        if (target) target.accounts.push(...row.accounts);
      }
    }

    let currency = companyCurrency;
    let conversionMissing = false;
    let currentYearResult: number | null = s.calculationType === 'COMBINED' ? Number(fromScaled(resultScaled)) : null;
    if (s.outputCurrency && s.outputCurrency !== companyCurrency) {
      const rateRows = await tx.execute(sql`
        select rate::text as rate, ratio_from, ratio_to from exchange_rate
        where rate_type = 'AVERAGE' and from_currency = ${companyCurrency}
          and to_currency = ${s.outputCurrency} and valid_from <= ${today}
        order by valid_from desc limit 1
      `);
      const rate = (rateRows as unknown as Array<{ rate: string; ratio_from: number; ratio_to: number }>)[0];
      if (!rate) {
        conversionMissing = true;
        warnings.push(`No AVERAGE rate from ${companyCurrency} to ${s.outputCurrency} stands; figures remain in ${companyCurrency}.`);
      } else {
        const factor = Number(rate.rate) * Number(rate.ratio_to) / Number(rate.ratio_from);
        currency = s.outputCurrency;
        const scale = (v: number) => v * factor;
        const scaleRow = (r: BalanceSheetAccountRow) => {
          r.openingBalance = scale(r.openingBalance);
          r.balance = scale(r.balance);
          r.debitTurnover = scale(r.debitTurnover);
          r.creditTurnover = scale(r.creditTurnover);
          if (r.comparativeBalance !== null) r.comparativeBalance = scale(r.comparativeBalance);
        };
        for (const node of displayed) {
          node.openingBalance = scale(node.openingBalance);
          node.balance = scale(node.balance);
          node.debitTurnover = scale(node.debitTurnover);
          node.creditTurnover = scale(node.creditTurnover);
          if (node.comparativeBalance !== null) node.comparativeBalance = scale(node.comparativeBalance);
          if (node.variance !== null) node.variance = scale(node.variance);
          node.accounts.forEach(scaleRow);
        }
        unassigned.forEach(scaleRow);
        if (currentYearResult !== null) currentYearResult = scale(currentYearResult);
      }
    }

    return {
      companyCode: s.companyCode, chartOfAccounts: chart, statementVersion: s.statementVersion,
      fiscalYear: s.fiscalYear, periodFrom: s.periodFrom, periodTo: effectiveTo,
      comparisonFiscalYear: compYear ?? null, currency, conversionMissing,
      calculationType: s.calculationType, summaryLevel: s.summaryLevel, ledger: s.ledger,
      currentYearResult,
      nodes: displayed, warnings, unassigned,
      totalDebitTurnover: Number(fromScaled(totalDebit)), totalCreditTurnover: Number(fromScaled(totalCredit)),
      calculatedAt,
    };
  });
}
