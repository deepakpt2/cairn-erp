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
