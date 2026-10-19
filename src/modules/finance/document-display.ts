/**
 * Accounting document display with flow — SCR-090 / R-138.
 *
 * A faithful, read-only window into the canonical posted
 * document: retrieved by its complete supplied key (number,
 * company, fiscal year — the year never derived or replaced),
 * lines in stable number order with every assignment, totals
 * judged independently per stored currency, and flow navigation
 * to the reversal chain, clearing documents and origin. Parked
 * documents are a distinct lifecycle and are answered as such,
 * never conflated with the ledger. Reading mutates nothing and
 * checks no posting period.
 *
 * Stage 1 carries the vocabulary only; retrieval lands in stage 3.
 */
export const DOCUMENT_FLOW_CAPABILITY = 'FIN.DOC.FLOW';

export class DocumentDisplayError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'DocumentDisplayError';
    this.remedy = remedy;
  }
}

export interface DocumentKeyInput {
  documentNumber: string;
  companyCode: string;
  fiscalYear: number;
}

export interface DocumentLineView {
  lineNumber: number;
  glAccount: string;
  debitCredit: 'S' | 'H';
  amountDocument: number;
  currency: string;
  amountLocal: number;
  costCenter: string | null;
  profitCenter: string | null;
  internalOrder: string | null;
  businessPartner: string | null;
  material: string | null;
  plant: string | null;
  taxCode: string | null;
  lineText: string | null;
  clearingDocument: string | null;
  clearingDate: string | null;
}

export interface DocumentFlowLink {
  kind: 'REVERSAL_OF' | 'REVERSED_BY' | 'ORIGIN' | 'CLEARING' | 'PREVIOUS' | 'NEXT';
  label: string;
  documentNumber: string | null;
  fiscalYear: number | null;
  href: string | null;
}

export interface DocumentHistoryEntry {
  changedAt: string;
  changedBy: string;
  changeType: string;
  reason: string | null;
}

export interface JournalDocumentView {
  documentNumber: string;
  displayNumber: string;
  fiscalYear: number;
  companyCode: string;
  documentType: string;
  documentDate: string;
  postingDate: string;
  postingPeriod: number;
  documentCurrency: string;
  localCurrency: string;
  exchangeRate: number;
  reference: string | null;
  headerText: string | null;
  status: string;
  originClass: string | null;
  originKey: string | null;
  postedBy: string;
  postedAt: string;
  lines: DocumentLineView[];
  debitDocument: number;
  creditDocument: number;
  debitLocal: number;
  creditLocal: number;
  flow: DocumentFlowLink[];
  history: DocumentHistoryEntry[];
}

export type DocumentLookup =
  | { kind: 'FOUND'; document: JournalDocumentView }
  | { kind: 'NOT_FOUND' }
  | { kind: 'PARKED'; parkedNumber: string };
