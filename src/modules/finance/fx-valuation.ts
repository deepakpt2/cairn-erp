/**
 * Foreign currency valuation — SCR-098 / R-146 (FAGL_FC_VAL as a
 * search alias only).
 *
 * Stage 1 vocabulary. The valuation service lands in stage 3.
 */
export const FX_VALUATION_CAPABILITY = 'FIN.FX.VALUATE';

export class FxValuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FxValuationError';
  }
}

export const FX_RATE_TYPES = ['AVERAGE', 'BUYING', 'SELLING'] as const;
export type FxRateType = (typeof FX_RATE_TYPES)[number];

export interface FxValuationSelection {
  companyCode: string;
  valuationArea: string;
  valuationKeyDate: string;
  postingDate: string;
  fiscalYear: number;
  valuationMethod: FxRateType;
  includeOpenItems: boolean;
  includeBalances: boolean;
  testRun: boolean;
  documentType: string;
  reversalDate?: string;
  requestKey: string;
}

export type FxItemStatus = 'CALCULATED' | 'POSTED' | 'SKIPPED' | 'ERROR';

export interface FxValuationItem {
  itemNumber: number;
  sourceKind: 'OPEN_ITEM' | 'BALANCE';
  accountNumber: string;
  sourceDocument: string | null;
  sourceLine: number | null;
  currency: string;
  foreignAmount: number;
  carryingAmount: number;
  valuationRate: number | null;
  rateType: string;
  requiredAmount: number | null;
  adjustmentAmount: number | null;
  classification: 'GAIN' | 'LOSS' | 'NONE' | null;
  status: FxItemStatus;
  error: string | null;
  postingDocument: string | null;
}

export interface FxValuationResult {
  runId: string;
  status: 'TEST' | 'COMPLETED' | 'REVERSED';
  companyCode: string;
  valuationArea: string;
  valuationKeyDate: string;
  postingDate: string;
  fiscalYear: number;
  valuationMethod: string;
  currency: string;
  items: FxValuationItem[];
  totalGain: number;
  totalLoss: number;
  postingDocument: string | null;
  reversalDocument: string | null;
  warnings: string[];
}
