/**
 * Quotation — SCR-157.
 *
 * One quotation prices one standing request. The supplier and the currency are
 * read from that request's event. They are not stored again. A check writes
 * nothing, including the number. A change does not rewrite the request, and it
 * does not create an order, a comparison, or an award.
 */
import { and, asc, desc, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber, NumberRangeError } from '../../platform/numbering';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { unitOfMeasure } from '../../platform/tables/reference';
import { businessPartner } from '../foundation/business-partner-schema';
import { materialUomConversion } from '../inventory/schema';
import {
  purchasingQuotation, purchasingQuotationItem, purchasingRfq, purchasingRfqEvent, purchasingRfqItem,
} from './schema';

export const QUOTATION_CAPABILITY = 'PROC.RFQ.QUOTATION';
export const QUOTATION_OBJECT = 'QUOTATION';
export const QUOTATION_ROUTE = '/purchasing/quotation';
const QUANTITY_SCALE = 3;
const PRICE_SCALE = 4;
const QUOTATION_CLASS = 'purchasing_quotation';

export class QuotationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'QuotationError';
    this.remedy = remedy;
  }
}

export interface QuotationLineInput {
  itemNumber?: number | string | null;
  quantity?: number | string | null;
  unit?: string | null;
  netPrice?: number | string | null;
  priceUnit?: number | string | null;
  deliveryDate?: string | null;
  remark?: string | null;
  materialNumber?: string | null;
  plant?: string | null;
  price?: number | string | null;
  unitPrice?: number | string | null;
  minimumOrderQuantity?: number | string | null;
  condition?: string | null;
  freight?: string | null;
  tax?: string | null;
  discount?: string | null;
}

export interface QuotationInput {
  client: string;
  changedBy: string;
  rfqNumber: string;
  quotationNumber?: string | null;
  expectedChangedAt?: string | null;
  reason?: string | null;
  partnerNumber?: string | null;
  currency?: string | null;
  companyCode?: string | null;
  status?: string | null;
  requestKey?: string | null;
  outbox?: string | null;
  revision?: string | null;
  receivedAt?: string | null;
  award?: string | null;
  comparison?: string | null;
  orderNumber?: string | null;
  requisitionNumber?: string | null;
  rejection?: string | null;
  withdrawal?: string | null;
  condition?: string | null;
  freight?: string | null;
  tax?: string | null;
  discount?: string | null;
  minimumOrderQuantity?: string | null;
  infoRecord?: string | null;
  price?: string | null;
  unitPrice?: string | null;
  normalizedPrice?: string | null;
  id?: string | null;
  deleteItem?: boolean;
  lines: QuotationLineInput[];
}

export interface StandingQuotationLine {
  itemNumber: number;
  quantity: string;
  unit: string;
  netPrice: string;
  priceUnit: string;
  deliveryDate: string;
  remark: string | null;
}

export interface AskedLine {
  itemNumber: number;
  materialNumber: string | null;
  plant: string;
  shortText: string;
  quantity: string;
  unit: string;
  deliveryDate: string;
}

export interface OfferedView extends StandingQuotationLine {
  pricePerUnit: string;
}

export interface QuotationPreview {
  quotationNumber: string | null;
  rfqNumber: string;
  eventNumber: string;
  partnerNumber: string;
  currency: string;
  quotationDeadline: string;
  currencyNote: string;
  lines: Array<{
    itemNumber: number;
    asked: AskedLine;
    before: StandingQuotationLine | null;
    after: OfferedView;
  }>;
  unquoted: AskedLine[];
  nothingWritten: true;
  unchanged: boolean;
  message: string;
}

export interface QuotationResult {
  quotationNumber: string;
  rfqNumber: string;
  changedAt: string | null;
}

interface LoadedRequest {
  rfqNumber: string;
  eventNumber: string;
  partnerNumber: string;
  currency: string;
  quotationDeadline: string;
  lines: AskedLine[];
}

function blank(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function tokenOf(value: Date | string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function tokensMatch(sent: string | null | undefined, standing: Date | string | null | undefined): boolean {
  return blank(sent) === tokenOf(standing);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new QuotationError(`${label} is not a date.`);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new QuotationError(`${label} is not a date.`);
  }
}

function quantityText(value: number | string | null | undefined): string {
  if (value == null || String(value).trim() === '') throw new QuotationError('A quantity is required.');
  const raw = String(value).trim();
  const fraction = raw.split('.')[1] ?? '';
  if (fraction.length > QUANTITY_SCALE) {
    throw new QuotationError(`Quantity ${raw} is not a decimal at scale ${QUANTITY_SCALE}.`);
  }
  let scaled: bigint;
  try {
    scaled = toScaled(raw, QUANTITY_SCALE);
  } catch {
    throw new QuotationError(`Quantity ${raw} is not a decimal at scale ${QUANTITY_SCALE}.`);
  }
  if (scaled <= 0n) throw new QuotationError('A quantity must be greater than zero.');
  return fromScaled(scaled, QUANTITY_SCALE);
}

function priceText(value: number | string | null | undefined): string {
  if (value == null || String(value).trim() === '') throw new QuotationError('A price is required.');
  const raw = String(value).trim();
  const fraction = raw.split('.')[1] ?? '';
  if (fraction.length > PRICE_SCALE) {
    throw new QuotationError(`Price ${raw} is not a decimal at scale ${PRICE_SCALE}.`);
  }
  let scaled: bigint;
  try {
    scaled = toScaled(raw, PRICE_SCALE);
  } catch {
    throw new QuotationError(`Price ${raw} is not a decimal at scale ${PRICE_SCALE}.`);
  }
  if (scaled < 0n) throw new QuotationError('A price must not be negative.');
  return fromScaled(scaled, PRICE_SCALE);
}

function priceUnitText(value: number | string | null | undefined): string {
  const raw = blank(value);
  if (!raw || !/^\d+$/.test(raw)) throw new QuotationError('A price unit is a positive integer.');
  const unit = Number(raw);
  if (!Number.isSafeInteger(unit) || unit < 1 || unit > 99999) {
    throw new QuotationError('A price unit is a positive integer of at most five digits.');
  }
  return String(unit);
}

/** Display only. The price per one unit is not a column. */
export function pricePerUnit(netPrice: string, priceUnit: string): string {
  const scaled = toScaled(netPrice, PRICE_SCALE);
  const unit = BigInt(priceUnit);
  const quotient = scaled / unit;
  const remainder = scaled % unit;
  const rounded = remainder * 2n >= unit ? quotient + 1n : quotient;
  return fromScaled(rounded, PRICE_SCALE);
}

function remarkText(value: string | null | undefined): string | null {
  if (value === undefined) return undefined as unknown as string | null;
  const remark = blank(value);
  if (remark && remark.length > 80) throw new QuotationError('A remark is at most 80 characters.');
  return remark;
}

function refuseCuts(input: QuotationInput, creating: boolean): void {
  if (creating && blank(input.quotationNumber)) throw new QuotationError('The quotation number is drawn.');
  if (blank(input.id)) throw new QuotationError('The drawn number is the key.');
  if (blank(input.companyCode)) throw new QuotationError('A company code is not a column. The plant carries it.');
  if (blank(input.status)) throw new QuotationError('A quotation has no stored status. It stands when it is saved.');
  if (blank(input.requestKey)) throw new QuotationError('A request key is not stored.');
  if (blank(input.outbox)) throw new QuotationError('An outbox is not written.');
  if (blank(input.revision)) throw new QuotationError('A revision is not stored. The loaded time is the token.');
  if (blank(input.receivedAt)) throw new QuotationError('A receipt time is not entered.');
  if (blank(input.award) || blank(input.comparison)) throw new QuotationError('An award is not created from this quotation.');
  if (blank(input.orderNumber)) throw new QuotationError('An order is not created.');
  if (blank(input.requisitionNumber)) throw new QuotationError('A requisition is not converted.');
  if (blank(input.rejection) || blank(input.withdrawal)) {
    throw new QuotationError('A rejection is not stored. The offer stands.');
  }
  if (blank(input.condition) || blank(input.freight) || blank(input.tax) || blank(input.discount)) {
    throw new QuotationError('A condition is not stored. The net price is the price named.');
  }
  if (blank(input.minimumOrderQuantity) || input.lines.some((line) => blank(line.minimumOrderQuantity))) {
    throw new QuotationError('A minimum order quantity is not stored.');
  }
  if (blank(input.infoRecord)) throw new QuotationError('An info record is not updated from a quotation.');
  if (blank(input.price) || input.lines.some((line) => blank(line.price))) {
    throw new QuotationError('A stored price is not a field. The net price is the price named.');
  }
  if (blank(input.unitPrice) || input.lines.some((line) => blank(line.unitPrice))) {
    throw new QuotationError('The price per one unit is not stored.');
  }
  if (blank(input.normalizedPrice)) throw new QuotationError('A comparison total is not stored.');
  if (input.deleteItem) throw new QuotationError('A quoted line is not physically deleted.');
  if (input.lines.some((line) => blank(line.condition) || blank(line.freight) || blank(line.tax) || blank(line.discount))) {
    throw new QuotationError('A condition is not stored. The net price is the price named.');
  }
}

function reasonOf(value: string | null | undefined): string {
  const reason = blank(value);
  if (!reason) throw new QuotationError('A reason is required.');
  if (reason.length < 3 || reason.length > 500) throw new QuotationError('A reason is three to five hundred characters.');
  return reason;
}

async function draw(tx: Tx, client: string, changedBy: string): Promise<string> {
  try {
    const drawn = await allocateNumber(tx, {
      client, objectCode: QUOTATION_OBJECT, companyCode: '*', subObject: '*', fiscalYear: 0, allocatedBy: changedBy,
    });
    return drawn.display;
  } catch (error) {
    if (error instanceof NumberRangeError) {
      throw new QuotationError(
        `No active internal ${QUOTATION_OBJECT} number range stands, so no number can be drawn.`,
        error.remedy,
      );
    }
    throw error;
  }
}

async function loadRequest(tx: Tx, client: string, rfqNumber: string, lock: boolean): Promise<LoadedRequest> {
  const requestQuery = tx.select().from(purchasingRfq).where(and(
    eq(purchasingRfq.client, client), eq(purchasingRfq.rfqNumber, rfqNumber),
  ));
  const [request] = lock ? await requestQuery.for('update') : await requestQuery;
  if (!request) throw new QuotationError(`Request ${rfqNumber} does not stand.`);
  const [event] = await tx.select().from(purchasingRfqEvent).where(and(
    eq(purchasingRfqEvent.client, client), eq(purchasingRfqEvent.eventNumber, request.eventNumber),
  ));
  if (!event) throw new QuotationError(`Request ${rfqNumber} does not stand.`);
  const copies = await tx.select().from(purchasingRfqItem).where(and(
    eq(purchasingRfqItem.client, client), eq(purchasingRfqItem.rfqNumber, rfqNumber),
  )).orderBy(asc(purchasingRfqItem.itemNumber));
  return {
    rfqNumber: request.rfqNumber,
    eventNumber: request.eventNumber,
    partnerNumber: request.partnerNumber,
    currency: event.currency.trim(),
    quotationDeadline: event.quotationDeadline,
    lines: copies.map((row) => ({
      itemNumber: row.itemNumber,
      materialNumber: row.materialNumber,
      plant: row.plant,
      shortText: row.shortText,
      quantity: row.quantity,
      unit: row.unit,
      deliveryDate: row.deliveryDate,
    })),
  };
}

function assertOpen(deadline: string): void {
  if (today() > deadline) throw new QuotationError(`The day is after the quotation deadline ${deadline}.`);
}

function assertIdentity(input: QuotationInput, request: LoadedRequest): void {
  const partner = blank(input.partnerNumber);
  if (partner && partner !== request.partnerNumber) {
    throw new QuotationError(`Supplier ${partner} is not the request's supplier ${request.partnerNumber}.`);
  }
  const currency = blank(input.currency)?.toUpperCase();
  if (currency && currency !== request.currency) {
    throw new QuotationError(`The currency is the company's local currency ${request.currency}, not a field on the quotation.`);
  }
}

async function judgeUnit(tx: Tx, client: string, asked: AskedLine, unit: string): Promise<void> {
  const [unitRow] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, unit));
  if (!unitRow) throw new QuotationError(`Unit ${unit} is not a standing unit of measure.`);
  if (unit === asked.unit) return;
  if (!asked.materialNumber) throw new QuotationError(`Unit ${unit} is not the unit that was asked.`);
  const [conversion] = await tx.select().from(materialUomConversion).where(and(
    eq(materialUomConversion.client, client),
    eq(materialUomConversion.materialNumber, asked.materialNumber),
    eq(materialUomConversion.alternativeUnit, unit),
  ));
  if (!conversion) throw new QuotationError(`Material ${asked.materialNumber} has no conversion from ${unit}.`);
}

async function offerOf(
  tx: Tx,
  client: string,
  asked: AskedLine,
  line: QuotationLineInput,
  standing: StandingQuotationLine | null,
): Promise<StandingQuotationLine> {
  const postedMaterial = blank(line.materialNumber);
  if (postedMaterial && postedMaterial !== asked.materialNumber) throw new QuotationError('The material is not changed.');
  const postedPlant = blank(line.plant);
  if (postedPlant && postedPlant !== asked.plant) throw new QuotationError('The plant is not changed.');
  const quantity = line.quantity === undefined && standing
    ? standing.quantity
    : quantityText(line.quantity);
  const unit = line.unit === undefined && standing
    ? standing.unit
    : (blank(line.unit)?.toUpperCase() ?? asked.unit);
  if (!unit) throw new QuotationError('A unit of measure is required.');
  await judgeUnit(tx, client, asked, unit);
  const netPrice = line.netPrice === undefined && standing
    ? standing.netPrice
    : priceText(line.netPrice);
  const priceUnit = line.priceUnit === undefined && standing
    ? standing.priceUnit
    : priceUnitText(line.priceUnit);
  const deliveryDate = line.deliveryDate === undefined && standing
    ? standing.deliveryDate
    : (line.deliveryDate ?? '');
  assertDate(deliveryDate, 'The delivery date');
  const remark = line.remark === undefined ? standing?.remark ?? null : remarkText(line.remark);
  return { itemNumber: asked.itemNumber, quantity, unit, netPrice, priceUnit, deliveryDate, remark };
}

function sameLine(left: StandingQuotationLine, right: StandingQuotationLine): boolean {
  return left.quantity === right.quantity
    && left.unit === right.unit
    && left.netPrice === right.netPrice
    && left.priceUnit === right.priceUnit
    && left.deliveryDate === right.deliveryDate
    && left.remark === right.remark;
}

function lineFields(line: StandingQuotationLine): Record<string, string | null> {
  const prefix = `line${line.itemNumber}`;
  return {
    [`${prefix}.quantity`]: line.quantity,
    [`${prefix}.unit`]: line.unit,
    [`${prefix}.netPrice`]: line.netPrice,
    [`${prefix}.priceUnit`]: line.priceUnit,
    [`${prefix}.deliveryDate`]: line.deliveryDate,
    [`${prefix}.remark`]: line.remark,
  };
}

function view(line: StandingQuotationLine): OfferedView {
  return { ...line, pricePerUnit: pricePerUnit(line.netPrice, line.priceUnit) };
}

interface Plan {
  preview: QuotationPreview;
  next: StandingQuotationLine[];
  standing: StandingQuotationLine[];
  quotationNumber: string | null;
  changedAt: string | null;
}

async function plan(tx: Tx, input: QuotationInput, creating: boolean, lock: boolean): Promise<Plan> {
  refuseCuts(input, creating);
  const rfqNumber = blank(input.rfqNumber);
  if (!rfqNumber) throw new QuotationError('A request number is required.');
  const request = await loadRequest(tx, input.client, rfqNumber, lock);
  assertOpen(request.quotationDeadline);
  assertIdentity(input, request);
  const quotationQuery = tx.select().from(purchasingQuotation).where(and(
    eq(purchasingQuotation.client, input.client), eq(purchasingQuotation.rfqNumber, rfqNumber),
  ));
  const [quotation] = lock ? await quotationQuery.for('update') : await quotationQuery;
  if (creating && quotation) throw new QuotationError(`A quotation already stands for request ${rfqNumber}.`);
  if (!creating && !quotation) throw new QuotationError(`Request ${rfqNumber} has no quotation.`);
  if (!creating && quotation) {
    const postedNumber = blank(input.quotationNumber);
    if (postedNumber && postedNumber !== quotation.quotationNumber) {
      throw new QuotationError('The quotation number is not changed.');
    }
    if (!tokensMatch(input.expectedChangedAt, quotation.changedAt)) {
      throw new QuotationError(`Quotation ${quotation.quotationNumber} stands as of ${tokenOf(quotation.changedAt) ?? 'its creation'}. Reload it.`);
    }
  }
  const copies = quotation
    ? await tx.select().from(purchasingQuotationItem).where(and(
      eq(purchasingQuotationItem.client, input.client),
      eq(purchasingQuotationItem.quotationNumber, quotation.quotationNumber),
    )).orderBy(asc(purchasingQuotationItem.itemNumber))
    : [];
  const standing = copies.map((row): StandingQuotationLine => ({
    itemNumber: row.itemNumber,
    quantity: row.quantity,
    unit: row.unit,
    netPrice: row.netPrice,
    priceUnit: row.priceUnit,
    deliveryDate: row.deliveryDate,
    remark: row.remark,
  }));
  const byItem = new Map(request.lines.map((line) => [line.itemNumber, line]));
  const standingByItem = new Map(standing.map((line) => [line.itemNumber, line]));
  if (input.lines.length === 0 && creating) throw new QuotationError('A quotation with no line does not stand.');
  const named = new Set<number>();
  const next: StandingQuotationLine[] = [];
  for (const line of input.lines) {
    const itemNumber = line.itemNumber == null || String(line.itemNumber).trim() === ''
      ? null
      : Number(String(line.itemNumber).trim());
    if (itemNumber == null || !Number.isSafeInteger(itemNumber) || !byItem.has(itemNumber)) {
      throw new QuotationError(itemNumber == null ? 'An item number is required.' : `Item ${line.itemNumber} is not on the request.`);
    }
    if (named.has(itemNumber)) throw new QuotationError(`Item ${itemNumber} is named twice.`);
    named.add(itemNumber);
    next.push(await offerOf(tx, input.client, byItem.get(itemNumber)!, line, standingByItem.get(itemNumber) ?? null));
  }
  if (!creating) {
    for (const line of standing) {
      if (!named.has(line.itemNumber)) throw new QuotationError('A line is not removed.');
    }
  }
  const unchanged = !creating
    && next.length === standing.length
    && next.every((line) => {
      const before = standingByItem.get(line.itemNumber);
      return before != null && sameLine(before, line);
    });
  const askedByItem = byItem;
  const preview: QuotationPreview = {
    quotationNumber: quotation?.quotationNumber ?? null,
    rfqNumber: request.rfqNumber,
    eventNumber: request.eventNumber,
    partnerNumber: request.partnerNumber,
    currency: request.currency,
    quotationDeadline: request.quotationDeadline,
    currencyNote: `The price is in ${request.currency}, the company's currency.`,
    lines: next.map((line) => ({
      itemNumber: line.itemNumber,
      asked: askedByItem.get(line.itemNumber)!,
      before: standingByItem.get(line.itemNumber) ?? null,
      after: view(line),
    })),
    unquoted: request.lines.filter((line) => !named.has(line.itemNumber)),
    nothingWritten: true,
    unchanged,
    message: unchanged
      ? 'Nothing would change.'
      : creating
        ? 'Nothing has been written. The number was not drawn.'
        : 'Nothing has been written.',
  };
  return {
    preview,
    next,
    standing,
    quotationNumber: quotation?.quotationNumber ?? null,
    changedAt: tokenOf(quotation?.changedAt),
  };
}

export async function previewQuotation(input: QuotationInput): Promise<QuotationPreview> {
  return withTenant(input.client, (tx) => plan(tx, input, true, false).then((row) => row.preview));
}

export async function previewQuotationChange(input: QuotationInput): Promise<QuotationPreview> {
  return withTenant(input.client, (tx) => plan(tx, input, false, false).then((row) => row.preview));
}

export async function createQuotation(input: QuotationInput): Promise<QuotationResult> {
  return withTenant(input.client, (tx) => writeQuotation(tx, input));
}

export async function writeQuotation(tx: Tx, input: QuotationInput): Promise<QuotationResult> {
  const planned = await plan(tx, input, true, true);
  const quotationNumber = await draw(tx, input.client, input.changedBy);
  await tx.insert(purchasingQuotation).values({
    client: input.client,
    quotationNumber,
    rfqNumber: planned.preview.rfqNumber,
    createdBy: input.changedBy,
  });
  await tx.insert(purchasingQuotationItem).values(planned.next.map((line) => ({
    client: input.client,
    quotationNumber,
    rfqNumber: planned.preview.rfqNumber,
    itemNumber: line.itemNumber,
    quantity: line.quantity,
    unit: line.unit,
    netPrice: line.netPrice,
    priceUnit: line.priceUnit,
    deliveryDate: line.deliveryDate,
    remark: line.remark,
    createdBy: input.changedBy,
  })));
  const after: Record<string, string | null> = {};
  for (const line of planned.next) Object.assign(after, lineFields(line));
  await recordChange(tx, {
    client: input.client,
    objectClass: QUOTATION_CLASS,
    objectKey: quotationNumber,
    changeType: 'CREATE',
    changedBy: input.changedBy,
    transactionCode: QUOTATION_CAPABILITY,
    after,
  });
  return { quotationNumber, rfqNumber: planned.preview.rfqNumber, changedAt: null };
}

export async function changeQuotation(input: QuotationInput): Promise<QuotationResult> {
  return withTenant(input.client, (tx) => writeQuotationChange(tx, input));
}

export async function writeQuotationChange(tx: Tx, input: QuotationInput): Promise<QuotationResult> {
  const planned = await plan(tx, input, false, true);
  if (planned.preview.unchanged) throw new QuotationError('Nothing would change.');
  const reason = reasonOf(input.reason);
  const quotationNumber = planned.quotationNumber!;
  const now = new Date();
  const standingByItem = new Map(planned.standing.map((line) => [line.itemNumber, line]));
  for (const line of planned.next) {
    const standing = standingByItem.get(line.itemNumber);
    if (!standing) {
      await tx.insert(purchasingQuotationItem).values({
        client: input.client,
        quotationNumber,
        rfqNumber: planned.preview.rfqNumber,
        itemNumber: line.itemNumber,
        quantity: line.quantity,
        unit: line.unit,
        netPrice: line.netPrice,
        priceUnit: line.priceUnit,
        deliveryDate: line.deliveryDate,
        remark: line.remark,
        createdBy: input.changedBy,
      });
      continue;
    }
    if (sameLine(standing, line)) continue;
    await tx.update(purchasingQuotationItem).set({
      quantity: line.quantity,
      unit: line.unit,
      netPrice: line.netPrice,
      priceUnit: line.priceUnit,
      deliveryDate: line.deliveryDate,
      remark: line.remark,
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(
      eq(purchasingQuotationItem.client, input.client),
      eq(purchasingQuotationItem.quotationNumber, quotationNumber),
      eq(purchasingQuotationItem.itemNumber, line.itemNumber),
    ));
  }
  await tx.update(purchasingQuotation).set({
    changedBy: input.changedBy,
    changedAt: now,
  }).where(and(
    eq(purchasingQuotation.client, input.client),
    eq(purchasingQuotation.quotationNumber, quotationNumber),
  ));
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  for (const line of planned.standing) Object.assign(before, lineFields(line));
  for (const line of planned.next) Object.assign(after, lineFields(line));
  await recordChange(tx, {
    client: input.client,
    objectClass: QUOTATION_CLASS,
    objectKey: quotationNumber,
    changeType: 'CHANGE',
    changedBy: input.changedBy,
    transactionCode: QUOTATION_CAPABILITY,
    reason,
    before,
    after,
  });
  return { quotationNumber, rfqNumber: planned.preview.rfqNumber, changedAt: tokenOf(now) };
}

export interface OpenedQuotation {
  rfqNumber: string;
  eventNumber: string;
  partnerNumber: string;
  partnerName: string;
  currency: string;
  quotationDeadline: string;
  lines: AskedLine[];
  quotation: {
    quotationNumber: string;
    changedAt: string | null;
    lines: StandingQuotationLine[];
  } | null;
}

export async function openQuotation(client: string, rfqNumber: string): Promise<OpenedQuotation | null> {
  return withTenant(client, async (tx) => {
    const [request] = await tx.select().from(purchasingRfq).where(and(
      eq(purchasingRfq.client, client), eq(purchasingRfq.rfqNumber, rfqNumber),
    ));
    if (!request) return null;
    const [event] = await tx.select().from(purchasingRfqEvent).where(and(
      eq(purchasingRfqEvent.client, client), eq(purchasingRfqEvent.eventNumber, request.eventNumber),
    ));
    if (!event) return null;
    const [partner] = await tx.select({ name: businessPartner.name }).from(businessPartner).where(and(
      eq(businessPartner.client, client), eq(businessPartner.partnerNumber, request.partnerNumber),
    ));
    const copies = await tx.select().from(purchasingRfqItem).where(and(
      eq(purchasingRfqItem.client, client), eq(purchasingRfqItem.rfqNumber, rfqNumber),
    )).orderBy(asc(purchasingRfqItem.itemNumber));
    const [quotation] = await tx.select().from(purchasingQuotation).where(and(
      eq(purchasingQuotation.client, client), eq(purchasingQuotation.rfqNumber, rfqNumber),
    ));
    const offered = quotation
      ? await tx.select().from(purchasingQuotationItem).where(and(
        eq(purchasingQuotationItem.client, client),
        eq(purchasingQuotationItem.quotationNumber, quotation.quotationNumber),
      )).orderBy(asc(purchasingQuotationItem.itemNumber))
      : [];
    return {
      rfqNumber: request.rfqNumber,
      eventNumber: request.eventNumber,
      partnerNumber: request.partnerNumber,
      partnerName: partner?.name ?? '',
      currency: event.currency.trim(),
      quotationDeadline: event.quotationDeadline,
      lines: copies.map((row) => ({
        itemNumber: row.itemNumber,
        materialNumber: row.materialNumber,
        plant: row.plant,
        shortText: row.shortText,
        quantity: row.quantity,
        unit: row.unit,
        deliveryDate: row.deliveryDate,
      })),
      quotation: quotation ? {
        quotationNumber: quotation.quotationNumber,
        changedAt: tokenOf(quotation.changedAt),
        lines: offered.map((row) => ({
          itemNumber: row.itemNumber,
          quantity: row.quantity,
          unit: row.unit,
          netPrice: row.netPrice,
          priceUnit: row.priceUnit,
          deliveryDate: row.deliveryDate,
          remark: row.remark,
        })),
      } : null,
    };
  });
}

export async function listRecentQuotationRequests(client: string): Promise<Array<{
  rfqNumber: string;
  partnerNumber: string;
  quotationDeadline: string;
  quotationNumber: string | null;
}>> {
  return withTenant(client, (tx) => tx.select({
    rfqNumber: purchasingRfq.rfqNumber,
    partnerNumber: purchasingRfq.partnerNumber,
    quotationDeadline: purchasingRfqEvent.quotationDeadline,
    quotationNumber: purchasingQuotation.quotationNumber,
  }).from(purchasingRfq)
    .innerJoin(purchasingRfqEvent, and(
      eq(purchasingRfqEvent.client, purchasingRfq.client),
      eq(purchasingRfqEvent.eventNumber, purchasingRfq.eventNumber),
    ))
    .leftJoin(purchasingQuotation, and(
      eq(purchasingQuotation.client, purchasingRfq.client),
      eq(purchasingQuotation.rfqNumber, purchasingRfq.rfqNumber),
    ))
    .where(eq(purchasingRfq.client, client))
    .orderBy(desc(purchasingRfq.rfqNumber))
    .limit(40));
}

export async function getQuotation(client: string, quotationNumber: string) {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(purchasingQuotation).where(and(
      eq(purchasingQuotation.client, client), eq(purchasingQuotation.quotationNumber, quotationNumber),
    ));
    if (!header) return null;
    const lines = await tx.select().from(purchasingQuotationItem).where(and(
      eq(purchasingQuotationItem.client, client),
      eq(purchasingQuotationItem.quotationNumber, quotationNumber),
    )).orderBy(asc(purchasingQuotationItem.itemNumber));
    return {
      quotationNumber: header.quotationNumber,
      rfqNumber: header.rfqNumber,
      changedAt: tokenOf(header.changedAt),
      lines: lines.map((row) => ({
        itemNumber: row.itemNumber,
        quantity: row.quantity,
        unit: row.unit,
        netPrice: row.netPrice,
        priceUnit: row.priceUnit,
        deliveryDate: row.deliveryDate,
        remark: row.remark,
      })),
    };
  });
}
