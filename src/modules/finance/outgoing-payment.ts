/**
 * Outgoing payment entry and allocation — SCR-078 / R-126.
 *
 * A payment allocates in full against the vendor's open payable
 * items: the vendor debits per allocation, the bank credits, and
 * every settled item clears in place under the payment document
 * and the clearing date. Credit items — the vendor side of credit
 * memos — count against the payment, so the selected items net.
 * The net allocation must equal the payment — a difference is
 * named, never discarded. Partial, residual, discount and
 * on-account outcomes stand deferred, as with incoming payment.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { supplierCompany } from '../foundation/supplier-company-schema';
import {
  journalEntry, journalEntryLine, outgoingPayment, vendorInvoice,
} from './schema';

export const OUTGOING_PAYMENT_CAPABILITY = 'FIN.AP.PAYMENT.POST';
const JOURNAL_DOCUMENT_TYPE = 'KZ';
const PAYMENT_CLASS = 'outgoing_payment';

export class OutgoingPaymentError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'OutgoingPaymentError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

// ── Open items ─────────────────────────────────────────────────────────

export interface PayableItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  currency: string;
  amount: string;
  /** Credit payables positive; debit credit items negative. */
  signed: number;
}

export interface OutgoingPaymentView {
  vendor: string;
  companyCode: string;
  openItems: PayableItem[];
  openBalance: number;
}

async function judgeVendor(tx: Tx, client: string, vendorNumber: string, companyCode: string) {
  const [standing] = await tx.select().from(supplierCompany).where(and(
    eq(supplierCompany.client, client),
    eq(supplierCompany.partnerNumber, vendorNumber),
    eq(supplierCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new OutgoingPaymentError(
      `Vendor ${vendorNumber} does not stand extended to company ${companyCode}.`,
      'Extend the vendor to the company code, then enter the payment.',
    );
  }
  if (standing.isBlocked) throw new OutgoingPaymentError(`Vendor ${vendorNumber} is blocked for company ${companyCode}.`);
  if (!standing.reconciliationAccount) {
    throw new OutgoingPaymentError(
      `Vendor ${vendorNumber} carries no reconciliation account in company ${companyCode}.`,
      'Maintain the vendor company data, then enter the payment.',
    );
  }
  return standing;
}

export async function getPayables(
  client: string, vendorNumber: string, companyCode: string,
): Promise<OutgoingPaymentView> {
  return withTenant(client, async (tx) => {
    const vendor = await judgeVendor(tx, client, vendorNumber, companyCode);
    const dueDates = new Map<string, string>();
    for (const inv of await tx.select().from(vendorInvoice).where(eq(vendorInvoice.client, client))) {
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
        eq(journalEntryLine.businessPartner, vendorNumber),
        eq(journalEntryLine.glAccount, vendor.reconciliationAccount!),
        eq(journalEntry.status, 'POSTED'),
        sql`${journalEntryLine.clearingDocument} is null`,
      ))
      .orderBy(journalEntry.postingDate, journalEntryLine.documentNumber);
    const openItems = rows.map((r) => ({
      documentNumber: r.documentNumber, fiscalYear: r.fiscalYear, lineNumber: r.lineNumber,
      postingDate: r.postingDate,
      dueDate: r.originClass === 'vendor_invoice' && r.originKey
        ? (dueDates.get(r.originKey) ?? r.postingDate)
        : r.postingDate,
      currency: r.currency, amount: r.amount,
      signed: r.debitCredit === 'H' ? Number(r.amount) : -Number(r.amount),
    }));
    return {
      vendor: vendorNumber, companyCode, openItems,
      openBalance: round4(openItems.reduce((s, i) => s + i.signed, 0)),
    };
  });
}

// ── Posting ────────────────────────────────────────────────────────────

export interface PaymentItemRef { documentNumber: string; fiscalYear: number; lineNumber: number }

export interface PostedOutgoingPayment {
  paymentNumber: string;
  journalDocumentNumber: string;
  amount: string;
  itemsCleared: number;
  clearingDate: string;
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<PostedOutgoingPayment | null> {
  const [row] = await tx.select().from(outgoingPayment).where(and(
    eq(outgoingPayment.client, client), eq(outgoingPayment.requestKey, requestKey),
  ));
  return row ? {
    paymentNumber: row.paymentNumber, journalDocumentNumber: row.journalDocumentNumber,
    amount: row.amount, itemsCleared: row.itemsCleared, clearingDate: row.clearingDate,
  } : null;
}

export async function postOutgoingPayment(input: {
  client: string; changedBy: string;
  vendorNumber: string; companyCode: string;
  documentDate: string; postingDate: string; clearingDate: string;
  bankGlAccount: string; amount: number; currency: string;
  reference?: string; valueDate?: string; requestKey: string;
  items: PaymentItemRef[];
}): Promise<PostedOutgoingPayment> {
  if (input.items.length === 0) {
    throw new OutgoingPaymentError('Select at least one open item to settle.', 'Tick the items this payment settles.');
  }
  if (!(input.amount > 0)) throw new OutgoingPaymentError('The payment amount must stand above zero.');
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate], ['Clearing date', input.clearingDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new OutgoingPaymentError(`${label} ${value} is not a calendar date.`);
  }
  if (input.valueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.valueDate)) {
    throw new OutgoingPaymentError(`Value date ${input.valueDate} is not a calendar date.`);
  }
  if (input.reference && input.reference.length > 16) {
    throw new OutgoingPaymentError('The reference may be at most 16 characters.', 'Shorten the cheque or transfer reference.');
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/outpay/${input.companyCode}/${input.vendorNumber}`}, 0))`);
    const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
    if (replayLocked) return replayLocked;

    const vendor = await judgeVendor(tx, input.client, input.vendorNumber, input.companyCode);
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new OutgoingPaymentError(`Company code ${input.companyCode} is not configured.`);

    interface Held { ref: PaymentItemRef; amount: string; currency: string; signed: number }
    const held: Held[] = [];
    for (const ref of input.items) {
      const [line] = await tx.select().from(journalEntryLine).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, ref.documentNumber),
        eq(journalEntryLine.fiscalYear, ref.fiscalYear),
        eq(journalEntryLine.lineNumber, ref.lineNumber),
      ));
      if (!line || line.businessPartner !== input.vendorNumber || line.companyCode !== input.companyCode
        || line.glAccount !== vendor.reconciliationAccount) {
        throw new OutgoingPaymentError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} is not an open payable of vendor ${input.vendorNumber} in company ${input.companyCode}.`,
          'Reload the open items, then post.',
        );
      }
      if (line.clearingDocument) {
        throw new OutgoingPaymentError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} already stands cleared by ${line.clearingDocument}.`,
          'Reload the open items, then post.',
        );
      }
      held.push({
        ref, amount: line.amountLocal, currency: line.currency,
        signed: line.debitCredit === 'H' ? Number(line.amountLocal) : -Number(line.amountLocal),
      });
    }

    const currencies = [...new Set([...held.map((h) => h.currency), input.currency.toUpperCase()])];
    if (currencies.length > 1) {
      throw new OutgoingPaymentError(
        `The payment and its items stand in ${currencies.join(' and ')}; one payment settles one currency.`,
        'Allocate items in the payment currency.',
      );
    }
    const allocated = round4(held.reduce((s, h) => s + h.signed, 0));
    const difference = round4(allocated - input.amount);
    if (difference !== 0) {
      throw new OutgoingPaymentError(
        `The allocation does not equal the payment: allocated ${allocated.toFixed(2)} against a payment of ${round4(input.amount).toFixed(2)} leaves a difference of ${difference.toFixed(2)} ${currencies[0]}.`,
        'Allocate items equalling the payment; partial, residual and on-account outcomes stand deferred.',
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
      headerText: `Outgoing payment ${input.vendorNumber}`,
      lines: [
        ...held.map((h) => ({
          glAccount: vendor.reconciliationAccount!, debitCredit: (h.signed >= 0 ? 'S' : 'H') as 'S' | 'H',
          amount: Number(h.amount).toFixed(2), businessPartner: input.vendorNumber,
        })),
        { glAccount: input.bankGlAccount, debitCredit: 'H' as const, amount: round4(input.amount).toFixed(2) },
      ],
      origin: { documentClass: PAYMENT_CLASS, documentKey: `${input.companyCode}/${input.vendorNumber}` },
      postedBy: input.changedBy,
      transactionCode: OUTGOING_PAYMENT_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new OutgoingPaymentError(error.message, error.remedy);
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
    // The payment's own vendor lines stand cleared against the same document.
    await tx.update(journalEntryLine).set({
      clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
    }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.documentNumber, journal.documentNumber),
      eq(journalEntryLine.fiscalYear, journal.fiscalYear),
      eq(journalEntryLine.businessPartner, input.vendorNumber),
    ));

    const paymentNumber = journal.documentNumber;
    await tx.insert(outgoingPayment).values({
      client: input.client, paymentNumber, fiscalYear: journal.fiscalYear,
      vendorNumber: input.vendorNumber, companyCode: input.companyCode,
      documentDate: input.documentDate, postingDate: input.postingDate, clearingDate: input.clearingDate,
      valueDate: input.valueDate ?? null,
      bankGlAccount: input.bankGlAccount, amount: String(round4(input.amount)),
      currency: currencies[0], reference: input.reference ?? null,
      journalDocumentNumber: journal.documentNumber, itemsCleared: held.length,
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: PAYMENT_CLASS,
      objectKey: `${input.companyCode}/${input.vendorNumber}/${paymentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: OUTGOING_PAYMENT_CAPABILITY,
      after: { journal: journal.documentNumber, amount: round4(input.amount), items: held.length },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}
