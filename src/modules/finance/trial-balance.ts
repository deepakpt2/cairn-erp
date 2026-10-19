/**
 * Trial balance / F.01 financial statement (SCR-106 /
 * FIN.RPT.TRIALBALANCE).
 *
 * Read-only: balances derive from the posted journal in one
 * snapshot — opening from every earlier year, turnover from the
 * selected period range, balance at cutoff as opening plus
 * turnover through the cutoff, never double-counted. The
 * financial statement version (hierarchy, account ranges,
 * presentation signs) is configuration resolved dynamically;
 * accounts with balances but no assignment surface as explicit
 * warnings, never silent omissions. Comparative figures follow
 * the identical rules; variance percentages handle zero
 * denominators explicitly.
 */

export const TRIAL_BALANCE_CAPABILITY = 'FIN.RPT.TRIALBALANCE';

export const STATEMENT_LEDGERS = ['0L'] as const;

export interface TrialBalanceSelection {
  companyCode: string;
  statementVersion: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  includeSpecialPeriods: boolean;
  comparisonFiscalYear?: number;
  comparisonPeriodFrom?: number;
  comparisonPeriodTo?: number;
  outputCurrency?: string;
  ledger: string;
}

export interface StatementAccountRow {
  accountNumber: string;
  accountName: string;
  debitTurnover: number;
  creditTurnover: number;
  balance: number;
  comparativeBalance: number | null;
}

export interface StatementNodeRow {
  node: string;
  description: string;
  depth: number;
  balance: number;
  debitTurnover: number;
  creditTurnover: number;
  comparativeBalance: number | null;
  variance: number | null;
  variancePercent: number | null;
  accounts: StatementAccountRow[];
}

export interface TrialBalanceResult {
  companyCode: string;
  chartOfAccounts: string;
  statementVersion: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  comparisonFiscalYear: number | null;
  currency: string;
  conversionMissing: boolean;
  nodes: StatementNodeRow[];
  warnings: string[];
  unassigned: StatementAccountRow[];
  totalDebitTurnover: number;
  totalCreditTurnover: number;
  calculatedAt: string;
}

export class TrialBalanceError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'TrialBalanceError';
    this.remedy = remedy;
  }
}

import { sql } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { fromScaled, toScaled } from '@/platform/posting/decimal';
import { getCompanyCode } from '@/platform/periods';

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
  compDebitTo: bigint;
  compCreditTo: bigint;
  compOpening: bigint;
}

export async function calculateTrialBalance(input: {
  client: string; selection: TrialBalanceSelection;
}): Promise<TrialBalanceResult> {
  const { client } = input;
  const s = { ...input.selection };
  if (!STATEMENT_LEDGERS.includes(s.ledger as (typeof STATEMENT_LEDGERS)[number])) {
    fail(`Ledger ${s.ledger || '(blank)'} is not configured.`, `Configured ledgers: ${STATEMENT_LEDGERS.join(', ')}.`);
  }
  if (!Number.isInteger(s.fiscalYear) || s.fiscalYear < 1900 || s.fiscalYear > 2199) fail('A valid fiscal year is required.');
  if (s.periodFrom < 1 || s.periodTo > 16 || s.periodFrom > s.periodTo) {
    fail('The period range is invalid.', 'Period from must not exceed period to; periods run 1–16.');
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

    const compYear = s.comparisonFiscalYear;
    const compFrom = s.comparisonPeriodFrom ?? s.periodFrom;
    const compTo = s.comparisonPeriodTo ?? effectiveTo;

    // One aggregation over the journal: opening from earlier
    // years, range turnover, turnover through the cutoff, and
    // the comparative equivalents — summarized before mapping.
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
        coalesce(sum(case when e.fiscal_year = ${compYear} and e.posting_period <= ${compTo} and l.debit_credit = 'S' then l.amount_local else 0 end), 0)::text as comp_debit_to,
        coalesce(sum(case when e.fiscal_year = ${compYear} and e.posting_period <= ${compTo} and l.debit_credit = 'H' then l.amount_local else 0 end), 0)::text as comp_credit_to` : sql`,
        '0'::text as comp_opening, '0'::text as comp_debit_to, '0'::text as comp_credit_to`}
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client} and e.company_code = ${s.companyCode} and e.status = 'POSTED'
      group by l.gl_account
      order by l.gl_account
    `);

    const nameRows = await tx.execute(sql`
      select account_number, name from gl_account where client = ${client} and chart_of_accounts = ${chart}
    `);
    const accountNames = new Map((nameRows as unknown as Array<{ account_number: string; name: string }>)
      .map((r) => [r.account_number, r.name]));

    const figures: AccountFigures[] = (figureRows as unknown as Array<Record<string, string>>).map((r) => ({
      account: r.account,
      opening: toScaled(r.opening ?? '0'),
      debitRange: toScaled(r.debit_range ?? '0'), creditRange: toScaled(r.credit_range ?? '0'),
      debitTo: toScaled(r.debit_to ?? '0'), creditTo: toScaled(r.credit_to ?? '0'),
      compOpening: toScaled(r.comp_opening ?? '0'),
      compDebitTo: toScaled(r.comp_debit_to ?? '0'), compCreditTo: toScaled(r.comp_credit_to ?? '0'),
    }));

    // Resolve assignments: first node (in statement order) wins;
    // duplicates warn instead of double-counting.
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

    const balanceOf = (f: AccountFigures) => f.opening + f.debitTo - f.creditTo;
    const comparativeOf = (f: AccountFigures) => f.compOpening + f.compDebitTo - f.compCreditTo;

    const accountsByNode = new Map<string, StatementAccountRow[]>();
    const unassigned: StatementAccountRow[] = [];
    let totalDebit = 0n;
    let totalCredit = 0n;
    for (const figure of figures) {
      totalDebit += figure.debitRange;
      totalCredit += figure.creditRange;
      const name = accountNames.get(figure.account);
      if (name === undefined) {
        warnings.push(`Account ${figure.account} carries postings but does not stand in chart ${chart}.`);
      }
      const balance = balanceOf(figure);
      const row: StatementAccountRow = {
        accountNumber: figure.account, accountName: name ?? '',
        debitTurnover: Number(fromScaled(figure.debitRange)),
        creditTurnover: Number(fromScaled(figure.creditRange)),
        balance: Number(fromScaled(balance)),
        comparativeBalance: compYear ? Number(fromScaled(comparativeOf(figure))) : null,
      };
      const assignment = assignmentOf.get(figure.account);
      if (!assignment) {
        if (balance !== 0n || figure.debitRange !== 0n || figure.creditRange !== 0n) unassigned.push(row);
        continue;
      }
      const sign = assignment.inverted ? -1 : 1;
      const presented: StatementAccountRow = {
        ...row,
        balance: row.balance * sign,
        comparativeBalance: row.comparativeBalance === null ? null : row.comparativeBalance * sign,
      };
      accountsByNode.set(assignment.node, [...(accountsByNode.get(assignment.node) ?? []), presented]);
    }
    if (unassigned.length > 0) {
      warnings.push(`${unassigned.length} account(s) with balances stand outside every FSV assignment and are listed below the statement.`);
    }

    // Roll the hierarchy up, depth-first in configured order.
    const childrenOf = new Map<string, typeof nodes>();
    for (const node of nodes) {
      if (node.parent_node) childrenOf.set(node.parent_node, [...(childrenOf.get(node.parent_node) ?? []), node]);
    }
    const ownTotals = (node: string) => {
      const accounts = accountsByNode.get(node) ?? [];
      return {
        balance: accounts.reduce((sum, a) => sum + a.balance, 0),
        debit: accounts.reduce((sum, a) => sum + a.debitTurnover, 0),
        credit: accounts.reduce((sum, a) => sum + a.creditTurnover, 0),
        comparative: accounts.some((a) => a.comparativeBalance !== null)
          ? accounts.reduce((sum, a) => sum + (a.comparativeBalance ?? 0), 0) : null,
      };
    };
    const flat: StatementNodeRow[] = [];
    const visit = (node: (typeof nodes)[number], depth: number): { balance: number; debit: number; credit: number; comparative: number | null } => {
      const own = ownTotals(node.node);
      const row: StatementNodeRow = {
        node: node.node, description: node.description, depth,
        balance: own.balance, debitTurnover: own.debit, creditTurnover: own.credit,
        comparativeBalance: own.comparative, variance: null, variancePercent: null,
        accounts: accountsByNode.get(node.node) ?? [],
      };
      flat.push(row);
      let comparative: number | null = own.comparative;
      for (const child of childrenOf.get(node.node) ?? []) {
        const totals = visit(child, depth + 1);
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
      return { balance: row.balance, debit: row.debitTurnover, credit: row.creditTurnover, comparative: row.comparativeBalance };
    };
    for (const root of nodes.filter((n) => !n.parent_node)) visit(root, 0);

    // Optional output-currency conversion (ratio-aware rates).
    let currency = companyCurrency;
    let conversionMissing = false;
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
        for (const node of flat) {
          node.balance = scale(node.balance);
          node.debitTurnover = scale(node.debitTurnover);
          node.creditTurnover = scale(node.creditTurnover);
          if (node.comparativeBalance !== null) node.comparativeBalance = scale(node.comparativeBalance);
          if (node.variance !== null) node.variance = scale(node.variance);
          for (const account of node.accounts) {
            account.balance = scale(account.balance);
            account.debitTurnover = scale(account.debitTurnover);
            account.creditTurnover = scale(account.creditTurnover);
            if (account.comparativeBalance !== null) account.comparativeBalance = scale(account.comparativeBalance);
          }
        }
        for (const account of unassigned) {
          account.balance = scale(account.balance);
          account.debitTurnover = scale(account.debitTurnover);
          account.creditTurnover = scale(account.creditTurnover);
        }
      }
    }

    return {
      companyCode: s.companyCode, chartOfAccounts: chart, statementVersion: s.statementVersion,
      fiscalYear: s.fiscalYear, periodFrom: s.periodFrom, periodTo: effectiveTo,
      comparisonFiscalYear: compYear ?? null, currency, conversionMissing,
      nodes: flat, warnings, unassigned,
      totalDebitTurnover: Number(fromScaled(totalDebit)), totalCreditTurnover: Number(fromScaled(totalCredit)),
      calculatedAt,
    };
  });
}

export async function listStatementVersions(client: string): Promise<Array<{ version: string; name: string; chartOfAccounts: string }>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select version, name, chart_of_accounts from financial_statement_version
      where client = ${client} and is_active = true order by version
    `);
    return (rows as unknown as Array<{ version: string; name: string; chart_of_accounts: string }>).map((r) => ({
      version: r.version, name: r.name, chartOfAccounts: r.chart_of_accounts,
    }));
  });
}
