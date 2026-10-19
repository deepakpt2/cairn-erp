/**
 * Vendor down payment request — SCR-086 / R-134.
 *
 * The vendor twin of the customer down-payment request: a noted
 * (statistical) item asking for an advance without creating a
 * vendor liability or moving the bank. The request record is
 * itself the document — it draws a VENDDPREQ number, derives its
 * fiscal year from the posting date and judges the posting period
 * and the entered document type against configuration exactly as
 * a posting would be judged. The actual disbursement remains
 * F-48's act, and fulfillment is an explicit allocation link from
 * the request to the posted payment line, judged under the
 * payment's lock. Fulfilled and remaining amounts derive from
 * the ACTIVE fulfillment rows, never from a stored total. The
 * request indicator is configuration carrying a target: the
 * special G/L row names the actual down-payment indicator
 * expected when the payment arrives, so neither letter is ever
 * hardcoded. A vendor's payment block does not refuse the
 * request — it is not a disbursement; F-48 enforces the block
 * before money moves.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { checkPostingAllowed, derivePosition, getCompanyCode } from '../../platform/periods';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { documentType, specialGlConfig } from '../foundation/schema';
import {
  journalEntryLine, vendorDownPaymentRequest, vendorDpRequestFulfillment,
} from './schema';
import { resolveSpecialGlAccount } from './vendor-down-payment';

export const VENDOR_DOWN_PAYMENT_REQUEST_CAPABILITY = 'FIN.AP.DOWNPAYMENT.REQUEST';
const REQUEST_CLASS = 'vendor_down_payment_request';

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

const round2 = (n: number) => Math.round(n * 100) / 100;

async function judgeVendor(tx: Tx, client: string, vendorNumber: string, companyCode: string) {
  const [standing] = await tx.select().from(supplierCompany).where(and(
    eq(supplierCompany.client, client),
    eq(supplierCompany.partnerNumber, vendorNumber),
    eq(supplierCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new VendorDownPaymentRequestError(
      `Vendor ${vendorNumber} does not stand extended to company ${companyCode}.`,
      'Extend the vendor to the company code, then enter the request.',
    );
  }
  // The company payment block is a disbursement control: it does
  // not refuse a noted request. F-48 refuses a blocked vendor
  // before any money moves.
  return standing;
}

/** The special G/L row for an indicator, company scope winning over tenant-wide. */
async function indicatorRow(tx: Tx, client: string, companyCode: string, indicator: string) {
  const rows = await tx.select().from(specialGlConfig).where(and(
    eq(specialGlConfig.client, client),
    eq(specialGlConfig.accountType, 'AP'),
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
    throw new VendorDownPaymentRequestError(
      `Special G/L indicator ${indicator} is not configured for vendors in company ${companyCode}.`,
      'Maintain the special G/L configuration for the indicator, then post again.',
    );
  }
  if (!row.targetSpecialGlIndicator) {
    throw new VendorDownPaymentRequestError(
      `Special G/L indicator ${indicator} is not configured as a down-payment request indicator for vendors in company ${companyCode}.`,
      'Give the indicator a target in the special G/L configuration, then post again.',
    );
  }
  return row.targetSpecialGlIndicator;
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<CreatedVendorDownPaymentRequest | null> {
  const [row] = await tx.select().from(vendorDownPaymentRequest).where(and(
    eq(vendorDownPaymentRequest.client, client), eq(vendorDownPaymentRequest.requestKey, requestKey),
  ));
  return row ? {
    requestNumber: row.requestNumber, fiscalYear: row.fiscalYear,
    targetIndicator: row.targetSpecialGlIndicator,
    requestedAmount: row.requestedAmount, status: row.status,
  } : null;
}

export async function createVendorDownPaymentRequest(input: {
  client: string; changedBy: string;
  vendorNumber: string; companyCode: string;
  documentDate: string; postingDate: string; dueDate: string;
  amount: number; currency: string;
  specialGlIndicator: string; documentType: string;
  reference?: string; requestKey: string;
}): Promise<CreatedVendorDownPaymentRequest> {
  if (!(input.amount > 0)) throw new VendorDownPaymentRequestError('The requested amount must stand above zero.');
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate], ['Due date', input.dueDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new VendorDownPaymentRequestError(`${label} ${value} is not a calendar date.`);
  }
  if (!/^[A-Za-z0-9]$/.test(input.specialGlIndicator)) {
    throw new VendorDownPaymentRequestError('The special G/L indicator is a single character.', 'Enter the configured one-character indicator.');
  }
  if (input.reference && input.reference.length > 16) {
    throw new VendorDownPaymentRequestError('The reference may be at most 16 characters.', 'Shorten the request reference.');
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/venddpreq/${input.companyCode}/${input.vendorNumber}`}, 0))`);
    const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
    if (replayLocked) return replayLocked;

    await judgeVendor(tx, input.client, input.vendorNumber, input.companyCode);
    const targetIndicator = await resolveRequestTarget(tx, input.client, input.companyCode, input.specialGlIndicator);
    // The target must stand as an actual (non-request) indicator.
    await resolveSpecialGlAccount(tx, input.client, input.companyCode, targetIndicator, 'AP')
      .catch((error: unknown) => {
        if (error instanceof Error) throw new VendorDownPaymentRequestError(error.message);
        throw error;
      });

    const [typeRow] = await tx.select().from(documentType).where(and(
      eq(documentType.client, input.client), eq(documentType.documentType, input.documentType.toUpperCase()),
    ));
    if (!typeRow) {
      throw new VendorDownPaymentRequestError(
        `Document type ${input.documentType.toUpperCase()} is not configured for this tenant.`,
        'Configure the document type, then post again.',
      );
    }
    if (!typeRow.allowedAccountTypes.includes('K')) {
      throw new VendorDownPaymentRequestError(
        `Document type ${input.documentType.toUpperCase()} does not permit vendor postings.`,
        'Choose a document type that permits the vendor account type.',
      );
    }

    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant || !company.postingPeriodVariant) {
      throw new VendorDownPaymentRequestError(`Company code ${input.companyCode} is not configured.`);
    }
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const verdict = await checkPostingAllowed(tx, input.client, company.postingPeriodVariant, 'K', position);
    if (!verdict.allowed) throw new VendorDownPaymentRequestError(verdict.reason!, verdict.remedy);

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'VENDDPREQ', allocatedBy: input.changedBy,
    });
    const requestNumber = allocated.display;
    await tx.insert(vendorDownPaymentRequest).values({
      client: input.client, requestNumber, fiscalYear: position.fiscalYear,
      vendorNumber: input.vendorNumber, companyCode: input.companyCode,
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
      objectKey: `${input.companyCode}/${input.vendorNumber}/${requestNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: VENDOR_DOWN_PAYMENT_REQUEST_CAPABILITY,
      after: { amount: round2(input.amount), indicator: input.specialGlIndicator, targetIndicator, dueDate: input.dueDate },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}

/** Fulfilled amount of a request, derived from its ACTIVE fulfillment rows. */
export async function fulfilledSoFar(tx: Tx, client: string, requestNumber: string): Promise<number> {
  const rows = await tx.select({ amount: vendorDpRequestFulfillment.fulfilledAmount })
    .from(vendorDpRequestFulfillment)
    .where(and(
      eq(vendorDpRequestFulfillment.client, client),
      eq(vendorDpRequestFulfillment.requestNumber, requestNumber),
      eq(vendorDpRequestFulfillment.status, 'ACTIVE'),
    ));
  return round2(rows.reduce((s, r) => s + Number(r.amount), 0));
}

export async function getVendorDownPaymentRequests(
  client: string, vendorNumber?: string, companyCode?: string,
): Promise<VendorDownPaymentRequestView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(vendorDownPaymentRequest)
      .where(eq(vendorDownPaymentRequest.client, client))
      .orderBy(vendorDownPaymentRequest.dueDate, vendorDownPaymentRequest.requestNumber);
    const views: VendorDownPaymentRequestView[] = [];
    for (const row of rows) {
      if (vendorNumber && row.vendorNumber !== vendorNumber) continue;
      if (companyCode && row.companyCode !== companyCode) continue;
      const fulfilled = await fulfilledSoFar(tx, client, row.requestNumber);
      const requested = Number(row.requestedAmount);
      views.push({
        requestNumber: row.requestNumber, fiscalYear: row.fiscalYear,
        vendor: row.vendorNumber, companyCode: row.companyCode,
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
 * Apply one fulfillment of a request by an actual payment line.
 * Runs inside the payment's transaction, under its lock: the
 * request is re-read for update and its remaining amount judged
 * again, so concurrent payments cannot over-fulfill it.
 */
export async function applyVendorRequestFulfillment(tx: Tx, input: {
  client: string; changedBy: string;
  requestNumber: string;
  vendorNumber: string; companyCode: string;
  /** The actual indicator the payment posted against. */
  indicator: string;
  currency: string;
  actualDocumentNumber: string; actualFiscalYear: number; actualLineNumber: number;
  /** Explicit fulfillment amount; defaults to the lesser of the payment's unallocated part and the request's remainder. */
  amount?: number;
  paymentUnallocated: number;
}): Promise<AppliedFulfillment> {
  const [request] = await tx.select().from(vendorDownPaymentRequest).where(and(
    eq(vendorDownPaymentRequest.client, input.client),
    eq(vendorDownPaymentRequest.requestNumber, input.requestNumber),
  )).for('update');
  if (!request) {
    throw new VendorDownPaymentRequestError(
      `Down payment request ${input.requestNumber} does not stand in this tenant.`,
      'Choose a standing request, then post again.',
    );
  }
  if (request.vendorNumber !== input.vendorNumber || request.companyCode !== input.companyCode) {
    throw new VendorDownPaymentRequestError(
      `Down payment request ${input.requestNumber} belongs to vendor ${request.vendorNumber} in company ${request.companyCode}, not to this payment.`,
      'Choose a request of this vendor and company, then post again.',
    );
  }
  if (request.status === 'CLOSED' || request.status === 'REVERSED') {
    throw new VendorDownPaymentRequestError(
      `Down payment request ${input.requestNumber} stands ${request.status.toLowerCase()} and cannot be fulfilled.`,
    );
  }
  if (request.targetSpecialGlIndicator !== input.indicator) {
    throw new VendorDownPaymentRequestError(
      `Down payment request ${input.requestNumber} expects indicator ${request.targetSpecialGlIndicator} at fulfillment, not ${input.indicator}.`,
      `Post the payment against indicator ${request.targetSpecialGlIndicator}, then fulfill.`,
    );
  }
  if (request.currency !== input.currency.toUpperCase()) {
    throw new VendorDownPaymentRequestError(
      `Down payment request ${input.requestNumber} stands in ${request.currency}; the payment stands in ${input.currency.toUpperCase()}.`,
      'Fulfill a request in its own currency.',
    );
  }
  const fulfilled = await fulfilledSoFar(tx, input.client, input.requestNumber);
  const remaining = round2(Number(request.requestedAmount) - fulfilled);
  if (remaining <= 0.005) {
    throw new VendorDownPaymentRequestError(
      `Down payment request ${input.requestNumber} already stands fulfilled.`,
    );
  }
  const amount = input.amount === undefined
    ? round2(Math.min(input.paymentUnallocated, remaining))
    : round2(input.amount);
  if (!(amount > 0)) {
    throw new VendorDownPaymentRequestError(
      `The fulfillment of request ${input.requestNumber} must stand above zero.`,
    );
  }
  if (amount - remaining > 0.005) {
    throw new VendorDownPaymentRequestError(
      `The fulfillment ${amount.toFixed(2)} exceeds the remaining ${remaining.toFixed(2)} of request ${input.requestNumber}.`,
      'Fulfill no more than the request stands open at; the excess posts as an ordinary down payment.',
    );
  }
  const existing = await tx.select({ n: vendorDpRequestFulfillment.fulfillmentNumber })
    .from(vendorDpRequestFulfillment)
    .where(and(
      eq(vendorDpRequestFulfillment.client, input.client),
      eq(vendorDpRequestFulfillment.requestNumber, input.requestNumber),
    ));
  const fulfillmentNumber = existing.length + 1;
  await tx.insert(vendorDpRequestFulfillment).values({
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
  await tx.update(vendorDownPaymentRequest).set({
    status, changedBy: input.changedBy, changedAt: new Date(),
  }).where(and(
    eq(vendorDownPaymentRequest.client, input.client),
    eq(vendorDownPaymentRequest.requestNumber, input.requestNumber),
  ));
  return { requestNumber: input.requestNumber, fulfilledAmount: amount, remainingAfter, status };
}

/** The payment line a fulfillment must point at: the down payment's debit line. */
export async function downPaymentDebitLine(
  tx: Tx, client: string, journalDocumentNumber: string, alternativeAccount: string, vendorNumber: string,
): Promise<{ fiscalYear: number; lineNumber: number }> {
  const [line] = await tx.select({
    fiscalYear: journalEntryLine.fiscalYear, lineNumber: journalEntryLine.lineNumber,
  }).from(journalEntryLine).where(and(
    eq(journalEntryLine.client, client),
    eq(journalEntryLine.documentNumber, journalDocumentNumber),
    eq(journalEntryLine.glAccount, alternativeAccount),
    eq(journalEntryLine.debitCredit, 'S'),
    eq(journalEntryLine.businessPartner, vendorNumber),
  ));
  if (!line) throw new VendorDownPaymentRequestError('The payment line to fulfill against could not be found.');
  return line;
}
