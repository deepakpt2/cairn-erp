/**
 * Incoming payment entry and allocation — SCR-068 / R-116.
 *
 * A receipt allocates in full against the customer's open
 * receivable items: the bank debits, the customer credits per
 * allocation, and every settled item clears in place under the
 * payment document and the clearing date. The allocation must
 * equal the receipt — a difference is named, never discarded.
 * Partial, residual and on-account outcomes stand deferred.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { customerCompany } from '../foundation/customer-company-schema';
import { customerInvoice } from '../purchasing/schema';
import { incomingPayment, journalEntry, journalEntryLine } from './schema';

export const INCOMING_PAYMENT_CAPABILITY = 'FIN.AR.PAYMENT.ENTER';
const JOURNAL_DOCUMENT_TYPE = 'DZ';
const PAYMENT_CLASS = 'incoming_payment';

export class IncomingPaymentError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'IncomingPaymentError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export interface ReceivableItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  currency: string;
  amount: string;
  signed: number;
}

export interface IncomingPaymentView {
  customer: string;
  companyCode: string;
  openItems: ReceivableItem[];
  openBalance: number;
}

async function judgeCustomer(tx: Tx, client: string, customerNumber: string, companyCode: string) {
  const [standing] = await tx.select().from(customerCompany).where(and(
    eq(customerCompany.client, client),
    eq(customerCompany.partnerNumber, customerNumber),
    eq(customerCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new IncomingPaymentError(
      `Customer ${customerNumber} does not stand extended to company ${companyCode}.`,
      'Extend the customer to the company code, then enter the payment.',
    );
  }
  if (standing.isBlocked) throw new IncomingPaymentError(`Customer ${customerNumber} is blocked for company ${companyCode}.`);
  if (!standing.reconciliationAccount) {
    throw new IncomingPaymentError(
      `Customer ${customerNumber} carries no reconciliation account in company ${companyCode}.`,
      'Maintain the customer company data, then enter the payment.',
    );
  }
  return standing;
}

export async function getReceivables(
  client: string, customerNumber: string, companyCode: string,
): Promise<IncomingPaymentView> {
  return withTenant(client, async (tx) => {
    await judgeCustomer(tx, client, customerNumber, companyCode);
    const dueDates = new Map<string, string>();
    for (const inv of await tx.select().from(customerInvoice).where(eq(customerInvoice.client, client))) {
      if (inv.dueDate) dueDates.set(inv.invoiceNumber, inv.dueDate);
    }
    const rows = await tx.select({
      documentNumber: journalEntryLine.documentNumber,
      fiscalYear: journalEntryLine.fiscalYear,
      lineNumber: journalEntryLine.lineNumber,
      postingDate: journalEntry.postingDate,
      originClass: journalEntry.originClass,
      originKey: journalEntry.originKey,
      currency: journalEntryLine.currency,
      amount: journalEntryLine.amountLocal,
      debitCredit: journalEntryLine.debitCredit,
    }).from(journalEntryLine)
      .innerJoin(journalEntry, and(
        eq(journalEntry.client, journalEntryLine.client),
        eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
        eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
      ))
      .where(and(
        eq(journalEntryLine.client, client),
        eq(journalEntryLine.companyCode, companyCode),
        eq(journalEntryLine.businessPartner, customerNumber),
        eq(journalEntryLine.debitCredit, 'S'),
        eq(journalEntry.status, 'POSTED'),
        sql`${journalEntryLine.clearingDocument} is null`,
      ))
      .orderBy(journalEntry.postingDate, journalEntryLine.documentNumber);
    const openItems = rows.map((r) => ({
      documentNumber: r.documentNumber, fiscalYear: r.fiscalYear, lineNumber: r.lineNumber,
      postingDate: r.postingDate,
      dueDate: r.originClass === 'customer_invoice' && r.originKey
        ? (dueDates.get(r.originKey) ?? r.postingDate)
        : r.postingDate,
      currency: r.currency, amount: r.amount, signed: Number(r.amount),
    }));
    return {
      customer: customerNumber, companyCode, openItems,
      openBalance: round4(openItems.reduce((s, i) => s + i.signed, 0)),
    };
  });
}

export interface PaymentItemRef { documentNumber: string; fiscalYear: number; lineNumber: number }

export interface PostedPayment {
  paymentNumber: string;
  journalDocumentNumber: string;
  amount: string;
  itemsCleared: number;
  clearingDate: string;
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<PostedPayment | null> {
  const [row] = await tx.select().from(incomingPayment).where(and(
    eq(incomingPayment.client, client), eq(incomingPayment.requestKey, requestKey),
  ));
  return row ? {
    paymentNumber: row.paymentNumber, journalDocumentNumber: row.journalDocumentNumber,
    amount: row.amount, itemsCleared: row.itemsCleared, clearingDate: row.clearingDate,
  } : null;
}

export async function postIncomingPayment(input: {
  client: string; changedBy: string;
  customerNumber: string; companyCode: string;
  documentDate: string; postingDate: string; clearingDate: string;
  bankGlAccount: string; amount: number; currency: string;
  reference?: string; requestKey: string;
  items: PaymentItemRef[];
}): Promise<PostedPayment> {
  if (input.items.length === 0) {
    throw new IncomingPaymentError('Select at least one open item to settle.', 'Tick the items this receipt settles.');
  }
  if (!(input.amount > 0)) throw new IncomingPaymentError('The incoming amount must stand above zero.');
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate], ['Clearing date', input.clearingDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new IncomingPaymentError(`${label} ${value} is not a calendar date.`);
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/incpay/${input.companyCode}/${input.customerNumber}`}, 0))`);
    const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
    if (replayLocked) return replayLocked;

    const customer = await judgeCustomer(tx, input.client, input.customerNumber, input.companyCode);
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new IncomingPaymentError(`Company code ${input.companyCode} is not configured.`);

    interface Held { ref: PaymentItemRef; amount: string; currency: string }
    const held: Held[] = [];
    for (const ref of input.items) {
      const [line] = await tx.select().from(journalEntryLine).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, ref.documentNumber),
        eq(journalEntryLine.fiscalYear, ref.fiscalYear),
        eq(journalEntryLine.lineNumber, ref.lineNumber),
      ));
      if (!line || line.businessPartner !== input.customerNumber || line.companyCode !== input.companyCode || line.debitCredit !== 'S') {
        throw new IncomingPaymentError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} is not an open receivable of customer ${input.customerNumber} in company ${input.companyCode}.`,
          'Reload the open items, then post.',
        );
      }
      if (line.clearingDocument) {
        throw new IncomingPaymentError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} already stands cleared by ${line.clearingDocument}.`,
          'Reload the open items, then post.',
        );
      }
      held.push({ ref, amount: line.amountLocal, currency: line.currency });
    }

    const currencies = [...new Set([...held.map((h) => h.currency), input.currency.toUpperCase()])];
    if (currencies.length > 1) {
      throw new IncomingPaymentError(
        `The payment and its items stand in ${currencies.join(' and ')}; one payment settles one currency.`,
        'Allocate items in the payment currency.',
      );
    }
    const allocated = round4(held.reduce((s, h) => s + Number(h.amount), 0));
    const difference = round4(allocated - input.amount);
    if (difference !== 0) {
      throw new IncomingPaymentError(
        `The allocation does not equal the receipt: allocated ${allocated.toFixed(2)} against an incoming amount of ${round4(input.amount).toFixed(2)} leaves a difference of ${difference.toFixed(2)} ${currencies[0]}.`,
        'Allocate items equalling the receipt; partial, residual and on-account outcomes stand deferred.',
      );
    }

    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: input.companyCode,
      documentType: JOURNAL_DOCUMENT_TYPE,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: currencies[0],
      localCurrency: company.currency,
      reference: input.reference,
      headerText: `Incoming payment ${input.customerNumber}`,
      lines: [
        { glAccount: input.bankGlAccount, debitCredit: 'S' as const, amount: round4(input.amount).toFixed(2) },
        ...held.map((h) => ({
          glAccount: customer.reconciliationAccount!, debitCredit: 'H' as const,
          amount: Number(h.amount).toFixed(2), businessPartner: input.customerNumber,
        })),
      ],
      origin: { documentClass: PAYMENT_CLASS, documentKey: `${input.companyCode}/${input.customerNumber}` },
      postedBy: input.changedBy,
      transactionCode: INCOMING_PAYMENT_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new IncomingPaymentError(error.message, error.remedy);
      throw error;
    });

    for (const h of held) {
      await tx.update(journalEntryLine).set({
        clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
      }).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, h.ref.documentNumber),
        eq(journalEntryLine.fiscalYear, h.ref.fiscalYear),
        eq(journalEntryLine.lineNumber, h.ref.lineNumber),
      ));
    }
    // The payment's own customer lines stand cleared against the same document.
    await tx.update(journalEntryLine).set({
      clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
    }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.documentNumber, journal.documentNumber),
      eq(journalEntryLine.fiscalYear, journal.fiscalYear),
      eq(journalEntryLine.businessPartner, input.customerNumber),
    ));

    const paymentNumber = journal.documentNumber;
    await tx.insert(incomingPayment).values({
      client: input.client, paymentNumber, fiscalYear: journal.fiscalYear,
      customerNumber: input.customerNumber, companyCode: input.companyCode,
      documentDate: input.documentDate, postingDate: input.postingDate, clearingDate: input.clearingDate,
      bankGlAccount: input.bankGlAccount, amount: String(round4(input.amount)),
      currency: currencies[0], reference: input.reference ?? null,
      journalDocumentNumber: journal.documentNumber, itemsCleared: held.length,
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: PAYMENT_CLASS,
      objectKey: `${input.companyCode}/${input.customerNumber}/${paymentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: INCOMING_PAYMENT_CAPABILITY,
      after: { journal: journal.documentNumber, amount: round4(input.amount), items: held.length },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}
