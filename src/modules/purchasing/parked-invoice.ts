/**
 * Park a supplier invoice — SCR-160.
 *
 * The park keeps the header and the lines. It does not post a journal, it
 * does not write supplier_invoice, and it does not consume the purchase order
 * or the goods receipt. Invoice verification posts. A check writes nothing,
 * including the number. The match is calculated when the document is read.
 * It is not a stored status.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';

import { changeHistory, recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode, PeriodError } from '../../platform/periods';
import { taxCode } from '../foundation/schema';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import { materialDocumentLine, movementType } from '../inventory/schema';
import {
  parkedSupplierInvoice, parkedSupplierInvoiceItem,
  purchaseOrder, purchaseOrderItem, supplierInvoice, supplierInvoiceItem,
} from './schema';

export const PARKED_INVOICE_CAPABILITY = 'PROC.INV.PARK';
export const PARKED_INVOICE_ROUTE = '/purchasing/parked-invoice';
const PARKED_CLASS = 'PARKED_SUPPLIER_INVOICE';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ParkedInvoiceError extends Error {
  readonly code = 'CAIRN_PARKED_INVOICE';
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ParkedInvoiceError';
    this.remedy = remedy;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => round2(n).toFixed(2);

export interface ParkedInvoiceLineInput {
  itemNumber: number;
  quantity: number;
  netAmount: number;
  taxCode?: string;
  taxAmount?: number;
  unit?: string;
}

export interface ParkedInvoiceInput {
  client: string;
  changedBy: string;
  orderNumber: string;
  supplierReference: string;
  invoiceDate: string;
  postingDate: string;
  grossAmount: number;
  headerText?: string;
  lines: ParkedInvoiceLineInput[];
  reason?: string;
  category?: string;
  currency?: string;
  companyCode?: string;
  supplierNumber?: string;
  paymentTerms?: string;
  exchangeRate?: string;
  freight?: string;
  discount?: string;
  status?: string;
  approval?: string;
  hold?: string;
  workflow?: string;
  draft?: string;
  posting?: string;
  award?: string;
  deletion?: string;
  requestKey?: string;
  taxAmount?: number;
}

export interface ParkedLineView {
  itemNumber: number;
  materialNumber: string | null;
  shortText: string;
  plant: string;
  unit: string;
  quantity: string;
  netAmount: string;
  expectedAmount: string;
  varianceAmount: string;
  taxCode: string | null;
  taxAmount: string;
  received: string;
  invoiced: string;
  invoiceable: string;
  note: string | null;
}

export interface ParkedInvoicePreview {
  parkedNumber: string | null;
  orderNumber: string;
  supplierNumber: string;
  companyCode: string;
  currency: string;
  supplierReference: string;
  invoiceDate: string;
  postingDate: string;
  fiscalYear: number;
  grossAmount: string;
  taxAmount: string;
  netAmount: string;
  paymentTerms: string | null;
  baselineDate: string | null;
  dueDate: string | null;
  headerText: string | null;
  notes: string[];
  lines: ParkedLineView[];
}

export interface ParkedHistoryField {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface ParkedInvoiceView extends ParkedInvoicePreview {
  parkedNumber: string;
  changedAt: string;
  history: Array<{
    changedAt: string;
    changeType: string;
    changedBy: string;
    fields: ParkedHistoryField[];
  }>;
}

export interface OpenedParkItem {
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

export interface OpenedPark {
  orderNumber: string;
  supplierNumber: string;
  companyCode: string;
  currency: string;
  items: OpenedParkItem[];
  parks: Array<{ parkedNumber: string; supplierReference: string; grossAmount: string }>;
}

interface StandingLine {
  itemNumber: number;
  quantity: number;
  netAmount: number;
  taxCode: string | null;
}

interface Prepared {
  preview: ParkedInvoicePreview;
  supplierNumber: string;
  companyCode: string;
  currency: string;
  paymentTerms: string | null;
  baselineDate: string | null;
  dueDate: string | null;
  fiscalYear: number;
  lines: Array<{
    itemNumber: number;
    materialNumber: string | null;
    plant: string;
    unit: string;
    quantity: number;
    netAmount: number;
    expectedAmount: number;
    varianceAmount: number;
    taxCode: string | null;
    taxAmount: number;
  }>;
}

function named(value: string | undefined): string {
  return value?.trim() ?? '';
}

function refuseNamed(input: ParkedInvoiceInput, checking: boolean): void {
  const category = named(input.category).toUpperCase();
  if (category === 'CREDIT_MEMO') {
    throw new ParkedInvoiceError(
      'A credit memo is not parked this round.',
      'Invoice verification posts an invoice. This screen does not post.',
    );
  }
  if (category === 'SUBSEQUENT_DEBIT') {
    throw new ParkedInvoiceError('A subsequent debit is not parked this round.', 'Invoice verification posts an invoice.');
  }
  if (category === 'SUBSEQUENT_CREDIT') {
    throw new ParkedInvoiceError('A subsequent credit is not parked this round.', 'Invoice verification posts an invoice.');
  }
  if (category) {
    throw new ParkedInvoiceError(
      'The park is an invoice. A category is not a field.',
      'A credit memo, a subsequent debit and a subsequent credit are not parked this round.',
    );
  }
  if (named(input.currency)) {
    throw new ParkedInvoiceError('The currency is the order\'s. It is not a field on the park.');
  }
  if (named(input.companyCode)) {
    throw new ParkedInvoiceError('The company code is the order\'s. It is not a field on the park.');
  }
  if (named(input.supplierNumber)) {
    throw new ParkedInvoiceError('The supplier is the order\'s. It is not a field on the park.');
  }
  if (named(input.paymentTerms)) {
    throw new ParkedInvoiceError('Payment terms are the supplier\'s. They are not a field on the park.');
  }
  if (input.taxAmount !== undefined) {
    throw new ParkedInvoiceError('The tax is the standing tax code\'s. It is not entered.');
  }
  if (named(input.exchangeRate)) {
    throw new ParkedInvoiceError('An exchange rate is not read. The currency is the order\'s.');
  }
  if (named(input.freight)) {
    throw new ParkedInvoiceError('Freight is not a field on the park.');
  }
  if (named(input.discount)) {
    throw new ParkedInvoiceError('A discount is not a field on the park.');
  }
  if (named(input.status) || named(input.draft)) {
    throw new ParkedInvoiceError('A parked invoice has no status. The row is the park.');
  }
  if (named(input.approval) || named(input.hold) || named(input.workflow)) {
    throw new ParkedInvoiceError(
      'An approval is not this screen. The park stands without a workflow.',
      'A later posting is invoice verification.',
    );
  }
  if (named(input.posting)) {
    throw new ParkedInvoiceError(
      'Posting is invoice verification. This screen does not post a journal, and it does not write a supplier invoice.',
      'Open invoice verification to post. A parked invoice is not invoiced quantity.',
    );
  }
  if (named(input.award)) {
    throw new ParkedInvoiceError('A parked invoice is not an award, and it is not a purchase order.');
  }
  if (named(input.deletion)) {
    throw new ParkedInvoiceError(
      'A parked invoice is not deleted. It stands until a later posting.',
      'Change the parked invoice, or leave it.',
    );
  }
  if (checking && named(input.requestKey)) {
    throw new ParkedInvoiceError('A request key is not a field on the check. A check writes nothing, including the number.');
  }
  const reason = named(input.reason);
  if (reason.length > 500) {
    throw new ParkedInvoiceError('The reason is longer than 500 characters.');
  }
}

function requireDates(input: ParkedInvoiceInput): { invoiceDate: string; postingDate: string; reference: string; headerText: string | null } {
  const invoiceDate = named(input.invoiceDate);
  const postingDate = named(input.postingDate);
  if (!DATE.test(invoiceDate)) {
    throw new ParkedInvoiceError('The invoice date is required.', 'Use the date printed on the supplier invoice.');
  }
  if (!DATE.test(postingDate)) {
    throw new ParkedInvoiceError(
      'The proposed posting date is required.',
      'A closed period does not block a park. A date that is not a date does.',
    );
  }
  const reference = named(input.supplierReference);
  if (!reference) {
    throw new ParkedInvoiceError('The supplier reference is required.', 'Enter the number printed on the supplier invoice.');
  }
  if (reference.length > 16) {
    throw new ParkedInvoiceError('The supplier reference is longer than 16 characters.');
  }
  const headerText = named(input.headerText);
  if (headerText.length > 100) {
    throw new ParkedInvoiceError('The header text is longer than 100 characters.');
  }
  return { invoiceDate, postingDate, reference, headerText: headerText || null };
}

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
  for (const movement of await tx.select().from(movementType).where(eq(movementType.client, client))) {
    directions.set(movement.movementType, movement.direction);
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

function lineNote(itemNumber: number, quantity: number, received: number, invoiced: number, invoiceable: number, variance: number): string | null {
  if (received <= 1e-9) {
    return `Item ${itemNumber}: nothing has been received. The park keeps the line. Invoice verification will refuse it until a receipt stands.`;
  }
  if (quantity > invoiceable + 1e-9) {
    return `Item ${itemNumber}: quantity ${quantity} is above the invoiceable quantity ${invoiceable} (received ${received}, already invoiced ${invoiced}). The park keeps the line. It does not count as invoiced.`;
  }
  if (variance !== 0) {
    return `Item ${itemNumber}: the net differs from the order price by ${money(variance)}. The difference is calculated. It is not a match status.`;
  }
  return null;
}

async function prepare(
  tx: Tx,
  input: ParkedInvoiceInput,
  standing: Map<number, StandingLine> | null,
  exceptParkedNumber: string | null,
): Promise<Prepared> {
  const dates = requireDates(input);
  const orderNumber = named(input.orderNumber).toUpperCase();
  if (!orderNumber) {
    throw new ParkedInvoiceError('The purchase order is required.', 'Name one standing purchase order.');
  }
  if (!Number.isFinite(input.grossAmount) || input.grossAmount < 0) {
    throw new ParkedInvoiceError('The gross amount must be zero or greater.', 'Enter the supplier invoice gross.');
  }
  if (input.lines.length === 0) {
    throw new ParkedInvoiceError('No invoice quantities were entered.', 'Enter a quantity for at least one item.');
  }
  const seen = new Set<number>();
  for (const line of input.lines) {
    if (seen.has(line.itemNumber)) {
      throw new ParkedInvoiceError(`Item ${line.itemNumber} is named twice.`);
    }
    seen.add(line.itemNumber);
    if (line.taxAmount !== undefined) {
      throw new ParkedInvoiceError('The tax is the standing tax code\'s. It is not entered.');
    }
    if (named(line.unit)) {
      throw new ParkedInvoiceError('The unit is the order item\'s. It is not a field on the park.');
    }
  }

  const [header] = await tx.select().from(purchaseOrder).where(and(
    eq(purchaseOrder.client, input.client), eq(purchaseOrder.orderNumber, orderNumber),
  ));
  if (!header) {
    throw new ParkedInvoiceError(`Purchase order ${orderNumber} does not stand.`, 'Open a standing purchase order.');
  }
  const currency = header.currency.trim();
  if (currency.length !== 3) {
    throw new ParkedInvoiceError(`The order currency ${header.currency} is not a standing currency.`);
  }
  const items = await tx.select().from(purchaseOrderItem).where(and(
    eq(purchaseOrderItem.client, input.client), eq(purchaseOrderItem.orderNumber, orderNumber),
  ));
  const byItem = new Map(items.map((item) => [item.itemNumber, item]));
  const received = await receivedQuantities(tx, input.client, orderNumber);
  const invoiced = await invoicedQuantities(tx, input.client, orderNumber);

  const [supplier] = await tx.select().from(supplierCompany).where(and(
    eq(supplierCompany.client, input.client),
    eq(supplierCompany.partnerNumber, header.supplierNumber),
    eq(supplierCompany.companyCode, header.companyCode),
  ));
  if (supplier?.isBlocked) {
    throw new ParkedInvoiceError(`Supplier ${header.supplierNumber} is blocked for ${header.companyCode}.`);
  }

  const company = await getCompanyCode(tx, input.client, header.companyCode);
  if (!company?.fiscalYearVariant) {
    throw new ParkedInvoiceError(
      `Company code ${header.companyCode} has no fiscal year variant. The proposed posting date cannot be placed in a year.`,
      'Assign a fiscal year variant. A closed period is not what blocks this.',
    );
  }
  let fiscalYear: number;
  try {
    fiscalYear = (await derivePosition(tx, input.client, company.fiscalYearVariant, dates.postingDate)).fiscalYear;
  } catch (caught) {
    if (caught instanceof PeriodError) {
      throw new ParkedInvoiceError(
        `The proposed posting date ${dates.postingDate} does not fall in a fiscal year.`,
        'A closed period does not block a park. A date with no year does.',
      );
    }
    throw caught;
  }

  const taxRates = new Map<string, number>();
  if (company.country) {
    for (const row of await tx.select().from(taxCode).where(and(
      eq(taxCode.client, input.client), eq(taxCode.country, company.country),
    ))) taxRates.set(row.taxCode, Number(row.ratePercent));
  }

  const notes: string[] = [];
  if (!supplier) {
    notes.push(`Supplier ${header.supplierNumber} has no company data for ${header.companyCode}. Payment terms were not derived. Invoice verification will refuse the post until they stand.`);
  }
  const preparedLines: Prepared['lines'] = [];
  const viewLines: ParkedLineView[] = [];
  for (const line of input.lines) {
    const item = byItem.get(line.itemNumber);
    if (!item) {
      throw new ParkedInvoiceError(`Order item ${line.itemNumber} does not stand on ${orderNumber}.`);
    }
    let refusal: string | null = null;
    if (item.markedForDeletion) refusal = 'The item is marked for deletion.';
    else if (!item.materialNumber) refusal = 'Text items carry no goods receipt to verify against this round.';
    else if (item.accountAssignmentCategory) refusal = 'Account-assigned items verify without GR/IR this round.';
    const previous = standing?.get(line.itemNumber);
    if (refusal) {
      const unchanged = previous
        && previous.quantity === line.quantity
        && previous.netAmount === round2(line.netAmount)
        && (previous.taxCode ?? '') === named(line.taxCode);
      if (!unchanged) {
        throw new ParkedInvoiceError(
          `Item ${line.itemNumber} cannot be parked: ${refusal}`,
          previous ? 'The saved line stands. A change to it is refused.' : 'Invoice verification will not post this item. The park does not keep a line it cannot name.',
        );
      }
    }
    if (!(line.quantity > 0)) {
      throw new ParkedInvoiceError(`Item ${line.itemNumber}: the quantity must be positive.`);
    }
    if (!(line.netAmount >= 0) || !Number.isFinite(line.netAmount)) {
      throw new ParkedInvoiceError(`Item ${line.itemNumber}: the net amount cannot be negative.`);
    }
    const code = named(line.taxCode);
    let taxAmount = 0;
    if (code) {
      const rate = taxRates.get(code);
      if (rate === undefined) {
        throw new ParkedInvoiceError(
          `Tax code ${code} does not stand for country ${company.country ?? 'unknown'}.`,
          'Choose a standing tax code. The tax is not entered as an amount.',
        );
      }
      taxAmount = round2((round2(line.netAmount) * rate) / 100);
    }
    const got = received.get(line.itemNumber) ?? 0;
    const done = invoiced.get(line.itemNumber) ?? 0;
    const invoiceable = Math.max(0, got - done);
    const expected = round2((line.quantity * Number(item.netPrice)) / Number(item.priceUnit));
    const netAmount = round2(line.netAmount);
    const variance = round2(netAmount - expected);
    const note = lineNote(line.itemNumber, line.quantity, got, done, invoiceable, variance);
    if (note) notes.push(note);
    preparedLines.push({
      itemNumber: line.itemNumber,
      materialNumber: item.materialNumber,
      plant: item.plant,
      unit: item.unit,
      quantity: line.quantity,
      netAmount,
      expectedAmount: expected,
      varianceAmount: variance,
      taxCode: code || null,
      taxAmount,
    });
    viewLines.push({
      itemNumber: line.itemNumber,
      materialNumber: item.materialNumber,
      shortText: item.shortText,
      plant: item.plant,
      unit: item.unit,
      quantity: String(line.quantity),
      netAmount: money(netAmount),
      expectedAmount: money(expected),
      varianceAmount: money(variance),
      taxCode: code || null,
      taxAmount: money(taxAmount),
      received: String(got),
      invoiced: String(done),
      invoiceable: String(invoiceable),
      note,
    });
  }

  const netTotal = round2(preparedLines.reduce((sum, line) => sum + line.netAmount, 0));
  const taxTotal = round2(preparedLines.reduce((sum, line) => sum + line.taxAmount, 0));
  if (Math.abs(round2(netTotal + taxTotal) - round2(input.grossAmount)) > 0.005) {
    throw new ParkedInvoiceError(
      `The gross amount ${money(input.grossAmount)} does not reconcile: items net ${money(netTotal)} plus tax ${money(taxTotal)} is ${money(netTotal + taxTotal)}.`,
      'Correct the gross amount or the item amounts. The tax is calculated. It is not entered.',
    );
  }

  const duplicatePosted = await tx.select({ invoiceNumber: supplierInvoice.invoiceNumber }).from(supplierInvoice).where(and(
    eq(supplierInvoice.client, input.client),
    eq(supplierInvoice.companyCode, header.companyCode),
    eq(supplierInvoice.supplierNumber, header.supplierNumber),
    eq(supplierInvoice.supplierReference, dates.reference),
    eq(supplierInvoice.status, 'POSTED'),
    sql`${supplierInvoice.cancellationOf} is null`,
  ));
  if (duplicatePosted.length > 0) {
    throw new ParkedInvoiceError(
      `Supplier reference ${dates.reference} already stands posted as invoice ${duplicatePosted[0].invoiceNumber}.`,
      'A parked invoice does not reuse a posted reference.',
    );
  }
  await assertReferenceFree(
    tx, input.client, header.companyCode, header.supplierNumber, dates.reference, exceptParkedNumber,
  );

  let paymentTermsCode: string | null = null;
  let baselineDate: string | null = null;
  let dueDate: string | null = null;
  if (supplier?.paymentTermsCode) {
    const [terms] = await tx.select().from(paymentTerms).where(and(
      eq(paymentTerms.client, input.client), eq(paymentTerms.termsCode, supplier.paymentTermsCode),
    ));
    if (terms) {
      paymentTermsCode = terms.termsCode;
      baselineDate = terms.baselineSource === 'POSTING_DATE' ? dates.postingDate : dates.invoiceDate;
      const due = new Date(`${baselineDate}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + terms.netDays);
      dueDate = due.toISOString().slice(0, 10);
    }
  }

  return {
    supplierNumber: header.supplierNumber,
    companyCode: header.companyCode,
    currency,
    paymentTerms: paymentTermsCode,
    baselineDate,
    dueDate,
    fiscalYear,
    lines: preparedLines,
    preview: {
      parkedNumber: null,
      orderNumber,
      supplierNumber: header.supplierNumber,
      companyCode: header.companyCode,
      currency,
      supplierReference: dates.reference,
      invoiceDate: dates.invoiceDate,
      postingDate: dates.postingDate,
      fiscalYear,
      grossAmount: money(input.grossAmount),
      taxAmount: money(taxTotal),
      netAmount: money(netTotal),
      paymentTerms: paymentTermsCode,
      baselineDate,
      dueDate,
      headerText: dates.headerText,
      notes,
      lines: viewLines,
    },
  };
}

async function assertReferenceFree(
  tx: Tx,
  client: string,
  companyCode: string,
  supplierNumber: string,
  reference: string,
  exceptNumber: string | null,
): Promise<void> {
  const rows = await tx.select({ parkedNumber: parkedSupplierInvoice.parkedNumber }).from(parkedSupplierInvoice).where(and(
    eq(parkedSupplierInvoice.client, client),
    eq(parkedSupplierInvoice.companyCode, companyCode),
    eq(parkedSupplierInvoice.supplierNumber, supplierNumber),
    eq(parkedSupplierInvoice.supplierReference, reference),
    exceptNumber ? ne(parkedSupplierInvoice.parkedNumber, exceptNumber) : undefined,
  ));
  if (rows.length > 0) {
    throw new ParkedInvoiceError(
      `Supplier reference ${reference} already stands parked as ${rows[0].parkedNumber}.`,
      'Use another supplier reference, or change the standing park.',
    );
  }
}

function snapshot(prepared: Prepared) {
  return {
    supplierReference: prepared.preview.supplierReference,
    invoiceDate: prepared.preview.invoiceDate,
    postingDate: prepared.preview.postingDate,
    grossAmount: prepared.preview.grossAmount,
    taxAmount: prepared.preview.taxAmount,
    headerText: prepared.preview.headerText,
    lines: [...prepared.lines].sort((left, right) => left.itemNumber - right.itemNumber).map((line) => ({
      item: line.itemNumber,
      quantity: line.quantity,
      net: line.netAmount,
      taxCode: line.taxCode,
    })),
  };
}

async function insertLines(tx: Tx, client: string, parkedNumber: string, orderNumber: string, changedBy: string, lines: Prepared['lines']) {
  if (lines.length === 0) return;
  await tx.insert(parkedSupplierInvoiceItem).values(lines.map((line) => ({
    client,
    parkedNumber,
    purchaseOrderNumber: orderNumber,
    lineNumber: line.itemNumber,
    purchaseOrderItem: line.itemNumber,
    materialNumber: line.materialNumber,
    plant: line.plant,
    quantity: String(line.quantity),
    unit: line.unit,
    netAmount: String(line.netAmount),
    expectedAmount: String(line.expectedAmount),
    varianceAmount: String(line.varianceAmount),
    taxCode: line.taxCode,
    taxAmount: String(line.taxAmount),
    createdBy: changedBy,
  })));
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<string | null> {
  const [row] = await tx.select({ parkedNumber: parkedSupplierInvoice.parkedNumber }).from(parkedSupplierInvoice).where(and(
    eq(parkedSupplierInvoice.client, client), eq(parkedSupplierInvoice.requestKey, requestKey),
  ));
  return row?.parkedNumber ?? null;
}

export async function previewParkedInvoice(input: ParkedInvoiceInput): Promise<ParkedInvoicePreview> {
  refuseNamed(input, true);
  return withTenant(input.client, async (tx) => (await prepare(tx, input, null, null)).preview);
}

export async function parkSupplierInvoice(input: ParkedInvoiceInput): Promise<ParkedInvoiceView> {
  refuseNamed(input, false);
  const requestKey = named(input.requestKey);
  if (!requestKey) {
    throw new ParkedInvoiceError('The save has no request key.', 'Save again. A check does not draw a number.');
  }
  if (requestKey.length > 64) {
    throw new ParkedInvoiceError('The request key is longer than 64 characters.');
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, requestKey);
    if (replay) return (await loadView(tx, input.client, replay))!;
    const prepared = await prepare(tx, input, null, null);
    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'PARKINV', allocatedBy: input.changedBy,
    });
    const parkedNumber = allocated.display;
    const now = new Date();
    await tx.insert(parkedSupplierInvoice).values({
      client: input.client,
      parkedNumber,
      fiscalYear: prepared.fiscalYear,
      supplierNumber: prepared.supplierNumber,
      companyCode: prepared.companyCode,
      purchaseOrderNumber: prepared.preview.orderNumber,
      invoiceDate: prepared.preview.invoiceDate,
      postingDate: prepared.preview.postingDate,
      supplierReference: prepared.preview.supplierReference,
      currency: prepared.currency,
      grossAmount: prepared.preview.grossAmount,
      taxAmount: prepared.preview.taxAmount,
      paymentTerms: prepared.paymentTerms,
      baselineDate: prepared.baselineDate,
      dueDate: prepared.dueDate,
      headerText: prepared.preview.headerText,
      requestKey,
      createdBy: input.changedBy,
      changedBy: input.changedBy,
      changedAt: now,
    });
    await insertLines(tx, input.client, parkedNumber, prepared.preview.orderNumber, input.changedBy, prepared.lines);
    await recordChange(tx, {
      client: input.client,
      objectClass: PARKED_CLASS,
      objectKey: parkedNumber,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: PARKED_INVOICE_CAPABILITY,
      after: snapshot(prepared),
    });
    return (await loadView(tx, input.client, parkedNumber))!;
  });
}

export async function previewParkedInvoiceChange(input: ParkedInvoiceInput & {
  parkedNumber: string;
}): Promise<ParkedInvoicePreview> {
  refuseNamed(input, true);
  return withTenant(input.client, async (tx) => {
    const standing = await standingLines(tx, input.client, named(input.parkedNumber).toUpperCase());
    const prepared = await prepare(tx, { ...input, orderNumber: standing.orderNumber }, standing.lines, standing.parkedNumber);
    prepared.preview.parkedNumber = standing.parkedNumber;
    return prepared.preview;
  });
}

export async function changeParkedInvoice(input: ParkedInvoiceInput & {
  parkedNumber: string;
  expectedChangedAt: string;
}): Promise<ParkedInvoiceView> {
  refuseNamed(input, false);
  const parkedNumber = named(input.parkedNumber).toUpperCase();
  if (!named(input.expectedChangedAt)) {
    throw new ParkedInvoiceError('The parked invoice was loaded without its change token.', 'Reload it, then apply the change.');
  }
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`
      select parked_number from parked_supplier_invoice
       where client = ${input.client} and parked_number = ${parkedNumber}
       for update
    `);
    const standing = await standingLines(tx, input.client, parkedNumber);
    if (standing.changedAt.getTime() !== new Date(input.expectedChangedAt).getTime()) {
      throw new ParkedInvoiceError(
        `Parked invoice ${parkedNumber} has changed since it was loaded.`,
        'Reload the parked invoice, then apply the change.',
      );
    }
    if (named(input.orderNumber) && named(input.orderNumber).toUpperCase() !== standing.orderNumber) {
      throw new ParkedInvoiceError(
        `The purchase order is ${standing.orderNumber}. It is not changed.`,
      );
    }
    const before = {
      supplierReference: standing.supplierReference,
      invoiceDate: standing.invoiceDate,
      postingDate: standing.postingDate,
      grossAmount: money(Number(standing.grossAmount)),
      taxAmount: money(Number(standing.taxAmount)),
      headerText: standing.headerText,
      lines: [...standing.lines.values()].sort((left, right) => left.itemNumber - right.itemNumber).map((line) => ({
        item: line.itemNumber,
        quantity: line.quantity,
        net: line.netAmount,
        taxCode: line.taxCode,
      })),
    };
    const prepared = await prepare(tx, { ...input, orderNumber: standing.orderNumber }, standing.lines, parkedNumber);
    const after = snapshot(prepared);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      throw new ParkedInvoiceError('Nothing has changed.', 'Change a quantity, an amount, a date, or the supplier reference.');
    }
    await tx.delete(parkedSupplierInvoiceItem).where(and(
      eq(parkedSupplierInvoiceItem.client, input.client),
      eq(parkedSupplierInvoiceItem.parkedNumber, parkedNumber),
    ));
    await insertLines(tx, input.client, parkedNumber, standing.orderNumber, input.changedBy, prepared.lines);
    await tx.update(parkedSupplierInvoice).set({
      fiscalYear: prepared.fiscalYear,
      invoiceDate: prepared.preview.invoiceDate,
      postingDate: prepared.preview.postingDate,
      supplierReference: prepared.preview.supplierReference,
      grossAmount: prepared.preview.grossAmount,
      taxAmount: prepared.preview.taxAmount,
      paymentTerms: prepared.paymentTerms,
      baselineDate: prepared.baselineDate,
      dueDate: prepared.dueDate,
      headerText: prepared.preview.headerText,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(parkedSupplierInvoice.client, input.client),
      eq(parkedSupplierInvoice.parkedNumber, parkedNumber),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: PARKED_CLASS,
      objectKey: parkedNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: PARKED_INVOICE_CAPABILITY,
      reason: named(input.reason) || undefined,
      before,
      after,
    });
    return (await loadView(tx, input.client, parkedNumber))!;
  });
}

export async function postParkedInvoice(): Promise<never> {
  throw new ParkedInvoiceError(
    'Posting is invoice verification. This screen does not post a journal, and it does not write a supplier invoice.',
    'Open invoice verification to post. A parked invoice is not invoiced quantity.',
  );
}

export async function deleteParkedInvoice(): Promise<never> {
  throw new ParkedInvoiceError(
    'A parked invoice is not deleted. It stands until a later posting.',
    'Change the parked invoice, or leave it.',
  );
}

async function standingLines(tx: Tx, client: string, parkedNumber: string): Promise<{
  parkedNumber: string;
  orderNumber: string;
  supplierReference: string;
  invoiceDate: string;
  postingDate: string;
  grossAmount: string;
  headerText: string | null;
  changedAt: Date;
  lines: Map<number, StandingLine>;
}> {
  const [header] = await tx.select().from(parkedSupplierInvoice).where(and(
    eq(parkedSupplierInvoice.client, client), eq(parkedSupplierInvoice.parkedNumber, parkedNumber),
  ));
  if (!header || !header.changedAt) {
    throw new ParkedInvoiceError(`Parked invoice ${parkedNumber} does not stand.`);
  }
  const rows = await tx.select().from(parkedSupplierInvoiceItem).where(and(
    eq(parkedSupplierInvoiceItem.client, client), eq(parkedSupplierInvoiceItem.parkedNumber, parkedNumber),
  ));
  return {
    parkedNumber: header.parkedNumber,
    orderNumber: header.purchaseOrderNumber,
    supplierReference: header.supplierReference,
    invoiceDate: header.invoiceDate,
    postingDate: header.postingDate,
    grossAmount: header.grossAmount,
    taxAmount: header.taxAmount,
    headerText: header.headerText,
    changedAt: header.changedAt,
    lines: new Map(rows.map((row) => [row.lineNumber, {
      itemNumber: row.lineNumber,
      quantity: Number(row.quantity),
      netAmount: round2(Number(row.netAmount)),
      taxCode: row.taxCode,
    }])),
  };
}

async function loadView(tx: Tx, client: string, parkedNumber: string): Promise<ParkedInvoiceView | null> {
  const [header] = await tx.select().from(parkedSupplierInvoice).where(and(
    eq(parkedSupplierInvoice.client, client), eq(parkedSupplierInvoice.parkedNumber, parkedNumber),
  ));
  if (!header || !header.changedAt) return null;
  const rows = await tx.select().from(parkedSupplierInvoiceItem).where(and(
    eq(parkedSupplierInvoiceItem.client, client), eq(parkedSupplierInvoiceItem.parkedNumber, parkedNumber),
  ));
  const orderItems = await tx.select().from(purchaseOrderItem).where(and(
    eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, header.purchaseOrderNumber),
  ));
  const byItem = new Map(orderItems.map((item) => [item.itemNumber, item]));
  const received = await receivedQuantities(tx, client, header.purchaseOrderNumber);
  const invoiced = await invoicedQuantities(tx, client, header.purchaseOrderNumber);
  const notes: string[] = [];
  const lines: ParkedLineView[] = rows.map((row) => {
    const item = byItem.get(row.purchaseOrderItem);
    const got = received.get(row.purchaseOrderItem) ?? 0;
    const done = invoiced.get(row.purchaseOrderItem) ?? 0;
    const invoiceable = Math.max(0, got - done);
    const quantity = Number(row.quantity);
    const variance = round2(Number(row.varianceAmount));
    const note = lineNote(row.lineNumber, quantity, got, done, invoiceable, variance);
    if (note) notes.push(note);
    if (item) {
      const currentExpected = round2((quantity * Number(item.netPrice)) / Number(item.priceUnit));
      if (currentExpected !== round2(Number(row.expectedAmount))) {
        notes.push(`Item ${row.lineNumber}: the order price now calculates ${money(currentExpected)}. The parked expected amount remains ${money(Number(row.expectedAmount))}.`);
      }
    }
    return {
      itemNumber: row.lineNumber,
      materialNumber: row.materialNumber,
      shortText: item?.shortText ?? '',
      plant: row.plant ?? '',
      unit: row.unit,
      quantity: String(quantity),
      netAmount: money(Number(row.netAmount)),
      expectedAmount: money(Number(row.expectedAmount)),
      varianceAmount: money(variance),
      taxCode: row.taxCode,
      taxAmount: money(Number(row.taxAmount)),
      received: String(got),
      invoiced: String(done),
      invoiceable: String(invoiceable),
      note,
    };
  });
  const history = await changeHistory(tx, client, PARKED_CLASS, parkedNumber);
  return {
    parkedNumber: header.parkedNumber,
    orderNumber: header.purchaseOrderNumber,
    supplierNumber: header.supplierNumber,
    companyCode: header.companyCode,
    currency: header.currency,
    supplierReference: header.supplierReference,
    invoiceDate: header.invoiceDate,
    postingDate: header.postingDate,
    fiscalYear: header.fiscalYear,
    grossAmount: money(Number(header.grossAmount)),
    taxAmount: money(Number(header.taxAmount)),
    netAmount: money(lines.reduce((sum, line) => sum + Number(line.netAmount), 0)),
    paymentTerms: header.paymentTerms,
    baselineDate: header.baselineDate,
    dueDate: header.dueDate,
    headerText: header.headerText,
    notes,
    lines,
    changedAt: header.changedAt.toISOString(),
    history: history.map((doc) => ({
      changedAt: doc.changedAt.toISOString(),
      changeType: doc.changeType,
      changedBy: doc.changedBy,
      fields: doc.items.map((item) => ({
        field: item.fieldName,
        oldValue: item.oldValue,
        newValue: item.newValue,
      })),
    })),
  };
}

export async function getParkedInvoice(client: string, parkedNumber: string): Promise<ParkedInvoiceView | null> {
  const number = named(parkedNumber).toUpperCase();
  if (!number) return null;
  return withTenant(client, (tx) => loadView(tx, client, number));
}

export async function openOrderForPark(client: string, orderNumber: string): Promise<OpenedPark | null> {
  const number = named(orderNumber).toUpperCase();
  if (!number) return null;
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(purchaseOrder).where(and(
      eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, number),
    ));
    if (!header) return null;
    const items = await tx.select().from(purchaseOrderItem).where(and(
      eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, number),
    )).orderBy(purchaseOrderItem.itemNumber);
    const received = await receivedQuantities(tx, client, number);
    const invoiced = await invoicedQuantities(tx, client, number);
    const parks = await tx.select({
      parkedNumber: parkedSupplierInvoice.parkedNumber,
      supplierReference: parkedSupplierInvoice.supplierReference,
      grossAmount: parkedSupplierInvoice.grossAmount,
    }).from(parkedSupplierInvoice).where(and(
      eq(parkedSupplierInvoice.client, client), eq(parkedSupplierInvoice.purchaseOrderNumber, number),
    )).orderBy(parkedSupplierInvoice.parkedNumber);
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
      parks: parks.map((row) => ({
        parkedNumber: row.parkedNumber,
        supplierReference: row.supplierReference,
        grossAmount: money(Number(row.grossAmount)),
      })),
    };
  });
}

export async function listRecentParkedInvoices(client: string): Promise<Array<{
  parkedNumber: string;
  purchaseOrderNumber: string;
  supplierReference: string;
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      parkedNumber: parkedSupplierInvoice.parkedNumber,
      purchaseOrderNumber: parkedSupplierInvoice.purchaseOrderNumber,
      supplierReference: parkedSupplierInvoice.supplierReference,
    }).from(parkedSupplierInvoice).where(eq(parkedSupplierInvoice.client, client))
      .orderBy(desc(parkedSupplierInvoice.createdAt))
      .limit(8);
    return rows;
  });
}
