/**
 * Vendor down payment clearing — SCR-082 / R-130.
 *
 * Applies standing down payments to open vendor invoices by a
 * transfer posting (KZ): the ordinary reconciliation account
 * debits per invoice settled, the indicator's alternative account
 * credits per down payment applied, and items applied in full
 * clear in place while remainders stand by the partial model.
 * The posting service lands in stage 3; this module carries the
 * capability, error and view vocabulary the screen speaks.
 */

export const VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY = 'FIN.AP.DOWNPAYMENT.CLEAR';

export class VendorDownPaymentClearingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'VendorDownPaymentClearingError';
    this.remedy = remedy;
  }
}

export interface DownPaymentItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  currency: string;
  /** Original advance amount. */
  amount: number;
  /** Already applied by earlier clearings. */
  applied: number;
  /** Still standing open. */
  remaining: number;
  indicator: string;
}

export interface ClearingInvoiceItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  currency: string;
  /** Original payable amount (credit positive). */
  amount: number;
  /** Already settled by earlier down-payment clearings. */
  applied: number;
  /** Still standing open. */
  remaining: number;
}

export interface DownPaymentClearingView {
  vendor: string;
  companyCode: string;
  indicator: string;
  alternativeAccount: string;
  downPayments: DownPaymentItem[];
  invoices: ClearingInvoiceItem[];
}
