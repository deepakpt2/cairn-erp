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
