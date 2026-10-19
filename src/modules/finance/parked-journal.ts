/**
 * Parked journal entries — SCR-087 / R-135.
 *
 * Parking stores a preliminary G/L document in staging tables
 * without touching posted balances: a parked document may stand
 * incomplete and unbalanced, while save-as-complete is a judged
 * transition (every line complete, accounts standing, debits
 * equal credits) and final posting revalidates everything through
 * the posting engine in one transaction. The parked record is
 * retained after posting as an immutable reference naming the
 * canonical document; deletion is a logical status with a
 * mandatory reason, never a physical delete. Edits are
 * version-checked, and any edit returns a completed document to
 * PARKED for re-judging.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-135.
 */
export const PARKED_JOURNAL_CAPABILITY = 'FIN.JOURNAL.PARK';

export class ParkedJournalError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ParkedJournalError';
    this.remedy = remedy;
  }
}

export type ParkedStatus = 'PARKED' | 'COMPLETED' | 'POSTED' | 'DELETED';

export interface ParkedLineView {
  lineNumber: number;
  glAccount: string;
  debitCredit: 'S' | 'H';
  amount: number;
  costCenter: string | null;
  profitCenter: string | null;
  taxCode: string | null;
  assignment: string | null;
  lineText: string | null;
}

export interface ParkedJournalView {
  parkedNumber: string;
  fiscalYear: number;
  companyCode: string;
  documentType: string;
  documentDate: string;
  postingDate: string;
  currency: string;
  reference: string | null;
  headerText: string | null;
  status: ParkedStatus;
  version: number;
  parkedBy: string;
  postedDocumentNumber: string | null;
  totalDebit: number;
  totalCredit: number;
  balance: number;
  lines: ParkedLineView[];
}
