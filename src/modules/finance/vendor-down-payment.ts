/**
 * Vendor down payment entry — SCR-081 / R-129.
 *
 * A down payment pays a vendor in advance against a special G/L
 * indicator: the indicator's configured alternative reconciliation
 * account debits and the bank credits, so the advance stands open
 * outside the vendor's ordinary payables until it is cleared
 * against invoices (clearing stands deferred to its own round).
 * The posting service lands in stage 3; this module carries the
 * capability and error vocabulary the screen already speaks.
 */

export const VENDOR_DOWN_PAYMENT_CAPABILITY = 'FIN.AP.DOWNPAYMENT.POST';

export class VendorDownPaymentError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'VendorDownPaymentError';
    this.remedy = remedy;
  }
}
