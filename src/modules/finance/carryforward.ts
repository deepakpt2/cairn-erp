/**
 * G/L balance carryforward (SCR-102 / FIN.CLOSE.CARRYFORWARD,
 * F.16/FAGLGVTR).
 *
 * Balances derive from the posted journal at read time, so the
 * carryforward records balance-sheet openings in its result rows
 * (no duplicate balance table) and closes P&L accounts with a
 * real judged transfer document into the source year against the
 * determined retained earnings account. Because the transfer
 * lands inside the source-year totals, repeat runs post only the
 * still-untransferred delta — late adjustments included — and a
 * test run changes nothing. The carryforward never closes the
 * prior year and never locks a period.
 */

export const CARRYFORWARD_CAPABILITY = 'FIN.CLOSE.CARRYFORWARD';

/** The delivered ledger vocabulary; multi-ledger is deferred. */
export const CLOSE_LEDGERS = ['0L'] as const;
export const DEFAULT_LEDGER = '0L';

export const RUN_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED'] as const;
export type CarryforwardRunStatus = (typeof RUN_STATUSES)[number];

export const RESULT_STATUSES = ['CARRIED', 'TRANSFERRED', 'EXCEPTION'] as const;
export type CarryforwardResultStatus = (typeof RESULT_STATUSES)[number];

export interface CarryforwardSelection {
  ledger: string;
  companyCodes: string[];
  targetFiscalYear: number;
  testRun: boolean;
}

export interface CarryforwardRunView {
  runId: string;
  ledger: string;
  sourceFiscalYear: number;
  targetFiscalYear: number;
  companyCodes: string[];
  testRun: boolean;
  status: CarryforwardRunStatus;
  accountsProcessed: number;
  balancesCarried: number;
  plTransferred: number;
  errors: number;
  transferDocuments: string[];
  executedBy: string;
  startedAt: string;
  endedAt: string | null;
}

export interface CarryforwardResultView {
  companyCode: string;
  accountNumber: string;
  accountCategory: 'BALANCE_SHEET' | 'PL_STATEMENT';
  profitCenter: string | null;
  currency: string;
  sourceClosingBalance: number;
  targetOpeningBalance: number;
  retainedEarningsAccount: string | null;
  transferDocumentNumber: string | null;
  status: CarryforwardResultStatus;
  detail: string | null;
}

export class CarryforwardError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CarryforwardError';
    this.remedy = remedy;
  }
}
