/**
 * Request for quotation — SCR-155, and its change — SCR-156.
 *
 * One event groups the requirement. Each invited supplier receives a separate
 * request, and that request copies the lines. Creating a request does not
 * create an order, a requisition, a quotation, a goods movement or a journal.
 * A check writes nothing, including either number.
 *
 * A change rewrites one request's copy. A header change is the event's, because
 * the group, the deadline and the collective number are not copied. The other
 * request's copy stays. A check of a change writes nothing, including the
 * change document.
 */
import { and, asc, desc, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber, NumberRangeError } from '../../platform/numbering';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { unitOfMeasure } from '../../platform/tables/reference';
import { businessPartner, bpRole } from '../foundation/business-partner-schema';
import {
  companyCode, plant, purchasingGroup, purchasingOrg, purchasingOrgPlant, storageLocation,
} from '../foundation/schema';
import { supplierPurchasing } from '../foundation/supplier-purchasing-schema';
import { material, materialPlant, materialUomConversion } from '../inventory/schema';
import { purchasingRfq, purchasingRfqEvent, purchasingRfqEventItem, purchasingRfqItem } from './schema';

export const RFQ_CAPABILITY = 'PROC.RFQ.CREATE';
export const RFQ_EVENT_OBJECT = 'RFQEVENT';
export const RFQ_OBJECT = 'RFQ';
export const RFQ_ROUTE = '/purchasing/rfq';
export const RFQ_TYPE = 'STANDARD';
const QUANTITY_SCALE = 3;
const EVENT_CLASS = 'purchasing_rfq_event';
const REQUEST_CLASS = 'purchasing_rfq';

export class RfqError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'RfqError';
    this.remedy = remedy;
  }
}

export interface RfqLineInput {
  itemNumber?: number | string | null;
  materialNumber?: string | null;
  shortText?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  plant?: string | null;
  storageLocation?: string | null;
  deliveryDate?: string | null;
  requisitionNumber?: string | null;
  price?: number | string | null;
  deliveryLocation?: string | null;
}

export interface RfqSupplierInput {
  partnerNumber?: string | null;
  rfqNumber?: string | null;
  contactId?: string | null;
  deliveryChannel?: string | null;
}

export interface RfqCreateInput {
  client: string;
  changedBy: string;
  documentType?: string | null;
  eventNumber?: string | null;
  rfqNumber?: string | null;
  purchasingOrg: string;
  purchasingGroup: string;
  rfqDate: string;
  quotationDeadline: string;
  collectiveNumber?: string | null;
  currency?: string | null;
  companyCode?: string | null;
  status?: string | null;
  deliveryChannel?: string | null;
  contactId?: string | null;
  sentAt?: string | null;
  deliveryReference?: string | null;
  requestKey?: string | null;
  price?: number | string | null;
  quotationNumber?: string | null;
  award?: string | null;
  comparison?: string | null;
  requisitionNumber?: string | null;
  orderNumber?: string | null;
  outbox?: string | null;
  deleteEvent?: boolean;
  id?: string | null;
  suppliers: RfqSupplierInput[];
  lines: RfqLineInput[];
}

export interface StandingRfqLine {
  itemNumber: number;
  materialNumber: string | null;
  shortText: string;
  quantity: string;
  unit: string;
  plant: string;
  storageLocation: string | null;
  deliveryDate: string;
}

export interface StandingRfq {
  rfqNumber: string;
  partnerNumber: string;
  changedAt: string | null;
  lines: StandingRfqLine[];
}

export interface StandingRfqEvent {
  eventNumber: string;
  documentType: string;
  purchasingOrg: string;
  purchasingGroup: string;
  rfqDate: string;
  quotationDeadline: string;
  currency: string;
  collectiveNumber: string | null;
  changedAt: string | null;
  lines: StandingRfqLine[];
  requests: StandingRfq[];
}

interface PreparedRequest {
  documentType: string;
  purchasingOrg: string;
  purchasingGroup: string;
  rfqDate: string;
  quotationDeadline: string;
  currency: string;
  collectiveNumber: string | null;
  lines: StandingRfqLine[];
  suppliers: string[];
}

function blank(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The loaded time is the concurrency token. A null token is a row that has not been changed. */
function tokenOf(value: Date | string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function tokensMatch(sent: string | null | undefined, standing: Date | string | null | undefined): boolean {
  return blank(sent) === tokenOf(standing);
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RfqError(`${label} is not a date.`);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RfqError(`${label} is not a date.`);
  }
}

function quantityText(value: number | string | null | undefined): string {
  if (value == null || String(value).trim() === '') throw new RfqError('A quantity is required.');
  const raw = String(value).trim();
  const fraction = raw.split('.')[1] ?? '';
  if (fraction.length > QUANTITY_SCALE) {
    throw new RfqError(`Quantity ${raw} is not a decimal at scale ${QUANTITY_SCALE}.`);
  }
  let scaled: bigint;
  try {
    scaled = toScaled(raw, QUANTITY_SCALE);
  } catch {
    throw new RfqError(`Quantity ${raw} is not a decimal at scale ${QUANTITY_SCALE}.`);
  }
  if (scaled <= 0n) throw new RfqError('A quantity must be greater than zero.');
  return fromScaled(scaled, QUANTITY_SCALE);
}

function refuseCuts(input: RfqCreateInput): void {
  if (blank(input.eventNumber)) throw new RfqError('The client does not assign the event number.');
  if (blank(input.rfqNumber) || input.suppliers.some((supplier) => blank(supplier.rfqNumber))) {
    throw new RfqError('The client does not assign the request number.');
  }
  if (input.lines.some((line) => line.itemNumber != null && String(line.itemNumber).trim() !== '')) {
    throw new RfqError('The client does not assign the item number.');
  }
  if (blank(input.id)) throw new RfqError('The drawn number is the key.');
  if (blank(input.companyCode)) throw new RfqError('A company code is not a column. The plant carries it.');
  if (blank(input.status)) throw new RfqError('A request has no stored status. It stands when it is saved.');
  if (blank(input.deliveryChannel) || input.suppliers.some((supplier) => blank(supplier.deliveryChannel))) {
    throw new RfqError('There is no dispatcher. A delivery channel is not stored.');
  }
  if (blank(input.contactId) || input.suppliers.some((supplier) => blank(supplier.contactId))) {
    throw new RfqError('A supplier contact is not stored.');
  }
  if (blank(input.sentAt) || blank(input.deliveryReference)) {
    throw new RfqError('A delivery attempt is not stored.');
  }
  if (blank(input.outbox)) throw new RfqError('An outbox is not written.');
  if (blank(input.requestKey)) throw new RfqError('A request key is not stored. A second submit is a second event.');
  if (blank(input.price) || input.lines.some((line) => blank(line.price))) {
    throw new RfqError('A request carries no price.');
  }
  if (blank(input.quotationNumber) || blank(input.award)) {
    throw new RfqError('A quotation is not created from this request.');
  }
  if (blank(input.comparison)) throw new RfqError('A comparison is not stored.');
  if (blank(input.requisitionNumber) || input.lines.some((line) => blank(line.requisitionNumber))) {
    throw new RfqError('A requisition is not converted.');
  }
  if (blank(input.orderNumber)) throw new RfqError('An order is not created.');
  if (input.lines.some((line) => blank(line.deliveryLocation))) {
    throw new RfqError('The plant is the delivery destination.');
  }
  if (input.deleteEvent) throw new RfqError('A request is not physically deleted.');
}

async function draw(tx: Tx, client: string, objectCode: string, changedBy: string): Promise<string> {
  try {
    const drawn = await allocateNumber(tx, {
      client, objectCode, companyCode: '*', subObject: '*', fiscalYear: 0, allocatedBy: changedBy,
    });
    return drawn.display;
  } catch (error) {
    if (error instanceof NumberRangeError) {
      throw new RfqError(
        `No active internal ${objectCode} number range stands, so no number can be drawn.`,
        error.remedy,
      );
    }
    throw error;
  }
}

async function prepareCreate(tx: Tx, input: RfqCreateInput): Promise<PreparedRequest> {
  refuseCuts(input);
  const documentType = blank(input.documentType) ?? RFQ_TYPE;
  if (documentType !== RFQ_TYPE) throw new RfqError(`Document type ${documentType} does not stand.`);
  const org = blank(input.purchasingOrg);
  const groupCode = blank(input.purchasingGroup);
  if (!org || !groupCode) throw new RfqError('A purchasing organisation and a purchasing group are required.');
  assertDate(input.rfqDate, 'The RFQ date');
  assertDate(input.quotationDeadline, 'The quotation deadline');
  if (input.quotationDeadline < input.rfqDate) {
    throw new RfqError('The quotation deadline is before the RFQ date.');
  }
  const collective = blank(input.collectiveNumber);
  if (collective && collective.length > 10) {
    throw new RfqError('A collective number is at most ten characters. It is a label, not the key.');
  }
  if (input.lines.length === 0) throw new RfqError('A request with no line does not stand.');
  if (input.suppliers.length === 0) throw new RfqError('A request with no supplier does not stand.');

  const [organisation] = await tx.select().from(purchasingOrg).where(and(
    eq(purchasingOrg.client, input.client), eq(purchasingOrg.purchasingOrg, org),
  ));
  if (!organisation?.isActive) {
    throw new RfqError(`Purchasing organisation ${org} does not exist or is inactive.`);
  }
  const [group] = await tx.select().from(purchasingGroup).where(and(
    eq(purchasingGroup.client, input.client), eq(purchasingGroup.purchasingGroup, groupCode),
  ));
  if (!group?.isActive) throw new RfqError(`Purchasing group ${groupCode} does not exist or is inactive.`);
  if (group.purchasingOrg && group.purchasingOrg !== org) {
    throw new RfqError(`Purchasing group ${groupCode} belongs to organisation ${group.purchasingOrg}.`);
  }

  const lines: StandingRfqLine[] = [];
  const companies = new Set<string>();
  for (const [index, line] of input.lines.entries()) {
    const plantCode = blank(line.plant);
    if (!plantCode) throw new RfqError('A plant is required.');
    assertDate(line.deliveryDate ?? '', 'The delivery date');
    const [plantRow] = await tx.select().from(plant).where(and(
      eq(plant.client, input.client), eq(plant.plant, plantCode),
    ));
    if (!plantRow?.isActive) throw new RfqError(`Plant ${plantCode} does not exist or is inactive.`);
    if (!plantRow.companyCode) {
      throw new RfqError(`Plant ${plantCode} belongs to no company code, so its currency cannot be judged.`);
    }
    companies.add(plantRow.companyCode);
    const [assigned] = await tx.select().from(purchasingOrgPlant).where(and(
      eq(purchasingOrgPlant.client, input.client),
      eq(purchasingOrgPlant.purchasingOrg, org),
      eq(purchasingOrgPlant.plant, plantCode),
    ));
    if (!assigned) throw new RfqError(`Plant ${plantCode} is not assigned to purchasing organisation ${org}.`);

    const storage = blank(line.storageLocation);
    if (storage) {
      const [location] = await tx.select().from(storageLocation).where(and(
        eq(storageLocation.client, input.client),
        eq(storageLocation.plant, plantCode),
        eq(storageLocation.storageLocation, storage),
      ));
      if (!location?.isActive) {
        throw new RfqError(`Storage location ${storage} does not stand active at plant ${plantCode}.`);
      }
    }

    const materialNumber = blank(line.materialNumber);
    let shortText = blank(line.shortText);
    let unit = blank(line.unit)?.toUpperCase() ?? null;
    let baseUnit: string | null = null;
    if (materialNumber) {
      const [master] = await tx.select().from(material).where(and(
        eq(material.client, input.client), eq(material.materialNumber, materialNumber),
      ));
      if (!master) throw new RfqError(`Material ${materialNumber} does not exist.`);
      if (master.isBlocked) throw new RfqError(`Material ${materialNumber} is blocked.`);
      const [extension] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, materialNumber),
        eq(materialPlant.plant, plantCode),
      ));
      if (!extension) throw new RfqError(`Material ${materialNumber} is not extended to plant ${plantCode}.`);
      if (!shortText) shortText = blank(master.description);
      baseUnit = master.baseUnit?.toUpperCase() ?? null;
      if (!unit) unit = baseUnit;
    }
    if (!shortText) throw new RfqError('A short text is required.');
    if (shortText.length > 40) throw new RfqError('A short text is at most 40 characters.');
    if (!unit) throw new RfqError('A unit of measure is required.');
    const [unitRow] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, unit));
    if (!unitRow) throw new RfqError(`Unit ${unit} is not a standing unit of measure.`);
    if (materialNumber && unit !== baseUnit) {
      const [conversion] = await tx.select().from(materialUomConversion).where(and(
        eq(materialUomConversion.client, input.client),
        eq(materialUomConversion.materialNumber, materialNumber),
        eq(materialUomConversion.alternativeUnit, unit),
      ));
      if (!conversion) throw new RfqError(`Material ${materialNumber} has no conversion from ${unit}.`);
    }
    lines.push({
      itemNumber: (index + 1) * 10,
      materialNumber,
      shortText,
      quantity: quantityText(line.quantity),
      unit,
      plant: plantCode,
      storageLocation: storage,
      deliveryDate: line.deliveryDate as string,
    });
  }

  if (companies.size !== 1) throw new RfqError('The plants do not share one company.');
  const sharedCompany = [...companies][0];
  if (organisation.companyCode && organisation.companyCode !== sharedCompany) {
    throw new RfqError(
      `The plants belong to company ${sharedCompany}, not purchasing organisation ${org}'s company ${organisation.companyCode}.`,
    );
  }
  const [company] = await tx.select().from(companyCode).where(and(
    eq(companyCode.client, input.client), eq(companyCode.companyCode, sharedCompany),
  ));
  if (!company?.isActive || !company.currency) {
    throw new RfqError(`Company ${sharedCompany} does not stand, so no currency can be judged.`);
  }
  const currency = company.currency.trim();
  const sentCurrency = blank(input.currency)?.toUpperCase();
  if (sentCurrency && sentCurrency !== currency) {
    throw new RfqError(`The currency is the company's local currency ${currency}, not a field on the request.`);
  }

  const suppliers: string[] = [];
  for (const supplier of input.suppliers) {
    const partner = blank(supplier.partnerNumber);
    if (!partner) throw new RfqError('A supplier is required.');
    if (suppliers.includes(partner)) throw new RfqError(`Supplier ${partner} is invited twice.`);
    const [partnerRow] = await tx.select().from(businessPartner).where(and(
      eq(businessPartner.client, input.client), eq(businessPartner.partnerNumber, partner),
    ));
    if (!partnerRow) throw new RfqError(`Supplier ${partner} does not exist.`);
    if (partnerRow.isBlocked) throw new RfqError(`Supplier ${partner} is blocked.`);
    const [role] = await tx.select().from(bpRole).where(and(
      eq(bpRole.client, input.client),
      eq(bpRole.partnerNumber, partner),
      eq(bpRole.roleCode, 'SUPPLIER'),
    ));
    if (!role?.isActive) throw new RfqError(`Supplier ${partner} has no supplier role.`);
    const [assignment] = await tx.select().from(supplierPurchasing).where(and(
      eq(supplierPurchasing.client, input.client),
      eq(supplierPurchasing.partnerNumber, partner),
      eq(supplierPurchasing.purchasingOrg, org),
    ));
    if (!assignment || assignment.purchasingStatus === 'INCOMPLETE') {
      throw new RfqError(`Supplier ${partner} has no purchasing assignment for organisation ${org}.`);
    }
    if (assignment.isBlocked) {
      throw new RfqError(`Supplier ${partner} is blocked for purchasing organisation ${org}.`);
    }
    suppliers.push(partner);
  }

  return {
    documentType,
    purchasingOrg: org,
    purchasingGroup: groupCode,
    rfqDate: input.rfqDate,
    quotationDeadline: input.quotationDeadline,
    currency,
    collectiveNumber: collective,
    lines,
    suppliers,
  };
}

function snapshot(eventNumber: string, prepared: PreparedRequest, requests: StandingRfq[]) {
  return {
    eventNumber,
    documentType: prepared.documentType,
    purchasingOrg: prepared.purchasingOrg,
    purchasingGroup: prepared.purchasingGroup,
    rfqDate: prepared.rfqDate,
    quotationDeadline: prepared.quotationDeadline,
    currency: prepared.currency,
    collectiveNumber: prepared.collectiveNumber,
    lines: prepared.lines,
    requests: requests.map((request) => ({
      rfqNumber: request.rfqNumber,
      partnerNumber: request.partnerNumber,
    })),
  };
}

export async function previewRequestForQuotation(input: RfqCreateInput): Promise<PreparedRequest & {
  eventNumber: null;
  requests: Array<{ rfqNumber: null; partnerNumber: string }>;
  nothingCreated: true;
  message: string;
}> {
  return withTenant(input.client, async (tx) => {
    const prepared = await prepareCreate(tx, input);
    return {
      ...prepared,
      eventNumber: null,
      requests: prepared.suppliers.map((partnerNumber) => ({ rfqNumber: null, partnerNumber })),
      nothingCreated: true,
      message: 'Nothing has been created.',
    };
  });
}

export async function createRequestForQuotation(input: RfqCreateInput): Promise<{ eventNumber: string; rfqNumbers: string[] }> {
  return withTenant(input.client, (tx) => writeRequestForQuotation(tx, input));
}

export async function writeRequestForQuotation(
  tx: Tx,
  input: RfqCreateInput,
): Promise<{ eventNumber: string; rfqNumbers: string[] }> {
  const prepared = await prepareCreate(tx, input);
  const eventNumber = await draw(tx, input.client, RFQ_EVENT_OBJECT, input.changedBy);
  await tx.insert(purchasingRfqEvent).values({
    client: input.client,
    eventNumber,
    documentType: prepared.documentType,
    purchasingOrg: prepared.purchasingOrg,
    purchasingGroup: prepared.purchasingGroup,
    rfqDate: prepared.rfqDate,
    quotationDeadline: prepared.quotationDeadline,
    currency: prepared.currency,
    collectiveNumber: prepared.collectiveNumber,
    createdBy: input.changedBy,
  });
  for (const line of prepared.lines) {
    await tx.insert(purchasingRfqEventItem).values({
      client: input.client,
      eventNumber,
      itemNumber: line.itemNumber,
      shortText: line.shortText,
      materialNumber: line.materialNumber,
      quantity: line.quantity,
      unit: line.unit,
      plant: line.plant,
      storageLocation: line.storageLocation,
      deliveryDate: line.deliveryDate,
      createdBy: input.changedBy,
    });
  }
  const requests: StandingRfq[] = [];
  for (const partnerNumber of prepared.suppliers) {
    const rfqNumber = await draw(tx, input.client, RFQ_OBJECT, input.changedBy);
    await tx.insert(purchasingRfq).values({
      client: input.client,
      rfqNumber,
      eventNumber,
      partnerNumber,
      createdBy: input.changedBy,
    });
    for (const line of prepared.lines) {
      await tx.insert(purchasingRfqItem).values({
        client: input.client,
        rfqNumber,
        eventNumber,
        itemNumber: line.itemNumber,
        shortText: line.shortText,
        materialNumber: line.materialNumber,
        quantity: line.quantity,
        unit: line.unit,
        plant: line.plant,
        storageLocation: line.storageLocation,
        deliveryDate: line.deliveryDate,
        createdBy: input.changedBy,
      });
    }
    requests.push({ rfqNumber, partnerNumber, lines: prepared.lines });
    await recordChange(tx, {
      client: input.client,
      objectClass: REQUEST_CLASS,
      objectKey: rfqNumber,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: RFQ_CAPABILITY,
      after: { eventNumber, partnerNumber, lines: prepared.lines },
    });
  }
  await recordChange(tx, {
    client: input.client,
    objectClass: EVENT_CLASS,
    objectKey: eventNumber,
    changeType: 'CREATE',
    changedBy: input.changedBy,
    transactionCode: RFQ_CAPABILITY,
    after: snapshot(eventNumber, prepared, requests),
  });
  return { eventNumber, rfqNumbers: requests.map((request) => request.rfqNumber) };
}

export async function listRecentRequestsForQuotation(client: string): Promise<Array<{
  eventNumber: string;
  purchasingOrg: string;
  quotationDeadline: string;
  collectiveNumber: string | null;
}>> {
  return withTenant(client, (tx) => tx.select({
    eventNumber: purchasingRfqEvent.eventNumber,
    purchasingOrg: purchasingRfqEvent.purchasingOrg,
    quotationDeadline: purchasingRfqEvent.quotationDeadline,
    collectiveNumber: purchasingRfqEvent.collectiveNumber,
  }).from(purchasingRfqEvent).where(eq(purchasingRfqEvent.client, client))
    .orderBy(desc(purchasingRfqEvent.eventNumber))
    .limit(40));
}

export async function getRequestForQuotation(client: string, eventNumber: string): Promise<StandingRfqEvent | null> {
  return withTenant(client, async (tx) => {
    const [event] = await tx.select().from(purchasingRfqEvent).where(and(
      eq(purchasingRfqEvent.client, client), eq(purchasingRfqEvent.eventNumber, eventNumber),
    ));
    if (!event) return null;
    const eventLines = await tx.select().from(purchasingRfqEventItem).where(and(
      eq(purchasingRfqEventItem.client, client), eq(purchasingRfqEventItem.eventNumber, eventNumber),
    )).orderBy(asc(purchasingRfqEventItem.itemNumber));
    const headers = await tx.select().from(purchasingRfq).where(and(
      eq(purchasingRfq.client, client), eq(purchasingRfq.eventNumber, eventNumber),
    )).orderBy(asc(purchasingRfq.rfqNumber));
    const copies = await tx.select().from(purchasingRfqItem).where(and(
      eq(purchasingRfqItem.client, client), eq(purchasingRfqItem.eventNumber, eventNumber),
    )).orderBy(asc(purchasingRfqItem.rfqNumber), asc(purchasingRfqItem.itemNumber));
    const lineOf = (row: typeof eventLines[number]): StandingRfqLine => ({
      itemNumber: row.itemNumber,
      materialNumber: row.materialNumber,
      shortText: row.shortText,
      quantity: row.quantity,
      unit: row.unit,
      plant: row.plant,
      storageLocation: row.storageLocation,
      deliveryDate: row.deliveryDate,
    });
    return {
      eventNumber: event.eventNumber,
      documentType: event.documentType,
      purchasingOrg: event.purchasingOrg,
      purchasingGroup: event.purchasingGroup,
      rfqDate: event.rfqDate,
      quotationDeadline: event.quotationDeadline,
      currency: event.currency.trim(),
      collectiveNumber: event.collectiveNumber,
      changedAt: tokenOf(event.changedAt),
      lines: eventLines.map(lineOf),
      requests: headers.map((header) => ({
        rfqNumber: header.rfqNumber,
        partnerNumber: header.partnerNumber,
        changedAt: tokenOf(header.changedAt),
        lines: copies.filter((row) => row.rfqNumber === header.rfqNumber).map(lineOf),
      })),
    };
  });
}

export interface RfqChangeInput {
  client: string;
  changedBy: string;
  rfqNumber: string;
  expectedEventChangedAt?: string | null;
  expectedRequestChangedAt?: string | null;
  reason?: string | null;
  purchasingGroup?: string | null;
  quotationDeadline?: string | null;
  collectiveNumber?: string | null;
  lines?: RfqLineInput[];
  suppliers?: RfqSupplierInput[];
  eventNumber?: string | null;
  partnerNumber?: string | null;
  purchasingOrg?: string | null;
  rfqDate?: string | null;
  documentType?: string | null;
  currency?: string | null;
  companyCode?: string | null;
  status?: string | null;
  deliveryChannel?: string | null;
  contactId?: string | null;
  sentAt?: string | null;
  deliveryReference?: string | null;
  requestKey?: string | null;
  price?: number | string | null;
  quotationNumber?: string | null;
  award?: string | null;
  comparison?: string | null;
  requisitionNumber?: string | null;
  orderNumber?: string | null;
  outbox?: string | null;
  notification?: string | null;
  revision?: string | null;
  deleteEvent?: boolean;
  deleteItem?: boolean;
  id?: string | null;
}

export interface RfqChangePreview {
  rfqNumber: string;
  eventNumber: string;
  partnerNumber: string;
  eventChangedAt: string | null;
  requestChangedAt: string | null;
  headerIsTheEvents: boolean;
  header: {
    purchasingGroup: { before: string; after: string };
    quotationDeadline: { before: string; after: string };
    collectiveNumber: { before: string | null; after: string | null };
  };
  lines: Array<{ itemNumber: number; before: StandingRfqLine; after: StandingRfqLine }>;
  nothingWritten: true;
  unchanged: boolean;
  message: string;
}

export interface RfqChangeResult {
  rfqNumber: string;
  eventNumber: string;
  eventChangedAt: string | null;
  requestChangedAt: string | null;
  headerChanged: boolean;
  linesChanged: boolean;
}

interface ChangePlan {
  preview: RfqChangePreview;
  reason: string | null;
  headerChanged: boolean;
  linesChanged: boolean;
  nextHeader: {
    purchasingGroup: string;
    quotationDeadline: string;
    collectiveNumber: string | null;
  };
  nextLines: StandingRfqLine[];
}

function refuseChangeCuts(input: RfqChangeInput): void {
  if (!blank(input.rfqNumber)) throw new RfqError('A request number is required.');
  if (blank(input.id)) throw new RfqError('The drawn number is the key.');
  if (blank(input.companyCode)) throw new RfqError('A company code is not a column. The plant carries it.');
  if (blank(input.status)) throw new RfqError('A request has no stored status. It stands when it is saved.');
  if (blank(input.deliveryChannel)) throw new RfqError('There is no dispatcher. A delivery channel is not stored.');
  if (blank(input.contactId)) throw new RfqError('A supplier contact is not stored.');
  if (blank(input.sentAt) || blank(input.deliveryReference)) throw new RfqError('A delivery attempt is not stored.');
  if (blank(input.outbox)) throw new RfqError('An outbox is not written.');
  if (blank(input.requestKey)) throw new RfqError('A request key is not stored. A retry of a committed change is a stale refusal.');
  if (blank(input.price) || input.lines?.some((line) => blank(line.price))) throw new RfqError('A request carries no price.');
  if (blank(input.quotationNumber) || blank(input.award)) throw new RfqError('A quotation is not created from this request.');
  if (blank(input.comparison)) throw new RfqError('A comparison is not stored.');
  if (blank(input.requisitionNumber) || input.lines?.some((line) => blank(line.requisitionNumber))) {
    throw new RfqError('A requisition is not converted.');
  }
  if (blank(input.orderNumber)) throw new RfqError('An order is not created.');
  if (input.lines?.some((line) => blank(line.deliveryLocation))) throw new RfqError('The plant is the delivery destination.');
  if (input.deleteEvent || input.deleteItem) throw new RfqError('A request is not physically deleted.');
  if (blank(input.revision)) throw new RfqError('A revision is not stored. The loaded time is the token.');
  if (blank(input.notification)) throw new RfqError('A supplier is not notified from this change.');
  if (input.suppliers && input.suppliers.length > 0) {
    const seen = new Set<string>();
    for (const supplier of input.suppliers) {
      const partner = blank(supplier.partnerNumber);
      if (!partner) throw new RfqError('A supplier is not invited from a change.');
      if (seen.has(partner)) throw new RfqError(`Supplier ${partner} is invited twice.`);
      seen.add(partner);
    }
    throw new RfqError('A supplier is not invited from a change.');
  }
}

function stoodAt(kind: 'Event' | 'Request', number: string, standing: Date | string | null | undefined): string {
  return `${kind} ${number} stands as of ${tokenOf(standing) ?? 'its creation'}. Reload it.`;
}

function lineSame(left: StandingRfqLine, right: StandingRfqLine): boolean {
  return left.shortText === right.shortText
    && left.quantity === right.quantity
    && left.unit === right.unit
    && left.plant === right.plant
    && left.storageLocation === right.storageLocation
    && left.deliveryDate === right.deliveryDate
    && left.materialNumber === right.materialNumber;
}

function lineFields(line: StandingRfqLine): Record<string, string | null> {
  const prefix = `line${line.itemNumber}`;
  return {
    [`${prefix}.shortText`]: line.shortText,
    [`${prefix}.quantity`]: line.quantity,
    [`${prefix}.unit`]: line.unit,
    [`${prefix}.plant`]: line.plant,
    [`${prefix}.storageLocation`]: line.storageLocation,
    [`${prefix}.deliveryDate`]: line.deliveryDate,
  };
}

async function loadChange(tx: Tx, client: string, rfqNumber: string, lock: boolean) {
  const [found] = await tx.select().from(purchasingRfq).where(and(
    eq(purchasingRfq.client, client), eq(purchasingRfq.rfqNumber, rfqNumber),
  ));
  if (!found) throw new RfqError(`Request ${rfqNumber} does not stand.`);
  const eventQuery = tx.select().from(purchasingRfqEvent).where(and(
    eq(purchasingRfqEvent.client, client), eq(purchasingRfqEvent.eventNumber, found.eventNumber),
  ));
  const [event] = lock ? await eventQuery.for('update') : await eventQuery;
  if (!event) throw new RfqError(`Request ${rfqNumber} does not stand.`);
  const requestQuery = tx.select().from(purchasingRfq).where(and(
    eq(purchasingRfq.client, client), eq(purchasingRfq.rfqNumber, rfqNumber),
  ));
  const [request] = lock ? await requestQuery.for('update') : await requestQuery;
  if (!request) throw new RfqError(`Request ${rfqNumber} does not stand.`);
  const copies = await tx.select().from(purchasingRfqItem).where(and(
    eq(purchasingRfqItem.client, client), eq(purchasingRfqItem.rfqNumber, rfqNumber),
  )).orderBy(asc(purchasingRfqItem.itemNumber));
  return { event, request, copies };
}

async function planChange(tx: Tx, input: RfqChangeInput, lock: boolean): Promise<ChangePlan> {
  refuseChangeCuts(input);
  const loaded = await loadChange(tx, input.client, input.rfqNumber.trim(), lock);
  const { event, request, copies } = loaded;
  if (!tokensMatch(input.expectedEventChangedAt, event.changedAt)) {
    throw new RfqError(stoodAt('Event', event.eventNumber, event.changedAt));
  }
  if (!tokensMatch(input.expectedRequestChangedAt, request.changedAt)) {
    throw new RfqError(stoodAt('Request', request.rfqNumber, request.changedAt));
  }
  const sentEvent = blank(input.eventNumber);
  if (sentEvent && sentEvent !== event.eventNumber) throw new RfqError('The event is not changed.');
  const sentPartner = blank(input.partnerNumber);
  if (sentPartner && sentPartner !== request.partnerNumber) throw new RfqError('The supplier is not changed.');
  const sentOrg = blank(input.purchasingOrg);
  if (sentOrg && sentOrg !== event.purchasingOrg) throw new RfqError('The purchasing organisation is not changed.');
  const sentDate = blank(input.rfqDate);
  if (sentDate && sentDate !== event.rfqDate) throw new RfqError('The RFQ date is not changed.');
  const sentType = blank(input.documentType);
  if (sentType && sentType !== event.documentType) throw new RfqError('The document type is not changed.');
  const sentCurrency = blank(input.currency)?.toUpperCase();
  if (sentCurrency && sentCurrency !== event.currency.trim()) {
    throw new RfqError(`The currency is the company's local currency ${event.currency.trim()}, not a field on the request.`);
  }

  const nextHeader = {
    purchasingGroup: event.purchasingGroup,
    quotationDeadline: event.quotationDeadline,
    collectiveNumber: event.collectiveNumber,
  };
  if (input.purchasingGroup !== undefined) {
    const groupCode = blank(input.purchasingGroup);
    if (!groupCode) throw new RfqError('A purchasing group is required.');
    nextHeader.purchasingGroup = groupCode;
  }
  if (input.quotationDeadline !== undefined) {
    assertDate(input.quotationDeadline, 'The quotation deadline');
    if (input.quotationDeadline < event.rfqDate) {
      throw new RfqError('The quotation deadline is before the RFQ date.');
    }
    nextHeader.quotationDeadline = input.quotationDeadline;
  }
  if (input.collectiveNumber !== undefined) {
    const collective = blank(input.collectiveNumber);
    if (collective && collective.length > 10) {
      throw new RfqError('A collective number is at most ten characters. It is a label, not the key.');
    }
    nextHeader.collectiveNumber = collective;
  }
  const headerChanged = nextHeader.purchasingGroup !== event.purchasingGroup
    || nextHeader.quotationDeadline !== event.quotationDeadline
    || nextHeader.collectiveNumber !== event.collectiveNumber;
  if (headerChanged && nextHeader.purchasingGroup !== event.purchasingGroup) {
    const [group] = await tx.select().from(purchasingGroup).where(and(
      eq(purchasingGroup.client, input.client), eq(purchasingGroup.purchasingGroup, nextHeader.purchasingGroup),
    ));
    if (!group?.isActive) throw new RfqError(`Purchasing group ${nextHeader.purchasingGroup} does not exist or is inactive.`);
    if (group.purchasingOrg && group.purchasingOrg !== event.purchasingOrg) {
      throw new RfqError(`Purchasing group ${nextHeader.purchasingGroup} belongs to organisation ${group.purchasingOrg}.`);
    }
  }

  const standingLines = copies.map((row): StandingRfqLine => ({
    itemNumber: row.itemNumber,
    materialNumber: row.materialNumber,
    shortText: row.shortText,
    quantity: row.quantity,
    unit: row.unit,
    plant: row.plant,
    storageLocation: row.storageLocation,
    deliveryDate: row.deliveryDate,
  }));
  const byItem = new Map(standingLines.map((line) => [line.itemNumber, line]));
  const nextLines = standingLines.map((line) => ({ ...line }));
  if (input.lines) {
    const named = new Set<number>();
    for (const line of input.lines) {
      const itemNumber = line.itemNumber == null || String(line.itemNumber).trim() === ''
        ? null
        : Number(String(line.itemNumber).trim());
      if (itemNumber == null || !Number.isSafeInteger(itemNumber) || !byItem.has(itemNumber)) {
        throw new RfqError('A line is not added.');
      }
      if (named.has(itemNumber)) throw new RfqError(`Item ${itemNumber} is named twice.`);
      named.add(itemNumber);
      const standing = byItem.get(itemNumber)!;
      if (line.materialNumber !== undefined && blank(line.materialNumber) !== standing.materialNumber) {
        throw new RfqError('The material is not changed.');
      }
      const proposed: StandingRfqLine = { ...standing };
      if (line.shortText !== undefined) {
        const text = blank(line.shortText);
        if (!text) throw new RfqError('A short text is required.');
        if (text.length > 40) throw new RfqError('A short text is at most 40 characters.');
        proposed.shortText = text;
      }
      if (line.quantity !== undefined) proposed.quantity = quantityText(line.quantity);
      if (line.unit !== undefined) {
        const unit = blank(line.unit)?.toUpperCase();
        if (!unit) throw new RfqError('A unit of measure is required.');
        proposed.unit = unit;
      }
      if (line.plant !== undefined) {
        const plantCode = blank(line.plant);
        if (!plantCode) throw new RfqError('A plant is required.');
        proposed.plant = plantCode;
      }
      if (line.storageLocation !== undefined) proposed.storageLocation = blank(line.storageLocation);
      if (line.deliveryDate !== undefined) {
        assertDate(line.deliveryDate ?? '', 'The delivery date');
        proposed.deliveryDate = line.deliveryDate as string;
      }
      if (!lineSame(standing, proposed)) await judgeChangedLine(tx, input.client, event, standing, proposed);
      const at = nextLines.findIndex((row) => row.itemNumber === itemNumber);
      nextLines[at] = proposed;
    }
    if (named.size !== standingLines.length) throw new RfqError('A line is not removed.');
  }
  const linesChanged = nextLines.some((line, index) => !lineSame(line, standingLines[index]));
  const unchanged = !headerChanged && !linesChanged;
  const reason = unchanged ? null : reasonOf(input.reason);
  const preview: RfqChangePreview = {
    rfqNumber: request.rfqNumber,
    eventNumber: event.eventNumber,
    partnerNumber: request.partnerNumber,
    eventChangedAt: tokenOf(event.changedAt),
    requestChangedAt: tokenOf(request.changedAt),
    headerIsTheEvents: headerChanged,
    header: {
      purchasingGroup: { before: event.purchasingGroup, after: nextHeader.purchasingGroup },
      quotationDeadline: { before: event.quotationDeadline, after: nextHeader.quotationDeadline },
      collectiveNumber: { before: event.collectiveNumber, after: nextHeader.collectiveNumber },
    },
    lines: nextLines.map((line, index) => ({
      itemNumber: line.itemNumber,
      before: standingLines[index],
      after: line,
    })),
    nothingWritten: true,
    unchanged,
    message: unchanged
      ? 'Nothing would change.'
      : headerChanged
        ? "The header is the event's. Nothing has been written."
        : 'Nothing has been written.',
  };
  return { preview, reason, headerChanged, linesChanged, nextHeader, nextLines };
}

function reasonOf(value: string | null | undefined): string {
  const reason = blank(value);
  if (!reason) throw new RfqError('A reason is required.');
  if (reason.length < 3 || reason.length > 500) throw new RfqError('A reason is three to five hundred characters.');
  return reason;
}

async function judgeChangedLine(
  tx: Tx,
  client: string,
  event: { purchasingOrg: string; currency: string; eventNumber: string },
  standing: StandingRfqLine,
  proposed: StandingRfqLine,
): Promise<void> {
  if (proposed.plant !== standing.plant || proposed.storageLocation !== standing.storageLocation) {
    const [plantRow] = await tx.select().from(plant).where(and(
      eq(plant.client, client), eq(plant.plant, proposed.plant),
    ));
    if (!plantRow?.isActive) throw new RfqError(`Plant ${proposed.plant} does not exist or is inactive.`);
    if (!plantRow.companyCode) {
      throw new RfqError(`Plant ${proposed.plant} belongs to no company code, so its currency cannot be judged.`);
    }
    const [assigned] = await tx.select().from(purchasingOrgPlant).where(and(
      eq(purchasingOrgPlant.client, client),
      eq(purchasingOrgPlant.purchasingOrg, event.purchasingOrg),
      eq(purchasingOrgPlant.plant, proposed.plant),
    ));
    if (!assigned) throw new RfqError(`Plant ${proposed.plant} is not assigned to purchasing organisation ${event.purchasingOrg}.`);
    const eventCompany = await companyOfEvent(tx, client, event.eventNumber);
    if (plantRow.companyCode !== eventCompany) {
      throw new RfqError(`Plant ${proposed.plant} belongs to company ${plantRow.companyCode}, not the event's company ${eventCompany}.`);
    }
    const [company] = await tx.select().from(companyCode).where(and(
      eq(companyCode.client, client), eq(companyCode.companyCode, plantRow.companyCode),
    ));
    if (!company?.currency || company.currency.trim() !== event.currency.trim()) {
      throw new RfqError(`The currency is the company's local currency ${event.currency.trim()}, not a field on the request.`);
    }
    if (proposed.storageLocation) {
      const [location] = await tx.select().from(storageLocation).where(and(
        eq(storageLocation.client, client),
        eq(storageLocation.plant, proposed.plant),
        eq(storageLocation.storageLocation, proposed.storageLocation),
      ));
      if (!location?.isActive) {
        throw new RfqError(`Storage location ${proposed.storageLocation} does not stand active at plant ${proposed.plant}.`);
      }
    }
  }
  if (proposed.materialNumber && (proposed.plant !== standing.plant || proposed.unit !== standing.unit)) {
    const [master] = await tx.select().from(material).where(and(
      eq(material.client, client), eq(material.materialNumber, proposed.materialNumber),
    ));
    if (!master) throw new RfqError(`Material ${proposed.materialNumber} does not exist.`);
    if (master.isBlocked) throw new RfqError(`Material ${proposed.materialNumber} is blocked.`);
    if (proposed.plant !== standing.plant) {
      const [extension] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, client),
        eq(materialPlant.materialNumber, proposed.materialNumber),
        eq(materialPlant.plant, proposed.plant),
      ));
      if (!extension) throw new RfqError(`Material ${proposed.materialNumber} is not extended to plant ${proposed.plant}.`);
    }
    if (proposed.unit !== standing.unit) {
      const unit = proposed.unit;
      const [unitRow] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, unit));
      if (!unitRow) throw new RfqError(`Unit ${unit} is not a standing unit of measure.`);
      const baseUnit = master.baseUnit?.toUpperCase() ?? null;
      if (unit !== baseUnit) {
        const [conversion] = await tx.select().from(materialUomConversion).where(and(
          eq(materialUomConversion.client, client),
          eq(materialUomConversion.materialNumber, proposed.materialNumber),
          eq(materialUomConversion.alternativeUnit, unit),
        ));
        if (!conversion) throw new RfqError(`Material ${proposed.materialNumber} has no conversion from ${unit}.`);
      }
    }
  }
  if (proposed.unit !== standing.unit && !proposed.materialNumber) {
    const [unitRow] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, proposed.unit));
    if (!unitRow) throw new RfqError(`Unit ${proposed.unit} is not a standing unit of measure.`);
  }
}

async function companyOfEvent(tx: Tx, client: string, eventNumber: string): Promise<string> {
  const lines = await tx.select().from(purchasingRfqEventItem).where(and(
    eq(purchasingRfqEventItem.client, client), eq(purchasingRfqEventItem.eventNumber, eventNumber),
  ));
  const companies = new Set<string>();
  for (const line of lines) {
    const [plantRow] = await tx.select().from(plant).where(and(
      eq(plant.client, client), eq(plant.plant, line.plant),
    ));
    if (!plantRow?.companyCode) {
      throw new RfqError(`Plant ${line.plant} belongs to no company code, so its currency cannot be judged.`);
    }
    companies.add(plantRow.companyCode);
  }
  if (companies.size !== 1) throw new RfqError('The plants do not share one company.');
  return [...companies][0];
}

export async function previewRequestForQuotationChange(input: RfqChangeInput): Promise<RfqChangePreview> {
  return withTenant(input.client, async (tx) => (await planChange(tx, input, false)).preview);
}

export async function changeRequestForQuotation(input: RfqChangeInput): Promise<RfqChangeResult> {
  return withTenant(input.client, (tx) => writeRequestForQuotationChange(tx, input));
}

export async function writeRequestForQuotationChange(tx: Tx, input: RfqChangeInput): Promise<RfqChangeResult> {
  const plan = await planChange(tx, input, true);
  if (plan.preview.unchanged) throw new RfqError('Nothing would change.');
  const now = new Date();
  const { eventNumber, rfqNumber } = plan.preview;
  if (plan.headerChanged) {
    await tx.update(purchasingRfqEvent).set({
      purchasingGroup: plan.nextHeader.purchasingGroup,
      quotationDeadline: plan.nextHeader.quotationDeadline,
      collectiveNumber: plan.nextHeader.collectiveNumber,
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(
      eq(purchasingRfqEvent.client, input.client),
      eq(purchasingRfqEvent.eventNumber, eventNumber),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: EVENT_CLASS,
      objectKey: eventNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: RFQ_CAPABILITY,
      reason: plan.reason ?? undefined,
      before: {
        purchasingGroup: plan.preview.header.purchasingGroup.before,
        quotationDeadline: plan.preview.header.quotationDeadline.before,
        collectiveNumber: plan.preview.header.collectiveNumber.before,
      },
      after: {
        purchasingGroup: plan.nextHeader.purchasingGroup,
        quotationDeadline: plan.nextHeader.quotationDeadline,
        collectiveNumber: plan.nextHeader.collectiveNumber,
      },
    });
  }
  if (plan.linesChanged) {
    for (const line of plan.preview.lines) {
      if (lineSame(line.before, line.after)) continue;
      await tx.update(purchasingRfqItem).set({
        shortText: line.after.shortText,
        quantity: line.after.quantity,
        unit: line.after.unit,
        plant: line.after.plant,
        storageLocation: line.after.storageLocation,
        deliveryDate: line.after.deliveryDate,
        changedBy: input.changedBy,
        changedAt: now,
      }).where(and(
        eq(purchasingRfqItem.client, input.client),
        eq(purchasingRfqItem.rfqNumber, rfqNumber),
        eq(purchasingRfqItem.itemNumber, line.itemNumber),
      ));
    }
    await tx.update(purchasingRfq).set({
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(
      eq(purchasingRfq.client, input.client),
      eq(purchasingRfq.rfqNumber, rfqNumber),
    ));
    const before: Record<string, string | null> = {};
    const after: Record<string, string | null> = {};
    for (const line of plan.preview.lines) {
      Object.assign(before, lineFields(line.before));
      Object.assign(after, lineFields(line.after));
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: REQUEST_CLASS,
      objectKey: rfqNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: RFQ_CAPABILITY,
      reason: plan.reason ?? undefined,
      before,
      after,
    });
  }
  return {
    rfqNumber,
    eventNumber,
    eventChangedAt: plan.headerChanged ? tokenOf(now) : plan.preview.eventChangedAt,
    requestChangedAt: plan.linesChanged ? tokenOf(now) : plan.preview.requestChangedAt,
    headerChanged: plan.headerChanged,
    linesChanged: plan.linesChanged,
  };
}

/** An event number opens the event. A request number opens its event and names that request. */
export async function resolveRequestForQuotation(
  client: string,
  number: string,
): Promise<{ eventNumber: string; rfqNumber: string | null } | null> {
  const key = number.trim();
  if (!key) return null;
  return withTenant(client, async (tx) => {
    const [event] = await tx.select({ eventNumber: purchasingRfqEvent.eventNumber }).from(purchasingRfqEvent).where(and(
      eq(purchasingRfqEvent.client, client), eq(purchasingRfqEvent.eventNumber, key),
    ));
    if (event) return { eventNumber: event.eventNumber, rfqNumber: null };
    const [request] = await tx.select({
      eventNumber: purchasingRfq.eventNumber,
      rfqNumber: purchasingRfq.rfqNumber,
    }).from(purchasingRfq).where(and(
      eq(purchasingRfq.client, client), eq(purchasingRfq.rfqNumber, key),
    ));
    if (!request) return null;
    return { eventNumber: request.eventNumber, rfqNumber: request.rfqNumber };
  });
}
