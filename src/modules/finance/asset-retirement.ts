/**
 * Asset retirement by scrapping — SCR-093 / R-141
 * (ABAVN as a search alias only).
 *
 * A retirement without proceeds posted only through the canonical
 * posting engine: credit the asset class's reconciliation account
 * with the retired acquisition value, debit accumulated
 * depreciation for its proportional share and the retirement loss
 * account with the remaining net book value. The retirement stands
 * as a value record linked to the accounting document — never a
 * second ledger — and asset values always derive from ACTIVE
 * acquisition and retirement records. Simulation runs the
 * identical judges and persists nothing; posting is request-key
 * idempotent under the asset's locks; reversal is asset-aware and
 * restores eligibility.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-141.
 */
export const ASSET_RETIRE_CAPABILITY = 'FIN.ASSET.RETIRE';

export class AssetRetirementError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AssetRetirementError';
    this.remedy = remedy;
  }
}

export type RetirementScope = 'COMPLETE' | 'PERCENT' | 'AMOUNT';

export interface RetirementInputView {
  companyCode: string;
  assetNumber: string;
  subNumber: string;
  documentDate: string;
  postingDate: string;
  assetValueDate: string;
  documentType: string;
  currency: string;
  transactionType: string;
  scope: RetirementScope;
  /** PERCENT scope: percentage of the remaining retireable acquisition value. */
  retirementPercent?: number;
  /** AMOUNT scope: acquisition value to retire (never net book value). */
  retirementAmount?: number;
  text?: string;
  reference?: string;
}

export interface RetirementPreview {
  assetDescription: string;
  assetClass: string;
  reconAccount: string;
  accumAccount: string;
  lossAccount: string;
  acquiredValue: number;
  alreadyRetiredValue: number;
  accumulatedDepreciation: number;
  scope: RetirementScope;
  retiredAcquisitionValue: number;
  depreciationReversed: number;
  lossAmount: number;
  remainingAcquisitionValue: number;
  remainingNetBookValue: number;
  currency: string;
  warnings: string[];
}

export interface RetirementResult {
  documentNumber: string;
  fiscalYear: number;
  assetNumber: string;
  subNumber: string;
  scope: RetirementScope;
  retiredAcquisitionValue: number;
  depreciationReversed: number;
  lossAmount: number;
  remainingAcquisitionValue: number;
  currency: string;
}
