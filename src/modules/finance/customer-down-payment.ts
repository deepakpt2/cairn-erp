/**
 * Customer down payment entry — SCR-083 / R-131.
 *
 * A down payment received from a customer against a special G/L
 * indicator: the bank debits and the indicator's configured
 * alternative customer reconciliation account credits, so the
 * advance stands open outside the customer's ordinary receivables
 * until it is cleared against invoices (clearing stands deferred
 * to its own round, F-39). The posting service lands in stage 3;
 * this module carries the capability and error vocabulary the
 * screen already speaks.
 */

export const CUSTOMER_DOWN_PAYMENT_CAPABILITY = 'FIN.AR.DOWNPAYMENT.POST';

export class CustomerDownPaymentError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerDownPaymentError';
    this.remedy = remedy;
  }
}
