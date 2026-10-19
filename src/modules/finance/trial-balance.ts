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
