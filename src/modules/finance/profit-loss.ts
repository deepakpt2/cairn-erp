/**
 * Profit and loss statement (SCR-111 / FIN.RPT.PROFITLOSS;
 * S_PL0_86000028 as a search alias only). A P&L-only statement
 * over the SCR-106/107 canon: the same FSV configuration and
 * posted-journal snapshot, restricted to profit-and-loss
 * accounts with balance-sheet-only subtrees dropped and node
 * totals re-rolled from the kept accounts. Every row carries
 * the movement strictly inside the selected range and the
 * cumulative year-to-date movement through the cutoff, with
 * independent comparatives. Calculation lands in stage 3.
 */
import type { BalanceSheetSelection } from './balance-sheet';

export const PROFIT_LOSS_CAPABILITY = 'FIN.RPT.PROFITLOSS';

export type ProfitLossSelection = BalanceSheetSelection;

export interface ProfitLossAccountRow {
  accountNumber: string;
  accountName: string;
  debitTurnover: number;
  creditTurnover: number;
  /** Movement strictly inside the selected range, presented. */
  periodMovement: number;
  /** Cumulative movement through the cutoff, presented. */
  yearToDateMovement: number;
  comparativeMovement: number | null;
  comparativeYearToDate: number | null;
}

export interface ProfitLossNodeRow {
  node: string;
  description: string;
  depth: number;
  periodMovement: number;
  yearToDateMovement: number;
  comparativeMovement: number | null;
  variance: number | null;
  variancePercent: number | null;
  accounts: ProfitLossAccountRow[];
}

export interface ProfitLossResult {
  companyCode: string;
  chartOfAccounts: string;
  statementVersion: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  comparisonFiscalYear: number | null;
  currency: string;
  conversionMissing: boolean;
  summaryLevel: number;
  ledger: string;
  currentYearResult: number | null;
  nodes: ProfitLossNodeRow[];
  warnings: string[];
  unassigned: ProfitLossAccountRow[];
  calculatedAt: string;
}


import { calculateBalanceSheet, type BalanceSheetAccountRow } from './balance-sheet';
import { TrialBalanceError } from './trial-balance';

function mapAccount(a: BalanceSheetAccountRow): ProfitLossAccountRow {
  return {
    accountNumber: a.accountNumber, accountName: a.accountName,
    debitTurnover: a.debitTurnover, creditTurnover: a.creditTurnover,
    periodMovement: a.balance,
    yearToDateMovement: a.yearToDateMovement,
    comparativeMovement: a.comparativeBalance,
    comparativeYearToDate: a.comparativeYearToDate,
  };
}

/**
 * The P&L-only view of the combined statement: one snapshot
 * (calculateBalanceSheet under COMBINED), then balance-sheet
 * accounts are removed and every kept node's totals are
 * re-rolled from its kept accounts — a node survives when it
 * or any descendant carries a P&L account. Range movement and
 * year-to-date movement stay side by side; comparatives were
 * computed independently by the same engine.
 */
export async function calculateProfitLoss(input: {
  client: string; selection: ProfitLossSelection;
}): Promise<ProfitLossResult> {
  const bs = await calculateBalanceSheet({
    client: input.client,
    selection: { ...input.selection, calculationType: 'COMBINED' },
  });

  // A node survives when its subtree keeps at least one P&L account.
  const ownPl = bs.nodes.map((n) => n.accounts.some((a) => !a.isBalanceSheet));
  const keep = new Array<boolean>(bs.nodes.length).fill(false);
  for (let i = bs.nodes.length - 1; i >= 0; i -= 1) {
    let survives = ownPl[i] ?? false;
    for (let j = i + 1; j < bs.nodes.length; j += 1) {
      if (bs.nodes[j]!.depth <= bs.nodes[i]!.depth) break;
      if (bs.nodes[j]!.depth === bs.nodes[i]!.depth + 1 && keep[j]) survives = true;
    }
    keep[i] = survives;
  }

  const nodes: ProfitLossNodeRow[] = [];
  bs.nodes.forEach((node, i) => {
    if (!keep[i]) return;
    const accounts = node.accounts.filter((a) => !a.isBalanceSheet).map(mapAccount);
    nodes.push({
      node: node.node, description: node.description, depth: node.depth,
      periodMovement: 0, yearToDateMovement: 0, comparativeMovement: null,
      variance: null, variancePercent: null, accounts,
    });
  });
  // Re-roll bottom-up over the kept flat list (DFS order, depth-marked).
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const row = nodes[i]!;
    row.periodMovement = row.accounts.reduce((sum, a) => sum + a.periodMovement, 0);
    row.yearToDateMovement = row.accounts.reduce((sum, a) => sum + a.yearToDateMovement, 0);
    let comparative: number | null = row.accounts.some((a) => a.comparativeMovement !== null)
      ? row.accounts.reduce((sum, a) => sum + (a.comparativeMovement ?? 0), 0) : null;
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (nodes[j]!.depth <= row.depth) break;
      if (nodes[j]!.depth === row.depth + 1) {
        const child = nodes[j]!;
        row.periodMovement += child.periodMovement;
        row.yearToDateMovement += child.yearToDateMovement;
        if (child.comparativeMovement !== null) comparative = (comparative ?? 0) + child.comparativeMovement;
      }
    }
    row.comparativeMovement = bs.comparisonFiscalYear ? comparative : null;
    if (row.comparativeMovement !== null) {
      row.variance = row.periodMovement - row.comparativeMovement;
      row.variancePercent = row.comparativeMovement === 0 ? null : row.variance / Math.abs(row.comparativeMovement) * 100;
    }
  }

  const unassigned = bs.unassigned.filter((a) => !a.isBalanceSheet).map(mapAccount);
  const warnings = bs.warnings.filter((w) => !w.includes('outside every FSV assignment'));
  if (unassigned.length > 0) {
    warnings.push(`${unassigned.length} P&L account(s) with balances stand outside every FSV assignment and are listed below the statement.`);
  }

  return {
    companyCode: bs.companyCode, chartOfAccounts: bs.chartOfAccounts,
    statementVersion: bs.statementVersion, fiscalYear: bs.fiscalYear,
    periodFrom: bs.periodFrom, periodTo: bs.periodTo,
    comparisonFiscalYear: bs.comparisonFiscalYear, currency: bs.currency,
    conversionMissing: bs.conversionMissing, summaryLevel: bs.summaryLevel,
    ledger: bs.ledger, currentYearResult: bs.currentYearResult,
    nodes, warnings, unassigned, calculatedAt: bs.calculatedAt,
  };
}

export { TrialBalanceError };
