/**
 * Asset history sheet — SCR-095 / R-143
 * (S_ALR_87011990 as a search alias only).
 *
 * A read-only aggregation over the canonical value records:
 * ACTIVE acquisitions and retirements by asset value date, and
 * posted depreciation per asset, area and period. Beginning
 * balances are the movements before the fiscal year, current-year
 * movements run to the reporting date, and REVERSED records never
 * count. No balance table stands behind this sheet and running it
 * writes nothing.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-143.
 */
export const ASSET_REPORT_CAPABILITY = 'FIN.ASSET.REPORT';

export class AssetHistoryError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AssetHistoryError';
    this.remedy = remedy;
  }
}

export interface AssetHistorySelection {
  companyCodeFrom: string;
  companyCodeTo?: string;
  assetClassFrom?: string;
  assetClassTo?: string;
  assetNumberFrom?: string;
  assetNumberTo?: string;
  subNumberFrom?: string;
  subNumberTo?: string;
  fiscalYear: number;
  depreciationArea: string;
  reportingDate?: string;
  sortVersion?: string;
  layout?: string;
  page?: number;
  pageSize?: number;
}

export interface AssetHistoryRow {
  companyCode: string;
  assetClass: string;
  assetNumber: string;
  subNumber: string;
  description: string;
  status: string;
  capitalizationDate: string | null;
  currency: string;
  acquisitionBeginning: number;
  acquisitions: number;
  transfersIn: number;
  transfersOut: number;
  retirements: number;
  otherMovements: number;
  acquisitionEnding: number;
  depreciationBeginning: number;
  depreciationYear: number;
  depreciationOnRetirements: number;
  depreciationAdjustments: number;
  depreciationEnding: number;
  netBookValue: number;
}

export interface AssetHistoryTotals {
  assetClass: string | null;
  currency: string;
  acquisitionBeginning: number;
  acquisitions: number;
  retirements: number;
  acquisitionEnding: number;
  depreciationBeginning: number;
  depreciationYear: number;
  depreciationOnRetirements: number;
  depreciationEnding: number;
  netBookValue: number;
}

export interface AssetHistorySheet {
  fiscalYear: number;
  depreciationArea: string;
  reportingDate: string;
  rows: AssetHistoryRow[];
  classTotals: AssetHistoryTotals[];
  grandTotals: AssetHistoryTotals[];
  totalRows: number;
  page: number;
  pageSize: number;
  warnings: string[];
}
