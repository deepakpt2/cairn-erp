/**
 * Depreciation run — SCR-094 / R-142 (AFAB as a search alias only).
 *
 * The run calculates depreciation per asset and depreciation area
 * from standing configuration — depreciable base (ACTIVE
 * acquisitions less ACTIVE retirements), depreciation key method,
 * useful life, start date — and posts it through the canonical
 * engine: debit the class depreciation-expense account, credit the
 * class accumulated-depreciation account. Posted amounts stand in
 * `asset_depreciation_posting`, the value record the retirement
 * reversal (SCR-093) reads; the journal stays the financial
 * authority. A test run persists only its execution log.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-142.
 */
export const ASSET_DEPRECIATE_CAPABILITY = 'FIN.ASSET.DEPRECIATE';

export class AssetDepreciationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AssetDepreciationError';
    this.remedy = remedy;
  }
}

/** 1 Planned · 2 Repeat · 3 Restart · 4 Unplanned (refused this round). */
export type DepreciationRunType = '1' | '2' | '3' | '4';

export type DepreciationRunStatus =
  | 'SIMULATED' | 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'FAILED';

export type DepreciationItemStatus = 'CALCULATED' | 'POSTED' | 'SKIPPED' | 'FAILED';

export interface DepreciationRunInputView {
  companyCode: string;
  fiscalYear: number;
  postingPeriod: number;
  runType: DepreciationRunType;
  testRun: boolean;
  documentType: string;
  postingDate: string;
  restartOfRunId?: string;
}

export interface DepreciationRunItemView {
  assetNumber: string;
  subNumber: string;
  areaCode: string;
  depreciationKey: string;
  calculatedAmount: number;
  previouslyPostedAmount: number;
  adjustmentAmount: number;
  currency: string;
  expenseAccount: string | null;
  accumAccount: string | null;
  costCenter: string | null;
  status: DepreciationItemStatus;
  documentNumber: string | null;
  message: string | null;
}

export interface DepreciationRunResult {
  runId: string;
  status: DepreciationRunStatus;
  testRun: boolean;
  totalCalculated: number;
  totalPosted: number;
  currency: string;
  documentNumber: string | null;
  items: DepreciationRunItemView[];
  warnings: string[];
}
