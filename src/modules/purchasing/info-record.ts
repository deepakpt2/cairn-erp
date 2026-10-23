/**
 * Purchasing info record — SCR-151.
 *
 * A default for a supplier and a material. It does not create a requisition,
 * an order, a goods movement or a journal. The price table is the only price.
 * ME12 is a change of the same record. The order calls the resolver inside its
 * own transaction and keeps the price it used. A change records every maintained
 * field that differs, including a closed price interval. A check of that change
 * writes nothing.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber, NumberRangeError } from '../../platform/numbering';
import { currency as currencyTable, unitOfMeasure } from '../../platform/tables/reference';
import { plant, purchasingOrg, purchasingOrgPlant } from '../foundation/schema';
import { supplierPurchasing } from '../foundation/supplier-purchasing-schema';
import { businessPartner } from '../foundation/business-partner-schema';
import { requireSupplierPurchasing, SupplierPurchasingError } from '../foundation/supplier-purchasing';
import { material, materialPlant } from '../inventory/schema';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import {
  purchasingInfoRecord, purchasingInfoRecordOrg, purchasingInfoRecordPrice,
} from './schema';

export const INFO_RECORD_CAPABILITY = 'PROC.INFO.RECORD.MAINTAIN';
export const INFO_RECORD_OBJECT = 'INFOREC';
export const INFO_RECORD_ROUTE = '/purchasing/info-record';
const OBJECT_CLASS = 'purchasing_info_record';
const CATEGORY = 'STANDARD';
const CONDITION = 'NET_PRICE';

export class InfoRecordError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'InfoRecordError';
    this.remedy = remedy;
  }
}

export interface InfoRecordPriceInput {
  amount: number;
  currency: string;
  priceUnit: number;
  priceUnitOfMeasure: string;
  validFrom: string;
  validTo: string;
}

export interface InfoRecordCreateInput {
  client: string;
  changedBy: string;
  partnerNumber: string;
  materialNumber: string;
  purchasingOrg: string;
  plant?: string | null;
  /** Names the existing record when the request adds a segment. A new record does not send a number. */
  infoRecordNumber?: string | null;
  expectedVersion?: number | null;
  price: InfoRecordPriceInput;
  plannedDeliveryDays?: number | null;
  minimumOrderQuantity?: number | null;
  minimumOrderUnit?: string | null;
  orderUnit?: string | null;
  materialGroup?: string | null;
  category?: string | null;
  conditionType?: string | null;
  taxCode?: string | null;
  incoterms?: string | null;
  confirmationControl?: string | null;
  standardQuantity?: number | null;
  scale?: string | null;
}

export interface InfoRecordChangeInput {
  client: string;
  changedBy: string;
  reason: string;
  infoRecordNumber: string;
  expectedVersion: number;
  segmentNumber?: number | null;
  expectedSegmentVersion?: number | null;
  partnerNumber?: string | null;
  materialNumber?: string | null;
  purchasingOrg?: string | null;
  plant?: string | null;
  plannedDeliveryDays?: number | null;
  minimumOrderQuantity?: number | null;
  minimumOrderUnit?: string | null;
  orderUnit?: string | null;
  markRecordDeleted?: boolean;
  reactivateRecord?: boolean;
  markSegmentDeleted?: boolean;
  reactivateSegment?: boolean;
  markPriceDeleted?: number | null;
  reactivatePrice?: number | null;
  newPrice?: InfoRecordPriceInput | null;
}

export interface InfoRecordChangePreview {
  infoRecordNumber: string;
  version: number;
  segmentNumber: number | null;
  changes: Array<{ field: string; before: string | null; after: string | null }>;
  closedInterval: {
    priceSequence: number;
    validFrom: string;
    previousValidTo: string;
    validTo: string;
  } | null;
}

export interface InfoRecordResolution {
  qualified: boolean;
  warning?: string;
  infoRecordNumber?: string;
  priceSequence?: number;
  amount?: string;
  currency?: string;
  priceUnit?: number;
  priceUnitOfMeasure?: string;
  orderUnit?: string | null;
  plannedDeliveryDays?: number | null;
  minimumOrderQuantity?: string | null;
  minimumOrderUnit?: string | null;
}

function blank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function lockKey(client: string, partner: string, materialNumber: string): string {
  return `${client}/purchasing_info_record/${partner}/${materialNumber}/${CATEGORY}`;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InfoRecordError(`${label} is not a date.`);
  }
}

function decimalScale(amount: number): number {
  const text = amount.toString().toLowerCase();
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const fraction = text.split('.')[1];
  return fraction ? fraction.replace(/0+$/, '').length : 0;
}

function refuseUnimplemented(input: InfoRecordCreateInput): void {
  if (blank(input.materialGroup)) {
    throw new InfoRecordError(
      'A material-group info record is not created.',
      'Name the material. A group record is a later round.',
    );
  }
  if (blank(input.taxCode) || blank(input.incoterms) || blank(input.confirmationControl)) {
    throw new InfoRecordError(
      'Tax, incoterms and confirmation control are not fields of the info record.',
      'The supplier purchasing view holds incoterms. The order holds its own tax code.',
    );
  }
  if (input.standardQuantity != null || blank(input.scale)) {
    throw new InfoRecordError('A scale and a standard quantity are not stored. One net price is the price.');
  }
  const category = blank(input.category) ?? CATEGORY;
  if (category !== CATEGORY) {
    throw new InfoRecordError(
      `Info record category ${category} is not supported. Only a standard record is created.`,
    );
  }
  const condition = blank(input.conditionType) ?? CONDITION;
  if (condition !== CONDITION) {
    throw new InfoRecordError(
      `Condition type ${condition} is not supported. The price is a net price, and there is no condition-type catalogue.`,
    );
  }
}

async function assertPrice(tx: Tx, client: string, materialNumber: string, price: InfoRecordPriceInput, orderCurrency: string): Promise<void> {
  if (!Number.isFinite(price.amount) || price.amount < 0) {
    throw new InfoRecordError('A price cannot be negative. Zero is a price.');
  }
  if (!Number.isInteger(price.priceUnit) || price.priceUnit <= 0) {
    throw new InfoRecordError('The price unit must be a positive whole number.');
  }
  assertDate(price.validFrom, 'The validity start');
  assertDate(price.validTo, 'The validity end');
  if (price.validTo < price.validFrom) {
    throw new InfoRecordError(
      `The validity end ${price.validTo} is before the start ${price.validFrom}.`,
    );
  }
  const code = price.currency.trim().toUpperCase();
  if (code !== orderCurrency.trim().toUpperCase()) {
    throw new InfoRecordError(
      `Price currency ${code} is not the supplier's order currency ${orderCurrency.trim()}. A different currency is not converted.`,
    );
  }
  const [money] = await tx.select().from(currencyTable).where(eq(currencyTable.code, code));
  if (!money?.isActive) throw new InfoRecordError(`Currency ${code} does not exist or is inactive.`);
  if (decimalScale(price.amount) > money.decimalPlaces) {
    throw new InfoRecordError(
      `The price has more decimal places than ${code} allows (${money.decimalPlaces}).`,
    );
  }
  const unit = price.priceUnitOfMeasure.trim().toUpperCase();
  try {
    await toBaseQuantity(tx, client, { materialNumber, quantity: 1, entryUnit: unit });
  } catch (error) {
    if (error instanceof UnitConversionError) throw new InfoRecordError(error.message, error.remedy);
    throw error;
  }
}

async function assertQuantityUnit(tx: Tx, client: string, materialNumber: string, unit: string | null, label: string): Promise<void> {
  if (!unit) return;
  try {
    await toBaseQuantity(tx, client, { materialNumber, quantity: 1, entryUnit: unit });
  } catch (error) {
    if (error instanceof UnitConversionError) {
      throw new InfoRecordError(`${label}: ${error.message}`, error.remedy);
    }
    throw error;
  }
}

async function assertOperational(input: {
  plannedDeliveryDays?: number | null;
  minimumOrderQuantity?: number | null;
  minimumOrderUnit?: string | null;
}, tx: Tx, client: string, materialNumber: string): Promise<void> {
  if (input.plannedDeliveryDays != null && (!Number.isInteger(input.plannedDeliveryDays) || input.plannedDeliveryDays < 0)) {
    throw new InfoRecordError('Planned delivery time is a nonnegative whole number of days, or it is omitted.');
  }
  const quantity = input.minimumOrderQuantity;
  const unit = blank(input.minimumOrderUnit);
  if ((quantity == null) !== (unit == null)) {
    throw new InfoRecordError('A minimum order quantity needs its unit, and a unit needs the quantity.');
  }
  if (quantity != null && (quantity < 0 || decimalScale(quantity) > 3)) {
    throw new InfoRecordError('The minimum order quantity is a nonnegative quantity, held to three decimal places.');
  }
  await assertQuantityUnit(tx, client, materialNumber, unit, 'The minimum order unit');
  await assertQuantityUnit(tx, client, materialNumber, blank(input.orderUnit ?? null)?.toUpperCase() ?? null, 'The order unit');
}

async function judgeMasters(
  tx: Tx,
  input: { client: string; partnerNumber: string; materialNumber: string; purchasingOrg: string; plant?: string | null },
): Promise<{ orderCurrency: string }> {
  const partnerNumber = input.partnerNumber.trim();
  const [partner] = await tx.select().from(businessPartner).where(and(
    eq(businessPartner.client, input.client), eq(businessPartner.partnerNumber, partnerNumber),
  ));
  if (!partner) throw new InfoRecordError(`Supplier ${partnerNumber} does not exist.`);
  if (partner.isBlocked) throw new InfoRecordError(`Supplier ${partnerNumber} is blocked.`);
  const plantCode = blank(input.plant);
  let purchasing;
  try {
    purchasing = await requireSupplierPurchasing(tx, input.client, partnerNumber, input.purchasingOrg.trim(), plantCode ?? undefined);
  } catch (error) {
    if (error instanceof SupplierPurchasingError) throw new InfoRecordError(error.message, error.remedy);
    throw error;
  }
  if (!purchasing.orderCurrency) {
    throw new InfoRecordError(
      `Supplier ${partnerNumber} has no order currency for purchasing organisation ${input.purchasingOrg}.`,
    );
  }
  const [mat] = await tx.select().from(material).where(and(
    eq(material.client, input.client), eq(material.materialNumber, input.materialNumber),
  ));
  if (!mat) throw new InfoRecordError(`Material ${input.materialNumber} does not exist.`);
  if (mat.isBlocked) throw new InfoRecordError(`Material ${input.materialNumber} is blocked.`);
  if (mat.markedForDeletion) throw new InfoRecordError(`Material ${input.materialNumber} is marked for deletion.`);
  if (!mat.baseUnit) throw new InfoRecordError(`Material ${input.materialNumber} carries no base unit.`);
  if (plantCode) {
    const [site] = await tx.select().from(plant).where(and(eq(plant.client, input.client), eq(plant.plant, plantCode)));
    const [org] = await tx.select().from(purchasingOrg).where(and(
      eq(purchasingOrg.client, input.client), eq(purchasingOrg.purchasingOrg, input.purchasingOrg.trim()),
    ));
    if (site?.companyCode && org?.companyCode && site.companyCode !== org.companyCode) {
      throw new InfoRecordError(
        `Plant ${plantCode} belongs to company code ${site.companyCode}, not purchasing organisation ${input.purchasingOrg}'s company code ${org.companyCode}.`,
      );
    }
    const [ext] = await tx.select().from(materialPlant).where(and(
      eq(materialPlant.client, input.client),
      eq(materialPlant.materialNumber, input.materialNumber),
      eq(materialPlant.plant, plantCode),
    ));
    if (!ext) {
      throw new InfoRecordError(
        `Material ${input.materialNumber} is not extended to plant ${plantCode}.`,
        'Extend the material to the plant, or omit the plant for an organisation-level record.',
      );
    }
    if (ext.markedForDeletion) {
      throw new InfoRecordError(`Material ${input.materialNumber} is marked for deletion at plant ${plantCode}.`);
    }
    if (ext.procurementType === 'MAKE') {
      throw new InfoRecordError(
        `Material ${input.materialNumber} is procured by production at plant ${plantCode}. A purchasing info record is not created for it.`,
      );
    }
  }
  return { orderCurrency: purchasing.orderCurrency };
}

async function existingGeneral(tx: Tx, client: string, partner: string, materialNumber: string) {
  const [row] = await tx.select().from(purchasingInfoRecord).where(and(
    eq(purchasingInfoRecord.client, client),
    eq(purchasingInfoRecord.partnerNumber, partner),
    eq(purchasingInfoRecord.materialNumber, materialNumber),
    eq(purchasingInfoRecord.category, CATEGORY),
  )).for('update');
  return row ?? null;
}

/** The same judgement as create, and it writes nothing. */
export async function previewPurchasingInfoRecord(input: InfoRecordCreateInput): Promise<{
  infoRecordNumber: string | null;
  existing: boolean;
}> {
  refuseUnimplemented(input);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(input.client, input.partnerNumber.trim(), input.materialNumber)}, 0))`);
    const { orderCurrency } = await judgeMasters(tx, input);
    await assertPrice(tx, input.client, input.materialNumber, input.price, orderCurrency);
    await assertOperational(input, tx, input.client, input.materialNumber);
    const standing = await existingGeneral(tx, input.client, input.partnerNumber.trim(), input.materialNumber);
    const named = blank(input.infoRecordNumber);
    if (standing && !named) {
      throw new InfoRecordError(
        `Info record ${standing.infoRecordNumber} already links supplier ${input.partnerNumber.trim()} to material ${input.materialNumber}.`,
        'Open that record to add a purchasing organisation, or retire it and create another.',
      );
    }
    if (named && (!standing || standing.infoRecordNumber !== named)) {
      throw new InfoRecordError(`Info record ${named} does not exist. The client does not assign the number.`);
    }
    if (standing && input.expectedVersion != null && input.expectedVersion !== standing.version) {
      throw new InfoRecordError(
        `Info record ${standing.infoRecordNumber} stands at version ${standing.version}.`,
        'Reload the record before adding a purchasing organisation.',
      );
    }
    if (standing) {
      const plantCode = blank(input.plant);
      const segments = await tx.select().from(purchasingInfoRecordOrg).where(and(
        eq(purchasingInfoRecordOrg.client, input.client),
        eq(purchasingInfoRecordOrg.infoRecordNumber, standing.infoRecordNumber),
      ));
      if (segments.some((row) => row.purchasingOrg === input.purchasingOrg.trim() && row.plant === plantCode)) {
        throw new InfoRecordError(
          `Info record ${standing.infoRecordNumber} already has a segment for purchasing organisation ${input.purchasingOrg.trim()}${plantCode ? ` and plant ${plantCode}` : ''}.`,
          'Change that segment, or retire it.',
        );
      }
    }
    return { infoRecordNumber: standing?.infoRecordNumber ?? null, existing: standing != null };
  });
}

export async function createPurchasingInfoRecord(input: InfoRecordCreateInput): Promise<{
  infoRecordNumber: string;
  segmentNumber: number;
  priceSequence: number;
  version: number;
}> {
  return withTenant(input.client, (tx) => writePurchasingInfoRecord(tx, input));
}

/** Exported so a test can prove a failure rolls the number back. The public create owns the transaction. */
export async function writePurchasingInfoRecord(tx: Tx, input: InfoRecordCreateInput): Promise<{
  infoRecordNumber: string;
  segmentNumber: number;
  priceSequence: number;
  version: number;
}> {
  refuseUnimplemented(input);
  const partner = input.partnerNumber.trim();
  const materialNumber = input.materialNumber.trim();
  const org = input.purchasingOrg.trim();
  const plantCode = blank(input.plant);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(input.client, partner, materialNumber)}, 0))`);
  const { orderCurrency } = await judgeMasters(tx, input);
  await assertPrice(tx, input.client, materialNumber, input.price, orderCurrency);
  await assertOperational(input, tx, input.client, materialNumber);
  const standing = await existingGeneral(tx, input.client, partner, materialNumber);
  const named = blank(input.infoRecordNumber);

  if (standing && !named) {
    throw new InfoRecordError(
      `Info record ${standing.infoRecordNumber} already links supplier ${partner} to material ${materialNumber}.`,
      'Open that record to add a purchasing organisation, or retire it and create another.',
    );
  }
  if (named && (!standing || standing.infoRecordNumber !== named)) {
    throw new InfoRecordError(`Info record ${named} does not exist. The client does not assign the number.`);
  }
  if (standing && input.expectedVersion !== standing.version) {
    throw new InfoRecordError(
      `Info record ${standing.infoRecordNumber} stands at version ${standing.version}.`,
      'Reload the record before adding a purchasing organisation.',
    );
  }

  let infoRecordNumber = standing?.infoRecordNumber;
  let version = standing?.version ?? 1;
  if (!standing) {
    let drawn;
    try {
      drawn = await allocateNumber(tx, {
        client: input.client, objectCode: INFO_RECORD_OBJECT, companyCode: '*',
        subObject: '*', fiscalYear: 0, allocatedBy: input.changedBy,
      });
    } catch (error) {
      if (error instanceof NumberRangeError) {
        throw new InfoRecordError(
          `No active internal ${INFO_RECORD_OBJECT} number range stands, so no info record number can be drawn.`,
          error.remedy,
        );
      }
      throw error;
    }
    infoRecordNumber = drawn.display;
    await tx.insert(purchasingInfoRecord).values({
      client: input.client,
      infoRecordNumber,
      partnerNumber: partner,
      roleCode: 'SUPPLIER',
      materialNumber,
      category: CATEGORY,
      version: 1,
      createdBy: input.changedBy,
    });
  }

  const number = infoRecordNumber!;
  const segments = await tx.select().from(purchasingInfoRecordOrg).where(and(
    eq(purchasingInfoRecordOrg.client, input.client),
    eq(purchasingInfoRecordOrg.infoRecordNumber, number),
  ));
  if (segments.some((row) => row.purchasingOrg === org && row.plant === plantCode)) {
    throw new InfoRecordError(
      `Info record ${number} already has a segment for purchasing organisation ${org}${plantCode ? ` and plant ${plantCode}` : ''}.`,
      'Change that segment, or retire it.',
    );
  }
  const segmentNumber = segments.reduce((max, row) => Math.max(max, row.segmentNumber), 0) + 1;
  const prices = await tx.select({ priceSequence: purchasingInfoRecordPrice.priceSequence })
    .from(purchasingInfoRecordPrice)
    .where(and(
      eq(purchasingInfoRecordPrice.client, input.client),
      eq(purchasingInfoRecordPrice.infoRecordNumber, number),
    ))
    .orderBy(desc(purchasingInfoRecordPrice.priceSequence))
    .limit(1);
  const priceSequence = (prices[0]?.priceSequence ?? 0) + 1;
  const orderUnit = blank(input.orderUnit)?.toUpperCase() ?? null;
  const minimumUnit = blank(input.minimumOrderUnit)?.toUpperCase() ?? null;
  await tx.insert(purchasingInfoRecordOrg).values({
    client: input.client,
    infoRecordNumber: number,
    segmentNumber,
    purchasingOrg: org,
    plant: plantCode,
    plannedDeliveryDays: input.plannedDeliveryDays ?? null,
    minimumOrderQuantity: input.minimumOrderQuantity == null ? null : input.minimumOrderQuantity.toFixed(3),
    minimumOrderUnit: minimumUnit,
    orderUnit,
    version: 1,
    createdBy: input.changedBy,
  });
  await tx.insert(purchasingInfoRecordPrice).values({
    client: input.client,
    infoRecordNumber: number,
    priceSequence,
    segmentNumber,
    conditionType: CONDITION,
    amount: input.price.amount.toFixed(4),
    currency: input.price.currency.trim().toUpperCase(),
    priceUnit: String(input.price.priceUnit),
    priceUnitOfMeasure: input.price.priceUnitOfMeasure.trim().toUpperCase(),
    validFrom: input.price.validFrom,
    validTo: input.price.validTo,
    createdBy: input.changedBy,
  });
  if (standing) {
    version = standing.version + 1;
    await tx.update(purchasingInfoRecord).set({
      version, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(eq(purchasingInfoRecord.client, input.client), eq(purchasingInfoRecord.infoRecordNumber, number)));
  }
  await recordChange(tx, {
    client: input.client,
    objectClass: OBJECT_CLASS,
    objectKey: number,
    changeType: standing ? 'CHANGE' : 'CREATE',
    changedBy: input.changedBy,
    transactionCode: INFO_RECORD_CAPABILITY,
    after: {
      supplier: partner,
      material: materialNumber,
      purchasingOrg: org,
      plant: plantCode,
      segmentNumber,
      priceSequence,
      amount: input.price.amount.toFixed(4),
      currency: input.price.currency.trim().toUpperCase(),
      validFrom: input.price.validFrom,
      validTo: input.price.validTo,
    },
    securityRelevantFields: ['amount', 'currency'],
  });
  return { infoRecordNumber: number, segmentNumber, priceSequence, version };
}

function assertReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 3 || trimmed.length > 500) {
    throw new InfoRecordError('A change needs a reason of three to five hundred characters.');
  }
  return trimmed;
}

export async function changePurchasingInfoRecord(input: InfoRecordChangeInput): Promise<{
  infoRecordNumber: string;
  version: number;
}> {
  return withTenant(input.client, (tx) => writePurchasingInfoRecordChange(tx, input));
}

/** Exported so a test can prove a failure rolls the change and its audit back. The public change owns the transaction. */
export async function writePurchasingInfoRecordChange(tx: Tx, input: InfoRecordChangeInput): Promise<{
  infoRecordNumber: string;
  version: number;
}> {
  const reason = assertReason(input.reason);
  const plan = await planInfoRecordChange(tx, input);
  if (plan.changes.length === 0) {
    throw new InfoRecordError('Nothing on the info record is changed.', 'Change a value, or reload the record.');
  }
  await applyInfoRecordChange(tx, input.changedBy, reason, plan);
  return { infoRecordNumber: plan.infoRecordNumber, version: plan.nextVersion };
}

/** The same judgement as a change, and it writes nothing. */
export async function previewPurchasingInfoRecordChange(input: InfoRecordChangeInput): Promise<InfoRecordChangePreview> {
  assertReason(input.reason);
  return withTenant(input.client, async (tx) => {
    const plan = await planInfoRecordChange(tx, input);
    return {
      infoRecordNumber: plan.infoRecordNumber,
      version: plan.version,
      segmentNumber: plan.segmentNumber,
      changes: plan.changes,
      closedInterval: plan.close,
    };
  });
}

interface ChangeDelta { field: string; before: string | null; after: string | null }
interface ClosedInterval {
  priceSequence: number;
  validFrom: string;
  previousValidTo: string;
  validTo: string;
}
interface PlannedPrice {
  priceSequence: number;
  amount: string;
  currency: string;
  priceUnit: string;
  priceUnitOfMeasure: string;
  validFrom: string;
  validTo: string;
}
interface ChangePlan {
  client: string;
  infoRecordNumber: string;
  version: number;
  nextVersion: number;
  segmentNumber: number | null;
  changes: ChangeDelta[];
  changeType: 'CHANGE' | 'BLOCK' | 'UNBLOCK';
  generalMarkedForDeletion: boolean;
  segment: {
    segmentNumber: number;
    plannedDeliveryDays: number | null;
    minimumOrderQuantity: string | null;
    minimumOrderUnit: string | null;
    orderUnit: string | null;
    markedForDeletion: boolean;
    version: number;
  } | null;
  close: ClosedInterval | null;
  newPrice: PlannedPrice | null;
  priceMark: { priceSequence: number; markedForDeletion: boolean } | null;
}

function pushDelta(changes: ChangeDelta[], field: string, before: string | null, after: string | null) {
  if (before === after) return;
  changes.push({ field, before, after });
}

function quantityText(value: number | null): string | null {
  return value == null ? null : value.toFixed(3);
}

function quantityStored(value: string | null): string | null {
  if (value == null || value.trim() === '') return null;
  return Number(value).toFixed(3);
}

function textOrNull(value: string | number | null | undefined): string | null {
  return value == null ? null : String(value);
}

async function planInfoRecordChange(tx: Tx, input: InfoRecordChangeInput): Promise<ChangePlan> {
  const [general] = await tx.select().from(purchasingInfoRecord).where(and(
    eq(purchasingInfoRecord.client, input.client),
    eq(purchasingInfoRecord.infoRecordNumber, input.infoRecordNumber),
  )).for('update');
  if (!general) throw new InfoRecordError(`Info record ${input.infoRecordNumber} does not exist.`);
  if (input.expectedVersion !== general.version) {
    throw new InfoRecordError(
      `Info record ${general.infoRecordNumber} stands at version ${general.version}.`,
      'Reload the record before saving.',
    );
  }
  if (blank(input.partnerNumber) && input.partnerNumber!.trim() !== general.partnerNumber) {
    throw new InfoRecordError('The supplier is part of the record and is not changed. Create another record and retire this one.');
  }
  if (blank(input.materialNumber) && input.materialNumber!.trim() !== general.materialNumber) {
    throw new InfoRecordError('The material is part of the record and is not changed. Create another record and retire this one.');
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(input.client, general.partnerNumber, general.materialNumber)}, 0))`);

  if (input.markRecordDeleted && input.reactivateRecord) {
    throw new InfoRecordError('A record is not deactivated and reactivated in the same change.');
  }
  const changes: ChangeDelta[] = [];
  const nextGeneralMark = input.markRecordDeleted ? true : input.reactivateRecord ? false : general.markedForDeletion;
  pushDelta(changes, 'markedForDeletion', String(general.markedForDeletion), String(nextGeneralMark));

  let segmentWrite: ChangePlan['segment'] = null;
  let close: ClosedInterval | null = null;
  let newPrice: PlannedPrice | null = null;
  let priceMark: ChangePlan['priceMark'] = null;

  if (input.segmentNumber != null) {
    const [segment] = await tx.select().from(purchasingInfoRecordOrg).where(and(
      eq(purchasingInfoRecordOrg.client, input.client),
      eq(purchasingInfoRecordOrg.infoRecordNumber, general.infoRecordNumber),
      eq(purchasingInfoRecordOrg.segmentNumber, input.segmentNumber),
    )).for('update');
    if (!segment) {
      throw new InfoRecordError(`Info record ${general.infoRecordNumber} has no segment ${input.segmentNumber}.`);
    }
    if (input.expectedSegmentVersion != null && input.expectedSegmentVersion !== segment.version) {
      throw new InfoRecordError(
        `Segment ${segment.segmentNumber} of info record ${general.infoRecordNumber} stands at version ${segment.version}.`,
        'Reload the record before saving.',
      );
    }
    if (blank(input.purchasingOrg) && input.purchasingOrg!.trim() !== segment.purchasingOrg) {
      throw new InfoRecordError('The purchasing organisation of a segment is not changed. Add another segment and retire this one.');
    }
    if (input.plant !== undefined && blank(input.plant) !== segment.plant) {
      throw new InfoRecordError('The plant of a segment is not changed. Add another segment and retire this one.');
    }
    if (input.markSegmentDeleted && input.reactivateSegment) {
      throw new InfoRecordError('A segment is not deactivated and reactivated in the same change.');
    }
    const nextLead = input.plannedDeliveryDays === undefined ? segment.plannedDeliveryDays : input.plannedDeliveryDays;
    const nextMinimum = input.minimumOrderQuantity === undefined
      ? segment.minimumOrderQuantity
      : quantityText(input.minimumOrderQuantity);
    const nextMinimumUnit = input.minimumOrderUnit === undefined
      ? segment.minimumOrderUnit
      : blank(input.minimumOrderUnit)?.toUpperCase() ?? null;
    const nextOrderUnit = input.orderUnit === undefined ? segment.orderUnit : blank(input.orderUnit)?.toUpperCase() ?? null;
    const nextSegmentMark = input.markSegmentDeleted ? true : input.reactivateSegment ? false : segment.markedForDeletion;
    await assertOperational({
      plannedDeliveryDays: nextLead,
      minimumOrderQuantity: nextMinimum == null ? null : Number(nextMinimum),
      minimumOrderUnit: nextMinimumUnit,
    }, tx, input.client, general.materialNumber);
    if (input.orderUnit !== undefined) {
      await assertQuantityUnit(tx, input.client, general.materialNumber, nextOrderUnit, 'The order unit');
    }
    pushDelta(changes, 'plannedDeliveryDays', textOrNull(segment.plannedDeliveryDays), textOrNull(nextLead));
    const standingMinimum = quantityStored(segment.minimumOrderQuantity);
    const proposedMinimum = quantityStored(nextMinimum);
    if (standingMinimum !== proposedMinimum) {
      changes.push({ field: 'minimumOrderQuantity', before: standingMinimum, after: proposedMinimum });
    }
    pushDelta(changes, 'minimumOrderUnit', segment.minimumOrderUnit, nextMinimumUnit);
    pushDelta(changes, 'orderUnit', segment.orderUnit, nextOrderUnit);
    pushDelta(changes, 'segmentMarkedForDeletion', String(segment.markedForDeletion), String(nextSegmentMark));

    if (input.newPrice) {
      const { orderCurrency } = await judgeMasters(tx, {
        client: input.client,
        partnerNumber: general.partnerNumber,
        materialNumber: general.materialNumber,
        purchasingOrg: segment.purchasingOrg,
        plant: segment.plant,
      });
      await assertPrice(tx, input.client, general.materialNumber, input.newPrice, orderCurrency);
      const priced = await planPrice(tx, input.client, general.infoRecordNumber, segment.segmentNumber, input.newPrice);
      close = priced.close;
      newPrice = priced.insert;
      if (close) {
        pushDelta(changes, 'closedPriceSequence', null, String(close.priceSequence));
        pushDelta(changes, 'closedValidTo', close.previousValidTo, close.validTo);
      }
      pushDelta(changes, 'priceSequence', null, String(newPrice.priceSequence));
      pushDelta(changes, 'amount', null, newPrice.amount);
      pushDelta(changes, 'currency', null, newPrice.currency);
      pushDelta(changes, 'priceUnit', null, newPrice.priceUnit);
      pushDelta(changes, 'priceUnitOfMeasure', null, newPrice.priceUnitOfMeasure);
      pushDelta(changes, 'validFrom', null, newPrice.validFrom);
      pushDelta(changes, 'validTo', null, newPrice.validTo);
    }
    if (input.markPriceDeleted != null || input.reactivatePrice != null) {
      const sequence = input.markPriceDeleted ?? input.reactivatePrice!;
      const [price] = await tx.select().from(purchasingInfoRecordPrice).where(and(
        eq(purchasingInfoRecordPrice.client, input.client),
        eq(purchasingInfoRecordPrice.infoRecordNumber, general.infoRecordNumber),
        eq(purchasingInfoRecordPrice.priceSequence, sequence),
      ));
      if (!price || price.segmentNumber !== segment.segmentNumber) {
        throw new InfoRecordError(`Price ${sequence} does not belong to segment ${segment.segmentNumber}.`);
      }
      const deleting = input.markPriceDeleted != null;
      if (String(price.markedForDeletion) !== String(deleting)) {
        priceMark = { priceSequence: sequence, markedForDeletion: deleting };
        pushDelta(changes, 'priceMarkedForDeletion', String(price.markedForDeletion), String(deleting));
      }
    }
    if (changes.some((row) => row.field !== 'markedForDeletion')) {
      segmentWrite = {
        segmentNumber: segment.segmentNumber,
        plannedDeliveryDays: nextLead,
        minimumOrderQuantity: nextMinimum,
        minimumOrderUnit: nextMinimumUnit,
        orderUnit: nextOrderUnit,
        markedForDeletion: nextSegmentMark,
        version: segment.version + 1,
      };
    }
  } else if (input.newPrice || input.markSegmentDeleted || input.reactivateSegment || input.markPriceDeleted != null || input.reactivatePrice != null) {
    throw new InfoRecordError('Name the segment the change applies to.');
  }

  const blocked = changes.some((row) => (
    row.field === 'markedForDeletion' || row.field === 'segmentMarkedForDeletion' || row.field === 'priceMarkedForDeletion'
  ) && row.after === 'true');
  const unblocked = changes.some((row) => (
    row.field === 'markedForDeletion' || row.field === 'segmentMarkedForDeletion' || row.field === 'priceMarkedForDeletion'
  ) && row.before === 'true' && row.after === 'false');

  return {
    client: input.client,
    infoRecordNumber: general.infoRecordNumber,
    version: general.version,
    nextVersion: general.version + 1,
    segmentNumber: input.segmentNumber ?? null,
    changes,
    changeType: blocked && !unblocked ? 'BLOCK' : unblocked && !blocked ? 'UNBLOCK' : 'CHANGE',
    generalMarkedForDeletion: nextGeneralMark,
    segment: segmentWrite,
    close,
    newPrice,
    priceMark,
  };
}

async function planPrice(
  tx: Tx,
  client: string,
  infoRecordNumber: string,
  segmentNumber: number,
  price: InfoRecordPriceInput,
): Promise<{ close: ClosedInterval | null; insert: PlannedPrice }> {
  const onRecord = await tx.select().from(purchasingInfoRecordPrice).where(and(
    eq(purchasingInfoRecordPrice.client, client),
    eq(purchasingInfoRecordPrice.infoRecordNumber, infoRecordNumber),
  )).for('update');
  const existing = onRecord.filter((row) => row.segmentNumber === segmentNumber && row.conditionType === CONDITION);
  if (existing.some((row) => row.validFrom === price.validFrom)) {
    throw new InfoRecordError(
      `A price of info record ${infoRecordNumber} already starts on ${price.validFrom}.`,
      'Choose another start. A written price is not overwritten.',
    );
  }
  const active = existing.filter((row) => !row.markedForDeletion);
  const overlapping = active.filter((row) => row.validFrom <= price.validTo && row.validTo >= price.validFrom);
  let close: ClosedInterval | null = null;
  if (overlapping.length === 1 && overlapping[0].validFrom < price.validFrom) {
    const closedTo = addDays(price.validFrom, -1);
    if (closedTo < overlapping[0].validFrom) {
      throw new InfoRecordError(
        `The price starting ${overlapping[0].validFrom} cannot be closed before the new price starts.`,
      );
    }
    close = {
      priceSequence: overlapping[0].priceSequence,
      validFrom: overlapping[0].validFrom,
      previousValidTo: overlapping[0].validTo,
      validTo: closedTo,
    };
  } else if (overlapping.length > 0) {
    throw new InfoRecordError(
      `The new price overlaps ${overlapping.map((row) => `${row.validFrom} to ${row.validTo}`).join(' and ')}. A price amount is not rewritten.`,
      'Close the other intervals first, or choose dates that meet only the open interval.',
    );
  }
  const sequence = onRecord.reduce((max, row) => Math.max(max, row.priceSequence), 0) + 1;
  return {
    close,
    insert: {
      priceSequence: sequence,
      amount: price.amount.toFixed(4),
      currency: price.currency.trim().toUpperCase(),
      priceUnit: String(price.priceUnit),
      priceUnitOfMeasure: price.priceUnitOfMeasure.trim().toUpperCase(),
      validFrom: price.validFrom,
      validTo: price.validTo,
    },
  };
}

async function applyInfoRecordChange(tx: Tx, changedBy: string, reason: string, plan: ChangePlan): Promise<void> {
  const now = new Date();
  if (plan.segment) {
    await tx.update(purchasingInfoRecordOrg).set({
      plannedDeliveryDays: plan.segment.plannedDeliveryDays,
      minimumOrderQuantity: plan.segment.minimumOrderQuantity,
      minimumOrderUnit: plan.segment.minimumOrderUnit,
      orderUnit: plan.segment.orderUnit,
      markedForDeletion: plan.segment.markedForDeletion,
      version: plan.segment.version,
      changedBy,
      changedAt: now,
    }).where(and(
      eq(purchasingInfoRecordOrg.client, plan.client),
      eq(purchasingInfoRecordOrg.infoRecordNumber, plan.infoRecordNumber),
      eq(purchasingInfoRecordOrg.segmentNumber, plan.segment.segmentNumber),
    ));
  }
  if (plan.close) {
    await tx.update(purchasingInfoRecordPrice).set({
      validTo: plan.close.validTo, changedBy, changedAt: now,
    }).where(and(
      eq(purchasingInfoRecordPrice.client, plan.client),
      eq(purchasingInfoRecordPrice.infoRecordNumber, plan.infoRecordNumber),
      eq(purchasingInfoRecordPrice.priceSequence, plan.close.priceSequence),
    ));
  }
  if (plan.newPrice && plan.segment) {
    await tx.insert(purchasingInfoRecordPrice).values({
      client: plan.client,
      infoRecordNumber: plan.infoRecordNumber,
      priceSequence: plan.newPrice.priceSequence,
      segmentNumber: plan.segment.segmentNumber,
      conditionType: CONDITION,
      amount: plan.newPrice.amount,
      currency: plan.newPrice.currency,
      priceUnit: plan.newPrice.priceUnit,
      priceUnitOfMeasure: plan.newPrice.priceUnitOfMeasure,
      validFrom: plan.newPrice.validFrom,
      validTo: plan.newPrice.validTo,
      createdBy: changedBy,
    });
  }
  if (plan.priceMark) {
    await tx.update(purchasingInfoRecordPrice).set({
      markedForDeletion: plan.priceMark.markedForDeletion, changedBy, changedAt: now,
    }).where(and(
      eq(purchasingInfoRecordPrice.client, plan.client),
      eq(purchasingInfoRecordPrice.infoRecordNumber, plan.infoRecordNumber),
      eq(purchasingInfoRecordPrice.priceSequence, plan.priceMark.priceSequence),
    ));
  }
  await tx.update(purchasingInfoRecord).set({
    version: plan.nextVersion,
    markedForDeletion: plan.generalMarkedForDeletion,
    changedBy,
    changedAt: now,
  }).where(and(
    eq(purchasingInfoRecord.client, plan.client),
    eq(purchasingInfoRecord.infoRecordNumber, plan.infoRecordNumber),
  ));
  const before: Record<string, unknown> = { version: plan.version };
  const after: Record<string, unknown> = { version: plan.nextVersion };
  for (const change of plan.changes) {
    before[change.field] = change.before;
    after[change.field] = change.after;
  }
  await recordChange(tx, {
    client: plan.client,
    objectClass: OBJECT_CLASS,
    objectKey: plan.infoRecordNumber,
    changeType: plan.changeType,
    changedBy,
    transactionCode: INFO_RECORD_CAPABILITY,
    reason,
    before,
    after,
    securityRelevantFields: ['amount', 'currency'],
  });
}

/**
 * Reads a default for an order. It does not open a transaction and it does not write.
 * A plant segment, when one exists, is the only candidate. An inactive plant segment
 * does not fall through to the organisation price.
 */
export async function resolvePurchasingInfoRecord(
  tx: Tx,
  input: {
    client: string;
    partnerNumber: string;
    materialNumber: string;
    purchasingOrg: string;
    plant: string;
    pricingDate: string;
    orderCurrency: string;
  },
): Promise<InfoRecordResolution> {
  const [general] = await tx.select().from(purchasingInfoRecord).where(and(
    eq(purchasingInfoRecord.client, input.client),
    eq(purchasingInfoRecord.partnerNumber, input.partnerNumber),
    eq(purchasingInfoRecord.materialNumber, input.materialNumber),
    eq(purchasingInfoRecord.category, CATEGORY),
  ));
  if (!general) return { qualified: false };
  if (general.markedForDeletion) {
    return { qualified: false, warning: `Info record ${general.infoRecordNumber} is inactive.` };
  }
  const [ext] = await tx.select().from(materialPlant).where(and(
    eq(materialPlant.client, input.client),
    eq(materialPlant.materialNumber, input.materialNumber),
    eq(materialPlant.plant, input.plant),
  ));
  if (ext?.procurementType === 'MAKE') {
    return {
      qualified: false,
      warning: `Material ${input.materialNumber} is procured by production at plant ${input.plant}, so the info record is not applied.`,
    };
  }
  const segments = await tx.select().from(purchasingInfoRecordOrg).where(and(
    eq(purchasingInfoRecordOrg.client, input.client),
    eq(purchasingInfoRecordOrg.infoRecordNumber, general.infoRecordNumber),
    eq(purchasingInfoRecordOrg.purchasingOrg, input.purchasingOrg),
  ));
  const plantSegment = segments.find((row) => row.plant === input.plant);
  const orgSegment = segments.find((row) => row.plant == null);
  let chosen = plantSegment ?? null;
  if (plantSegment?.markedForDeletion) {
    return {
      qualified: false,
      warning: `The plant segment of info record ${general.infoRecordNumber} for plant ${input.plant} is inactive, and the organisation price is not used in its place.`,
    };
  }
  if (!plantSegment) {
    if (!orgSegment || orgSegment.markedForDeletion) {
      return orgSegment
        ? { qualified: false, warning: `Info record ${general.infoRecordNumber} is inactive for purchasing organisation ${input.purchasingOrg}.` }
        : { qualified: false };
    }
    chosen = orgSegment;
  }
  if (!chosen) return { qualified: false };
  const prices = await tx.select().from(purchasingInfoRecordPrice).where(and(
    eq(purchasingInfoRecordPrice.client, input.client),
    eq(purchasingInfoRecordPrice.infoRecordNumber, general.infoRecordNumber),
    eq(purchasingInfoRecordPrice.segmentNumber, chosen.segmentNumber),
    eq(purchasingInfoRecordPrice.conditionType, CONDITION),
    eq(purchasingInfoRecordPrice.markedForDeletion, false),
  ));
  const applicable = prices.filter((row) => row.validFrom <= input.pricingDate && row.validTo >= input.pricingDate);
  if (applicable.length === 0) {
    return {
      qualified: false,
      warning: `Info record ${general.infoRecordNumber} has no price valid on ${input.pricingDate}.`,
    };
  }
  if (applicable.length > 1) {
    return {
      qualified: false,
      warning: `Info record ${general.infoRecordNumber} has more than one price valid on ${input.pricingDate}.`,
    };
  }
  const price = applicable[0];
  return {
    qualified: true,
    infoRecordNumber: general.infoRecordNumber,
    priceSequence: price.priceSequence,
    amount: price.amount,
    currency: price.currency.trim(),
    priceUnit: Number(price.priceUnit),
    priceUnitOfMeasure: price.priceUnitOfMeasure,
    orderUnit: chosen.orderUnit,
    plannedDeliveryDays: chosen.plannedDeliveryDays,
    minimumOrderQuantity: chosen.minimumOrderQuantity,
    minimumOrderUnit: chosen.minimumOrderUnit,
  };
}

export interface InfoRecordPriceView {
  priceSequence: number;
  amount: string;
  currency: string;
  priceUnit: string;
  priceUnitOfMeasure: string;
  validFrom: string;
  validTo: string;
  markedForDeletion: boolean;
}

export interface InfoRecordSegmentView {
  segmentNumber: number;
  purchasingOrg: string;
  plant: string | null;
  plannedDeliveryDays: number | null;
  minimumOrderQuantity: string | null;
  minimumOrderUnit: string | null;
  orderUnit: string | null;
  markedForDeletion: boolean;
  version: number;
  prices: InfoRecordPriceView[];
}

export interface InfoRecordDocument {
  infoRecordNumber: string;
  partnerNumber: string;
  partnerName: string;
  materialNumber: string;
  materialDescription: string;
  category: string;
  markedForDeletion: boolean;
  version: number;
  segments: InfoRecordSegmentView[];
}

export interface InfoRecordChoiceLists {
  suppliers: Array<{ partnerNumber: string; name: string; purchasingOrg: string; orderCurrency: string | null }>;
  materials: Array<{ materialNumber: string; description: string }>;
  purchasingOrgs: Array<{ purchasingOrg: string; name: string }>;
  plants: Array<{ plant: string; name: string; purchasingOrg: string }>;
  currencies: string[];
  units: string[];
  records: Array<{ infoRecordNumber: string; partnerNumber: string; materialNumber: string; markedForDeletion: boolean }>;
}

/** The standing number for a supplier and material, or none. It writes nothing. */
export async function findPurchasingInfoRecord(
  client: string,
  partnerNumber: string,
  materialNumber: string,
): Promise<string | null> {
  const partner = partnerNumber.trim();
  const materialCode = materialNumber.trim();
  if (!partner || !materialCode) return null;
  return withTenant(client, async (tx) => {
    const [row] = await tx.select({ infoRecordNumber: purchasingInfoRecord.infoRecordNumber })
      .from(purchasingInfoRecord)
      .where(and(
        eq(purchasingInfoRecord.client, client),
        eq(purchasingInfoRecord.partnerNumber, partner),
        eq(purchasingInfoRecord.materialNumber, materialCode),
        eq(purchasingInfoRecord.category, CATEGORY),
      ));
    return row?.infoRecordNumber ?? null;
  });
}

/** The record the screen opens. It writes nothing. */
export async function getPurchasingInfoRecord(client: string, infoRecordNumber: string): Promise<InfoRecordDocument | null> {
  const number = infoRecordNumber.trim();
  if (!number) return null;
  return withTenant(client, async (tx) => {
    const [general] = await tx.select().from(purchasingInfoRecord).where(and(
      eq(purchasingInfoRecord.client, client),
      eq(purchasingInfoRecord.infoRecordNumber, number),
    ));
    if (!general) return null;
    const [partner] = await tx.select({ name: businessPartner.name }).from(businessPartner).where(and(
      eq(businessPartner.client, client), eq(businessPartner.partnerNumber, general.partnerNumber),
    ));
    const [mat] = await tx.select({ description: material.description }).from(material).where(and(
      eq(material.client, client), eq(material.materialNumber, general.materialNumber),
    ));
    const segments = await tx.select().from(purchasingInfoRecordOrg).where(and(
      eq(purchasingInfoRecordOrg.client, client),
      eq(purchasingInfoRecordOrg.infoRecordNumber, number),
    )).orderBy(asc(purchasingInfoRecordOrg.segmentNumber));
    const prices = await tx.select().from(purchasingInfoRecordPrice).where(and(
      eq(purchasingInfoRecordPrice.client, client),
      eq(purchasingInfoRecordPrice.infoRecordNumber, number),
    )).orderBy(asc(purchasingInfoRecordPrice.priceSequence));
    return {
      infoRecordNumber: general.infoRecordNumber,
      partnerNumber: general.partnerNumber,
      partnerName: partner?.name ?? '',
      materialNumber: general.materialNumber,
      materialDescription: mat?.description ?? '',
      category: general.category,
      markedForDeletion: general.markedForDeletion,
      version: general.version,
      segments: segments.map((segment) => ({
        segmentNumber: segment.segmentNumber,
        purchasingOrg: segment.purchasingOrg,
        plant: segment.plant,
        plannedDeliveryDays: segment.plannedDeliveryDays,
        minimumOrderQuantity: segment.minimumOrderQuantity,
        minimumOrderUnit: segment.minimumOrderUnit,
        orderUnit: segment.orderUnit,
        markedForDeletion: segment.markedForDeletion,
        version: segment.version,
        prices: prices.filter((price) => price.segmentNumber === segment.segmentNumber).map((price) => ({
          priceSequence: price.priceSequence,
          amount: price.amount,
          currency: price.currency.trim(),
          priceUnit: price.priceUnit,
          priceUnitOfMeasure: price.priceUnitOfMeasure,
          validFrom: price.validFrom,
          validTo: price.validTo,
          markedForDeletion: price.markedForDeletion,
        })),
      })),
    };
  });
}

/** Lists for the screen. A typed value that is not in the list is still sent, and the service refuses it by name. */
export async function infoRecordChoices(client: string): Promise<InfoRecordChoiceLists> {
  return withTenant(client, async (tx) => {
    const suppliers = await tx.select().from(supplierPurchasing).where(eq(supplierPurchasing.client, client));
    const partners = await tx.select({ partnerNumber: businessPartner.partnerNumber, name: businessPartner.name })
      .from(businessPartner).where(eq(businessPartner.client, client));
    const orgs = await tx.select().from(purchasingOrg).where(eq(purchasingOrg.client, client));
    const assignments = await tx.select().from(purchasingOrgPlant).where(eq(purchasingOrgPlant.client, client));
    const sites = await tx.select().from(plant).where(eq(plant.client, client));
    const materials = await tx.select({ materialNumber: material.materialNumber, description: material.description })
      .from(material).where(eq(material.client, client)).orderBy(asc(material.materialNumber)).limit(200);
    const currencies = await tx.select({ code: currencyTable.code }).from(currencyTable)
      .where(eq(currencyTable.isActive, true)).orderBy(asc(currencyTable.code));
    const units = await tx.select({ code: unitOfMeasure.code }).from(unitOfMeasure).orderBy(asc(unitOfMeasure.code));
    const records = await tx.select({
      infoRecordNumber: purchasingInfoRecord.infoRecordNumber,
      partnerNumber: purchasingInfoRecord.partnerNumber,
      materialNumber: purchasingInfoRecord.materialNumber,
      markedForDeletion: purchasingInfoRecord.markedForDeletion,
    }).from(purchasingInfoRecord).where(eq(purchasingInfoRecord.client, client))
      .orderBy(desc(purchasingInfoRecord.infoRecordNumber)).limit(40);
    return {
      suppliers: suppliers.filter((row) => !row.isBlocked).map((row) => ({
        partnerNumber: row.partnerNumber,
        name: partners.find((partner) => partner.partnerNumber === row.partnerNumber)?.name ?? '',
        purchasingOrg: row.purchasingOrg,
        orderCurrency: row.orderCurrency?.trim() ?? null,
      })),
      materials,
      purchasingOrgs: orgs.filter((row) => row.isActive).map((row) => ({ purchasingOrg: row.purchasingOrg, name: row.name })),
      plants: assignments.map((row) => ({
        plant: row.plant,
        name: sites.find((site) => site.plant === row.plant)?.name ?? '',
        purchasingOrg: row.purchasingOrg,
      })),
      currencies: currencies.map((row) => row.code.trim()),
      units: units.map((row) => row.code),
      records,
    };
  });
}
