/**
 * Customer down payment request — SCR-085 / R-133.
 *
 * A down-payment request is a noted (statistical) item: it asks
 * for an advance without creating a receivable, a cash receipt or
 * any general-ledger movement. The request record is itself the
 * document (a drawn CUSTDPREQ number, the fiscal year derived
 * from its posting date); the actual receipt remains F-29's act,
 * and fulfillment is an explicit allocation link from the request
 * to the posted receipt line, judged under the receipt's lock.
 * The request indicator is configuration carrying a target: the
 * special G/L row names the actual down-payment indicator expected
 * when the receipt arrives, so neither letter is ever hardcoded.
 *
 * Stage 1 carries the vocabulary only; the services land in
 * stage 3 of R-133.
 */
export const CUSTOMER_DOWN_PAYMENT_REQUEST_CAPABILITY = 'FIN.AR.DOWNPAYMENT.REQUEST';

export class CustomerDownPaymentRequestError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerDownPaymentRequestError';
    this.remedy = remedy;
  }
}

/** A request with its derived fulfillment standing. */
export interface CustomerDownPaymentRequestView {
  requestNumber: string;
  fiscalYear: number;
  customer: string;
  companyCode: string;
  indicator: string;
  targetIndicator: string;
  documentDate: string;
  postingDate: string;
  dueDate: string;
  currency: string;
  reference: string | null;
  requestedAmount: number;
  fulfilledAmount: number;
  remainingAmount: number;
  status: string;
}

export interface CreatedDownPaymentRequest {
  requestNumber: string;
  fiscalYear: number;
  targetIndicator: string;
  requestedAmount: string;
  status: string;
}
