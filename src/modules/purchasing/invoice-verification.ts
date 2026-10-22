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
import { accountDetermination, taxCode } from '../foundation/schema';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import { materialDocumentLine, materialValuation, movementType } from '../inventory/schema';
import {
  parkedSupplierInvoice,
  purchaseOrder, purchaseOrderItem, supplierInvoice, supplierInvoiceItem,
} from './schema';

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
}

async function orderViewInTx(tx: Tx, client: string, orderNumber: string): Promise<InvoiceOrderView | null> {
  const [header] = await tx.select().from(purchaseOrder).where(and(
    eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber),
  ));
  if (!header) return null;
  const items = await tx.select().from(purchaseOrderItem).where(and(
    eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, orderNumber),
  )).orderBy(purchaseOrderItem.itemNumber);
  const received = await receivedQuantities(tx, client, orderNumber);
  const invoiced = await invoicedQuantities(tx, client, orderNumber);
  return {
    orderNumber: header.orderNumber,
    supplierNumber: header.supplierNumber,
    companyCode: header.companyCode,
    currency: header.currency,
    items: items.map((item) => {
      const got = received.get(item.itemNumber) ?? 0;
      const done = invoiced.get(item.itemNumber) ?? 0;
      let refusal: string | null = null;
      if (item.markedForDeletion) refusal = 'The item is marked for deletion.';
      else if (!item.materialNumber) refusal = 'Text items carry no goods receipt to verify against this round.';
      else if (item.accountAssignmentCategory) refusal = 'Account-assigned items verify without GR/IR this round.';
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
        invoiceable: Math.max(0, got - done),
        netPrice: item.netPrice,
        priceUnit: item.priceUnit,
        eligible: !refusal,
        refusal,
      };
    }),
  };
}

export async function getInvoiceOrder(client: string, orderNumber: string): Promise<InvoiceOrderView | null> {
  return withTenant(client, (tx) => orderViewInTx(tx, client, orderNumber));
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
}

function toView(
  header: typeof supplierInvoice.$inferSelect,
  items: Array<typeof supplierInvoiceItem.$inferSelect>,
): SupplierInvoiceView {
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
  };
}

async function loadView(tx: Tx, client: string, number: string): Promise<SupplierInvoiceView | null> {
  const [header] = await tx.select().from(supplierInvoice).where(and(
    eq(supplierInvoice.client, client), eq(supplierInvoice.invoiceNumber, number),
  ));
  if (!header) return null;
  const items = await tx.select().from(supplierInvoiceItem).where(and(
    eq(supplierInvoiceItem.client, client), eq(supplierInvoiceItem.invoiceNumber, number),
  )).orderBy(supplierInvoiceItem.lineNumber);
  return toView(header, items);
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
          `Item ${line.itemNumber}: ${line.quantity} exceeds the invoiceable quantity ${item.invoiceable} (received ${item.received}, already invoiced ${item.invoiced}).`,
          'Invoice no more than stands received and not yet invoiced.',
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
      prepared.push({
        item, quantity: line.quantity, netAmount: round2(line.netAmount), expected,
        variance: round2(line.netAmount - expected),
        taxCode: code || null, taxAmount,
        valuationClass: await valuationClassFor(tx, input.client, item.materialNumber, item.plant),
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

    const grIrAccount = await resolveAccount(tx, input.client, chart, 'GR_IR_CLEARING', '');
    const journalLines: Array<{
      glAccount: string; debitCredit: 'S' | 'H'; amount: string;
      businessPartner?: string; material?: string; plant?: string; taxCode?: string;
    }> = [];
    const taxByCode = new Map<string, number>();
    for (const p of prepared) {
      journalLines.push({
        glAccount: grIrAccount, debitCredit: 'S', amount: p.expected.toFixed(2),
        material: p.item.materialNumber!, plant: p.item.plant,
      });
      if (p.variance !== 0) {
        const prd = await resolveAccount(tx, input.client, chart, 'PRICE_DIFFERENCE', p.valuationClass);
        journalLines.push({
          glAccount: prd, debitCredit: p.variance > 0 ? 'S' : 'H',
          amount: Math.abs(p.variance).toFixed(2), material: p.item.materialNumber!, plant: p.item.plant,
        });
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
