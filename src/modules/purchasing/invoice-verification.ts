/**
 * Invoice verification — SCR-062 / R-110.
 *
 * A supplier invoice is verified against its purchase order and the
 * goods receipts posted under it. The gross amount is a judged
 * figure, not a formula's output: items' tax-exclusive net total
 * plus the tax their standing tax codes calculate must equal it.
 * Quantity judges against received-not-yet-invoiced history; price
 * variance posts to the price-difference event. Posting clears
 * GR/IR and credits the supplier's reconciliation account in one
 * balanced journal. A posted invoice is never edited — cancellation
 * is a linked mirror document judging its own posting date.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { linkDocuments } from '../../platform/document';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, reverseJournalEntry, PostingError } from '../../platform/posting';
import { ClearingResetError, resetClearingTx } from '../finance/clearing-reset';
import {
  AssetAcquisitionError, markAssetAcquisitionsReversedTx, recordAssetAcquisition,
} from '../finance/asset-acquisition';
import {
  accountAssignmentLabel, assignmentObject, type AssignmentObject,
} from './account-assignment';
import { accountDetermination, taxCode } from '../foundation/schema';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import { materialDocumentLine, materialValuation, movementType } from '../inventory/schema';
import { postingValuationRefusal } from '../inventory/valuation-class-definition';
import {
  clearDownPaymentsTx, getDownPaymentClearingTx, getOrderAdvances,
  VendorDownPaymentClearingError, type OrderAdvance,
} from '../finance/vendor-down-payment-clearing';
import {
  journalEntry, journalEntryLine, vendorDownPayment, vendorDownPaymentClearing,
} from '../finance/schema';
import {
  parkedSupplierInvoice,
  purchaseOrder, purchaseOrderAssignment, purchaseOrderItem,
  supplierInvoice, supplierInvoiceItem,
} from './schema';
import { judgeAccountAssignments } from './account-assignment';

export const INVOICE_CAPABILITY = 'PROC.INV.RECORD';
const JOURNAL_DOCUMENT_TYPE = 'KR';
const INVOICE_CLASS = 'supplier_invoice';

export class InvoiceVerificationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'InvoiceVerificationError';
    this.remedy = remedy;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function receivedQuantities(tx: Tx, client: string, orderNumber: string): Promise<Map<number, number>> {
  const rows = await tx.select({
    item: materialDocumentLine.purchaseOrderItem,
    movement: materialDocumentLine.movementType,
    qty: materialDocumentLine.baseQuantity,
  }).from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.purchaseOrderNumber, orderNumber),
  ));
  const directions = new Map<string, string>();
  for (const m of await tx.select().from(movementType).where(eq(movementType.client, client))) {
    directions.set(m.movementType, m.direction);
  }
  const map = new Map<number, number>();
  for (const row of rows) {
    if (row.item == null) continue;
    const sign = directions.get(row.movement) === 'REVERSAL' ? -1 : 1;
    map.set(row.item, (map.get(row.item) ?? 0) + sign * Number(row.qty));
  }
  return map;
}

async function invoicedQuantities(tx: Tx, client: string, orderNumber: string): Promise<Map<number, number>> {
  const rows = await tx.select({
    item: supplierInvoiceItem.purchaseOrderItem,
    qty: supplierInvoiceItem.quantity,
  }).from(supplierInvoiceItem)
    .innerJoin(supplierInvoice, and(
      eq(supplierInvoice.client, supplierInvoiceItem.client),
      eq(supplierInvoice.invoiceNumber, supplierInvoiceItem.invoiceNumber),
    ))
    .where(and(
      eq(supplierInvoiceItem.client, client),
      eq(supplierInvoiceItem.purchaseOrderNumber, orderNumber),
      eq(supplierInvoice.status, 'POSTED'),
      sql`${supplierInvoice.cancellationOf} is null`,
    ));
  const map = new Map<number, number>();
  for (const row of rows) map.set(row.item, (map.get(row.item) ?? 0) + Number(row.qty));
  return map;
}

export interface InvoiceItemView {
  itemNumber: number;
  materialNumber: string | null;
  shortText: string;
  plant: string;
  unit: string;
  taxCode: string;
  ordered: number;
  received: number;
  invoiced: number;
  invoiceable: number;
  /**
   * What the invoiceable figure was worked out from: the goods that arrived, or the
   * quantity that was ordered. A screen that shows one number without saying which is
   * hiding the thing that decided it.
   */
  invoiceBasis: 'GOODS_RECEIPT' | 'ORDERED_QUANTITY';
  goodsReceiptIndicator: boolean;
  invoiceReceiptIndicator: boolean;
  grBasedInvoiceVerification: boolean;
  finalInvoiceIndicator: boolean;
  /**
   * What the item's value belongs to, where it does not go through stock (9224).
   * Empty for an ordinary stock item.
   */
  accountAssignmentCategory: string | null;
  /** The same category as a screen names it — 'Cost centre (K)' — or null for stock. */
  accountAssignmentLabel: string | null;
  assignments: Array<{
    lineNumber: number; glAccount: string; distributionPercentage: string;
    costCenter: string | null; internalOrder: string | null;
    assetNumber: string | null; assetSubNumber: string | null;
    assetTransactionType: string | null;
    /** The object this line commits to, read once and shown as every screen shows it. */
    object: AssignmentObject | null;
  }>;
  netPrice: string;
  priceUnit: string;
  eligible: boolean;
  refusal: string | null;
}

export interface InvoiceOrderView {
  orderNumber: string;
  supplierNumber: string;
  companyCode: string;
  currency: string;
  items: InvoiceItemView[];
  /** Money already handed to the supplier against this order, and what is left of it. */
  advances: OrderAdvance[];
}

/** The order as the invoice will judge it. The advances against it are read separately. */
async function orderViewInTx(
  tx: Tx, client: string, orderNumber: string,
): Promise<Omit<InvoiceOrderView, 'advances'> | null> {
  const [header] = await tx.select().from(purchaseOrder).where(and(
    eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber),
  ));
  if (!header) return null;
  const items = await tx.select().from(purchaseOrderItem).where(and(
    eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, orderNumber),
  )).orderBy(purchaseOrderItem.itemNumber);
  const received = await receivedQuantities(tx, client, orderNumber);
  const invoiced = await invoicedQuantities(tx, client, orderNumber);
  const assigned = await tx.select().from(purchaseOrderAssignment).where(and(
    eq(purchaseOrderAssignment.client, client),
    eq(purchaseOrderAssignment.orderNumber, orderNumber),
  )).orderBy(purchaseOrderAssignment.itemNumber, purchaseOrderAssignment.lineNumber);
  return {
    orderNumber: header.orderNumber,
    supplierNumber: header.supplierNumber,
    companyCode: header.companyCode,
    currency: header.currency,
    items: items.map((item) => {
      const got = received.get(item.itemNumber) ?? 0;
      const done = invoiced.get(item.itemNumber) ?? 0;
      const assignmentRows = assigned.filter((row) => row.itemNumber === item.itemNumber);
      let refusal: string | null = null;
      if (item.markedForDeletion) refusal = 'The item is marked for deletion.';
      else if (!item.invoiceReceiptIndicator) refusal = 'The item is not invoiceable: its invoice receipt indicator is off.';
      else if (item.finalInvoiceIndicator) refusal = 'The final invoice has been posted against this item.';
      // An account-assigned item needs no material: what it buys is not stock, and the
      // short text is what describes it. What it does need is somewhere for the value to
      // go, and that is checked in full when the invoice is posted — a cost centre that
      // stood valid when the order was written may not stand valid on the posting day.
      else if (!item.accountAssignmentCategory && !item.materialNumber) {
        refusal = 'Text items carry no goods receipt to verify against this round.';
      } else if (item.accountAssignmentCategory && assignmentRows.length === 0) {
        refusal = 'An account-assigned item carries no account assignment row, so nothing says where its value belongs.';
      } else if (item.accountAssignmentCategory) {
        const total = assignmentRows.reduce((sum, row) => sum + Number(row.distributionPercentage), 0);
        if (Math.abs(total - 100) > 0.005) {
          refusal = `Assignment percentages total ${total.toFixed(2)}, not 100.`;
        }
      }
      // Verified against goods only where there are goods to verify against and the item
      // asks for it. An item that receives none is invoiced against what was ordered, which
      // is not a fallback: the buyer who switched the goods receipt off said none would
      // arrive. An account-assigned item joins them by the same reasoning carried one step
      // further — its invoice clears no goods-received balance at all, because it never
      // created one, so the order quantity is the only quantity there is to check against.
      const grBased = item.grBasedInvoiceVerification
        && item.goodsReceiptIndicator
        && !item.accountAssignmentCategory;
      return {
        itemNumber: item.itemNumber,
        materialNumber: item.materialNumber,
        shortText: item.shortText,
        plant: item.plant,
        unit: item.unit,
        taxCode: item.taxCode ?? '',
        ordered: Number(item.quantity),
        received: got,
        invoiced: done,
        invoiceable: grBased ? Math.max(0, got - done) : Math.max(0, Number(item.quantity) - done),
        invoiceBasis: grBased ? 'GOODS_RECEIPT' : 'ORDERED_QUANTITY',
        goodsReceiptIndicator: item.goodsReceiptIndicator,
        invoiceReceiptIndicator: item.invoiceReceiptIndicator,
        grBasedInvoiceVerification: item.grBasedInvoiceVerification,
        finalInvoiceIndicator: item.finalInvoiceIndicator,
        accountAssignmentCategory: item.accountAssignmentCategory,
        /** The category in words with SAP's code beside it; null for a stock item. */
        accountAssignmentLabel: accountAssignmentLabel(item.accountAssignmentCategory),
        assignments: assignmentRows.map((row) => ({
          lineNumber: row.lineNumber, glAccount: row.glAccount,
          distributionPercentage: row.distributionPercentage,
          costCenter: row.costCenter, internalOrder: row.internalOrder,
          assetNumber: row.assetNumber, assetSubNumber: row.assetSubNumber,
          assetTransactionType: row.assetTransactionType,
          object: assignmentObject(row),
        })),
        netPrice: item.netPrice,
        priceUnit: item.priceUnit,
        eligible: !refusal,
        refusal,
      };
    }),
  };
}

export async function getInvoiceOrder(client: string, orderNumber: string): Promise<InvoiceOrderView | null> {
  const view = await withTenant(client, (tx) => orderViewInTx(tx, client, orderNumber));
  if (!view) return null;
  // An order with no advance raises no question, so nothing is looked up for one: an order
  // that does carry money already paid is the only one that needs the answer.
  return { ...view, advances: await getOrderAdvances(client, orderNumber) };
}

export interface TaxCodeChoice { code: string; ratePercent: string; name: string }

export async function listInvoiceTaxCodes(client: string, companyCode: string): Promise<TaxCodeChoice[]> {
  return withTenant(client, async (tx) => {
    const company = await getCompanyCode(tx, client, companyCode);
    if (!company?.country) return [];
    const rows = await tx.select().from(taxCode).where(and(
      eq(taxCode.client, client), eq(taxCode.country, company.country),
    ));
    return rows.map((r) => ({ code: r.taxCode, ratePercent: r.ratePercent, name: r.name }));
  });
}

export interface SupplierInvoiceView {
  invoiceNumber: string;
  fiscalYear: number;
  category: string;
  supplierNumber: string;
  companyCode: string;
  purchaseOrderNumber: string;
  invoiceDate: string;
  postingDate: string;
  supplierReference: string;
  currency: string;
  grossAmount: string;
  taxAmount: string;
  paymentTerms: string | null;
  baselineDate: string | null;
  dueDate: string | null;
  status: string;
  journalDocumentNumber: string | null;
  cancelledBy: string | null;
  cancellationOf: string | null;
  items: Array<{
    lineNumber: number; purchaseOrderItem: number; materialNumber: string | null;
    quantity: string; netAmount: string; expectedAmount: string; varianceAmount: string;
    taxCode: string | null; taxAmount: string;
  }>;
  /**
   * The advance settlements this invoice carries (9223). A settlement is its own
   * accounting document; listed here so the invoice can say what it has already
   * been paid against, and what is still owed.
   */
  settlements: Array<{
    clearingNumber: string; fiscalYear: number; indicator: string; totalApplied: string;
    journalDocumentNumber: string; reversed: boolean;
  }>;
  /** What the settlements have taken off the gross so far. */
  advanceApplied: string;
  /** The gross less what the settlements have taken — the liability that still stands. */
  remainingPayable: string;
}

function toView(
  header: typeof supplierInvoice.$inferSelect,
  items: Array<typeof supplierInvoiceItem.$inferSelect>,
  settlements: SupplierInvoiceView['settlements'],
): SupplierInvoiceView {
  const applied = settlements
    .filter((row) => !row.reversed)
    .reduce((sum, row) => sum + Number(row.totalApplied), 0);
  const gross = Number(header.grossAmount);
  return {
    invoiceNumber: header.invoiceNumber, fiscalYear: header.fiscalYear,
    category: header.category, supplierNumber: header.supplierNumber,
    companyCode: header.companyCode, purchaseOrderNumber: header.purchaseOrderNumber,
    invoiceDate: header.invoiceDate, postingDate: header.postingDate,
    supplierReference: header.supplierReference, currency: header.currency,
    grossAmount: header.grossAmount, taxAmount: header.taxAmount,
    paymentTerms: header.paymentTerms, baselineDate: header.baselineDate,
    dueDate: header.dueDate, status: header.status,
    journalDocumentNumber: header.journalDocumentNumber,
    cancelledBy: header.cancelledBy, cancellationOf: header.cancellationOf,
    items: items.map((i) => ({
      lineNumber: i.lineNumber, purchaseOrderItem: i.purchaseOrderItem,
      materialNumber: i.materialNumber, quantity: i.quantity,
      netAmount: i.netAmount, expectedAmount: i.expectedAmount,
      varianceAmount: i.varianceAmount, taxCode: i.taxCode, taxAmount: i.taxAmount,
    })),
    settlements,
    advanceApplied: round2(applied).toFixed(2),
    remainingPayable: round2(gross - applied).toFixed(2),
  };
}

/**
 * The advance settlements raised against one invoice.
 *
 * A settlement that has been reversed no longer counts: the advance stands open
 * again and the invoice is owed in full. The judgement is read off the clearing
 * journal, which is the document that stands, not off a column that could drift.
 */
async function loadSettlements(
  tx: Tx, client: string, invoiceNumber: string,
): Promise<SupplierInvoiceView['settlements']> {
  const rows = await tx.select({
    clearingNumber: vendorDownPaymentClearing.clearingNumber,
    fiscalYear: vendorDownPaymentClearing.fiscalYear,
    indicator: vendorDownPaymentClearing.specialGlIndicator,
    totalApplied: vendorDownPaymentClearing.totalApplied,
    journalDocumentNumber: vendorDownPaymentClearing.journalDocumentNumber,
    status: journalEntry.status,
  }).from(vendorDownPaymentClearing)
    .leftJoin(journalEntry, and(
      eq(journalEntry.client, vendorDownPaymentClearing.client),
      eq(journalEntry.documentNumber, vendorDownPaymentClearing.journalDocumentNumber),
      eq(journalEntry.fiscalYear, vendorDownPaymentClearing.fiscalYear),
    ))
    .where(and(
      eq(vendorDownPaymentClearing.client, client),
      eq(vendorDownPaymentClearing.invoiceNumber, invoiceNumber),
    ))
    .orderBy(vendorDownPaymentClearing.clearingNumber);
  return rows.map((row) => ({
    clearingNumber: row.clearingNumber,
    fiscalYear: row.fiscalYear,
    indicator: row.indicator,
    totalApplied: row.totalApplied,
    journalDocumentNumber: row.journalDocumentNumber,
    reversed: row.status === 'REVERSED',
  }));
}

async function loadView(tx: Tx, client: string, number: string): Promise<SupplierInvoiceView | null> {
  const [header] = await tx.select().from(supplierInvoice).where(and(
    eq(supplierInvoice.client, client), eq(supplierInvoice.invoiceNumber, number),
  ));
  if (!header) return null;
  const items = await tx.select().from(supplierInvoiceItem).where(and(
    eq(supplierInvoiceItem.client, client), eq(supplierInvoiceItem.invoiceNumber, number),
  )).orderBy(supplierInvoiceItem.lineNumber);
  return toView(header, items, await loadSettlements(tx, client, number));
}

export async function getSupplierInvoice(client: string, number: string): Promise<SupplierInvoiceView | null> {
  return withTenant(client, (tx) => loadView(tx, client, number));
}

async function byRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(supplierInvoice).where(and(
    eq(supplierInvoice.client, client), eq(supplierInvoice.requestKey, requestKey),
  ));
  return header ? loadView(tx, client, header.invoiceNumber) : null;
}

async function resolveAccount(
  tx: Tx, client: string, chart: string, event: string, valuationClass: string,
): Promise<string> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
  ));
  const row = rows.find((r) => r.valuationClass === valuationClass)
    ?? rows.find((r) => r.valuationClass === '');
  if (!row) {
    throw new InvoiceVerificationError(
      `Account determination for ${event}${valuationClass ? ` and valuation class ${valuationClass}` : ''} does not stand in chart ${chart}.`,
      'Maintain the account determination for this event, then post again.',
    );
  }
  return row.glAccount;
}

async function valuationClassFor(tx: Tx, client: string, materialNumber: string, plant: string): Promise<string> {
  const [valuation] = await tx.select().from(materialValuation).where(and(
    eq(materialValuation.client, client),
    eq(materialValuation.materialNumber, materialNumber),
    eq(materialValuation.valuationArea, plant),
  ));
  if (!valuation?.valuationClass) {
    throw new InvoiceVerificationError(
      `Material ${materialNumber} carries no valuation class in plant ${plant}.`,
      'Complete the material valuation data, then post again.',
    );
  }
  const classRefusal = await postingValuationRefusal(tx, client, materialNumber, valuation.valuationClass);
  if (classRefusal) {
    throw new InvoiceVerificationError(classRefusal, 'Maintain a valuation class this material type permits, then post again.');
  }
  return valuation.valuationClass;
}

export interface PostInvoiceInput {
  client: string;
  changedBy: string;
  orderNumber: string;
  supplierReference: string;
  invoiceDate: string;
  postingDate: string;
  grossAmount: number;
  headerText?: string;
  requestKey: string;
  lines: Array<{ itemNumber: number; quantity: number; netAmount: number; taxCode?: string }>;
  /**
   * Advances to clear against this invoice, named by their payment document. The
   * amount defaults to what stands open on the advance; naming one at all is
   * always the user's decision, never the system's.
   */
  advances?: Array<{ paymentNumber: string; amount?: number }>;
}

interface InvoiceSettlement {
  clearingNumber: string;
  indicator: string;
  totalApplied: string;
}

/**
 * Clear the advances the user selected against the invoice that has just been posted.
 *
 * The invoice is posted first and settled second, in one transaction, because the
 * settlement clears an open vendor credit line — and that line does not exist until
 * the invoice journal stands written. Nothing about the invoice changes: the gross
 * stands, the tax stands, and the vendor is still credited in full. What the
 * settlement does is transfer value from the advance to the invoice, so the
 * supplier is owed the difference rather than the whole.
 *
 * Every guard the clearing already keeps on its own screen applies here as well:
 * vendor, company and currency must agree, and no advance can give more than it
 * still stands open at. What is added is the one rule only the invoice knows —
 * the advances may clear no more than the invoice is worth.
 */
async function settleAdvances(
  tx: Tx,
  input: {
    client: string; changedBy: string; orderNumber: string; invoiceNumber: string;
    supplierNumber: string; companyCode: string; currency: string;
    grossAmount: number; invoiceDate: string; postingDate: string;
    requestKey: string; journalDocumentNumber: string; journalFiscalYear: number;
    advances: NonNullable<PostInvoiceInput['advances']>;
  },
): Promise<InvoiceSettlement[]> {
  const requested = input.advances;
  if (requested.length === 0) return [];

  const [credit] = await tx.select().from(journalEntryLine).where(and(
    eq(journalEntryLine.client, input.client),
    eq(journalEntryLine.documentNumber, input.journalDocumentNumber),
    eq(journalEntryLine.fiscalYear, input.journalFiscalYear),
    eq(journalEntryLine.businessPartner, input.supplierNumber),
    eq(journalEntryLine.debitCredit, 'H'),
  ));
  if (!credit) {
    throw new InvoiceVerificationError(
      `Invoice ${input.invoiceNumber} posted no open credit to supplier ${input.supplierNumber}, so no advance can be cleared against it.`,
      'Post the invoice without advances, then clear them from the clearing screen.',
    );
  }

  const seen = new Set<string>();
  const groups = new Map<string, Array<{
    documentNumber: string; fiscalYear: number; lineNumber: number; applied: number;
  }>>();
  let total = 0;

  for (const request of requested) {
    const paymentNumber = request.paymentNumber?.trim();
    if (!paymentNumber) {
      throw new InvoiceVerificationError('An advance was named without a document number.');
    }
    if (seen.has(paymentNumber)) {
      throw new InvoiceVerificationError(
        `Advance ${paymentNumber} is named twice.`,
        'Name each advance once; the amount decides how much of it is cleared.',
      );
    }
    seen.add(paymentNumber);

    const [advance] = await tx.select().from(vendorDownPayment).where(and(
      eq(vendorDownPayment.client, input.client),
      eq(vendorDownPayment.paymentNumber, paymentNumber),
    ));
    if (!advance) {
      throw new InvoiceVerificationError(
        `Advance ${paymentNumber} does not stand.`,
        'Reload the order; the advances on offer are the ones that stand posted.',
      );
    }
    if (advance.vendorNumber !== input.supplierNumber) {
      throw new InvoiceVerificationError(
        `Advance ${paymentNumber} was paid to supplier ${advance.vendorNumber}, not to ${input.supplierNumber}.`,
        'An advance settles the supplier it was paid to.',
      );
    }
    if (advance.companyCode !== input.companyCode) {
      throw new InvoiceVerificationError(
        `Advance ${paymentNumber} was paid in company code ${advance.companyCode}, not in ${input.companyCode}.`,
        'An advance settles inside the company that paid it.',
      );
    }
    if (advance.currency !== input.currency) {
      throw new InvoiceVerificationError(
        `Advance ${paymentNumber} stands in ${advance.currency}; the invoice stands in ${input.currency}.`,
        'Clear advances in the currency they were paid in.',
      );
    }

    const standing = await getDownPaymentClearingTx(
      tx, input.client, input.supplierNumber, input.companyCode, advance.specialGlIndicator,
    );
    const open = standing.downPayments.find((row) => row.documentNumber === advance.journalDocumentNumber);
    if (!open) {
      throw new InvoiceVerificationError(
        `Advance ${paymentNumber} stands fully cleared already.`,
        'Reload the order; only what is still open can be cleared.',
      );
    }
    const applied = request.amount === undefined ? open.remaining : round2(request.amount);
    if (!(applied > 0)) {
      throw new InvoiceVerificationError(
        `Advance ${paymentNumber}: the amount to clear must stand above zero.`,
      );
    }
    if (applied - open.remaining > 0.005) {
      throw new InvoiceVerificationError(
        `Advance ${paymentNumber} stands open at ${open.remaining.toFixed(2)} ${input.currency}; ${applied.toFixed(2)} was asked of it.`,
        'Clear no more than the advance still stands at.',
      );
    }

    const group = groups.get(advance.specialGlIndicator) ?? [];
    group.push({
      documentNumber: open.documentNumber, fiscalYear: open.fiscalYear,
      lineNumber: open.lineNumber, applied,
    });
    groups.set(advance.specialGlIndicator, group);
    total = round2(total + applied);
  }

  // An advance is money already given, not a discount: clearing more than the
  // invoice is worth would leave the supplier owing us on a document that says
  // they owe nothing.
  if (total - round2(input.grossAmount) > 0.005) {
    throw new InvoiceVerificationError(
      `The advances asked to clear ${total.toFixed(2)} ${input.currency}, which exceeds the invoice gross ${round2(input.grossAmount).toFixed(2)}.`,
      'Clear no more than the invoice is worth.',
    );
  }

  const settlements: InvoiceSettlement[] = [];
  for (const [indicator, references] of groups) {
    const applied = round2(references.reduce((sum, row) => sum + row.applied, 0));
    const clearing = await clearDownPaymentsTx(tx, {
      client: input.client, changedBy: input.changedBy,
      vendorNumber: input.supplierNumber, companyCode: input.companyCode, indicator,
      documentDate: input.invoiceDate,
      postingDate: input.postingDate, clearingDate: input.postingDate,
      currency: input.currency,
      reference: input.invoiceNumber.length > 16 ? input.invoiceNumber.slice(0, 16) : input.invoiceNumber,
      requestKey: `${input.requestKey}/advance/${indicator}`,
      downPayments: references,
      invoices: [{
        documentNumber: credit.documentNumber, fiscalYear: credit.fiscalYear,
        lineNumber: credit.lineNumber, applied,
      }],
      invoiceNumber: input.invoiceNumber,
      purchaseOrder: input.orderNumber,
    }).catch((error: unknown) => {
      if (error instanceof VendorDownPaymentClearingError) {
        throw new InvoiceVerificationError(error.message, error.remedy);
      }
      throw error;
    });
    settlements.push({
      clearingNumber: clearing.clearingNumber, indicator, totalApplied: clearing.totalApplied,
    });
  }
  return settlements;
}

export async function postSupplierInvoice(input: PostInvoiceInput): Promise<SupplierInvoiceView> {
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/iv/${input.orderNumber}`}, 0))`);
    const view = await orderViewInTx(tx, input.client, input.orderNumber);
    if (!view) throw new InvoiceVerificationError(`Purchase order ${input.orderNumber} does not exist.`);
    if (!input.supplierReference) {
      throw new InvoiceVerificationError('The supplier reference is required.', 'Enter the number printed on the supplier invoice.');
    }
    if (input.lines.length === 0) {
      throw new InvoiceVerificationError('No invoice quantities were entered.', 'Enter a quantity for at least one item.');
    }

    const [supplier] = await tx.select().from(supplierCompany).where(and(
      eq(supplierCompany.client, input.client),
      eq(supplierCompany.partnerNumber, view.supplierNumber),
      eq(supplierCompany.companyCode, view.companyCode),
    ));
    if (!supplier) {
      throw new InvoiceVerificationError(
        `Supplier ${view.supplierNumber} carries no company data for ${view.companyCode}.`,
        'Maintain the supplier company data, then post again.',
      );
    }
    if (supplier.isBlocked) throw new InvoiceVerificationError(`Supplier ${view.supplierNumber} is blocked for ${view.companyCode}.`);
    if (!supplier.reconciliationAccount) {
      throw new InvoiceVerificationError(
        `Supplier ${view.supplierNumber} carries no reconciliation account for ${view.companyCode}.`,
        'Maintain the reconciliation account in the supplier company data.',
      );
    }

    const duplicate = await tx.select().from(supplierInvoice).where(and(
      eq(supplierInvoice.client, input.client),
      eq(supplierInvoice.companyCode, view.companyCode),
      eq(supplierInvoice.supplierNumber, view.supplierNumber),
      eq(supplierInvoice.supplierReference, input.supplierReference),
      eq(supplierInvoice.status, 'POSTED'),
      sql`${supplierInvoice.cancellationOf} is null`,
    ));
    if (duplicate.length > 0) {
      throw new InvoiceVerificationError(
        `Supplier reference ${input.supplierReference} already stands posted as invoice ${duplicate[0].invoiceNumber}.`,
        'Check for a duplicate entry; cancel the standing invoice if it is wrong.',
      );
    }
    const parkedDuplicate = await tx.select({ parkedNumber: parkedSupplierInvoice.parkedNumber }).from(parkedSupplierInvoice).where(and(
      eq(parkedSupplierInvoice.client, input.client),
      eq(parkedSupplierInvoice.companyCode, view.companyCode),
      eq(parkedSupplierInvoice.supplierNumber, view.supplierNumber),
      eq(parkedSupplierInvoice.supplierReference, input.supplierReference),
    ));
    if (parkedDuplicate.length > 0) {
      throw new InvoiceVerificationError(
        `Supplier reference ${input.supplierReference} already stands parked as ${parkedDuplicate[0].parkedNumber}.`,
        'Invoice verification does not post a parked invoice from this reference alone. Use another reference, or post from the parked invoice in a later round.',
      );
    }

    const company = await getCompanyCode(tx, input.client, view.companyCode);
    if (!company?.fiscalYearVariant || !company.country) {
      throw new InvoiceVerificationError(`Company code ${view.companyCode} is not configured.`);
    }
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const chart = supplier.chartOfAccounts;

    const itemsByNumber = new Map(view.items.map((i) => [i.itemNumber, i]));
    const taxRates = new Map<string, number>();
    for (const row of await tx.select().from(taxCode).where(and(
      eq(taxCode.client, input.client), eq(taxCode.country, company.country),
    ))) taxRates.set(row.taxCode, Number(row.ratePercent));

    const prepared: Array<{
      item: InvoiceItemView; quantity: number; netAmount: number; expected: number;
      variance: number; taxCode: string | null; taxAmount: number; valuationClass: string;
      /**
       * Where an account-assigned item's value goes, judged on the posting date.
       * Empty for a stock item, which settles through GR/IR instead.
       */
      shares: Array<{
        glAccount: string; amount: number;
        costCenter: string | null; internalOrder: string | null;
        assetNumber: string | null; assetSubNumber: string | null;
        assetTransactionType: string | null;
      }>;
    }> = [];
    for (const line of input.lines) {
      const item = itemsByNumber.get(line.itemNumber);
      if (!item) throw new InvoiceVerificationError(`Order item ${line.itemNumber} does not stand on ${input.orderNumber}.`);
      if (!item.eligible || !item.materialNumber) {
        throw new InvoiceVerificationError(`Item ${line.itemNumber} cannot be verified: ${item.refusal ?? 'not eligible.'}`);
      }
      if (!(line.quantity > 0)) throw new InvoiceVerificationError(`Item ${line.itemNumber}: the invoiced quantity must be positive.`);
      if (line.quantity > item.invoiceable + 1e-9) {
        throw new InvoiceVerificationError(
          item.invoiceBasis === 'GOODS_RECEIPT'
            ? `Item ${line.itemNumber}: ${line.quantity} exceeds the invoiceable quantity ${item.invoiceable} (received ${item.received}, already invoiced ${item.invoiced}).`
            : `Item ${line.itemNumber}: ${line.quantity} exceeds the quantity ordered and not yet invoiced, ${item.invoiceable} (ordered ${item.ordered}, already invoiced ${item.invoiced}). This item is not verified against goods receipts.`,
          item.invoiceBasis === 'GOODS_RECEIPT'
            ? 'Invoice no more than stands received and not yet invoiced.'
            : 'Invoice no more than stands ordered and not yet invoiced. The item is paid before the goods arrive, so nothing checks the quantity against a receipt.',
        );
      }
      if (!(line.netAmount >= 0)) throw new InvoiceVerificationError(`Item ${line.itemNumber}: the net amount cannot be negative.`);
      const code = (line.taxCode ?? item.taxCode ?? '').trim();
      let taxAmount = 0;
      if (code) {
        const rate = taxRates.get(code);
        if (rate === undefined) {
          throw new InvoiceVerificationError(`Tax code ${code} does not stand for country ${company.country}.`, 'Choose a standing tax code.');
        }
        taxAmount = round2((line.netAmount * rate) / 100);
      }
      const expected = round2((line.quantity * Number(item.netPrice)) / Number(item.priceUnit));
      // An account-assigned item is judged again here, on the day the money is posted, by
      // the same rule the order was written under. A cost centre locked since October, an
      // internal order that ended, an asset since deactivated: none of them may take the
      // value now, however valid they were when the commitment was made.
      const shares: typeof prepared[number]['shares'] = [];
      if (item.accountAssignmentCategory) {
        const judged = await judgeAccountAssignments(tx, {
          client: input.client, companyCode: view.companyCode, chartOfAccounts: chart,
          onDate: input.postingDate,
          category: item.accountAssignmentCategory, rows: item.assignments,
        });
        if (judged.refusal) {
          throw new InvoiceVerificationError(
            `Item ${line.itemNumber}: ${judged.refusal}`,
            'Put the account assignment right on the order, then verify the invoice again.',
          );
        }
        // The value is what the supplier charged: with no stock to revalue there is no
        // variance to separate, and the order price was a planning figure. The last share
        // takes the rounding so the shares add up to the invoice exactly.
        const net = round2(line.netAmount);
        let given = 0;
        judged.rows.forEach((row, index) => {
          const amount = index === judged.rows.length - 1
            ? round2(net - given)
            : round2((net * row.percentage) / 100);
          given = round2(given + amount);
          shares.push({
            glAccount: row.glAccount, amount,
            costCenter: row.costCenter, internalOrder: row.internalOrder,
            assetNumber: row.assetNumber, assetSubNumber: row.assetSubNumber,
            assetTransactionType: row.assetTransactionType,
          });
        });
      }
      prepared.push({
        item, quantity: line.quantity, netAmount: round2(line.netAmount), expected,
        variance: round2(line.netAmount - expected),
        taxCode: code || null, taxAmount,
        valuationClass: item.accountAssignmentCategory
          ? ''
          : await valuationClassFor(tx, input.client, item.materialNumber, item.plant),
        shares,
      });
    }

    const netTotal = round2(prepared.reduce((s, p) => s + p.netAmount, 0));
    const taxTotal = round2(prepared.reduce((s, p) => s + p.taxAmount, 0));
    if (Math.abs(round2(netTotal + taxTotal) - round2(input.grossAmount)) > 0.005) {
      throw new InvoiceVerificationError(
        `The gross amount ${round2(input.grossAmount).toFixed(2)} does not reconcile: items net ${netTotal.toFixed(2)} plus tax ${taxTotal.toFixed(2)} is ${round2(netTotal + taxTotal).toFixed(2)}.`,
        'Correct the gross amount or the item amounts so the document balances.',
      );
    }

    // Asked for only when something settles through GR/IR. An order of nothing but
    // account-assigned items buys no stock, and a tenant that has never configured a
    // GR/IR account has no reason to be told about one.
    let grIr: string | null = null;
    const grIrAccount = async (): Promise<string> => (
      grIr ??= await resolveAccount(tx, input.client, chart, 'GR_IR_CLEARING', '')
    );
    const journalLines: Array<{
      glAccount: string; debitCredit: 'S' | 'H'; amount: string;
      businessPartner?: string; material?: string; plant?: string; taxCode?: string;
    }> = [];
    const taxByCode = new Map<string, number>();
    /** What each asset takes from this invoice, capitalized once the journal stands. */
    const assetCharges: Array<{
      assetNumber: string; subNumber: string; transactionType: string; amount: number;
    }> = [];
    for (const p of prepared) {
      if (p.shares.length > 0) {
        // Nothing here touches GR/IR. An account-assigned item buys no stock, so there
        // is no receipt for the invoice to clear and no balance left to explain: the
        // value goes where the order said it belonged.
        for (const share of p.shares) {
          journalLines.push({
            glAccount: share.glAccount, debitCredit: 'S', amount: share.amount.toFixed(2),
            ...(share.costCenter ? { costCenter: share.costCenter } : {}),
            ...(share.internalOrder ? { internalOrder: share.internalOrder } : {}),
            ...(share.assetNumber ? { lineText: `Asset ${share.assetNumber}/${share.assetSubNumber ?? '0000'}` } : {}),
            plant: p.item.plant,
          });
          if (share.assetNumber) {
            assetCharges.push({
              assetNumber: share.assetNumber, subNumber: share.assetSubNumber ?? '0000',
              transactionType: share.assetTransactionType!, amount: share.amount,
            });
          }
        }
      } else {
        journalLines.push({
          glAccount: await grIrAccount(), debitCredit: 'S', amount: p.expected.toFixed(2),
          material: p.item.materialNumber!, plant: p.item.plant,
        });
        if (p.variance !== 0) {
          const prd = await resolveAccount(tx, input.client, chart, 'PRICE_DIFFERENCE', p.valuationClass);
          journalLines.push({
            glAccount: prd, debitCredit: p.variance > 0 ? 'S' : 'H',
            amount: Math.abs(p.variance).toFixed(2), material: p.item.materialNumber!, plant: p.item.plant,
          });
        }
      }
      if (p.taxAmount > 0 && p.taxCode) {
        taxByCode.set(p.taxCode, round2((taxByCode.get(p.taxCode) ?? 0) + p.taxAmount));
      }
    }
    for (const [code, amount] of taxByCode) {
      const taxAccount = await resolveAccount(tx, input.client, chart, 'TAX', '');
      journalLines.push({ glAccount: taxAccount, debitCredit: 'S', amount: amount.toFixed(2), taxCode: code });
    }
    journalLines.push({
      glAccount: supplier.reconciliationAccount, debitCredit: 'H',
      amount: round2(input.grossAmount).toFixed(2), businessPartner: view.supplierNumber,
    });

    // Payment terms and the due date they compute.
    let baseline: string | null = null;
    let due: string | null = null;
    if (supplier.paymentTermsCode) {
      const [terms] = await tx.select().from(paymentTerms).where(and(
        eq(paymentTerms.client, input.client), eq(paymentTerms.termsCode, supplier.paymentTermsCode),
      ));
      if (terms) {
        baseline = terms.baselineSource === 'POSTING_DATE' ? input.postingDate : input.invoiceDate;
        const d = new Date(`${baseline}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + terms.netDays);
        due = d.toISOString().slice(0, 10);
      }
    }

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'VENDINV', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: view.companyCode,
      documentType: JOURNAL_DOCUMENT_TYPE,
      documentDate: input.invoiceDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: view.currency,
      localCurrency: company.currency,
      reference: input.supplierReference,
      headerText: input.headerText,
      lines: journalLines,
      origin: { documentClass: INVOICE_CLASS, documentKey: number },
      postedBy: input.changedBy,
      transactionCode: INVOICE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new InvoiceVerificationError(error.message, error.remedy);
      throw error;
    });

    // An asset-assigned line capitalizes as the invoice posts: the value has gone and the
    // supplier stands credited, so the asset must carry it. The invoice's own journal is
    // the posting — no second journal is written, because a second journal would credit
    // the supplier twice.
    for (const charge of assetCharges) {
      if (!(charge.amount > 0)) continue;
      await recordAssetAcquisition(tx, {
        client: input.client, changedBy: input.changedBy,
        companyCode: view.companyCode,
        assetNumber: charge.assetNumber, subNumber: charge.subNumber,
        transactionType: charge.transactionType,
        documentDate: input.invoiceDate, postingDate: input.postingDate,
        assetValueDate: input.postingDate,
        amount: charge.amount, currency: view.currency,
        offsetAccount: supplier.reconciliationAccount,
        reference: `Invoice ${number}`,
        text: `Order ${input.orderNumber}`,
        documentNumber: journal.documentNumber, fiscalYear: journal.fiscalYear,
        requestKey: `${input.requestKey}/asset/${charge.assetNumber}-${charge.subNumber}`,
      }).catch((error: unknown) => {
        if (error instanceof AssetAcquisitionError) {
          throw new InvoiceVerificationError(error.message, error.remedy);
        }
        throw error;
      });
    }

    await tx.insert(supplierInvoice).values({
      client: input.client, invoiceNumber: number, fiscalYear: position.fiscalYear,
      category: 'INVOICE', supplierNumber: view.supplierNumber, companyCode: view.companyCode,
      purchaseOrderNumber: input.orderNumber,
      invoiceDate: input.invoiceDate, postingDate: input.postingDate,
      supplierReference: input.supplierReference, currency: view.currency,
      grossAmount: String(round2(input.grossAmount)), taxAmount: String(taxTotal),
      paymentTerms: supplier.paymentTermsCode, baselineDate: baseline, dueDate: due,
      headerText: input.headerText ?? null, status: 'POSTED',
      journalDocumentNumber: journal.documentNumber, requestKey: input.requestKey,
      createdBy: input.changedBy,
    });
    let lineNumber = 0;
    for (const p of prepared) {
      lineNumber += 1;
      await tx.insert(supplierInvoiceItem).values({
        client: input.client, invoiceNumber: number, lineNumber,
        purchaseOrderNumber: input.orderNumber, purchaseOrderItem: p.item.itemNumber,
        materialNumber: p.item.materialNumber, plant: p.item.plant,
        quantity: String(p.quantity), unit: p.item.unit,
        netAmount: String(p.netAmount), expectedAmount: String(p.expected),
        varianceAmount: String(p.variance), taxCode: p.taxCode,
        taxAmount: String(p.taxAmount), createdBy: input.changedBy,
      });
    }
    const settlements = await settleAdvances(tx, {
      client: input.client, changedBy: input.changedBy, orderNumber: input.orderNumber,
      invoiceNumber: number, supplierNumber: view.supplierNumber, companyCode: view.companyCode,
      currency: view.currency, grossAmount: input.grossAmount,
      invoiceDate: input.invoiceDate, postingDate: input.postingDate,
      requestKey: input.requestKey,
      journalDocumentNumber: journal.documentNumber, journalFiscalYear: journal.fiscalYear,
      advances: input.advances ?? [],
    });

    await linkDocuments(tx, {
      client: input.client,
      predecessor: { documentClass: 'purchase_order', documentKey: input.orderNumber },
      successor: { documentClass: INVOICE_CLASS, documentKey: number },
      relationType: 'INVOICE_VERIFICATION',
      createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: INVOICE_CLASS, objectKey: number,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: INVOICE_CAPABILITY,
      after: {
        order: input.orderNumber, supplier: view.supplierNumber,
        gross: round2(input.grossAmount), tax: taxTotal, journal: journal.documentNumber,
        advances: settlements.map((row) => ({
          clearing: row.clearingNumber, indicator: row.indicator, applied: row.totalApplied,
        })),
      },
    });

    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}

export interface CancelInvoiceInput {
  client: string;
  changedBy: string;
  invoiceNumber: string;
  postingDate: string;
  requestKey: string;
}

export async function cancelSupplierInvoice(input: CancelInvoiceInput): Promise<SupplierInvoiceView> {
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;

    const original = await loadView(tx, input.client, input.invoiceNumber);
    if (!original) throw new InvoiceVerificationError(`Invoice ${input.invoiceNumber} does not exist.`);
    if (original.status === 'CANCELLED') {
      throw new InvoiceVerificationError(`Invoice ${input.invoiceNumber} has already been cancelled by ${original.cancelledBy}.`);
    }
    if (original.cancellationOf) {
      throw new InvoiceVerificationError('A cancellation document cannot itself be cancelled.', 'Cancel the original invoice instead.');
    }
    if (!original.journalDocumentNumber) throw new InvoiceVerificationError('The invoice carries no journal to mirror.');

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'VENDINV', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    // Advances cleared against the invoice come off with it. An advance is money
    // already paid: leaving it cleared against an invoice that no longer stands
    // would spend it twice. The clearing is reset first, which reopens the advance
    // and the invoice line, and only then reversed — a reversal mirrors a document
    // that stands posted, and a reset will not touch one already reversed.
    const settlements = (await loadSettlements(tx, input.client, input.invoiceNumber))
      .filter((row) => !row.reversed);
    for (const settlement of settlements) {
      await resetClearingTx(tx, {
        client: input.client, changedBy: input.changedBy,
        companyCode: original.companyCode,
        clearingDocument: settlement.clearingNumber, fiscalYear: settlement.fiscalYear,
        reason: `Invoice cancellation ${number}`,
        requestKey: `${input.requestKey}/reset/${settlement.clearingNumber}`,
      }).catch((error: unknown) => {
        if (error instanceof ClearingResetError) {
          throw new InvoiceVerificationError(error.message, error.remedy);
        }
        throw error;
      });
      await reverseJournalEntry(tx, {
        client: input.client,
        documentNumber: settlement.clearingNumber, fiscalYear: settlement.fiscalYear,
        reversalDate: input.postingDate,
        reason: `Invoice cancellation ${number}`,
        reversedBy: input.changedBy,
        transactionCode: INVOICE_CAPABILITY,
      }).catch((error: unknown) => {
        if (error instanceof PostingError) throw new InvoiceVerificationError(error.message, error.remedy);
        throw error;
      });
    }

    const journalYear = Number(original.journalDocumentNumber.split('/')[1]);

    const reversal = await reverseJournalEntry(tx, {
      client: input.client,
      documentNumber: original.journalDocumentNumber,
      fiscalYear: journalYear,
      reversalDate: input.postingDate,
      reason: `Invoice cancellation ${number}`,
      reversedBy: input.changedBy,
      transactionCode: INVOICE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new InvoiceVerificationError(error.message, error.remedy);
      throw error;
    });

    // What the invoice capitalized comes off the asset with it. The reversal above
    // already mirrored the journal, so the asset's value record follows that document
    // rather than starting a second reversal — a second one would credit the supplier twice.
    await markAssetAcquisitionsReversedTx(tx, {
      client: input.client, changedBy: input.changedBy, companyCode: original.companyCode,
      documentNumber: original.journalDocumentNumber, fiscalYear: journalYear,
      reversalDocumentNumber: reversal.documentNumber,
      reason: `Invoice cancellation ${number}`,
    });

    const company = await getCompanyCode(tx, input.client, original.companyCode);
    const position = company?.fiscalYearVariant
      ? await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate)
      : { fiscalYear: Number(input.postingDate.slice(0, 4)), period: Number(input.postingDate.slice(5, 7)) };

    await tx.insert(supplierInvoice).values({
      client: input.client, invoiceNumber: number, fiscalYear: position.fiscalYear,
      category: original.category, supplierNumber: original.supplierNumber,
      companyCode: original.companyCode, purchaseOrderNumber: original.purchaseOrderNumber,
      invoiceDate: original.invoiceDate, postingDate: input.postingDate,
      supplierReference: original.supplierReference, currency: original.currency,
      grossAmount: original.grossAmount, taxAmount: original.taxAmount,
      paymentTerms: original.paymentTerms, baselineDate: original.baselineDate,
      dueDate: original.dueDate, headerText: `Cancellation of ${original.invoiceNumber}`,
      status: 'POSTED', journalDocumentNumber: reversal.documentNumber,
      cancellationOf: original.invoiceNumber, requestKey: input.requestKey,
      createdBy: input.changedBy,
    });
    const [origHeader] = await tx.select().from(supplierInvoice).where(and(
      eq(supplierInvoice.client, input.client), eq(supplierInvoice.invoiceNumber, original.invoiceNumber),
    ));
    void origHeader;
    const origItems = await tx.select().from(supplierInvoiceItem).where(and(
      eq(supplierInvoiceItem.client, input.client),
      eq(supplierInvoiceItem.invoiceNumber, original.invoiceNumber),
    ));
    for (const item of origItems) {
      await tx.insert(supplierInvoiceItem).values({
        client: input.client, invoiceNumber: number, lineNumber: item.lineNumber,
        purchaseOrderNumber: item.purchaseOrderNumber, purchaseOrderItem: item.purchaseOrderItem,
        materialNumber: item.materialNumber, plant: item.plant,
        quantity: item.quantity, unit: item.unit,
        netAmount: item.netAmount, expectedAmount: item.expectedAmount,
        varianceAmount: item.varianceAmount, taxCode: item.taxCode,
        taxAmount: item.taxAmount, createdBy: input.changedBy,
      });
    }
    await tx.update(supplierInvoice).set({
      status: 'CANCELLED', cancelledBy: number, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(supplierInvoice.client, input.client),
      eq(supplierInvoice.invoiceNumber, original.invoiceNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: INVOICE_CLASS, objectKey: number,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: INVOICE_CAPABILITY,
      after: { cancellationOf: original.invoiceNumber, journal: reversal.documentNumber },
    });

    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}
