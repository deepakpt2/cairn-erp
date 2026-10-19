/**
 * Advance return for tax on sales/purchases — SCR-097 / R-145
 * (S_ALR_87012357 as a search alias only).
 *
 * Stage 1 vocabulary. The extraction service lands in stage 3.
 */
export const TAX_REPORT_CAPABILITY = 'FIN.TAX.REPORT';

export class TaxReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxReportError';
  }
}

export interface TaxReportSelection {
  companyCode: string;
  taxGroup?: string;
  postingDateFrom: string;
  postingDateTo: string;
  taxReturnCountry: string;
  testRun: boolean;
  doNotUpdateDocuments: boolean;
  electronicReturn: boolean;
  correctedReturn: boolean;
  clearingAccount?: string;
}

export interface TaxReportLine {
  taxCode: string;
  accountKey: string | null;
  ratePercent: number;
  /** Derived from the standing rate where above zero; null when not derivable. */
  taxBase: number | null;
  inputTax: number;
  outputTax: number;
  currency: string;
  documentCount: number;
  alreadyReported: number;
}

export interface TaxReportResult {
  companies: string[];
  postingDateFrom: string;
  postingDateTo: string;
  taxReturnCountry: string;
  lines: TaxReportLine[];
  totalBase: number;
  totalInputTax: number;
  totalOutputTax: number;
  /** Output over input: positive is payable, negative receivable. */
  netTax: number;
  currency: string;
  warnings: string[];
  runId: string | null;
  transferDocumentNumber: string | null;
}
