/**
 * Asset acquisition with automatic offsetting — SCR-092 / R-140
 * (ABZON as a search alias only).
 *
 * A vendor-less acquisition posted only through the canonical
 * posting engine: debit the asset class's configured
 * reconciliation account, credit the entered offsetting account,
 * and record the asset transaction as a value record linked to
 * the accounting document — never a second ledger. Simulation
 * runs the identical judges and persists nothing. Posting is
 * request-key idempotent under the asset's locks, and reversal
 * is asset-aware, flipping the value record with its journal.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-140.
 */
export const ASSET_ACQUIRE_CAPABILITY = 'FIN.ASSET.ACQUIRE';

export class AssetAcquisitionError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AssetAcquisitionError';
    this.remedy = remedy;
  }
}

export interface AcquisitionInputView {
  companyCode: string;
  assetNumber: string;
  subNumber: string;
  documentDate: string;
  postingDate: string;
  assetValueDate: string;
  documentType: string;
  currency: string;
  amount: number;
  offsetAccount: string;
  transactionType: string;
  text?: string;
  reference?: string;
}

export interface AcquisitionPreview {
  assetDescription: string;
  assetClass: string;
  reconAccount: string;
  offsetAccount: string;
  debitAmount: number;
  creditAmount: number;
  currency: string;
  localCurrency: string;
  localAmount: number;
  capitalizationDate: string;
  warnings: string[];
}

export interface AcquisitionResult {
  documentNumber: string;
  fiscalYear: number;
  assetNumber: string;
  subNumber: string;
  amount: number;
  currency: string;
  totalAcquiredValue: number;
}
