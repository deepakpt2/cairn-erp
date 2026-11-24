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
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { moneyFor } from '../../platform/posting/money';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { purchaseOrder } from '../purchasing/schema';
import {
  journalEntry, journalEntryLine, vendorDownPayment, vendorDownPaymentClearing, vendorInvoice,
} from './schema';
import {
  activeValuationConflict, fxDifferenceAccount, lockValuationSettlement,
  proportionalLocal, realizedFxDirection, realizedFxLine,
} from './fx-settlement';
import { openItemBalances } from './open-item-netting';
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

/**
 * The document- and local-currency amounts already applied against one open item, read through the
 * shared netting helper so the units cannot drift from the reporting side.
 */
async function appliedBalances(
  tx: Tx, client: string, line: {
    documentNumber: string; companyCode: string; businessPartner: string;
    glAccount: string; currency: string; debitCredit: 'S' | 'H';
  },
): Promise<{ document: bigint; local: bigint }> {
  return (await openItemBalances(tx, client, line)).liability;
}

export interface DownPaymentItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  currency: string;
  /** Amount, applied and remaining are in the item's document currency. */
  amount: number;
  applied: number;
  remaining: number;
  /** The local-currency equivalents, labelled with `localCurrency` at the view level. */
  amountLocal: number;
  appliedLocal: number;
  remainingLocal: number;
  indicator: string;
}

export interface ClearingInvoiceItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  currency: string;
  /** Amount, applied and remaining are in the item's document currency. */
  amount: number;
  applied: number;
  remaining: number;
  /** The local-currency equivalents, labelled with `localCurrency` at the view level. */
  amountLocal: number;
  appliedLocal: number;
  remainingLocal: number;
}

export interface DownPaymentClearingView {
  vendor: string;
  companyCode: string;
  indicator: string;
  alternativeAccount: string;
  /** The company's local currency, which labels every `*Local` amount. */
  localCurrency: string;
  downPayments: DownPaymentItem[];
  invoices: ClearingInvoiceItem[];
}

interface OpenLine {
  documentNumber: string; fiscalYear: number; lineNumber: number;
  postingDate: string; currency: string; amountDocument: string; amountLocal: string;
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
    amountDocument: journalEntryLine.amountDocument,
    amountLocal: journalEntryLine.amountLocal,
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

export async function getDownPaymentClearingTx(
  tx: Tx, client: string, vendorNumber: string, companyCode: string, indicator: string,
): Promise<DownPaymentClearingView> {
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
  const company = await getCompanyCode(tx, client, companyCode);
  const localCurrency = company?.currency ?? '';
  const dpDocs = new Set(dpRecords.map((r) => r.journalDocumentNumber));
  const dpLines = (await openLines(tx, client, companyCode, alternativeAccount, vendorNumber, 'S'))
    .filter((l) => dpDocs.has(l.documentNumber));
  const downPayments: DownPaymentItem[] = [];
  for (const line of dpLines) {
    const applied = await appliedBalances(tx, client, {
      documentNumber: line.documentNumber, companyCode, businessPartner: vendorNumber,
      glAccount: alternativeAccount, currency: line.currency, debitCredit: 'S',
    });
    const amountDocument = toScaled(line.amountDocument);
    const amountLocal = toScaled(line.amountLocal);
    const remainingDocument = amountDocument - applied.document;
    const remainingLocal = amountLocal - applied.local;
    if (remainingDocument <= 0n) continue;
    downPayments.push({
      documentNumber: line.documentNumber, fiscalYear: line.fiscalYear, lineNumber: line.lineNumber,
      postingDate: line.postingDate, currency: line.currency,
      amount: Number(fromScaled(amountDocument)),
      applied: Number(fromScaled(applied.document)),
      remaining: Number(fromScaled(remainingDocument)),
      amountLocal: Number(fromScaled(amountLocal)),
      appliedLocal: Number(fromScaled(applied.local)),
      remainingLocal: Number(fromScaled(remainingLocal)),
      indicator,
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
    const applied = await appliedBalances(tx, client, {
      documentNumber: line.documentNumber, companyCode, businessPartner: vendorNumber,
      glAccount: recon, currency: line.currency, debitCredit: 'H',
    });
    const amountDocument = toScaled(line.amountDocument);
    const amountLocal = toScaled(line.amountLocal);
    const remainingDocument = amountDocument - applied.document;
    const remainingLocal = amountLocal - applied.local;
    if (remainingDocument <= 0n) continue;
    const originKey = originKeys.get(line.documentNumber);
    invoices.push({
      documentNumber: line.documentNumber, fiscalYear: line.fiscalYear, lineNumber: line.lineNumber,
      postingDate: line.postingDate,
      dueDate: originKey ? (dueDates.get(originKey) ?? line.postingDate) : line.postingDate,
      currency: line.currency,
      amount: Number(fromScaled(amountDocument)),
      applied: Number(fromScaled(applied.document)),
      remaining: Number(fromScaled(remainingDocument)),
      amountLocal: Number(fromScaled(amountLocal)),
      appliedLocal: Number(fromScaled(applied.local)),
      remainingLocal: Number(fromScaled(remainingLocal)),
    });
  }
  return {
    vendor: vendorNumber, companyCode, indicator, alternativeAccount, localCurrency,
    downPayments, invoices,
  };
}

export async function getDownPaymentClearing(
  client: string, vendorNumber: string, companyCode: string, indicator: string,
): Promise<DownPaymentClearingView> {
  return withTenant(client, (tx) => getDownPaymentClearingTx(tx, client, vendorNumber, companyCode, indicator));
}

/**
 * The advances raised against one purchase order, and how much of each is still unspent.
 *
 * An advance that names an order is money given against that commitment, so the buyer is
 * entitled to see it there and to know what is left of it when the invoice comes in. What
 * is left is derived the same way the clearing derives it: what has been applied against
 * the advance already, read off the offsetting lines that name it.
 */
export async function getOrderAdvances(client: string, orderNumber: string): Promise<OrderAdvance[]> {
  return withTenant(client, async (tx) => {
    const [order] = await tx.select().from(purchaseOrder).where(and(
      eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber),
    ));
    if (!order) {
      throw new VendorDownPaymentClearingError(
        `Purchase order ${orderNumber} does not stand.`,
        'Open the order, then look at its advances again.',
      );
    }
    if (!order.supplierNumber) {
      // A stock transport order is not bought from anybody: it can carry no advance.
      return [];
    }
    const rows = await tx.select().from(vendorDownPayment).where(and(
      eq(vendorDownPayment.client, client),
      eq(vendorDownPayment.vendorNumber, order.supplierNumber),
      eq(vendorDownPayment.companyCode, order.companyCode),
      eq(vendorDownPayment.purchaseOrder, orderNumber),
    ));
    if (rows.length === 0) return [];

    const advances: OrderAdvance[] = [];
    for (const indicator of new Set(rows.map((r) => r.specialGlIndicator))) {
      const view = await getDownPaymentClearingTx(tx, client, order.supplierNumber, order.companyCode, indicator);
      const documents = new Set(
        rows.filter((r) => r.specialGlIndicator === indicator).map((r) => r.journalDocumentNumber),
      );
      const numbers = new Map(rows.map((r) => [r.journalDocumentNumber, r.paymentNumber]));
      for (const payment of view.downPayments) {
        if (!documents.has(payment.documentNumber)) continue;
        advances.push({
          ...payment, indicator,
          paymentNumber: numbers.get(payment.documentNumber) ?? payment.documentNumber,
        });
      }
    }
    return advances.sort(
      (a, b) => a.postingDate.localeCompare(b.postingDate) || a.documentNumber.localeCompare(b.documentNumber),
    );
  });
}

export interface OrderAdvance extends DownPaymentItem {
  /** The special G/L indicator the advance was posted under. */
  indicator: string;
  /**
   * The number the advance is known by. Its journal line is what a clearing
   * settles, but the document people name is the payment, so the order's view
   * carries both.
   */
  paymentNumber: string;
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

export interface ClearDownPaymentsInput {
  client: string; changedBy: string;
  vendorNumber: string; companyCode: string; indicator: string;
  documentDate: string; postingDate: string; clearingDate: string;
  currency: string; reference?: string; requestKey: string;
  downPayments: ClearingItemRef[];
  invoices: ClearingItemRef[];
  /** The supplier invoice this clearing settles, when it was raised from invoice verification. */
  invoiceNumber?: string;
  /** The order behind the settlement, when the advance named one. */
  purchaseOrder?: string;
}

/**
 * The settlement itself, on a transaction the caller already owns.
 *
 * Invoice verification posts the invoice and settles the advances against it in one
 * movement: the clearing reads the invoice's open credit line, and that line does not
 * exist until the invoice journal stands written. So the clearing takes the caller's
 * transaction rather than opening one of its own — a second connection could not see
 * the invoice the first has not yet committed.
 */
export async function clearDownPaymentsTx(
  tx: Tx, input: ClearDownPaymentsInput,
): Promise<PostedClearing> {
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

  const replay = await byRequestKey(tx, input.client, input.requestKey);
  if (replay) return replay;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/dpclear/${input.companyCode}/${input.vendorNumber}`}, 0))`);
  // Serialize with payments, clearings and period-end valuation for this company, the same
  // company-scoped settlement lock every other settlement path takes.
  await lockValuationSettlement(tx, input.client, input.companyCode);
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

  const localMoney = await moneyFor(tx, company.currency);
  const localScale = localMoney.scale;

  interface Held {
    ref: ClearingItemRef;
    account: string;
    /** Document-currency amount applied by this clearing. */
    appliedDocument: bigint;
    /** The carrying local amount released, pro-rata of the item's posted local amount. */
    releasedLocal: bigint;
    /** Document-currency amount the item stood open at before this clearing. */
    remainingDocument: bigint;
    currency: string;
    lineText: string;
  }
  const holdSide = async (
    refs: ClearingItemRef[], account: string, debitCredit: 'S' | 'H',
    kind: 'down payment' | 'invoice', textOf: (doc: string) => string,
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
      const applied = await appliedBalances(tx, input.client, {
        documentNumber: ref.documentNumber, companyCode: input.companyCode,
        businessPartner: input.vendorNumber, glAccount: account,
        currency: line.currency, debitCredit,
      });
      const openDocument = toScaled(line.amountDocument) - applied.document;
      const openLocal = toScaled(line.amountLocal) - applied.local;
      if (openDocument < 0n || openLocal < 0n) {
        throw new VendorDownPaymentClearingError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} carries applications that exceed it.`,
          'Investigate the applications on this item before clearing it.',
        );
      }
      const requestedDocument = ref.applied === undefined ? openDocument : toScaled(ref.applied);
      if (!(requestedDocument > 0n)) {
        throw new VendorDownPaymentClearingError(
          `Document ${ref.documentNumber} line ${ref.lineNumber}: the applied amount must stand above zero.`,
        );
      }
      if (requestedDocument > openDocument) {
        throw new VendorDownPaymentClearingError(
          `The applied ${fromScaled(requestedDocument)} on document ${ref.documentNumber} exceeds its remaining ${fromScaled(openDocument)} ${line.currency}.`,
          'Apply no more than the item stands open at.',
        );
      }
      // The released local amount is the item's own carrying amount, pro-rata. When the item is
      // applied in full, `proportionalLocal` returns the exact open local amount, so there is no
      // rounding drift across several partial applications.
      const releasedLocal = proportionalLocal(openLocal, openDocument, requestedDocument, localScale);
      held.push({
        ref, account, appliedDocument: requestedDocument, releasedLocal,
        remainingDocument: openDocument, currency: line.currency, lineText: textOf(ref.documentNumber),
      });
    }
    return held;
  };

  const dpHeld = await holdSide(
    input.downPayments, alternativeAccount, 'S', 'down payment', (doc) => `Applied from ${doc}`,
  );
  const invHeld = await holdSide(
    input.invoices, recon, 'H', 'invoice', (doc) => `Settles ${doc}`,
  );

  const dpTotalDocument = dpHeld.reduce((s, h) => s + h.appliedDocument, 0n);
  const invTotalDocument = invHeld.reduce((s, h) => s + h.appliedDocument, 0n);
  if (dpTotalDocument !== invTotalDocument) {
    throw new VendorDownPaymentClearingError(
      `The applied totals do not agree: down payments ${fromScaled(dpTotalDocument)} against invoices ${fromScaled(invTotalDocument)} ${input.currency.toUpperCase()}.`,
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

  // A clearing over an item a period-end valuation already adjusted would count the same exchange
  // difference twice. Refuse until that valuation is reversed, exactly as the ordinary clearing does.
  for (const h of [...dpHeld, ...invHeld]) {
    const conflict = await activeValuationConflict(tx, input.client, input.companyCode, {
      documentNumber: h.ref.documentNumber, lineNumber: h.ref.lineNumber,
      accountNumber: h.account, currency: h.currency,
    }, input.postingDate);
    if (conflict) {
      throw new VendorDownPaymentClearingError(
        `Document ${h.ref.documentNumber} line ${h.ref.lineNumber} was valued at period end by run ${conflict.runId} (key date ${conflict.valuationKeyDate}).`,
        'Reverse that FX valuation document first, then clear. Clearing over an active valuation would count the same exchange difference twice. Nothing has been posted.',
      );
    }
  }

  const lines: Array<{
    glAccount: string; debitCredit: 'S' | 'H'; amount: string; amountLocal: string;
    localOnly?: boolean; businessPartner?: string; lineText?: string;
  }> = [
    ...invHeld.map((h) => ({
      glAccount: recon, debitCredit: 'S' as const,
      amount: fromScaled(h.appliedDocument), amountLocal: fromScaled(h.releasedLocal),
      businessPartner: input.vendorNumber, lineText: h.lineText,
    })),
    ...dpHeld.map((h) => ({
      glAccount: alternativeAccount, debitCredit: 'H' as const,
      amount: fromScaled(h.appliedDocument), amountLocal: fromScaled(h.releasedLocal),
      businessPartner: input.vendorNumber, lineText: h.lineText,
    })),
  ];
  // The two legs carry different carrying amounts when the advance and the invoice stand at
  // different rates. Their difference is the realized exchange difference (AP: a debit loss when the
  // advance's carrying amount is the higher one).
  const localSigned = invHeld.reduce((s, h) => s + h.releasedLocal, 0n)
    - dpHeld.reduce((s, h) => s + h.releasedLocal, 0n);
  if (localSigned !== 0n) {
    const { event } = realizedFxDirection(localSigned);
    const account = await fxDifferenceAccount(tx, input.client, company.chartOfAccounts ?? '', event);
    if (!account) {
      throw new VendorDownPaymentClearingError(
        `Account determination for ${event} does not stand in chart ${company.chartOfAccounts ?? ''}, so the realized exchange difference cannot be posted.`,
        `Maintain the ${event} account determination, then clear again. Nothing has been posted.`,
      );
    }
    lines.push(realizedFxLine(localSigned, account));
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
    lines,
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
    if (h.appliedDocument === h.remainingDocument) await stampItem(h, recon);
  }
  for (const h of dpHeld) {
    if (h.appliedDocument === h.remainingDocument) await stampItem(h, alternativeAccount);
  }

  const clearingNumber = journal.documentNumber;
  await tx.insert(vendorDownPaymentClearing).values({
    client: input.client, clearingNumber, fiscalYear: journal.fiscalYear,
    vendorNumber: input.vendorNumber, companyCode: input.companyCode,
    specialGlIndicator: input.indicator,
    alternativeReconciliationAccount: alternativeAccount,
    documentDate: input.documentDate, postingDate: input.postingDate, clearingDate: input.clearingDate,
    totalApplied: fromScaled(dpTotalDocument),
    currency: currencies[0], reference: input.reference ?? null,
    journalDocumentNumber: journal.documentNumber,
    invoiceNumber: input.invoiceNumber ?? null,
    purchaseOrder: input.purchaseOrder ?? null,
    requestKey: input.requestKey, createdBy: input.changedBy,
  });
  await recordChange(tx, {
    client: input.client, objectClass: CLEARING_CLASS,
    objectKey: `${input.companyCode}/${input.vendorNumber}/${clearingNumber}`,
    changeType: 'CREATE', changedBy: input.changedBy, transactionCode: VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY,
    after: {
      journal: journal.documentNumber, totalApplied: fromScaled(dpTotalDocument), itemsCleared,
      invoice: input.invoiceNumber ?? null, order: input.purchaseOrder ?? null,
    },
  });
  const result = await byRequestKey(tx, input.client, input.requestKey);
  return { ...result!, itemsCleared };
}

export async function clearDownPayments(input: ClearDownPaymentsInput): Promise<PostedClearing> {
  return withTenant(input.client, (tx) => clearDownPaymentsTx(tx, input));
}
