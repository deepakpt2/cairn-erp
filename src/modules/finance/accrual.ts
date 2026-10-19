/**
 * Accrual/deferral documents — SCR-100 / R-148 (FBS1 entry and
 * F.81 reversal processing as search aliases only).
 *
 * Stage 1 vocabulary. The posting and reversal services land in
 * stage 3.
 */
export const ACCRUAL_CAPABILITY = 'FIN.ACCRUAL.POST';

export class AccrualError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AccrualError';
    this.remedy = remedy;
  }
}

export interface AccrualLineInput {
  glAccount: string;
  debitCredit: 'S' | 'H';
  amount: string;
  costCenter?: string;
  profitCenter?: string;
  assignment?: string;
  lineText?: string;
}

export interface AccrualDocumentView {
  companyCode: string;
  documentNumber: string;
  displayNumber: string;
  fiscalYear: number;
  documentType: string;
  documentDate: string;
  postingDate: string;
  currency: string;
  reference: string | null;
  headerText: string | null;
  reversalDate: string;
  reversalReason: string;
  reversalStatus: 'PENDING' | 'REVERSED';
  reversalDocumentNumber: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  journalStatus: string;
  totalAmount: number;
}
