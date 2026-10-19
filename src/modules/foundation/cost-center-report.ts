/**
 * Cost centers: actual / plan / variance (SCR-112 /
 * FIN.RPT.COSTCENTER.ACTUAL; S_ALR_87013611 primary alias,
 * S_ALR_87013614 and KSB1N as further search aliases).
 *
 * Actuals are the journal lines carrying a cost centre (cost
 * element = the posted G/L account; primary cost elements are
 * the only posting source in canon). Plan values read the
 * cost_center_plan table the same round builds; a missing plan
 * is null, never a dressed-up zero. Variance = actual − plan;
 * favorable/unfavorable judges by the element's account type
 * (EXPENSE over plan unfavorable, REVENUE over plan favorable).
 * Range totals and year-to-date totals stand as distinct
 * measures. Read-only; closed periods report normally.
 *
 * Stage 1 carries the vocabulary only; plan schema lands in
 * stage 2 and the report service in stage 3.
 */
export const COST_CENTER_REPORT_CAPABILITY = 'FIN.RPT.COSTCENTER.ACTUAL';
export const DEFAULT_PLAN_VERSION = '000';

export interface CostCenterReportSelection {
  controllingArea: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  planVersion: string;
  costCenterFrom?: string;
  costCenterTo?: string;
  costCenterGroup?: string;
  costElementFrom?: string;
  costElementTo?: string;
}

export type VarianceStatus = 'FAVORABLE' | 'UNFAVORABLE' | 'ON_PLAN';

export interface CostCenterReportRow {
  kind: 'GROUP' | 'CENTER' | 'ELEMENT';
  key: string;
  label: string;
  depth: number;
  costCenter?: string;
  costElement?: string;
  actual: number;
  /** Null when no plan row stands — missing is never a zero. */
  plan: number | null;
  variance: number | null;
  variancePercent: number | null;
  status: VarianceStatus | null;
  actualYtd: number;
  planYtd: number | null;
}

export interface CostCenterActivityPlan {
  costCenter: string;
  activityType: string;
  plannedQuantity: number;
  fixedPrice: number;
  variablePrice: number;
  priceUnit: number;
}

export interface CostCenterReportResult {
  controllingArea: string;
  currency: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  planVersion: string;
  rows: CostCenterReportRow[];
  activities: CostCenterActivityPlan[];
  /** Centres excluded because no validity covers a reported period. */
  excludedCenters: string[];
  warnings: string[];
  calculatedAt: string;
}
