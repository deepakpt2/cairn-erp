/**
 * Fixed asset master — SCR-091 / R-139 (AS01 create, AS02 change).
 *
 * Master data only: creating or changing an asset posts nothing,
 * retires nothing and depreciates nothing. Identity stands under
 * the complete key (tenant, company, main number, sub-number);
 * assignments are effective-dated intervals whose history is
 * never rewritten; depreciation parameters stand per configured
 * area with useful life as years and periods apart. Changes are
 * version-checked, identity and asset class immutable, and every
 * write lands on the standing change-document audit.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-139.
 */
export const ASSET_CREATE_CAPABILITY = 'FIN.ASSET.CREATE';
export const ASSET_CHANGE_CAPABILITY = 'FIN.ASSET.CHANGE';

export class AssetMasterError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AssetMasterError';
    this.remedy = remedy;
  }
}

export interface AssetAssignmentView {
  validFrom: string;
  validTo: string | null;
  costCenter: string | null;
  profitCenter: string | null;
  plant: string | null;
  location: string | null;
}

export interface AssetDepreciationView {
  areaCode: string;
  depreciationKey: string;
  usefulLifeYears: number;
  usefulLifePeriods: number;
  depreciationStartDate: string | null;
}

export interface AssetView {
  companyCode: string;
  assetNumber: string;
  subNumber: string;
  assetClass: string;
  description1: string;
  description2: string | null;
  inventoryNumber: string | null;
  serialNumber: string | null;
  quantity: number | null;
  unitOfMeasure: string | null;
  capitalizationDate: string | null;
  deactivationDate: string | null;
  status: 'ACTIVE' | 'DEACTIVATED';
  version: number;
  assignments: AssetAssignmentView[];
  depreciation: AssetDepreciationView[];
}
