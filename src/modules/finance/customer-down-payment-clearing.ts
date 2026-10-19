/**
 * Customer down payment clearing — SCR-084 / R-132.
 *
 * Applies standing customer down payments (F-29) to open customer
 * invoices by a real transfer posting (DZ): the indicator's
 * configured alternative reconciliation account debits per down
 * payment applied (`Applied from …`) and the customer's ordinary
 * reconciliation account credits per invoice settled
 * (`Settles …`) — a clearing transfers value between the advance
 * and the receivable, it never merely marks items cleared. The
 * unit of work is a pairwise allocation: one down-payment item,
 * one invoice item, one amount; partial allocations leave the
 * remainders standing open by the standing partial model.
 * Allocations are remembered on the clearing's mapping rows while
 * the journal lines stay the balance authority. The indicator
 * resolves through AR special G/L configuration, never hardcoded.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-132.
 */
export const CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY = 'FIN.AR.DOWNPAYMENT.CLEAR';

export class CustomerDownPaymentClearingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerDownPaymentClearingError';
    this.remedy = remedy;
  }
}

export interface CustomerDownPaymentItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  currency: string;
  amount: number;
  applied: number;
  remaining: number;
  indicator: string;
}

export interface CustomerClearingInvoiceItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  currency: string;
  amount: number;
  applied: number;
  remaining: number;
}

export interface CustomerDownPaymentClearingView {
  customer: string;
  companyCode: string;
  indicator: string;
  alternativeAccount: string;
  reconciliationAccount: string;
  downPayments: CustomerDownPaymentItem[];
  invoices: CustomerClearingInvoiceItem[];
}

export interface ClearingItemRef {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
}

/** One pairwise application of advance to invoice. */
export interface ClearingAllocation {
  downPayment: ClearingItemRef;
  invoice: ClearingItemRef;
  amount: number;
}

export interface PostedCustomerClearing {
  clearingNumber: string;
  journalDocumentNumber: string;
  totalApplied: string;
  itemsCleared: number;
  clearingDate: string;
}
