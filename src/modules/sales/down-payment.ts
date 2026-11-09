/**
 * Money before the goods — the down payment (SAP F-37, F-29, F-39).
 *
 * A delivery earns an invoice when its goods go out, and a plan date bills the share that has fallen
 * due. Neither is any answer to a customer who is asked to pay part of an order in advance: nothing
 * has been delivered and nothing has yet been earned, and an invoice is a claim about goods or work,
 * not a request for money.
 *
 * So the advance is asked for, and the asking is a document of its own. It is raised from a plan date
 * maintained as a down payment date, and it stands behind a *noted item* in accounting: a drawn
 * number, no journal, no receivable, no revenue. A customer asked for money is not yet a customer who
 * owes it. The money itself arrives through accounting's own act — a special G/L receipt allocated to
 * the request — and it lands on an alternative reconciliation account, outside the customer's ordinary
 * receivables, which is what a special G/L indicator is for.
 *
 * Then the goods go out, or the work is done, and the invoice is raised. It bills the whole of what
 * has been earned and it consumes the advance: a transfer posting moves the money from the alternative
 * account onto the receivable, so that billed amount less down payment amount is what is still to pay.
 * That is the third act, and it is the one that makes the first two honest — an advance that was never
 * cleared is a customer who paid twice.
 *
 * Three things are held to here.
 *
 * The indicator is configuration and never a letter this module knows. A request indicator is one that
 * names a target, and the target is the actual indicator the receipt arrives under — which is why
 * nothing defaults it: an unconfigured request indicator is refused, and an ambiguous one is refused
 * naming the indicators that stand.
 *
 * A request that money has arrived against cannot be withdrawn. It is settled the way an advance is
 * settled — by clearing it against what the customer owes — and a withdrawal that quietly dropped the
 * receipts would lose money on the record.
 *
 * And the clearing never exceeds the smaller of the two. What an advance still stands at and what an
 * invoice still stands open at are both derived from posted lines, and the allocation takes the lesser
 * of them: a clearing that invented a difference would be a difference somebody has to explain.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { specialGlConfig } from '../foundation/schema';
import {
  createCustomerDownPaymentRequestTx, fulfilledSoFar, reverseCustomerDownPaymentRequestTx,
} from '../finance/customer-down-payment-request';
import {
  clearCustomerDownPaymentsTx, getCustomerDownPaymentClearingTx,
  type ClearingAllocation, type ClearingItemRef,
} from '../finance/customer-down-payment-clearing';
import { customerDownPaymentRequest, downPaymentRequestFulfillment } from '../finance/schema';
import {
  billingDocument, billingDocumentLine, salesDownPaymentRequest, type DownPaymentRequestStatus,
} from './schema';
import { DOCUMENT_TYPE_REMEDY, STANDARD_DOWN_PAYMENT_REQUEST_TYPE, salesDocumentTypeFor } from './document-type';
import { loadBillablePlanDate, markPlanDateBilled, releasePlanDateForBilling } from './billing-plan';
import { documentPartners, writeDocumentPartners } from './partners';

export const DOWN_PAYMENT_OBJECT_CLASS = 'sales_down_payment_request';

export class DownPaymentError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'DownPaymentError';
    this.remedy = remedy;
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');
const key = (max: number) => z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().min(1).max(max));

export const downPaymentRequestInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  orderNumber: key(20),
  orderLineNumber: z.coerce.number().int().positive(),
  dateNumber: z.coerce.number().int().positive(),
  billingDate: isoDate,
  postingDate: z.union([z.undefined(), z.literal(''), isoDate]).optional(),
  /** The day the advance is expected. It is the day it is asked for unless the clerk names another. */
  dueDate: z.union([z.undefined(), isoDate]),
  /**
   * The request indicator, where a tenant maintains more than one. Derived where exactly one stands,
   * and refused where the configuration names several and the caller names none.
   */
  indicator: z.union([z.undefined(), z.string().trim().toUpperCase().pipe(z.string().min(1).max(1))]),
  /** The accounting document type the noted item is written under; DZ, the customer payment type. */
  financeDocumentType: z.union([z.undefined(), key(12)]),
  requestKey: z.union([z.undefined(), z.string().trim().min(1).max(64)]),
});
export type DownPaymentRequestInput = z.infer<typeof downPaymentRequestInput>;

export const downPaymentCancelInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  billingNumber: key(20),
  reason: z.union([z.undefined(), z.string().trim().min(3).max(500)]),
  requestKey: z.union([z.undefined(), z.string().trim().min(1).max(64)]),
});
export type DownPaymentCancelInput = z.infer<typeof downPaymentCancelInput>;

/** What a raised down payment request looks like to a caller. */
export interface DownPaymentRequestResult {
  billingNumber: string;
  /** The accounting noted item behind it. */
  requestNumber: string;
  /** The indicator the request stands under, and the one the receipt will arrive under. */
  indicator: string;
  targetIndicator: string;
  customerNumber: string;
  companyCode: string;
  currency: string;
  amount: string;
  dueDate: string;
  orderNumber: string;
  orderLineNumber: number;
  dateNumber: number;
  /** True where a second submission of the same key found the document that was already raised. */
  replayed: boolean;
}

const round2 = (value: number) => (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
const round3 = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;
const round4 = (value: number) => (Math.round((value + Number.EPSILON) * 10000) / 10000).toFixed(4);

/**
 * The customer request indicators a company maintains.
 *
 * A request indicator is configuration carrying a target: the row names the actual indicator a receipt
 * is expected under, so neither letter is ever hardcoded and a tenant that maintains two is a tenant
 * the code asks rather than guesses at. A company's own configuration answers before the tenant-wide
 * one, as it does everywhere else.
 */
async function requestIndicators(
  tx: Tx, client: string, companyCode: string,
): Promise<Array<{ indicator: string; targetIndicator: string }>> {
  const rows = await tx.select({
    companyCode: specialGlConfig.companyCode,
    indicator: specialGlConfig.indicator,
    targetIndicator: specialGlConfig.targetSpecialGlIndicator,
  }).from(specialGlConfig).where(and(
    eq(specialGlConfig.client, client),
    eq(specialGlConfig.accountType, 'AR'),
    inArray(specialGlConfig.companyCode, [companyCode, '']),
  ));
  const seen = new Map<string, string>();
  // A company's own row answers first; the tenant-wide one is the fallback, and is not consulted at
  // all where the company maintains its own.
  for (const code of [companyCode, ''] as const) {
    for (const row of rows) {
      if (row.companyCode !== code) continue;
      if (!row.targetIndicator) continue;
      if (!seen.has(row.indicator)) seen.set(row.indicator, row.targetIndicator);
    }
    if (seen.size > 0) break;
  }
  return [...seen].map(([indicator, targetIndicator]) => ({ indicator, targetIndicator }));
}

/**
 * Ask a plan date's share of an order item in advance.
 *
 * The date is the instruction and nothing else is accepted: what is asked for is the share the plan
 * says, of the value the order says the item has, gross — because what the customer pays is net plus
 * tax, and a request that asked for the net would be asking for money that does not cover the tax the
 * invoice will state.
 *
 * Nothing is posted by this act. The document stands, the noted item is written beside it, and the
 * money cannot move until the receipt, which is accounting's own act under its own authority.
 */
export async function requestDownPaymentFromPlanDate(
  raw: DownPaymentRequestInput,
): Promise<DownPaymentRequestResult> {
  const parsed = downPaymentRequestInput.parse(raw);
  const { client, orderNumber, orderLineNumber, dateNumber, changedBy } = parsed;
  const postingDate = (parsed.postingDate || '') || parsed.billingDate;
  return withTenant(client, async (tx) => {
    // One date, one request. Two clerks asking for the same date at the same moment is the whole
    // reason the lock is taken before the date is read rather than after it.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/plan/${orderNumber}/${orderLineNumber}/${dateNumber}`}, 0))`);

    if (parsed.requestKey) {
      const [existing] = await tx.select().from(billingDocument).where(and(
        eq(billingDocument.client, client), eq(billingDocument.requestKey, parsed.requestKey),
      )).limit(1);
      if (existing) {
        const [raised] = await tx.select().from(salesDownPaymentRequest).where(and(
          eq(salesDownPaymentRequest.client, client),
          eq(salesDownPaymentRequest.billingNumber, existing.billingNumber),
        )).limit(1);
        if (raised) {
          const [request] = await tx.select().from(customerDownPaymentRequest).where(and(
            eq(customerDownPaymentRequest.client, client),
            eq(customerDownPaymentRequest.requestNumber, raised.requestNumber),
          )).limit(1);
          return {
            billingNumber: raised.billingNumber,
            requestNumber: raised.requestNumber,
            indicator: request?.specialGlIndicator ?? '',
            targetIndicator: request?.targetSpecialGlIndicator ?? '',
            customerNumber: raised.customerNumber,
            companyCode: raised.companyCode,
            currency: raised.currency,
            amount: round2(Number(raised.amount)),
            dueDate: request?.dueDate ?? existing.billingDate,
            orderNumber, orderLineNumber, dateNumber,
            replayed: true,
          };
        }
      }
    }

    const { order, orderLine, date } = await loadBillablePlanDate(tx, {
      client, orderNumber, orderLineNumber, dateNumber,
      billingDate: parsed.billingDate, action: 'asked for',
    });
    if (date.billingRule !== 'DOWN_PAYMENT') {
      throw new DownPaymentError(
        `Date ${dateNumber} of order ${orderNumber} item ${orderLineNumber} is maintained to invoice ${date.percentage} per cent of the item, not to ask for it in advance.`,
        'Maintain the date as a down payment at /sales/billing-plans, then ask for it; a date that invoices is billed, which is SALES.BILLING.CREATE.',
      );
    }

    // What is asked for: the date's share of the item, gross. The same arithmetic the due list shows
    // beside the date, so the number a clerk saw is the number the customer is asked for.
    const share = Number(date.percentage) / 100;
    const netTotal = Number(round2(Number(orderLine.netAmount) * share));
    const taxTotal = Number(round2(Number(orderLine.taxAmount) * share));
    const amount = Number(round2(netTotal + taxTotal));
    if (!(amount > 0)) {
      throw new DownPaymentError(
        `Date ${dateNumber} asks for ${date.percentage} per cent of ${orderLine.netAmount} ${order.currency}, which is nothing a customer can be asked to pay.`,
        'Raise the share the date carries, or the value on the order item.',
      );
    }

    const indicators = await requestIndicators(tx, client, order.companyCode);
    let chosen: { indicator: string; targetIndicator: string } | undefined;
    if (parsed.indicator) {
      chosen = indicators.find((row) => row.indicator === parsed.indicator);
      if (!chosen) {
        throw new DownPaymentError(
          `Special G/L indicator ${parsed.indicator} does not stand as a down-payment request indicator for customers in company ${order.companyCode}.`,
          `Configure it at /config/special-gl as a customer indicator carrying a target${
            indicators.length ? `, or choose one of those that stand: ${indicators.map((row) => `${row.indicator} (target ${row.targetIndicator})`).join(', ')}.` : '.'
          }`,
        );
      }
    } else if (indicators.length === 1) {
      chosen = indicators[0];
    } else if (indicators.length === 0) {
      throw new DownPaymentError(
        `No special G/L indicator is configured as a down-payment request indicator for customers in company ${order.companyCode}, so no advance can be asked for.`,
        'Configure at /config/special-gl a customer indicator carrying a target indicator — the target is the one the receipt arrives under.',
      );
    } else {
      throw new DownPaymentError(
        `Company ${order.companyCode} maintains ${indicators.length} customer down-payment request indicators (${indicators.map((row) => row.indicator).join(', ')}), so the one this advance is asked under has to be named.`,
        'Name the indicator on this request, or maintain only one request indicator for the company.',
      );
    }

    // Who is asked: the payer who will pay it, and where no payer stands the customer who ordered.
    const partners = await documentPartners(tx, client, 'ORDER', order.orderNumber);
    const customerNumber = partners?.payer || order.customerNumber;

    const billingType = await salesDocumentTypeFor(tx, client, STANDARD_DOWN_PAYMENT_REQUEST_TYPE);
    if (!billingType) {
      throw new DownPaymentError(
        `Sales document type ${STANDARD_DOWN_PAYMENT_REQUEST_TYPE} does not stand for this tenant, so no request document can be created.`,
        DOCUMENT_TYPE_REMEDY,
      );
    }
    let number: string;
    try {
      const drawn = await allocateNumber(tx, {
        client, objectCode: billingType.numberRangeObject, companyCode: '*',
        subObject: billingType.numberRangeSubObject, fiscalYear: 0, allocatedBy: changedBy,
      });
      number = drawn.display;
    } catch {
      throw new DownPaymentError(
        `No active internal ${billingType.numberRangeObject} number range stands for sub-object ${billingType.numberRangeSubObject} of sales document type ${billingType.documentType}, so no request document can be created.`,
        'Define or unblock the interval on the number ranges screen, then ask again.',
      );
    }

    const dueDate = parsed.dueDate || date.billingDate;
    const requested = await createCustomerDownPaymentRequestTx(tx, {
      client, changedBy,
      customerNumber, companyCode: order.companyCode,
      documentDate: parsed.billingDate, postingDate, dueDate,
      amount, currency: order.currency,
      specialGlIndicator: chosen.indicator,
      documentType: parsed.financeDocumentType || 'DZ',
      // The order the advance belongs to, so the noted item can be found from the sale and the sale
      // from the noted item.
      reference: orderNumber.slice(0, 16),
      requestKey: `sd-dpr-${client}-${number}`.slice(0, 64),
    }).catch((caught: unknown) => {
      const error = caught as { message?: string; remedy?: string };
      throw new DownPaymentError(
        `The advance of date ${dateNumber} could not be asked for: ${error?.message ?? 'the accounting request was refused.'}`,
        `${error?.remedy ?? 'Correct the customer or the accounting configuration, then ask again.'} The retry under the same submission raises no second request.`,
      );
    });

    const ordered = Number(orderLine.orderQuantity);
    const billed = round3(ordered * share);
    await tx.insert(billingDocument).values({
      client,
      billingNumber: number,
      documentType: billingType.documentType,
      orderNumber: order.orderNumber,
      deliveryNumber: null,
      salesOrg: order.salesOrg,
      distributionChannel: order.distributionChannel,
      division: order.division,
      customerNumber: order.customerNumber,
      companyCode: order.companyCode,
      currency: order.currency,
      billingDate: parsed.billingDate,
      postingDate: postingDate,
      // A request stands and was sent — and it names no invoice, because asking for an advance posts
      // nothing at all.
      status: 'POSTED',
      netValue: round2(netTotal),
      taxValue: round2(taxTotal),
      grossValue: round2(netTotal + taxTotal),
      referenceDocumentText: `Order ${order.orderNumber} item ${orderLine.lineNumber} date ${dateNumber}`.slice(0, 100),
      requestKey: parsed.requestKey || null,
      createdBy: changedBy,
    });

    // One line, carrying the share this date asks for. The request is not revenue and posts nothing,
    // but a document with no line is a document that cannot say what it was asking for.
    await tx.insert(billingDocumentLine).values({
      client,
      billingNumber: number,
      lineNumber: 10,
      deliveryNumber: null,
      deliveryLineNumber: null,
      orderNumber: order.orderNumber,
      orderLineNumber: orderLine.lineNumber,
      materialNumber: orderLine.materialNumber,
      billingQuantity: billed.toFixed(3),
      netPrice: billed > 0 ? round4((netTotal * orderLine.priceUnit) / billed) : '0',
      priceUnit: orderLine.priceUnit,
      netAmount: round2(netTotal),
      taxCode: orderLine.taxCode,
      taxRate: round4(netTotal > 0 ? (taxTotal / netTotal) * 100 : 0),
      taxAmount: round2(taxTotal),
      conditionNumber: orderLine.conditionNumber,
      createdBy: changedBy,
    });

    await tx.insert(salesDownPaymentRequest).values({
      client,
      billingNumber: number,
      orderNumber: order.orderNumber,
      orderLineNumber: orderLine.lineNumber,
      dateNumber,
      requestNumber: requested.requestNumber,
      customerNumber,
      companyCode: order.companyCode,
      currency: order.currency,
      amount: round2(amount),
      status: 'OPEN',
      createdBy: changedBy,
    });

    // The partners of the request document, from the order: it has no delivery to carry them, and the
    // payer it was asked of is the payer the invoice will be raised against.
    if (partners) {
      await writeDocumentPartners(tx, {
        client, documentCategory: 'BILLING', documentNumber: number, partners, changedBy,
      });
    }

    // The date is asked for inside the transaction that raised the document: a document that stood
    // while its date stayed open would be asked for again the next time the due list was read.
    await markPlanDateBilled(tx, {
      client, orderNumber: order.orderNumber, orderLineNumber: orderLine.lineNumber,
      dateNumber, billingNumber: number, changedBy,
    });

    await recordChange(tx, {
      client, objectClass: DOWN_PAYMENT_OBJECT_CLASS, objectKey: number,
      changeType: 'CREATE', changedBy,
      after: {
        order: order.orderNumber,
        item: String(orderLine.lineNumber),
        planDate: String(dateNumber),
        share: `${date.percentage}%`,
        customer: customerNumber,
        requestNumber: requested.requestNumber,
        indicator: chosen.indicator,
        targetIndicator: chosen.targetIndicator,
        amount: round2(amount),
        currency: order.currency,
        dueDate,
      },
      fieldLabels: {
        planDate: 'Plan date', share: 'Share of the item', requestNumber: 'Accounting request',
        indicator: 'Request indicator', targetIndicator: 'Receipt indicator', amount: 'Amount asked',
      },
    });

    return {
      billingNumber: number,
      requestNumber: requested.requestNumber,
      indicator: chosen.indicator,
      targetIndicator: chosen.targetIndicator,
      customerNumber,
      companyCode: order.companyCode,
      currency: order.currency,
      amount: round2(amount),
      dueDate,
      orderNumber: order.orderNumber,
      orderLineNumber: orderLine.lineNumber,
      dateNumber,
      replayed: false,
    };
  });
}

/**
 * Withdraw an advance that was asked for and never paid.
 *
 * The request document is cancelled, the date is released, and the noted item stops answering — a
 * noted item that stood would let a receipt be allocated to it for years, and a customer no longer
 * being asked must not be able to pay. Money that has arrived cannot be withdrawn away: it stands on
 * the customer's special G/L account and is settled the way an advance is settled, by clearing it
 * against what is owed.
 */
export async function cancelDownPaymentRequest(
  raw: DownPaymentCancelInput,
): Promise<{ billingNumber: string; requestNumber: string; releasedDate: number | null }> {
  const parsed = downPaymentCancelInput.parse(raw);
  const { client, billingNumber, changedBy } = parsed;
  return withTenant(client, async (tx) => {
    const [raised] = await tx.select().from(salesDownPaymentRequest).where(and(
      eq(salesDownPaymentRequest.client, client),
      eq(salesDownPaymentRequest.billingNumber, billingNumber),
    )).limit(1);
    if (!raised) {
      throw new DownPaymentError(
        `Billing document ${billingNumber} is not a down payment request in this tenant.`,
        'Cancel a request document — one raised from a plan date maintained as a down payment.',
      );
    }
    if (raised.status === 'CANCELLED') {
      throw new DownPaymentError(
        `Down payment request ${billingNumber} already stands withdrawn.`,
        'A withdrawn request answers nothing, and is not withdrawn twice.',
      );
    }
    if (raised.status === 'CLEARED') {
      throw new DownPaymentError(
        `Down payment request ${billingNumber} was cleared against an invoice of order ${raised.orderNumber}, so the advance has already been settled.`,
        'A cleared advance is undone by cancelling the invoice that consumed it, not by withdrawing the request.',
      );
    }
    const [request] = await tx.select().from(customerDownPaymentRequest).where(and(
      eq(customerDownPaymentRequest.client, client),
      eq(customerDownPaymentRequest.requestNumber, raised.requestNumber),
    )).limit(1);
    const received = request ? await fulfilledSoFar(tx, client, raised.requestNumber) : 0;
    if (received > 0.005) {
      throw new DownPaymentError(
        `Down payment request ${billingNumber} has ${received.toFixed(2)} ${raised.currency} of receipts standing against it, so it cannot be withdrawn.`,
        'Clear the advance against an invoice of the order, which is how a paid advance is settled.',
      );
    }

    await tx.update(salesDownPaymentRequest).set({
      status: 'CANCELLED', changedBy, changedAt: new Date(),
    }).where(and(
      eq(salesDownPaymentRequest.client, client),
      eq(salesDownPaymentRequest.billingNumber, billingNumber),
    ));
    await tx.update(billingDocument).set({
      status: 'CANCELLED', changedBy, changedAt: new Date(),
    }).where(and(
      eq(billingDocument.client, client),
      eq(billingDocument.billingNumber, billingNumber),
    ));
    // The date is released, as a cancelled invoice releases the delivery it stands against: the
    // corrected request can be raised against it.
    await releasePlanDateForBilling(tx, { client, billingNumber, changedBy });

    if (request) {
      await reverseCustomerDownPaymentRequestTx(tx, {
        client, changedBy, requestNumber: raised.requestNumber,
        reason: parsed.reason ?? `Withdrawn with request document ${billingNumber}.`,
      }).catch((caught: unknown) => {
        const error = caught as { message?: string };
        throw new DownPaymentError(
          `The request document stands withdrawn, but the accounting noted item would not stop answering: ${error?.message ?? 'the reversal was refused.'}`,
          'Withdraw it again: the documents are already cancelled, and the retry finishes the act.',
        );
      });
    }

    await recordChange(tx, {
      client, objectClass: DOWN_PAYMENT_OBJECT_CLASS, objectKey: billingNumber,
      changeType: 'CHANGE', changedBy, reason: parsed.reason,
      before: { status: raised.status, amount: round2(Number(raised.amount)), requestNumber: raised.requestNumber },
      after: { status: 'CANCELLED' },
      fieldLabels: { amount: 'Amount asked', requestNumber: 'Accounting request', status: 'Where it stands' },
    });

    return { billingNumber, requestNumber: raised.requestNumber, releasedDate: raised.dateNumber };
  });
}

/** One advance asked for on an order, and where the money stands. */
export interface OrderDownPayment {
  billingNumber: string;
  requestNumber: string;
  orderNumber: string;
  orderLineNumber: number;
  dateNumber: number;
  customerNumber: string;
  companyCode: string;
  currency: string;
  amount: string;
  /** What the customer has paid against it, derived from the receipts allocated to the request. */
  received: string;
  status: DownPaymentRequestStatus;
  /** The accounting request's own status, where it still stands. */
  requestStatus: string | null;
}

/**
 * The advances of an order: what was asked, what arrived, and where each one stands.
 *
 * The register is read from the rows rather than from a stored total, and the received amount is what
 * the accounting engine says was allocated to the request — the receipts themselves are accounting's
 * own documents and are not restated here.
 */
export async function orderDownPayments(client: string, orderNumber: string): Promise<OrderDownPayment[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(salesDownPaymentRequest).where(and(
      eq(salesDownPaymentRequest.client, client),
      eq(salesDownPaymentRequest.orderNumber, orderNumber),
    )).orderBy(asc(salesDownPaymentRequest.dateNumber), asc(salesDownPaymentRequest.billingNumber));
    const out: OrderDownPayment[] = [];
    for (const row of rows) {
      const [request] = await tx.select().from(customerDownPaymentRequest).where(and(
        eq(customerDownPaymentRequest.client, client),
        eq(customerDownPaymentRequest.requestNumber, row.requestNumber),
      )).limit(1);
      const received = row.status === 'CANCELLED' ? 0 : await fulfilledSoFar(tx, client, row.requestNumber);
      out.push({
        billingNumber: row.billingNumber,
        requestNumber: row.requestNumber,
        orderNumber: row.orderNumber,
        orderLineNumber: row.orderLineNumber,
        dateNumber: row.dateNumber,
        customerNumber: row.customerNumber,
        companyCode: row.companyCode,
        currency: row.currency,
        amount: round2(Number(row.amount)),
        received: round2(received),
        status: row.status as DownPaymentRequestStatus,
        requestStatus: request?.status ?? null,
      });
    }
    return out;
  });
}

/** What an invoice consumed of the advances that stood for its order. */
export interface DownPaymentClearing {
  cleared: string;
  clearingNumber: string | null;
  /** Where nothing could be cleared and the reason stands: the invoice still stands, unbilled of it. */
  error: string | null;
}

/**
 * Clear the advances of an order against an invoice that has just been posted.
 *
 * Called from the one finish both create paths share, so a document raised against a delivery and one
 * raised against a plan date settle the advance the same way. The allocation takes the lesser of what
 * an advance still stands at and what the invoice still stands open at, both derived from posted lines,
 * and it stops when either is exhausted.
 *
 * A failure here does not undo the invoice. The receivable stands, the document is posted, and the
 * advance remains where it is — to be cleared later, which is exactly what an accountant would do with
 * it by hand. Saying so in the result is what stops the money being quietly forgotten.
 */
export async function clearDownPaymentsForInvoice(input: {
  client: string;
  changedBy: string;
  orderNumber: string;
  billingNumber: string;
  journalDocumentNumber: string;
  customerNumber: string;
  companyCode: string;
  currency: string;
  postingDate: string;
}): Promise<DownPaymentClearing> {
  const { client, orderNumber, billingNumber, journalDocumentNumber } = input;
  const empty: DownPaymentClearing = { cleared: '0.00', clearingNumber: null, error: null };
  return withTenant(client, async (tx) => {
    const standing = await tx.select().from(salesDownPaymentRequest).where(and(
      eq(salesDownPaymentRequest.client, client),
      eq(salesDownPaymentRequest.orderNumber, orderNumber),
    )).orderBy(asc(salesDownPaymentRequest.dateNumber), asc(salesDownPaymentRequest.billingNumber));
    if (standing.length === 0) return empty;

    // One clearing view per indicator, and one clearing per indicator: an order whose advances were
    // asked under two indicators settles each against its own account.
    const byIndicator = new Map<string, typeof standing>();
    for (const row of standing) {
      const [request] = await tx.select().from(customerDownPaymentRequest).where(and(
        eq(customerDownPaymentRequest.client, client),
        eq(customerDownPaymentRequest.requestNumber, row.requestNumber),
      )).limit(1);
      const indicator = request?.targetSpecialGlIndicator ?? '';
      if (!indicator) continue;
      const list = byIndicator.get(indicator) ?? [];
      list.push(row);
      byIndicator.set(indicator, list);
    }

    let clearedTotal = 0;
    let clearingNumber: string | null = null;
    let failure: string | null = null;

    for (const [indicator, requested] of byIndicator) {
      if (failure) break;
      // The requests of this indicator that money has actually arrived against, and the posted lines
      // that money landed on. A request nobody has paid has nothing to clear, and is not offered.
      const advances = new Map<string, ClearingItemRef[]>();
      for (const row of requested) {
        const lines = await advanceLines(tx, client, row.requestNumber);
        if (lines.length === 0) continue;
        advances.set(row.requestNumber, lines);
      }
      if (advances.size === 0) continue;

      let view;
      try {
        view = await getCustomerDownPaymentClearingTx(tx, client, input.customerNumber, input.companyCode, indicator);
      } catch {
        // Nothing stands to be cleared under this indicator — no configuration, no advance, no
        // receivable. An order with an advance asked but nothing received into is the ordinary case.
        continue;
      }
      const invoice = view.invoices.find((row) => row.documentNumber === journalDocumentNumber);
      if (!invoice || !(invoice.remaining > 0.005)) continue;

      // What each of those advances still stands at, read from the account it landed on rather than
      // from anything the sale remembers: a line already spent by an earlier clearing no longer stands.
      const open = new Map<string, ClearingItemRef & { remaining: number }>();
      for (const lines of advances.values()) {
        for (const row of view.downPayments) {
          if (!lines.some((line) => line.documentNumber === row.documentNumber
            && line.fiscalYear === row.fiscalYear && line.lineNumber === row.lineNumber)) continue;
          open.set(`${row.documentNumber}/${row.fiscalYear}/${row.lineNumber}`, {
            documentNumber: row.documentNumber, fiscalYear: row.fiscalYear,
            lineNumber: row.lineNumber, remaining: row.remaining,
          });
        }
      }
      if (open.size === 0) continue;

      const allocations: ClearingAllocation[] = [];
      let left = invoice.remaining;
      for (const advance of open.values()) {
        if (left <= 0.005) break;
        const amount = Number(round2(Math.min(advance.remaining, left)));
        if (!(amount > 0)) continue;
        allocations.push({
          downPayment: {
            documentNumber: advance.documentNumber, fiscalYear: advance.fiscalYear,
            lineNumber: advance.lineNumber,
          },
          invoice: {
            documentNumber: invoice.documentNumber, fiscalYear: invoice.fiscalYear,
            lineNumber: invoice.lineNumber,
          },
          amount,
        });
        left = Number(round2(left - amount));
      }
      if (allocations.length === 0) continue;

      try {
        const posted = await clearCustomerDownPaymentsTx(tx, {
          client, changedBy: input.changedBy,
          customerNumber: input.customerNumber, companyCode: input.companyCode,
          indicator,
          documentDate: input.postingDate, postingDate: input.postingDate,
          clearingDate: input.postingDate,
          currency: input.currency,
          reference: billingNumber.slice(0, 16),
          requestKey: `sd-dpc-${client}-${billingNumber}-${indicator}`.slice(0, 64),
          allocations,
        });
        clearedTotal = Number(round2(clearedTotal + Number(posted.totalApplied)));
        clearingNumber = posted.clearingNumber;
      } catch (caught) {
        const error = caught as { message?: string; remedy?: string };
        failure = error?.message ?? 'the clearing was refused.';
        continue;
      }

      // A request whose every advance has been consumed stands cleared. The rest stay open, because
      // the money that arrived against them has not yet been settled.
      for (const requestNumber of advances.keys()) {
        const remaining = await remainingForTx(tx, client, requestNumber, indicator,
          input.customerNumber, input.companyCode);
        if (remaining <= 0.005) {
          await tx.update(salesDownPaymentRequest).set({
            status: 'CLEARED', changedBy: input.changedBy, changedAt: new Date(),
          }).where(and(
            eq(salesDownPaymentRequest.client, client),
            eq(salesDownPaymentRequest.requestNumber, requestNumber),
          ));
        }
      }
    }

    if (clearedTotal > 0) {
      await tx.update(billingDocument).set({
        downPaymentClearingNumber: clearingNumber,
        downPaymentClearedAmount: round2(clearedTotal),
        changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(billingDocument.client, client),
        eq(billingDocument.billingNumber, billingNumber),
      ));
      await recordChange(tx, {
        client, objectClass: DOWN_PAYMENT_OBJECT_CLASS, objectKey: billingNumber,
        changeType: 'CHANGE', changedBy: input.changedBy,
        after: {
          billingNumber, cleared: round2(clearedTotal), clearingNumber: clearingNumber ?? '',
          currency: input.currency,
        },
        fieldLabels: {
          billingNumber: 'Invoice', cleared: 'Advance cleared', clearingNumber: 'Clearing document',
        },
      });
    }

    return {
      cleared: round2(clearedTotal),
      clearingNumber,
      error: failure,
    };
  });
}

/** What a request's advances still stand at, read from the open items of the account they landed on. */
async function remainingForTx(
  tx: Tx, client: string, requestNumber: string, indicator: string,
  customerNumber: string, companyCode: string,
): Promise<number> {
  const lines = await advanceLines(tx, client, requestNumber);
  if (lines.length === 0) return 0;
  let view;
  try {
    view = await getCustomerDownPaymentClearingTx(tx, client, customerNumber, companyCode, indicator);
  } catch {
    return 0;
  }
  return Number(round2(view.downPayments
    .filter((row) => lines.some((line) => line.documentNumber === row.documentNumber
      && line.fiscalYear === row.fiscalYear && line.lineNumber === row.lineNumber))
    .reduce((sum, row) => sum + row.remaining, 0)));
}

/** The posted lines the receipts allocated to a request landed on. */
async function advanceLines(
  tx: Tx, client: string, requestNumber: string,
): Promise<Array<{ documentNumber: string; fiscalYear: number; lineNumber: number }>> {
  return tx.select({
    documentNumber: downPaymentRequestFulfillment.actualDocumentNumber,
    fiscalYear: downPaymentRequestFulfillment.actualFiscalYear,
    lineNumber: downPaymentRequestFulfillment.actualLineNumber,
  }).from(downPaymentRequestFulfillment).where(and(
    eq(downPaymentRequestFulfillment.client, client),
    eq(downPaymentRequestFulfillment.requestNumber, requestNumber),
    eq(downPaymentRequestFulfillment.status, 'ACTIVE'),
  ));
}
