/**
 * G/L line item report — SCR-088 / R-136.
 *
 * A strictly read-only inquiry over the canonical journal: the
 * tenant comes from the session, never from the client; amounts
 * display as stored in document and local currency; subtotals
 * never combine unlike currencies; the hit cap stands enforced
 * server-side with an explicit truncation signal. Open/cleared is
 * judged from the line's clearing document, and only for accounts
 * standing open-item-managed — other lines carry no status.
 * Closed periods remain displayable: period locks govern posting,
 * not inquiry. Reading mutates nothing.
 *
 * Stage 1 carries the vocabulary only; the query lands in stage 3.
 */
export const JOURNAL_ITEMS_CAPABILITY = 'FIN.JOURNAL.LIST';

export class JournalItemsError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'JournalItemsError';
    this.remedy = remedy;
  }
}

export type LineItemStatusFilter = 'ALL' | 'OPEN' | 'CLEARED';

export interface JournalItemFilters {
  accountFrom: string;
  accountTo?: string;
  companyCodes: string[];
  fiscalYear?: number;
  postingDateFrom?: string;
  postingDateTo?: string;
  documentDateFrom?: string;
  documentDateTo?: string;
  documentNumber?: string;
  documentType?: string;
  status: LineItemStatusFilter;
  profitCenter?: string;
  costCenter?: string;
  reference?: string;
  maxHits?: number;
}

export interface JournalItemRow {
  companyCode: string;
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  documentDate: string;
  documentType: string;
  documentStatus: string;
  glAccount: string;
  debitCredit: 'S' | 'H';
  amountDocument: number;
  currency: string;
  amountLocal: number;
  localCurrency: string;
  costCenter: string | null;
  profitCenter: string | null;
  taxCode: string | null;
  lineText: string | null;
  businessPartner: string | null;
  reference: string | null;
  clearingDocument: string | null;
  clearingDate: string | null;
  /** OPEN | CLEARED on open-item-managed accounts; null otherwise. */
  itemStatus: 'OPEN' | 'CLEARED' | null;
}

export interface JournalItemSubtotal {
  companyCode: string;
  glAccount: string;
  currency: string;
  localCurrency: string;
  debitDocument: number;
  creditDocument: number;
  debitLocal: number;
  creditLocal: number;
}

export interface JournalItemsResult {
  rows: JournalItemRow[];
  subtotals: JournalItemSubtotal[];
  truncated: boolean;
  cap: number;
}
