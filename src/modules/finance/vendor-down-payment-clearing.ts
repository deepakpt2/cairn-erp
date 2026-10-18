/**
 * Vendor down payment clearing — SCR-082 / R-130.
 *
 * Applies standing down payments to open vendor invoices by a
 * transfer posting (KZ): the ordinary reconciliation account
 * debits per invoice settled (`Settles …` lines), the indicator's
 * alternative account credits per down payment applied
 * (`Applied from …` lines), and the two applied totals must agree
 * — a clearing transfers value, it never creates it. An item
 * applied to its full remaining amount clears in place together
 * with its offsetting lines; an item applied in part keeps its
 * original line open beside the offsetting line, the pair netting
 * to the true remainder (the standing partial model). Remaining
 * amounts derive from the posted journal lines: the original line
 * less the offsetting lines naming it, never from a side table.
 * Replay by request key, revalidation under the advisory lock.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { supplierCompany } from '../foundation/supplier-company-schema';
import {
  journalEntry, journalEntryLine, vendorDownPayment, vendorDownPaymentClearing, vendorInvoice,
} from './schema';
import { resolveSpecialGlAccount } from './vendor-down-payment';

export const VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY = 'FIN.AP.DOWNPAYMENT.CLEAR';
const JOURNAL_DOCUMENT_TYPE = 'KZ';
const CLEARING_CLASS = 'vendor_down_payment_clearing';

export class VendorDownPaymentClearingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'VendorDownPaymentClearingError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const round2 = (n: number) => Math.round(n * 100) / 100;

async function judgeVendor(tx: Tx, client: string, vendorNumber: string, companyCode: string) {
  const [standing] = await tx.select().from(supplierCompany).where(and(
    eq(supplierCompany.client, client),
    eq(supplierCompany.partnerNumber, vendorNumber),
    eq(supplierCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new VendorDownPaymentClearingError(
      `Vendor ${vendorNumber} does not stand extended to company ${companyCode}.`,
      'Extend the vendor to the company code, then clear.',
    );
  }
  if (standing.isBlocked) throw new VendorDownPaymentClearingError(`Vendor ${vendorNumber} is blocked for company ${companyCode}.`);
  if (!standing.reconciliationAccount) {
    throw new VendorDownPaymentClearingError(
      `Vendor ${vendorNumber} carries no reconciliation account in company ${companyCode}.`,
      'Maintain the vendor company data, then clear.',
    );
  }
  return standing;
}

/** Signed sum of the offsetting lines naming an item, reversals netting out. */
async function appliedSoFar(
  tx: Tx, client: string, companyCode: string, account: string,
  partner: string, lineText: string, creditSide: boolean,
): Promise<number> {
  const rows = await tx.select({
    debitCredit: journalEntryLine.debitCredit, amount: journalEntryLine.amountLocal,
  }).from(journalEntryLine)
    .innerJoin(journalEntry, and(
      eq(journalEntry.client, journalEntryLine.client),
      eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
      eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
    ))
    .where(and(
      eq(journalEntryLine.client, client),
      eq(journalEntryLine.companyCode, companyCode),
      eq(journalEntryLine.glAccount, account),
      eq(journalEntryLine.businessPartner, partner),
      eq(journalEntryLine.lineText, lineText),
      eq(journalEntry.status, 'POSTED'),
    ));
  return round2(rows.reduce((s, r) => {
    const signed = creditSide
      ? (r.debitCredit === 'H' ? Number(r.amount) : -Number(r.amount))
      : (r.debitCredit === 'S' ? Number(r.amount) : -Number(r.amount));
    return s + signed;
  }, 0));
}

export interface DownPaymentItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  currency: string;
  amount: number;
  applied: number;
  remaining: number;
  indicator: string;
}

export interface ClearingInvoiceItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  currency: string;
  amount: number;
  applied: number;
  remaining: number;
}

export interface DownPaymentClearingView {
  vendor: string;
  companyCode: string;
  indicator: string;
  alternativeAccount: string;
  downPayments: DownPaymentItem[];
  invoices: ClearingInvoiceItem[];
}

interface OpenLine {
  documentNumber: string; fiscalYear: number; lineNumber: number;
  postingDate: string; currency: string; amount: string;
}

async function openLines(
  tx: Tx, client: string, companyCode: string, account: string,
  partner: string, debitCredit: 'S' | 'H',
): Promise<OpenLine[]> {
  const rows = await tx.select({
    documentNumber: journalEntryLine.documentNumber,
    fiscalYear: journalEntryLine.fiscalYear,
    lineNumber: journalEntryLine.lineNumber,
    postingDate: journalEntry.postingDate,
    currency: journalEntryLine.currency,
    amount: journalEntryLine.amountLocal,
  }).from(journalEntryLine)
    .innerJoin(journalEntry, and(
      eq(journalEntry.client, journalEntryLine.client),
      eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
      eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
    ))
    .where(and(
      eq(journalEntryLine.client, client),
      eq(journalEntryLine.companyCode, companyCode),
      eq(journalEntryLine.glAccount, account),
      eq(journalEntryLine.businessPartner, partner),
      eq(journalEntryLine.debitCredit, debitCredit),
      eq(journalEntry.status, 'POSTED'),
      sql`${journalEntryLine.clearingDocument} is null`,
    ))
    .orderBy(journalEntry.postingDate, journalEntryLine.documentNumber);
  return rows;
}

export async function getDownPaymentClearing(
  client: string, vendorNumber: string, companyCode: string, indicator: string,
): Promise<DownPaymentClearingView> {
  return withTenant(client, async (tx) => {
    const vendor = await judgeVendor(tx, client, vendorNumber, companyCode);
    const alternativeAccount = await resolveSpecialGlAccount(tx, client, companyCode, indicator)
      .catch((error: unknown) => {
        if (error instanceof Error) throw new VendorDownPaymentClearingError(error.message);
        throw error;
      });

    // Down payments: the open advance lines of this indicator.
    const dpRecords = await tx.select().from(vendorDownPayment).where(and(
      eq(vendorDownPayment.client, client),
      eq(vendorDownPayment.vendorNumber, vendorNumber),
      eq(vendorDownPayment.companyCode, companyCode),
      eq(vendorDownPayment.specialGlIndicator, indicator),
    ));
    const dpDocs = new Set(dpRecords.map((r) => r.journalDocumentNumber));
    const dpLines = (await openLines(tx, client, companyCode, alternativeAccount, vendorNumber, 'S'))
      .filter((l) => dpDocs.has(l.documentNumber));
    const downPayments: DownPaymentItem[] = [];
    for (const line of dpLines) {
      const applied = await appliedSoFar(
        tx, client, companyCode, alternativeAccount, vendorNumber, `Applied from ${line.documentNumber}`, true,
      );
      const amount = Number(line.amount);
      downPayments.push({
        documentNumber: line.documentNumber, fiscalYear: line.fiscalYear, lineNumber: line.lineNumber,
        postingDate: line.postingDate, currency: line.currency,
        amount, applied, remaining: round2(amount - applied), indicator,
      });
    }

    // Invoices: the open credit items on the ordinary account.
    const dueDates = new Map<string, string>();
    for (const inv of await tx.select().from(vendorInvoice).where(eq(vendorInvoice.client, client))) {
      if (inv.dueDate) dueDates.set(inv.invoiceNumber, inv.dueDate);
    }
    const originKeys = new Map<string, string>();
    for (const entry of await tx.select().from(journalEntry).where(eq(journalEntry.client, client))) {
      if (entry.originClass === 'vendor_invoice' && entry.originKey) {
        originKeys.set(entry.documentNumber, entry.originKey);
      }
    }
    const recon = vendor.reconciliationAccount!;
    const invLines = await openLines(tx, client, companyCode, recon, vendorNumber, 'H');
    const invoices: ClearingInvoiceItem[] = [];
    for (const line of invLines) {
      const applied = await appliedSoFar(
        tx, client, companyCode, recon, vendorNumber, `Settles ${line.documentNumber}`, false,
      );
      const amount = Number(line.amount);
      const originKey = originKeys.get(line.documentNumber);
      invoices.push({
        documentNumber: line.documentNumber, fiscalYear: line.fiscalYear, lineNumber: line.lineNumber,
        postingDate: line.postingDate,
        dueDate: originKey ? (dueDates.get(originKey) ?? line.postingDate) : line.postingDate,
        currency: line.currency,
        amount, applied, remaining: round2(amount - applied),
      });
    }
    return { vendor: vendorNumber, companyCode, indicator, alternativeAccount, downPayments, invoices };
  });
}

export interface ClearingItemRef {
  documentNumber: string; fiscalYear: number; lineNumber: number;
  /** Amount applied now; defaults to the item's full remaining amount. */
  applied?: number;
}

export interface PostedClearing {
  clearingNumber: string;
  journalDocumentNumber: string;
  totalApplied: string;
  itemsCleared: number;
  clearingDate: string;
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<PostedClearing | null> {
  const [row] = await tx.select().from(vendorDownPaymentClearing).where(and(
    eq(vendorDownPaymentClearing.client, client), eq(vendorDownPaymentClearing.requestKey, requestKey),
  ));
  return row ? {
    clearingNumber: row.clearingNumber, journalDocumentNumber: row.journalDocumentNumber,
    totalApplied: row.totalApplied, itemsCleared: 0, clearingDate: row.clearingDate,
  } : null;
}

export async function clearDownPayments(input: {
  client: string; changedBy: string;
  vendorNumber: string; companyCode: string; indicator: string;
  documentDate: string; postingDate: string; clearingDate: string;
  currency: string; reference?: string; requestKey: string;
  downPayments: ClearingItemRef[];
  invoices: ClearingItemRef[];
}): Promise<PostedClearing> {
  if (input.downPayments.length === 0) {
    throw new VendorDownPaymentClearingError('Select at least one down payment to apply.', 'Tick the advances this clearing applies.');
  }
  if (input.invoices.length === 0) {
    throw new VendorDownPaymentClearingError('Select at least one invoice to settle.', 'Tick the invoices this clearing settles.');
  }
  for (const ref of [...input.downPayments, ...input.invoices]) {
    if (ref.applied !== undefined && !(ref.applied > 0)) {
      throw new VendorDownPaymentClearingError(
        `Document ${ref.documentNumber} line ${ref.lineNumber}: the applied amount must stand above zero.`,
      );
    }
  }
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate], ['Clearing date', input.clearingDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new VendorDownPaymentClearingError(`${label} ${value} is not a calendar date.`);
  }
  if (input.reference && input.reference.length > 16) {
    throw new VendorDownPaymentClearingError('The reference may be at most 16 characters.', 'Shorten the clearing reference.');
  }

  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/dpclear/${input.companyCode}/${input.vendorNumber}`}, 0))`);
    const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
    if (replayLocked) return replayLocked;

    const vendor = await judgeVendor(tx, input.client, input.vendorNumber, input.companyCode);
    const alternativeAccount = await resolveSpecialGlAccount(tx, input.client, input.companyCode, input.indicator)
      .catch((error: unknown) => {
        if (error instanceof Error) throw new VendorDownPaymentClearingError(error.message);
        throw error;
      });
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new VendorDownPaymentClearingError(`Company code ${input.companyCode} is not configured.`);
    const recon = vendor.reconciliationAccount!;

    interface Held {
      ref: ClearingItemRef; applied: number; remaining: number; currency: string; lineText: string;
    }
    const holdSide = async (
      refs: ClearingItemRef[], account: string, debitCredit: 'S' | 'H',
      kind: 'down payment' | 'invoice', textOf: (doc: string) => string, creditSide: boolean,
    ): Promise<Held[]> => {
      const held: Held[] = [];
      for (const ref of refs) {
        const [line] = await tx.select().from(journalEntryLine).where(and(
          eq(journalEntryLine.client, input.client),
          eq(journalEntryLine.documentNumber, ref.documentNumber),
          eq(journalEntryLine.fiscalYear, ref.fiscalYear),
          eq(journalEntryLine.lineNumber, ref.lineNumber),
        ));
        if (!line || line.businessPartner !== input.vendorNumber || line.companyCode !== input.companyCode
          || line.glAccount !== account || line.debitCredit !== debitCredit) {
          throw new VendorDownPaymentClearingError(
            `Document ${ref.documentNumber} line ${ref.lineNumber} is not an open ${kind} of vendor ${input.vendorNumber} in company ${input.companyCode}.`,
            'Reload the open items, then post.',
          );
        }
        if (line.clearingDocument) {
          throw new VendorDownPaymentClearingError(
            `Document ${ref.documentNumber} line ${ref.lineNumber} already stands cleared by ${line.clearingDocument}.`,
            'Reload the open items, then post.',
          );
        }
        const already = await appliedSoFar(
          tx, input.client, input.companyCode, account, input.vendorNumber, textOf(ref.documentNumber), creditSide,
        );
        const remaining = round2(Number(line.amountLocal) - already);
        const applied = ref.applied === undefined ? remaining : round2(ref.applied);
        if (!(applied > 0)) {
          throw new VendorDownPaymentClearingError(
            `Document ${ref.documentNumber} line ${ref.lineNumber}: the applied amount must stand above zero.`,
          );
        }
        if (applied - remaining > 0.005) {
          throw new VendorDownPaymentClearingError(
            `The applied ${applied.toFixed(2)} on document ${ref.documentNumber} exceeds its remaining ${remaining.toFixed(2)}.`,
            'Apply no more than the item stands open at.',
          );
        }
        held.push({ ref, applied, remaining, currency: line.currency, lineText: textOf(ref.documentNumber) });
      }
      return held;
    };

    const dpHeld = await holdSide(
      input.downPayments, alternativeAccount, 'S', 'down payment', (doc) => `Applied from ${doc}`, true,
    );
    const invHeld = await holdSide(
      input.invoices, recon, 'H', 'invoice', (doc) => `Settles ${doc}`, false,
    );

    const dpTotal = round2(dpHeld.reduce((s, h) => s + h.applied, 0));
    if (dpTotal !== round2(invHeld.reduce((s, h) => s + h.applied, 0))) {
      throw new VendorDownPaymentClearingError(
        `The applied totals do not agree: down payments ${dpTotal.toFixed(2)} against invoices ${round2(invHeld.reduce((s, h) => s + h.applied, 0)).toFixed(2)} ${input.currency.toUpperCase()}.`,
        'Apply exactly as much advance as the invoices settle — a clearing transfers value, it never creates it.',
      );
    }

    const currencies = [...new Set([
      ...dpHeld.map((h) => h.currency), ...invHeld.map((h) => h.currency), input.currency.toUpperCase(),
    ])];
    if (currencies.length > 1) {
      throw new VendorDownPaymentClearingError(
        `The clearing and its items stand in ${currencies.join(' and ')}; one clearing settles one currency.`,
        'Clear items in the clearing currency.',
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
      headerText: `Down payment clearing ${input.vendorNumber}`,
      lines: [
        ...invHeld.map((h) => ({
          glAccount: recon, debitCredit: 'S' as const,
          amount: h.applied.toFixed(2), businessPartner: input.vendorNumber,
          lineText: h.lineText,
        })),
        ...dpHeld.map((h) => ({
          glAccount: alternativeAccount, debitCredit: 'H' as const,
          amount: h.applied.toFixed(2), businessPartner: input.vendorNumber,
          lineText: h.lineText,
        })),
      ],
      origin: { documentClass: CLEARING_CLASS, documentKey: `${input.companyCode}/${input.vendorNumber}` },
      postedBy: input.changedBy,
      transactionCode: VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new VendorDownPaymentClearingError(error.message, error.remedy);
      throw error;
    });

    // Full application stamps the original item and its offsetting
    // lines; partial application leaves the netting pair standing.
    let itemsCleared = 0;
    const stampItem = async (h: Held, account: string) => {
      itemsCleared += 1;
      await tx.update(journalEntryLine).set({
        clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
      }).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, h.ref.documentNumber),
        eq(journalEntryLine.fiscalYear, h.ref.fiscalYear),
        eq(journalEntryLine.lineNumber, h.ref.lineNumber),
      ));
      await tx.update(journalEntryLine).set({
        clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
      }).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.companyCode, input.companyCode),
        eq(journalEntryLine.glAccount, account),
        eq(journalEntryLine.businessPartner, input.vendorNumber),
        eq(journalEntryLine.lineText, h.lineText),
        sql`${journalEntryLine.clearingDocument} is null`,
      ));
    };
    for (const h of invHeld) {
      if (h.applied >= h.remaining - 0.005) await stampItem(h, recon);
    }
    for (const h of dpHeld) {
      if (h.applied >= h.remaining - 0.005) await stampItem(h, alternativeAccount);
    }

    const clearingNumber = journal.documentNumber;
    await tx.insert(vendorDownPaymentClearing).values({
      client: input.client, clearingNumber, fiscalYear: journal.fiscalYear,
      vendorNumber: input.vendorNumber, companyCode: input.companyCode,
      specialGlIndicator: input.indicator,
      alternativeReconciliationAccount: alternativeAccount,
      documentDate: input.documentDate, postingDate: input.postingDate, clearingDate: input.clearingDate,
      totalApplied: String(dpTotal),
      currency: currencies[0], reference: input.reference ?? null,
      journalDocumentNumber: journal.documentNumber,
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: CLEARING_CLASS,
      objectKey: `${input.companyCode}/${input.vendorNumber}/${clearingNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY,
      after: { journal: journal.documentNumber, totalApplied: dpTotal, itemsCleared },
    });
    const result = await byRequestKey(tx, input.client, input.requestKey);
    return { ...result!, itemsCleared };
  });
}
