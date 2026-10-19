/**
 * Profit centre: actual line items (SCR-113 /
 * FIN.RPT.PROFITCENTER; KE5Z search alias).
 *
 * The journal is the universal-journal equivalent (§14.1):
 * actuals are the POSTED journal lines carrying a profit
 * centre, exactly as recorded at posting — never re-derived
 * from current master data. No classic PCA tables stand and
 * none are added; no report-specific posting tables.
 *
 * Selection per the owner package: controlling area,
 * profit centre single/range/group (groups resolve through
 * ranged leaves), fiscal year, period range, G/L account
 * range, ledger (canon carries the one leading ledger `0L`;
 * any other ledger is refused by name), optional document
 * number range, and a server-side maximum-hits limit whose
 * truncation is always indicated. Totals stand by profit
 * centre, G/L account and currency, document-currency and
 * local totals kept separate. Read-only; closed periods
 * never suppress history.
 *
 * Deferred by name: partner profit centre (not recorded on
 * canon lines), G/L account groups (ranges only), KE5Y plan
 * line items, interactive sorting/filtering, and direct
 * operational-document navigation beyond the journal
 * display's origin reference.
 *
 * Stage 1 carries the vocabulary only; the index check
 * lands in stage 2 and the line-item service in stage 3.
 */
export const PROFIT_CENTER_REPORT_CAPABILITY = 'FIN.RPT.PROFITCENTER';
export const LEADING_LEDGER = '0L';
export const DEFAULT_MAX_HITS = 5000;
export const MAX_HITS_CAP = 50000;

export interface ProfitCenterReportSelection {
  controllingArea: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  ledger: string;
  profitCenterFrom?: string;
  profitCenterTo?: string;
  profitCenterGroup?: string;
  glAccountFrom?: string;
  glAccountTo?: string;
  documentFrom?: string;
  documentTo?: string;
  maxHits: number;
}

export interface ProfitCenterLine {
  companyCode: string;
  documentNumber: string;
  displayNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  documentDate: string;
  documentType: string;
  ledger: string;
  profitCenter: string;
  profitCenterName: string;
  glAccount: string;
  debitCredit: string;
  documentCurrency: string;
  /** Signed by the debit/credit indicator (debit positive). */
  amountDocument: number;
  localCurrency: string;
  amountLocal: number;
  assignment: string;
  reference: string;
  lineText: string;
  costCenter: string;
  internalOrder: string;
  productionOrder: string;
  businessPartner: string;
  material: string;
  plant: string;
  originClass: string;
  originKey: string;
}

export interface ProfitCenterTotal {
  profitCenter: string;
  glAccount: string;
  documentCurrency: string;
  amountDocument: number;
  localCurrency: string;
  amountLocal: number;
}

export interface ProfitCenterReportResult {
  controllingArea: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  ledger: string;
  lines: ProfitCenterLine[];
  totals: ProfitCenterTotal[];
  /** True when the hit limit cut the result; never silent. */
  truncated: boolean;
  maxHits: number;
  /** Centres excluded because no validity stands in the area or year. */
  excludedCenters: string[];
  warnings: string[];
  calculatedAt: string;
}
