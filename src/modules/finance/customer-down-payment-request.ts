/**
 * Customer down payment request — SCR-085 / R-133.
 *
 * A down-payment request is a noted (statistical) item: it asks
 * for an advance without creating a receivable, a cash receipt or
 * any general-ledger movement. The request record is itself the
 * document — it draws a CUSTDPREQ number, derives its fiscal year
 * from the posting date and judges the posting period and the
 * entered document type against configuration exactly as a posting
 * would be judged. The actual receipt remains F-29's act, and
 * fulfillment is an explicit allocation link from the request to
 * the posted receipt line, judged under the receipt's lock.
 * Fulfilled and remaining amounts derive from the ACTIVE
 * fulfillment rows, never from a stored total. The request
 * indicator is configuration carrying a target: the special G/L
 * row names the actual down-payment indicator expected when the
 * receipt arrives, so neither letter is ever hardcoded.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { checkPostingAllowed, derivePosition, getCompanyCode } from '../../platform/periods';
import { customerCompany } from '../foundation/customer-company-schema';
import { documentType, specialGlConfig } from '../foundation/schema';
import {
  customerDownPaymentRequest, downPaymentRequestFulfillment, journalEntryLine,
} from './schema';
import { resolveSpecialGlAccount } from './vendor-down-payment';

export const CUSTOMER_DOWN_PAYMENT_REQUEST_CAPABILITY = 'FIN.AR.DOWNPAYMENT.REQUEST';
const REQUEST_CLASS = 'customer_down_payment_request';

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

const round2 = (n: number) => Math.round(n * 100) / 100;

async function judgeCustomer(tx: Tx, client: string, customerNumber: string, companyCode: string) {
  const [standing] = await tx.select().from(customerCompany).where(and(
    eq(customerCompany.client, client),
    eq(customerCompany.partnerNumber, customerNumber),
    eq(customerCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new CustomerDownPaymentRequestError(
      `Customer ${customerNumber} does not stand extended to company ${companyCode}.`,
      'Extend the customer to the company code, then enter the request.',
    );
  }
  if (standing.isBlocked) throw new CustomerDownPaymentRequestError(`Customer ${customerNumber} is blocked for company ${companyCode}.`);
  return standing;
}

/** The special G/L row for an indicator, company scope winning over tenant-wide. */
async function indicatorRow(tx: Tx, client: string, companyCode: string, indicator: string) {
  const rows = await tx.select().from(specialGlConfig).where(and(
    eq(specialGlConfig.client, client),
    eq(specialGlConfig.accountType, 'AR'),
    eq(specialGlConfig.indicator, indicator),
  ));
  return rows.find((r) => r.companyCode === companyCode) ?? rows.find((r) => r.companyCode === '');
}

/** Resolve a request indicator to the actual indicator it expects at fulfillment. */
export async function resolveRequestTarget(
  tx: Tx, client: string, companyCode: string, indicator: string,
): Promise<string> {
  const row = await indicatorRow(tx, client, companyCode, indicator);
  if (!row) {
    throw new CustomerDownPaymentRequestError(
      `Special G/L indicator ${indicator} is not configured for customers in company ${companyCode}.`,
      'Maintain the special G/L configuration for the indicator, then post again.',
    );
  }
  if (!row.targetSpecialGlIndicator) {
    throw new CustomerDownPaymentRequestError(
      `Special G/L indicator ${indicator} is not configured as a down-payment request indicator for customers in company ${companyCode}.`,
      'Give the indicator a target in the special G/L configuration, then post again.',
    );
  }
  return row.targetSpecialGlIndicator;
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<CreatedDownPaymentRequest | null> {
  const [row] = await tx.select().from(customerDownPaymentRequest).where(and(
    eq(customerDownPaymentRequest.client, client), eq(customerDownPaymentRequest.requestKey, requestKey),
  ));
  return row ? {
    requestNumber: row.requestNumber, fiscalYear: row.fiscalYear,
    targetIndicator: row.targetSpecialGlIndicator,
    requestedAmount: row.requestedAmount, status: row.status,
  } : null;
}

export async function createCustomerDownPaymentRequest(input: {
  client: string; changedBy: string;
  customerNumber: string; companyCode: string;
  documentDate: string; postingDate: string; dueDate: string;
  amount: number; currency: string;
  specialGlIndicator: string; documentType: string;
  reference?: string; requestKey: string;
}): Promise<CreatedDownPaymentRequest> {
  if (!(input.amount > 0)) throw new CustomerDownPaymentRequestError('The requested amount must stand above zero.');
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate], ['Due date', input.dueDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CustomerDownPaymentRequestError(`${label} ${value} is not a calendar date.`);
  }
  if (!/^[A-Za-z0-9]$/.test(input.specialGlIndicator)) {
    throw new CustomerDownPaymentRequestError('The special G/L indicator is a single character.', 'Enter the configured one-character indicator.');
  }
  if (input.reference && input.reference.length > 16) {
    throw new CustomerDownPaymentRequestError('The reference may be at most 16 characters.', 'Shorten the request reference.');
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/custdpreq/${input.companyCode}/${input.customerNumber}`}, 0))`);
    const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
    if (replayLocked) return replayLocked;

    await judgeCustomer(tx, input.client, input.customerNumber, input.companyCode);
    const targetIndicator = await resolveRequestTarget(tx, input.client, input.companyCode, input.specialGlIndicator);
    // The target must stand as an actual (non-request) indicator.
    await resolveSpecialGlAccount(tx, input.client, input.companyCode, targetIndicator, 'AR')
      .catch((error: unknown) => {
        if (error instanceof Error) throw new CustomerDownPaymentRequestError(error.message);
        throw error;
      });

    const [typeRow] = await tx.select().from(documentType).where(and(
      eq(documentType.client, input.client), eq(documentType.documentType, input.documentType.toUpperCase()),
    ));
    if (!typeRow) {
      throw new CustomerDownPaymentRequestError(
        `Document type ${input.documentType.toUpperCase()} is not configured for this tenant.`,
        'Configure the document type, then post again.',
      );
    }
    if (!typeRow.allowedAccountTypes.includes('D')) {
      throw new CustomerDownPaymentRequestError(
        `Document type ${input.documentType.toUpperCase()} does not permit customer postings.`,
        'Choose a document type that permits the customer account type.',
      );
    }

    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant || !company.postingPeriodVariant) {
      throw new CustomerDownPaymentRequestError(`Company code ${input.companyCode} is not configured.`);
    }
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const verdict = await checkPostingAllowed(tx, input.client, company.postingPeriodVariant, 'D', position);
    if (!verdict.allowed) throw new CustomerDownPaymentRequestError(verdict.reason!, verdict.remedy);

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'CUSTDPREQ', allocatedBy: input.changedBy,
    });
    const requestNumber = allocated.display;
    await tx.insert(customerDownPaymentRequest).values({
      client: input.client, requestNumber, fiscalYear: position.fiscalYear,
      customerNumber: input.customerNumber, companyCode: input.companyCode,
      specialGlIndicator: input.specialGlIndicator,
      targetSpecialGlIndicator: targetIndicator,
      documentDate: input.documentDate, postingDate: input.postingDate, dueDate: input.dueDate,
      documentType: input.documentType.toUpperCase(),
      currency: input.currency.toUpperCase(), reference: input.reference ?? null,
      requestedAmount: String(round2(input.amount)),
      status: 'OPEN',
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: REQUEST_CLASS,
      objectKey: `${input.companyCode}/${input.customerNumber}/${requestNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: CUSTOMER_DOWN_PAYMENT_REQUEST_CAPABILITY,
      after: { amount: round2(input.amount), indicator: input.specialGlIndicator, targetIndicator, dueDate: input.dueDate },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}

/** Fulfilled amount of a request, derived from its ACTIVE fulfillment rows. */
export async function fulfilledSoFar(tx: Tx, client: string, requestNumber: string): Promise<number> {
  const rows = await tx.select({ amount: downPaymentRequestFulfillment.fulfilledAmount })
    .from(downPaymentRequestFulfillment)
    .where(and(
      eq(downPaymentRequestFulfillment.client, client),
      eq(downPaymentRequestFulfillment.requestNumber, requestNumber),
      eq(downPaymentRequestFulfillment.status, 'ACTIVE'),
    ));
  return round2(rows.reduce((s, r) => s + Number(r.amount), 0));
}

export async function getCustomerDownPaymentRequests(
  client: string, customerNumber?: string, companyCode?: string,
): Promise<CustomerDownPaymentRequestView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(customerDownPaymentRequest)
      .where(eq(customerDownPaymentRequest.client, client))
      .orderBy(customerDownPaymentRequest.dueDate, customerDownPaymentRequest.requestNumber);
    const views: CustomerDownPaymentRequestView[] = [];
    for (const row of rows) {
      if (customerNumber && row.customerNumber !== customerNumber) continue;
      if (companyCode && row.companyCode !== companyCode) continue;
      const fulfilled = await fulfilledSoFar(tx, client, row.requestNumber);
      const requested = Number(row.requestedAmount);
      views.push({
        requestNumber: row.requestNumber, fiscalYear: row.fiscalYear,
        customer: row.customerNumber, companyCode: row.companyCode,
        indicator: row.specialGlIndicator, targetIndicator: row.targetSpecialGlIndicator,
        documentDate: row.documentDate, postingDate: row.postingDate, dueDate: row.dueDate,
        currency: row.currency, reference: row.reference,
        requestedAmount: requested, fulfilledAmount: fulfilled,
        remainingAmount: round2(requested - fulfilled), status: row.status,
      });
    }
    return views;
  });
}

export interface AppliedFulfillment {
  requestNumber: string;
  fulfilledAmount: number;
  remainingAfter: number;
  status: string;
}

/**
 * Apply one fulfillment of a request by an actual receipt line.
 * Runs inside the receipt's transaction, under its lock: the
 * request is re-read for update and its remaining amount judged
 * again, so concurrent receipts cannot over-fulfill it.
 */
export async function applyRequestFulfillment(tx: Tx, input: {
  client: string; changedBy: string;
  requestNumber: string;
  customerNumber: string; companyCode: string;
  /** The actual indicator the receipt posted against. */
  indicator: string;
  currency: string;
  actualDocumentNumber: string; actualFiscalYear: number; actualLineNumber: number;
  /** Explicit fulfillment amount; defaults to the lesser of the receipt's unallocated part and the request's remainder. */
  amount?: number;
  receiptUnallocated: number;
}): Promise<AppliedFulfillment> {
  const [request] = await tx.select().from(customerDownPaymentRequest).where(and(
    eq(customerDownPaymentRequest.client, input.client),
    eq(customerDownPaymentRequest.requestNumber, input.requestNumber),
  )).for('update');
  if (!request) {
    throw new CustomerDownPaymentRequestError(
      `Down payment request ${input.requestNumber} does not stand in this tenant.`,
      'Choose a standing request, then post again.',
    );
  }
  if (request.customerNumber !== input.customerNumber || request.companyCode !== input.companyCode) {
    throw new CustomerDownPaymentRequestError(
      `Down payment request ${input.requestNumber} belongs to customer ${request.customerNumber} in company ${request.companyCode}, not to this receipt.`,
      'Choose a request of this customer and company, then post again.',
    );
  }
  if (request.status === 'CLOSED' || request.status === 'REVERSED') {
    throw new CustomerDownPaymentRequestError(
      `Down payment request ${input.requestNumber} stands ${request.status.toLowerCase()} and cannot be fulfilled.`,
    );
  }
  if (request.targetSpecialGlIndicator !== input.indicator) {
    throw new CustomerDownPaymentRequestError(
      `Down payment request ${input.requestNumber} expects indicator ${request.targetSpecialGlIndicator} at fulfillment, not ${input.indicator}.`,
      `Post the receipt against indicator ${request.targetSpecialGlIndicator}, then fulfill.`,
    );
  }
  if (request.currency !== input.currency.toUpperCase()) {
    throw new CustomerDownPaymentRequestError(
      `Down payment request ${input.requestNumber} stands in ${request.currency}; the receipt stands in ${input.currency.toUpperCase()}.`,
      'Fulfill a request in its own currency.',
    );
  }
  const fulfilled = await fulfilledSoFar(tx, input.client, input.requestNumber);
  const remaining = round2(Number(request.requestedAmount) - fulfilled);
  if (remaining <= 0.005) {
    throw new CustomerDownPaymentRequestError(
      `Down payment request ${input.requestNumber} already stands fulfilled.`,
    );
  }
  const amount = input.amount === undefined
    ? round2(Math.min(input.receiptUnallocated, remaining))
    : round2(input.amount);
  if (!(amount > 0)) {
    throw new CustomerDownPaymentRequestError(
      `The fulfillment of request ${input.requestNumber} must stand above zero.`,
    );
  }
  if (amount - remaining > 0.005) {
    throw new CustomerDownPaymentRequestError(
      `The fulfillment ${amount.toFixed(2)} exceeds the remaining ${remaining.toFixed(2)} of request ${input.requestNumber}.`,
      'Fulfill no more than the request stands open at; the excess posts as an ordinary down payment.',
    );
  }
  const existing = await tx.select({ n: downPaymentRequestFulfillment.fulfillmentNumber })
    .from(downPaymentRequestFulfillment)
    .where(and(
      eq(downPaymentRequestFulfillment.client, input.client),
      eq(downPaymentRequestFulfillment.requestNumber, input.requestNumber),
    ));
  const fulfillmentNumber = existing.length + 1;
  await tx.insert(downPaymentRequestFulfillment).values({
    client: input.client, requestNumber: input.requestNumber,
    requestFiscalYear: request.fiscalYear, fulfillmentNumber,
    actualDocumentNumber: input.actualDocumentNumber,
    actualFiscalYear: input.actualFiscalYear, actualLineNumber: input.actualLineNumber,
    fulfillmentCurrency: request.currency,
    fulfilledAmount: String(amount),
    status: 'ACTIVE', createdBy: input.changedBy,
  });
  const remainingAfter = round2(remaining - amount);
  const status = remainingAfter <= 0.005 ? 'FULFILLED' : 'PARTIAL';
  await tx.update(customerDownPaymentRequest).set({
    status, changedBy: input.changedBy, changedAt: new Date(),
  }).where(and(
    eq(customerDownPaymentRequest.client, input.client),
    eq(customerDownPaymentRequest.requestNumber, input.requestNumber),
  ));
  return { requestNumber: input.requestNumber, fulfilledAmount: amount, remainingAfter, status };
}

/** The receipt line a fulfillment must point at: the down payment's credit line. */
export async function downPaymentCreditLine(
  tx: Tx, client: string, journalDocumentNumber: string, alternativeAccount: string, customerNumber: string,
): Promise<{ fiscalYear: number; lineNumber: number }> {
  const [line] = await tx.select({
    fiscalYear: journalEntryLine.fiscalYear, lineNumber: journalEntryLine.lineNumber,
  }).from(journalEntryLine).where(and(
    eq(journalEntryLine.client, client),
    eq(journalEntryLine.documentNumber, journalDocumentNumber),
    eq(journalEntryLine.glAccount, alternativeAccount),
    eq(journalEntryLine.debitCredit, 'H'),
    eq(journalEntryLine.businessPartner, customerNumber),
  ));
  if (!line) throw new CustomerDownPaymentRequestError('The receipt line to fulfill against could not be found.');
  return line;
}
