/**
 * The credit memo: SAP's G2, the document that gives the customer their money back.
 *
 * The returns chain can take goods back and put them in returns stock, but until this document exists the
 * customer is still invoiced for them. A credit memo is a billing document raised against an invoice,
 * carrying the value back the other way — which is why the value here is negative and the quantity is not:
 * a credit is a positive number of goods being credited and a negative amount of money going back.
 *
 * The document is priced from the original billing line, not from a condition record. That is the whole
 * point of it: a credit settles what was invoiced, at the price that was invoiced, and a price
 * renegotiated since is no part of what the customer is owed back. What is copied is the price, the tax,
 * the unit and the material; what is asked is the quantity.
 *
 * The receivable half is not this module's to write. The accounting credit — the customer invoice of
 * category CREDIT_MEMO and the journal that credits the reconciliation account and debits revenue —
 * belongs to the finance service that owns it, and is asked for here rather than re-implemented. What
 * this module knows is which revenue account the invoice used, and that is the one it hands over, so the
 * reversal travels the same account determination the revenue did.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import {
  CustomerCreditMemoError, postCustomerCreditMemo,
} from '../finance/customer-credit-memo';
import { salesOrderLine, billingDocument, billingDocumentLine } from './schema';
import {
  STANDARD_CREDIT_MEMO_TYPE, DOCUMENT_TYPE_REMEDY, salesDocumentTypeFor,
} from './document-type';
import { revenueAccountFor } from './billing';

/** The transaction a credit memo records. No screen offers it yet, so no capability is bound. */
export const CREDIT_MEMO_TRANSACTION = 'SALES.CREDIT_MEMO.CREATE';

const BILLING_OBJECT_CLASS = 'billing_document';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreditMemoError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CreditMemoError';
    this.remedy = remedy;
  }
}

/** What the user enters for one item: the invoiced line being credited, and how much of it. */
export interface CreditMemoLineInput {
  /** The line of the invoice being credited. */
  billingLineNumber: number;
  /** How much of that line is being credited, in the unit it was invoiced in. */
  quantity: number;
}

export interface CreateCreditMemoInput {
  client: string;
  changedBy: string;
  requestKey: string;
  /** The invoice being credited. It must stand posted: there is no crediting what was never charged. */
  billingNumber: string;
  billingDate: string;
  headerText?: string;
  items: CreditMemoLineInput[];
}

export interface PostCreditMemoInput {
  client: string;
  changedBy: string;
  /** The credit memo being posted. */
  billingNumber: string;
  expectedVersion: number;
  postingDate: string;
  requestKey: string;
}

function round2(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function quantityDecimals(value: number): number {
  const text = String(value);
  const point = text.indexOf('.');
  return point < 0 ? 0 : text.length - point - 1;
}

function validateCreditMemoInput(input: CreateCreditMemoInput): void {
  if (!ISO_DATE.test(input.billingDate)) {
    throw new CreditMemoError(
      `A credit memo is raised on a date, and ${input.billingDate} is not one.`,
      'Enter the date as YYYY-MM-DD.',
    );
  }
  if (input.items.length === 0) {
    throw new CreditMemoError(
      'A credit memo with no items credits nothing.',
      'Name at least one invoiced line, and how much of it is being credited.',
    );
  }
  const seen = new Set<number>();
  for (const item of input.items) {
    if (seen.has(item.billingLineNumber)) {
      throw new CreditMemoError(
        `Invoice line ${item.billingLineNumber} was named twice.`,
        'Name each invoiced line once; crediting a line twice is one item with a larger quantity.',
      );
    }
    seen.add(item.billingLineNumber);
    if (!(item.quantity > 0)) {
      throw new CreditMemoError(
        `A quantity of ${item.quantity} on invoice line ${item.billingLineNumber} credits nothing.`,
        'Enter how much of the invoiced line is being credited.',
      );
    }
    if (quantityDecimals(item.quantity) > 3) {
      throw new CreditMemoError(
        `A quantity of ${item.quantity} carries more decimals than a quantity can hold (3).`,
        'Enter the quantity with at most three decimal places.',
      );
    }
  }
}

/**
 * How much of one invoiced line has already been credited, over the credit memos that stand.
 *
 * A cancelled credit gives its quantity back, for the same reason a cancelled invoice stops standing: the
 * value it carried has been reversed, so the line is creditable again up to what was invoiced.
 */
async function quantityCreditedAgainst(
  tx: Tx,
  client: string,
  billingNumber: string,
  billingLineNumber: number,
): Promise<number> {
  const [row] = await tx.execute(sql`
    select coalesce(sum(l.billing_quantity), 0)::text as quantity
      from billing_document_line l
      join billing_document d on d.client = l.client and d.billing_number = l.billing_number
     where l.client = ${client}
       and d.document_type = ${STANDARD_CREDIT_MEMO_TYPE}
       and d.status <> 'CANCELLED'
       and l.reference_billing_number = ${billingNumber}
       and l.reference_billing_line_number = ${billingLineNumber}
  `) as unknown as Array<{ quantity: string }>;
  return Number(row?.quantity ?? '0');
}

/**
 * The invoice a credit may be raised against: standing, posted, and an invoice rather than another
 * credit or a cancellation. Shared with the returns order, which asks the same question for the same
 * reason — goods and money both come back against what was actually charged.
 */
async function requireCreditableInvoice(
  tx: Tx,
  client: string,
  billingNumber: string,
  refuse: (message: string, remedy: string) => never,
): Promise<typeof billingDocument.$inferSelect> {
  const [invoice] = await tx.select().from(billingDocument).where(and(
    eq(billingDocument.client, client), eq(billingDocument.billingNumber, billingNumber),
  )).limit(1);
  if (!invoice) {
    refuse(
      `Billing document ${billingNumber} does not stand for this tenant.`,
      'Raise the credit against an invoice that exists.',
    );
  }
  if (invoice.status === 'CANCELLED') {
    refuse(
      `Billing document ${billingNumber} stands cancelled, and a cancelled invoice has nothing left to credit.`,
      'Raise the credit against an invoice that stands.',
    );
  }
  // What the document is, before what state it is in: a credit memo is not an invoice whatever state
  // it stands in, and saying so first is the answer that tells whoever asked what to do about it.
  if (invoice.cancellationOf || invoice.creditOf) {
    refuse(
      `Billing document ${billingNumber} is ${invoice.creditOf ? 'a credit memo' : 'a cancellation'}, and a credit is raised against an invoice.`,
      'Name the invoice the customer was charged on.',
    );
  }
  if (invoice.status !== 'POSTED') {
    refuse(
      `Billing document ${billingNumber} stands ${invoice.status}, and a credit gives back what an invoice has charged — nothing has been charged yet.`,
      'Post the invoice first; an unposted document has raised no receivable to credit.',
    );
  }
  return invoice;
}

/**
 * Raise a credit memo against a posted invoice.
 *
 * Every figure is the invoice's, at the quantity being credited: the price, the tax rate, the unit and
 * the material are copied from the invoiced line, and the value is what those come to, negated — because
 * this document gives money back rather than taking it. The quantity is bounded by what was invoiced less
 * what has already been credited, so a line cannot be credited twice over, and the document is answered
 * idempotently when the same request arrives again.
 *
 * It is raised OPEN, like an invoice: nothing reaches the ledger until it is posted.
 */
export async function createCreditMemo(
  input: CreateCreditMemoInput,
): Promise<{ billingNumber: string; replayed: boolean; netValue: string; taxValue: string; grossValue: string }> {
  validateCreditMemoInput(input);
  return withTenant(input.client, async (tx) => {
    const type = await salesDocumentTypeFor(tx, input.client, STANDARD_CREDIT_MEMO_TYPE);
    if (!type) {
      throw new CreditMemoError(
        `Sales document type ${STANDARD_CREDIT_MEMO_TYPE} does not stand for this tenant, so no credit memo can be created.`,
        DOCUMENT_TYPE_REMEDY,
      );
    }

    const [standing] = await tx.select({ number: billingDocument.billingNumber }).from(billingDocument).where(and(
      eq(billingDocument.client, input.client), eq(billingDocument.requestKey, input.requestKey),
    )).limit(1);
    if (standing) {
      const [saved] = await tx.select().from(billingDocument).where(and(
        eq(billingDocument.client, input.client), eq(billingDocument.billingNumber, standing.number),
      ));
      return {
        billingNumber: standing.number, replayed: true,
        netValue: saved ? Number(saved.netValue).toFixed(2) : '0.00',
        taxValue: saved ? Number(saved.taxValue).toFixed(2) : '0.00',
        grossValue: saved ? Number(saved.grossValue).toFixed(2) : '0.00',
      };
    }

    const invoice = await requireCreditableInvoice(tx, input.client, input.billingNumber,
      (message, remedy) => { throw new CreditMemoError(message, remedy); });

    const invoiceLines = await tx.select().from(billingDocumentLine).where(and(
      eq(billingDocumentLine.client, input.client),
      eq(billingDocumentLine.billingNumber, input.billingNumber),
    ));
    const byNumber = new Map(invoiceLines.map((line) => [line.lineNumber, line]));

    const rows: Array<typeof billingDocumentLine.$inferInsert> = [];
    let lineNumber = 10;
    for (const item of input.items) {
      const billed = byNumber.get(item.billingLineNumber);
      if (!billed) {
        throw new CreditMemoError(
          `Billing document ${input.billingNumber} carries no line ${item.billingLineNumber}.`,
          'Name a line the invoice actually carries.',
        );
      }
      const already = await quantityCreditedAgainst(tx, input.client, input.billingNumber, item.billingLineNumber);
      const invoiced = Number(billed.billingQuantity);
      if (item.quantity > invoiced - already + 1e-9) {
        throw new CreditMemoError(
          `Invoice line ${item.billingLineNumber} billed ${invoiced}, of which ${already} has already been credited, so only ${invoiced - already} can be credited.`,
          'Credit no more than was invoiced; what was never charged cannot be given back.',
        );
      }
      // The unit the goods were sold in comes from the order line the invoice was raised from, which is
      // what a billing line does not carry; the price and the tax it does carry are the invoice's own.
      const [sold] = await tx.select().from(salesOrderLine).where(and(
        eq(salesOrderLine.client, input.client),
        eq(salesOrderLine.orderNumber, billed.orderNumber),
        eq(salesOrderLine.lineNumber, billed.orderLineNumber),
      )).limit(1);
      if (!sold) {
        throw new CreditMemoError(
          `Invoice line ${item.billingLineNumber} was raised from order item ${billed.orderLineNumber} of order ${billed.orderNumber}, which does not stand, so the credit has no unit to be credited in.`,
          'Credit an invoice whose order still stands.',
        );
      }

      const netAmount = round2((item.quantity * Number(billed.netPrice)) / billed.priceUnit);
      const taxAmount = round2((Number(netAmount) * Number(billed.taxRate)) / 100);
      rows.push({
        client: input.client, billingNumber: '', lineNumber,
        deliveryNumber: billed.deliveryNumber, deliveryLineNumber: billed.deliveryLineNumber,
        orderNumber: billed.orderNumber, orderLineNumber: billed.orderLineNumber,
        materialNumber: billed.materialNumber,
        billingQuantity: String(item.quantity),
        // A credit carries the same goods back at the same price, and its value is what goes back: the
        // price is negated so that quantity times price is the negative amount the document is worth.
        netPrice: (-Number(billed.netPrice)).toFixed(4), priceUnit: billed.priceUnit,
        netAmount: (-Number(netAmount)).toFixed(2),
        taxCode: billed.taxCode, taxRate: billed.taxRate,
        taxAmount: (-Number(taxAmount)).toFixed(2),
        conditionNumber: billed.conditionNumber,
        referenceBillingNumber: billed.billingNumber, referenceBillingLineNumber: billed.lineNumber,
        createdBy: input.changedBy,
      });
      lineNumber += 10;
    }

    // The value of a credit memo is what the customer is being given back, so every total is negative.
    const netValue = (-Number(round2(rows.reduce((sum, row) => sum + Math.abs(Number(row.netAmount)), 0)))).toFixed(2);
    const taxValue = (-Number(round2(rows.reduce((sum, row) => sum + Math.abs(Number(row.taxAmount)), 0)))).toFixed(2);
    const grossValue = (Number(netValue) + Number(taxValue)).toFixed(2);

    let number: string;
    try {
      const drawn = await allocateNumber(tx, {
        client: input.client, objectCode: type.numberRangeObject, companyCode: '*',
        subObject: type.numberRangeSubObject, fiscalYear: 0, allocatedBy: input.changedBy,
      });
      number = drawn.display;
    } catch {
      throw new CreditMemoError(
        `No active internal ${type.numberRangeObject} number range stands for sub-object ${type.numberRangeSubObject} of sales document type ${type.documentType}, so no credit memo number can be drawn.`,
        'Define or unblock the interval on the number ranges screen, then save again.',
      );
    }

    await tx.insert(billingDocument).values({
      client: input.client, billingNumber: number, documentType: type.documentType,
      orderNumber: invoice.orderNumber, deliveryNumber: invoice.deliveryNumber,
      salesOrg: invoice.salesOrg, distributionChannel: invoice.distributionChannel, division: invoice.division,
      customerNumber: invoice.customerNumber, companyCode: invoice.companyCode, currency: invoice.currency,
      billingDate: input.billingDate, postingDate: null,
      status: 'OPEN',
      netValue, taxValue, grossValue,
      referenceDocumentText: input.headerText?.trim() || `Credit against ${invoice.billingNumber}`.slice(0, 100),
      creditOf: invoice.billingNumber,
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    for (const row of rows) {
      await tx.insert(billingDocumentLine).values({ ...row, billingNumber: number });
    }

    await recordChange(tx, {
      client: input.client, objectClass: BILLING_OBJECT_CLASS, objectKey: number, changeType: 'CREATE',
      changedBy: input.changedBy, transactionCode: CREDIT_MEMO_TRANSACTION,
      after: {
        documentType: type.documentType, creditOf: invoice.billingNumber,
        items: rows.length, netValue, taxValue, grossValue, status: 'OPEN',
      },
      fieldLabels: { creditOf: 'Credits', items: 'Items' },
    });

    return { billingNumber: number, replayed: false, netValue, taxValue, grossValue };
  });
}

/**
 * Post a credit memo: the act that actually gives the money back.
 *
 * The accounting side is asked for rather than written here. The finance service raises the customer
 * invoice of category CREDIT_MEMO and posts the journal that credits the customer's reconciliation
 * account and debits revenue and tax — the mirror of the invoice — and it holds the credit to what the
 * original invoice still stands at. What it is told is the one thing it cannot know: which revenue
 * account to reverse, which is the same account determination the invoice was raised through.
 *
 * The sales document then carries the invoice and the journal that came of it, exactly as a posted
 * invoice does, so the chain can answer who gave what back and where it landed.
 */
export async function postCreditMemo(input: PostCreditMemoInput): Promise<{
  billingNumber: string;
  invoiceNumber: string;
  journalDocumentNumber: string;
}> {
  if (!ISO_DATE.test(input.postingDate)) {
    throw new CreditMemoError(
      `A credit memo is posted on a date, and ${input.postingDate} is not one.`,
      'Enter the posting date as YYYY-MM-DD.',
    );
  }
  return withTenant(input.client, async (tx) => {
    const [memo] = await tx.select().from(billingDocument).where(and(
      eq(billingDocument.client, input.client), eq(billingDocument.billingNumber, input.billingNumber),
    )).limit(1);
    if (!memo) {
      throw new CreditMemoError(
        `Billing document ${input.billingNumber} does not stand for this tenant.`,
        'Read the credit memo before posting it.',
      );
    }
    if (memo.documentType !== STANDARD_CREDIT_MEMO_TYPE) {
      throw new CreditMemoError(
        `Billing document ${input.billingNumber} is a ${memo.documentType}, and only a credit memo is posted as one.`,
        'Post the document the way its own type is posted — an invoice is posted, not credited.',
      );
    }
    if (memo.status === 'CANCELLED') {
      throw new CreditMemoError(
        `Credit memo ${input.billingNumber} stands cancelled, and a cancelled credit gives nothing back.`,
        'Raise a new credit memo.',
      );
    }
    if (memo.status === 'POSTED') {
      throw new CreditMemoError(
        `Credit memo ${input.billingNumber} is already posted${memo.customerInvoiceNumber ? ` as invoice ${memo.customerInvoiceNumber}` : ''}.`,
        'A credit memo is posted once; cancel it if what it gave back was wrong.',
      );
    }
    if (memo.version !== input.expectedVersion) {
      throw new CreditMemoError(
        `Credit memo ${input.billingNumber} changed since it was read (version ${memo.version}, expected ${input.expectedVersion}).`,
        'Reload the credit memo and post what stands now.',
      );
    }

    const lines = await tx.select().from(billingDocumentLine).where(and(
      eq(billingDocumentLine.client, input.client), eq(billingDocumentLine.billingNumber, input.billingNumber),
    )).orderBy(billingDocumentLine.lineNumber);
    if (lines.length === 0) {
      throw new CreditMemoError(
        `Credit memo ${input.billingNumber} carries no items, so there is nothing to give back.`,
        'Credit at least one invoiced line.',
      );
    }

    const revenueAccount = await revenueAccountFor(tx, input.client, memo.companyCode);

    // The profit centre that earned the revenue is the one that gives it back, and it lives on the order
    // line the invoice was raised from — a billing line carries the price, not the dimension behind it.
    const orderNumbers = [...new Set(lines.map((line) => line.orderNumber))];
    const orderLines = await tx.select().from(salesOrderLine).where(and(
      eq(salesOrderLine.client, input.client), inArray(salesOrderLine.orderNumber, orderNumbers),
    ));
    const profitCenters = new Map(
      orderLines.map((line) => [`${line.orderNumber}|${line.lineNumber}`, line.profitCenter]),
    );

    // The accounting credit is raised in the money the customer is being given back: positive amounts
    // on the finance side, where the direction is carried by the journal's own debit and credit.
    let credited: Awaited<ReturnType<typeof postCustomerCreditMemo>>;
    try {
      credited = await postCustomerCreditMemo({
        client: input.client, changedBy: input.changedBy,
        customerNumber: memo.customerNumber, companyCode: memo.companyCode,
        documentDate: memo.billingDate, postingDate: input.postingDate,
        reference: input.billingNumber, currency: memo.currency,
        grossAmount: Math.abs(Number(memo.grossValue)),
        creditOfBilling: memo.creditOf ?? undefined,
        headerText: memo.referenceDocumentText ?? undefined,
        requestKey: `credit-memo/${input.billingNumber}/${input.requestKey}`,
        lines: lines.map((line) => ({
          glAccount: revenueAccount, netAmount: Math.abs(Number(line.netAmount)),
          taxCode: line.taxCode, lineText: line.materialNumber,
          profitCenter: profitCenters.get(`${line.orderNumber}|${line.orderLineNumber}`) ?? undefined,
        })),
      });
    } catch (error) {
      if (error instanceof CustomerCreditMemoError) throw new CreditMemoError(error.message, error.remedy);
      throw error;
    }

    await tx.update(billingDocument).set({
      status: 'POSTED',
      postingDate: input.postingDate,
      customerInvoiceNumber: credited.invoiceNumber,
      journalDocumentNumber: credited.journalDocumentNumber,
      version: memo.version + 1,
    }).where(and(
      eq(billingDocument.client, input.client), eq(billingDocument.billingNumber, input.billingNumber),
    ));

    await recordChange(tx, {
      client: input.client, objectClass: BILLING_OBJECT_CLASS, objectKey: input.billingNumber,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: CREDIT_MEMO_TRANSACTION,
      before: { status: memo.status },
      after: {
        status: 'POSTED', invoice: credited.invoiceNumber,
        journal: credited.journalDocumentNumber ?? '', value: memo.grossValue,
      },
      fieldLabels: { invoice: 'Credit invoice', journal: 'Journal', value: 'Value credited' },
    });

    return {
      billingNumber: input.billingNumber,
      invoiceNumber: credited.invoiceNumber,
      journalDocumentNumber: credited.journalDocumentNumber ?? '',
    };
  });
}
