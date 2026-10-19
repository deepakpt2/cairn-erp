/**
 * Clear G/L account — manual clearing (SCR-114 / FIN.GL.CLEAR;
 * F-03 search alias).
 *
 * Open items of an open-item-managed G/L account clear against
 * each other when their signed sum stands at zero. Following
 * the FIN.AR.CLEAR house pattern: one clearing journal posted
 * through the standing posting engine carries the audit trail;
 * the cleared lines are stamped in place with the clearing
 * document and clearing date. A posted clearing is history —
 * reset rides the standing FBRA workflow, never an edit.
 *
 * The account must stand extended to the company and stand
 * open-item managed, judged segment-first with the chart flag
 * as fallback (SCR-110 settlement). The clearing document
 * type is operator-selected and validated against configured
 * document types — never a universal hardcoded type.
 * Tolerance-based difference posting and partial/residual
 * clearing are deferred by name; a difference is never
 * silently discarded.
 *
 * Stage 1 carries the vocabulary only; the schema/index
 * check lands in stage 2 and the clearing service in stage 3.
 */
export const GL_CLEARING_CAPABILITY = 'FIN.GL.CLEAR';

export class GlClearingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'GlClearingError';
    this.remedy = remedy;
  }
}

export interface GlClearingItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  documentType: string;
  assignment: string;
  reference: string;
  debitCredit: string;
  currency: string;
  amount: string;
  /** Local-currency amount signed by debit/credit (debit positive). */
  signed: number;
  clearingDocument: string | null;
  clearingDate: string | null;
}

export interface GlClearingView {
  companyCode: string;
  glAccount: string;
  accountCurrency: string;
  openItems: GlClearingItem[];
  clearedItems: GlClearingItem[];
  openBalance: number;
}

export interface GlClearingFilters {
  documentNumber?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  assignment?: string;
  reference?: string;
}
