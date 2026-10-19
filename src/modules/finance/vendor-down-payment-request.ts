/**
 * Vendor down payment request — SCR-086 / R-134.
 *
 * A vendor down-payment request is a noted (statistical) item: it
 * asks for an advance without creating a vendor liability or
 * moving the bank. The request record is itself the document (a
 * drawn VENDDPREQ number, the fiscal year derived from its
 * posting date); the actual disbursement remains F-48's act, and
 * fulfillment is an explicit allocation link from the request to
 * the posted payment line, judged under the payment's lock.
 * Fulfilled and remaining amounts derive from the ACTIVE
 * fulfillment rows. The request indicator is configuration
 * carrying a target: the special G/L row names the actual
 * down-payment indicator expected at payment, so neither letter
 * is ever hardcoded.
 *
 * Stage 1 carries the vocabulary only; the services land in
 * stage 3 of R-134.
 */
export const VENDOR_DOWN_PAYMENT_REQUEST_CAPABILITY = 'FIN.AP.DOWNPAYMENT.REQUEST';

export class VendorDownPaymentRequestError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'VendorDownPaymentRequestError';
    this.remedy = remedy;
  }
}

/** A request with its derived fulfillment standing. */
export interface VendorDownPaymentRequestView {
  requestNumber: string;
  fiscalYear: number;
  vendor: string;
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

export interface CreatedVendorDownPaymentRequest {
  requestNumber: string;
  fiscalYear: number;
  targetIndicator: string;
  requestedAmount: string;
  status: string;
}
