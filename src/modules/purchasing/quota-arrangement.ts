/**
 * Purchasing quota arrangement — SCR-154.
 *
 * Who shares a requirement for a material at a plant, by relative weight.
 * Maintaining an arrangement does not create a requisition, an order, a goods
 * movement or a journal. The rating is one function. Allocated quantity is not
 * a field. The order is not called.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber, NumberRangeError } from '../../platform/numbering';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { plant, purchasingOrg, purchasingOrgPlant } from '../foundation/schema';
import { businessPartner, bpRole } from '../foundation/business-partner-schema';
import { supplierPurchasing } from '../foundation/supplier-purchasing-schema';
import { material, materialPlant } from '../inventory/schema';
import {
  purchasingQuotaArrangement,
  purchasingQuotaArrangementItem,
  purchasingSourceList,
  purchasingSourceListEntry,
} from './schema';
import { resolveSourceList, SourceListError } from './source-list';

export const QUOTA_CAPABILITY = 'PROC.QUOTA.MAINTAIN';
export const QUOTA_OBJECT = 'QUOTAARR';
export const QUOTA_ROUTE = '/purchasing/quota-arrangement';
export const RATING_SCALE = 6;
const QUANTITY_SCALE = 3;
const OBJECT_CLASS = 'purchasing_quota_arrangement';

export class QuotaError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'QuotaError';
    this.remedy = remedy;
  }
}

export interface QuotaItemInput {
  itemNumber?: string | null;
  partnerNumber?: string | null;
  purchasingOrg?: string | null;
  quota?: number | null;
  quotaBaseQuantity?: string | number | null;
  markDeleted?: boolean;
  reactivate?: boolean;
  supplyingPlant?: string | null;
  procurementType?: string | null;
  allocatedQuantity?: string | number | null;
  minSplitQuantity?: string | number | null;
  maxLotSize?: string | number | null;
  unit?: string | null;
}

interface RefusedArrangement {
  supplyingPlant?: string | null;
  procurementType?: string | null;
  allocatedQuantity?: string | number | null;
  minSplitQuantity?: string | number | null;
  maxLotSize?: string | number | null;
  unit?: string | null;
  status?: string | null;
  agreementNumber?: string | null;
  price?: number | null;
  ranking?: number | null;
  companyCode?: string | null;
  requestKey?: string | null;
  deleteArrangement?: boolean;
  percentage?: number | null;
}

export interface QuotaCreateInput extends RefusedArrangement {
  client: string;
  changedBy: string;
  materialNumber: string;
  plant: string;
  validFrom: string;
  validTo: string;
  quotaNumber?: string | null;
  items: QuotaItemInput[];
}

export interface QuotaChangeInput extends RefusedArrangement {
  client: string;
  changedBy: string;
  reason: string;
  quotaNumber: string;
  expectedVersion: number;
  materialNumber?: string | null;
  plant?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  markDeleted?: boolean;
  reactivate?: boolean;
  items?: QuotaItemInput[];
}

export interface QuotaRating {
  itemNumber: string;
  partnerNumber: string;
  purchasingOrg: string;
  quota: number;
  baseQuantity: string;
  allocatedQuantity: string;
  rating: string;
  eligible: boolean;
  reason: string | null;
}

export interface QuotaSelection {
  quotaNumber: string | null;
  documentDate: string;
  preferredItemNumber: string | null;
  fixedSourceNumber: string | null;
  fixedSourcePartner: string | null;
  nothingAllocated: boolean;
  message: string;
  ratings: QuotaRating[];
}

export interface StandingItem {
  itemNumber: string;
  partnerNumber: string;
  purchasingOrg: string;
  quota: number;
  quotaBaseQuantity: string;
  markedForDeletion: boolean;
}

interface StandingArrangement {
  quotaNumber: string;
  materialNumber: string;
  plant: string;
  validFrom: string;
  validTo: string;
  markedForDeletion: boolean;
  version: number;
  items: StandingItem[];
}

function blank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function lockKey(client: string, materialNumber: string, plantCode: string): string {
  return `${client}/purchasing_quota_arrangement/${materialNumber}/${plantCode}`;
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new QuotaError(`${label} is not a date.`);
}

function overlaps(from: string, to: string, otherFrom: string, otherTo: string): boolean {
  return from <= otherTo && otherFrom <= to;
}

function quantityText(value: string | number | null | undefined, fallback = '0'): string {
  const raw = value == null || value === '' ? fallback : String(value);
  try {
    return fromScaled(toScaled(raw, QUANTITY_SCALE), QUANTITY_SCALE);
  } catch {
    throw new QuotaError(`Quantity ${raw} is not a decimal at scale ${QUANTITY_SCALE}.`);
  }
}

function assertQuota(value: number | null | undefined): number {
  if (value == null || !Number.isInteger(value) || value <= 0) {
    throw new QuotaError('A quota must be a positive integer. It is a weight, not a percentage.');
  }
  return value;
}

/** (allocated + base) / quota, exact decimal, displayed at scale 6, half-up. */
export function rateQuota(input: { quota: number; baseQuantity: string; allocatedQuantity: string }): string {
  const quota = assertQuota(input.quota);
  const base = toScaled(quantityText(input.baseQuantity), QUANTITY_SCALE);
  const allocated = toScaled(quantityText(input.allocatedQuantity), QUANTITY_SCALE);
  if (base < 0n || allocated < 0n) throw new QuotaError('A quota quantity cannot be negative.');
  const numerator = (allocated + base) * (10n ** BigInt(RATING_SCALE - QUANTITY_SCALE));
  const divisor = BigInt(quota);
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return fromScaled(rounded, RATING_SCALE);
}

function refuseCuts(input: RefusedArrangement, items: QuotaItemInput[] = []): void {
  if (blank(input.supplyingPlant) || items.some((item) => blank(item.supplyingPlant))) {
    throw new QuotaError(
      'An internal supplying plant is not a quota source. There is no stock-transfer procurement source.',
    );
  }
  const types = [input.procurementType, ...items.map((item) => item.procurementType)].filter(Boolean);
  if (types.length > 0) {
    throw new QuotaError('A procurement type of F or E is not stored. An item is an external supplier.');
  }
  if (input.allocatedQuantity != null || items.some((item) => item.allocatedQuantity != null)) {
    throw new QuotaError('Allocated quantity is not a field. Nothing has been allocated.');
  }
  if (input.minSplitQuantity != null || items.some((item) => item.minSplitQuantity != null)) {
    throw new QuotaError('A minimum split quantity is not stored. It belongs to an allocator this ERP does not have.');
  }
  if (input.maxLotSize != null || items.some((item) => item.maxLotSize != null)) {
    throw new QuotaError('A maximum lot size is not stored. The material lot size is not reused.');
  }
  if (blank(input.unit) || items.some((item) => blank(item.unit))) {
    throw new QuotaError('A quota quantity has no unit field. It is the material base unit.');
  }
  if (blank(input.status)) {
    throw new QuotaError('A quota arrangement has no stored status. Expired is a reading of the dates.');
  }
  if (blank(input.agreementNumber)) throw new QuotaError('An agreement is not a quota.');
  if (input.price != null) throw new QuotaError('A quota arrangement does not carry a price.');
  if (input.ranking != null || input.percentage != null) {
    throw new QuotaError('A ranking and a percentage are not stored. The lower rating is preferred.');
  }
  if (blank(input.companyCode)) throw new QuotaError('A quota arrangement has no company code. The plant carries the company.');
  if (blank(input.requestKey)) {
    throw new QuotaError('A quota arrangement has no request key. A retry that still carries the loaded version is a stale refusal.');
  }
  if (input.deleteArrangement) {
    throw new QuotaError('A standing arrangement is not physically deleted. Deactivation marks it.');
  }
}

function assertInterval(validFrom: string, validTo: string): void {
  assertDate(validFrom, 'The validity start');
  assertDate(validTo, 'The validity end');
  if (validTo < validFrom) throw new QuotaError('The validity end is before the start.');
}

function assertReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 3 || trimmed.length > 500) {
    throw new QuotaError('A change needs a reason of three to five hundred characters.');
  }
  return trimmed;
}

function itemNumberOf(value: number): string {
  if (value < 1 || value > 999) throw new QuotaError('An arrangement cannot hold more than 999 items.');
  return String(value).padStart(3, '0');
}

async function judgeMasters(
  tx: Tx,
  client: string,
  materialNumber: string,
  plantCode: string,
  partner: string,
  org: string,
): Promise<void> {
  if (!materialNumber) throw new QuotaError('A material is required.');
  if (!plantCode) throw new QuotaError('A plant is required.');
  if (!partner) throw new QuotaError('A supplier is required.');
  if (!org) throw new QuotaError('A purchasing organisation is required.');
  const [mat] = await tx.select().from(material).where(and(
    eq(material.client, client), eq(material.materialNumber, materialNumber),
  ));
  if (!mat) throw new QuotaError(`Material ${materialNumber} does not exist.`);
  const [site] = await tx.select().from(plant).where(and(eq(plant.client, client), eq(plant.plant, plantCode)));
  if (!site) throw new QuotaError(`Plant ${plantCode} does not exist.`);
  const [extension] = await tx.select().from(materialPlant).where(and(
    eq(materialPlant.client, client),
    eq(materialPlant.materialNumber, materialNumber),
    eq(materialPlant.plant, plantCode),
  ));
  if (!extension) {
    throw new QuotaError(
      `Material ${materialNumber} is not extended to plant ${plantCode}.`,
      'Extend the material to the plant, or choose another plant.',
    );
  }
  if (extension.procurementType === 'MAKE') {
    throw new QuotaError(
      `Material ${materialNumber} is procured only by production at plant ${plantCode}. A quota arrangement is not created.`,
    );
  }
  const [organisation] = await tx.select().from(purchasingOrg).where(and(
    eq(purchasingOrg.client, client), eq(purchasingOrg.purchasingOrg, org),
  ));
  if (!organisation?.isActive) throw new QuotaError(`Purchasing organisation ${org} does not exist or is inactive.`);
  const [assigned] = await tx.select().from(purchasingOrgPlant).where(and(
    eq(purchasingOrgPlant.client, client),
    eq(purchasingOrgPlant.purchasingOrg, org),
    eq(purchasingOrgPlant.plant, plantCode),
  ));
  if (!assigned) throw new QuotaError(`Plant ${plantCode} is not assigned to purchasing organisation ${org}.`);
  const [partnerRow] = await tx.select().from(businessPartner).where(and(
    eq(businessPartner.client, client), eq(businessPartner.partnerNumber, partner),
  ));
  if (!partnerRow) throw new QuotaError(`Supplier ${partner} does not exist.`);
  if (partnerRow.isBlocked) throw new QuotaError(`Supplier ${partner} is blocked.`);
  const [role] = await tx.select().from(bpRole).where(and(
    eq(bpRole.client, client), eq(bpRole.partnerNumber, partner), eq(bpRole.roleCode, 'SUPPLIER'),
  ));
  if (!role?.isActive) throw new QuotaError(`Supplier ${partner} has no supplier role.`);
  const [assignment] = await tx.select().from(supplierPurchasing).where(and(
    eq(supplierPurchasing.client, client),
    eq(supplierPurchasing.partnerNumber, partner),
    eq(supplierPurchasing.purchasingOrg, org),
  ));
  if (!assignment || assignment.purchasingStatus === 'INCOMPLETE') {
    throw new QuotaError(`Supplier ${partner} has no purchasing assignment for organisation ${org}.`);
  }
  if (assignment.isBlocked) throw new QuotaError(`Supplier ${partner} is blocked for purchasing organisation ${org}.`);
}

function assertDistinct(items: StandingItem[]): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    const key = `${item.purchasingOrg}/${item.partnerNumber}`;
    const prior = seen.get(key);
    if (prior) {
      throw new QuotaError(
        `Supplier ${item.partnerNumber} in organisation ${item.purchasingOrg} already stands as item ${prior}.`,
      );
    }
    seen.set(key, item.itemNumber);
  }
}

async function standingArrangements(
  tx: Tx,
  client: string,
  materialNumber: string,
  plantCode: string,
): Promise<Array<Pick<StandingArrangement, 'quotaNumber' | 'validFrom' | 'validTo' | 'markedForDeletion'>>> {
  return tx.select({
    quotaNumber: purchasingQuotaArrangement.quotaNumber,
    validFrom: purchasingQuotaArrangement.validFrom,
    validTo: purchasingQuotaArrangement.validTo,
    markedForDeletion: purchasingQuotaArrangement.markedForDeletion,
  }).from(purchasingQuotaArrangement).where(and(
    eq(purchasingQuotaArrangement.client, client),
    eq(purchasingQuotaArrangement.materialNumber, materialNumber),
    eq(purchasingQuotaArrangement.plant, plantCode),
  )).for('update');
}

function assertNoOverlap(
  rows: Array<Pick<StandingArrangement, 'quotaNumber' | 'validFrom' | 'validTo' | 'markedForDeletion'>>,
  next: { quotaNumber?: string; validFrom: string; validTo: string; markedForDeletion: boolean },
): void {
  if (next.markedForDeletion) return;
  for (const other of rows) {
    if (next.quotaNumber && other.quotaNumber === next.quotaNumber) continue;
    if (other.markedForDeletion) continue;
    if (!overlaps(next.validFrom, next.validTo, other.validFrom, other.validTo)) continue;
    throw new QuotaError(
      `Quota ${other.quotaNumber} already covers ${other.validFrom} to ${other.validTo}. A change does not close it.`,
      'Move the validity so the intervals do not overlap, or deactivate one arrangement.',
    );
  }
}

function snapshot(arrangement: StandingArrangement): Record<string, string | boolean | number> {
  const fields: Record<string, string | boolean | number> = {
    materialNumber: arrangement.materialNumber,
    plant: arrangement.plant,
    validFrom: arrangement.validFrom,
    validTo: arrangement.validTo,
    markedForDeletion: arrangement.markedForDeletion,
  };
  for (const item of arrangement.items) {
    fields[`${item.itemNumber}.partnerNumber`] = item.partnerNumber;
    fields[`${item.itemNumber}.purchasingOrg`] = item.purchasingOrg;
    fields[`${item.itemNumber}.quota`] = item.quota;
    fields[`${item.itemNumber}.quotaBaseQuantity`] = item.quotaBaseQuantity;
    fields[`${item.itemNumber}.markedForDeletion`] = item.markedForDeletion;
  }
  return fields;
}

function diff(
  before: Record<string, string | boolean | number>,
  after: Record<string, string | boolean | number>,
): Array<{ field: string; before: string | null; after: string | null }> {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: Array<{ field: string; before: string | null; after: string | null }> = [];
  for (const field of [...fields].sort()) {
    const left = before[field] == null ? null : String(before[field]);
    const right = after[field] == null ? null : String(after[field]);
    if (left !== right) changes.push({ field, before: left, after: right });
  }
  return changes;
}

async function loadItems(tx: Tx, client: string, quotaNumber: string): Promise<StandingItem[]> {
  const rows = await tx.select().from(purchasingQuotaArrangementItem).where(and(
    eq(purchasingQuotaArrangementItem.client, client),
    eq(purchasingQuotaArrangementItem.quotaNumber, quotaNumber),
  )).orderBy(asc(purchasingQuotaArrangementItem.itemNumber));
  return rows.map((row) => ({
    itemNumber: row.itemNumber,
    partnerNumber: row.partnerNumber,
    purchasingOrg: row.purchasingOrg,
    quota: row.quota,
    quotaBaseQuantity: quantityText(row.quotaBaseQuantity),
    markedForDeletion: row.markedForDeletion,
  }));
}

async function loadArrangement(tx: Tx, client: string, quotaNumber: string): Promise<StandingArrangement> {
  const [row] = await tx.select().from(purchasingQuotaArrangement).where(and(
    eq(purchasingQuotaArrangement.client, client),
    eq(purchasingQuotaArrangement.quotaNumber, quotaNumber.trim()),
  )).for('update');
  if (!row) throw new QuotaError(`Quota ${quotaNumber} does not exist.`);
  return {
    quotaNumber: row.quotaNumber,
    materialNumber: row.materialNumber,
    plant: row.plant,
    validFrom: row.validFrom,
    validTo: row.validTo,
    markedForDeletion: row.markedForDeletion,
    version: row.version,
    items: await loadItems(tx, client, quotaNumber),
  };
}

function planItems(
  current: StandingItem[],
  sent: QuotaItemInput[] | undefined,
  materialNumber: string,
  plantCode: string,
): { items: StandingItem[]; added: StandingItem[] } {
  const items = current.map((item) => ({ ...item }));
  const added: StandingItem[] = [];
  if (!sent) return { items, added };
  let next = items.reduce((max, item) => Math.max(max, Number(item.itemNumber)), 0);
  for (const input of sent) {
    refuseCuts({}, [input]);
    if (input.markDeleted && input.reactivate) {
      throw new QuotaError('An item cannot be deactivated and reactivated in the same change.');
    }
    const named = blank(input.itemNumber);
    if (!named) {
      const partner = blank(input.partnerNumber);
      const org = blank(input.purchasingOrg);
      if (!partner || !org) throw new QuotaError('A new item needs a supplier and a purchasing organisation.');
      const item: StandingItem = {
        itemNumber: itemNumberOf(next + 1),
        partnerNumber: partner,
        purchasingOrg: org,
        quota: assertQuota(input.quota),
        quotaBaseQuantity: quantityText(input.quotaBaseQuantity),
        markedForDeletion: input.markDeleted ?? false,
      };
      if (toScaled(item.quotaBaseQuantity, QUANTITY_SCALE) < 0n) throw new QuotaError('A quota quantity cannot be negative.');
      next += 1;
      items.push(item);
      added.push(item);
      continue;
    }
    const standing = items.find((item) => item.itemNumber === named);
    if (!standing) throw new QuotaError(`Item ${named} does not stand on this arrangement.`);
    const partner = blank(input.partnerNumber);
    const org = blank(input.purchasingOrg);
    if ((partner && partner !== standing.partnerNumber) || (org && org !== standing.purchasingOrg)) {
      throw new QuotaError('Material, plant, supplier and purchasing organisation are not retargeted.');
    }
    if (input.quota != null) standing.quota = assertQuota(input.quota);
    if (input.quotaBaseQuantity != null) {
      standing.quotaBaseQuantity = quantityText(input.quotaBaseQuantity);
      if (toScaled(standing.quotaBaseQuantity, QUANTITY_SCALE) < 0n) throw new QuotaError('A quota quantity cannot be negative.');
    }
    if (input.reactivate) standing.markedForDeletion = false;
    else if (input.markDeleted) standing.markedForDeletion = true;
  }
  void materialNumber;
  void plantCode;
  assertDistinct(items);
  return { items, added };
}

function planChange(input: QuotaChangeInput, current: StandingArrangement): {
  next: StandingArrangement;
  added: StandingItem[];
  changes: Array<{ field: string; before: string | null; after: string | null }>;
} {
  refuseCuts(input, input.items ?? []);
  assertReason(input.reason);
  if (input.markDeleted && input.reactivate) {
    throw new QuotaError('An arrangement cannot be deactivated and reactivated in the same change.');
  }
  const sentMaterial = blank(input.materialNumber);
  const sentPlant = blank(input.plant);
  if ((sentMaterial && sentMaterial !== current.materialNumber) || (sentPlant && sentPlant !== current.plant)) {
    throw new QuotaError('Material, plant, supplier and purchasing organisation are not retargeted.');
  }
  if (input.expectedVersion !== current.version) {
    throw new QuotaError(
      `Quota ${current.quotaNumber} stands at version ${current.version}.`,
      'Reload the arrangement before changing it.',
    );
  }
  const validFrom = input.validFrom ?? current.validFrom;
  const validTo = input.validTo ?? current.validTo;
  assertInterval(validFrom, validTo);
  const marked = input.reactivate ? false : input.markDeleted ? true : current.markedForDeletion;
  const planned = planItems(current.items, input.items, current.materialNumber, current.plant);
  const next: StandingArrangement = {
    ...current,
    validFrom,
    validTo,
    markedForDeletion: marked,
    version: current.version,
    items: planned.items,
  };
  const changes = diff(snapshot(current), snapshot(next));
  if (changes.length === 0) throw new QuotaError('Nothing on the quota arrangement is changed.');
  next.version = current.version + 1;
  return { next, added: planned.added, changes };
}

async function prepareCreate(tx: Tx, input: QuotaCreateInput): Promise<{
  materialNumber: string;
  plant: string;
  validFrom: string;
  validTo: string;
  items: StandingItem[];
}> {
  refuseCuts(input, input.items);
  if (blank(input.quotaNumber)) throw new QuotaError('The client does not assign the quota number.');
  if (input.items.some((item) => blank(item.itemNumber))) {
    throw new QuotaError('The client does not assign the item number.');
  }
  if (input.items.length === 0) throw new QuotaError('An arrangement with no item does not stand.');
  const materialNumber = input.materialNumber.trim();
  const plantCode = input.plant.trim();
  assertInterval(input.validFrom, input.validTo);
  const items: StandingItem[] = [];
  for (const [index, item] of input.items.entries()) {
    const partner = blank(item.partnerNumber);
    const org = blank(item.purchasingOrg);
    if (!partner || !org) throw new QuotaError('A supplier and a purchasing organisation are required.');
    const base = quantityText(item.quotaBaseQuantity);
    if (toScaled(base, QUANTITY_SCALE) < 0n) throw new QuotaError('A quota quantity cannot be negative.');
    await judgeMasters(tx, input.client, materialNumber, plantCode, partner, org);
    items.push({
      itemNumber: itemNumberOf(index + 1),
      partnerNumber: partner,
      purchasingOrg: org,
      quota: assertQuota(item.quota),
      quotaBaseQuantity: base,
      markedForDeletion: false,
    });
  }
  assertDistinct(items);
  return { materialNumber, plant: plantCode, validFrom: input.validFrom, validTo: input.validTo, items };
}

export async function previewQuotaArrangement(input: QuotaCreateInput): Promise<{
  quotaNumber: null;
  materialNumber: string;
  plant: string;
  validFrom: string;
  validTo: string;
  items: StandingItem[];
  ratings: QuotaRating[];
  nothingAllocated: true;
}> {
  return withTenant(input.client, async (tx) => {
    const prepared = await prepareCreate(tx, input);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(input.client, prepared.materialNumber, prepared.plant)}, 0))`);
    assertNoOverlap(
      await standingArrangements(tx, input.client, prepared.materialNumber, prepared.plant),
      { validFrom: prepared.validFrom, validTo: prepared.validTo, markedForDeletion: false },
    );
    return {
      quotaNumber: null,
      ...prepared,
      nothingAllocated: true,
      ratings: prepared.items.map((item) => ({
        itemNumber: item.itemNumber,
        partnerNumber: item.partnerNumber,
        purchasingOrg: item.purchasingOrg,
        quota: item.quota,
        baseQuantity: item.quotaBaseQuantity,
        allocatedQuantity: '0.000',
        rating: rateQuota({ quota: item.quota, baseQuantity: item.quotaBaseQuantity, allocatedQuantity: '0' }),
        eligible: !item.markedForDeletion,
        reason: null,
      })),
    };
  });
}

export async function createQuotaArrangement(input: QuotaCreateInput): Promise<{ quotaNumber: string; version: number }> {
  return withTenant(input.client, (tx) => writeQuotaArrangement(tx, input));
}

export async function writeQuotaArrangement(tx: Tx, input: QuotaCreateInput): Promise<{ quotaNumber: string; version: number }> {
  const prepared = await prepareCreate(tx, input);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(input.client, prepared.materialNumber, prepared.plant)}, 0))`);
  assertNoOverlap(
    await standingArrangements(tx, input.client, prepared.materialNumber, prepared.plant),
    { validFrom: prepared.validFrom, validTo: prepared.validTo, markedForDeletion: false },
  );
  let drawn;
  try {
    drawn = await allocateNumber(tx, {
      client: input.client, objectCode: QUOTA_OBJECT, companyCode: '*',
      subObject: '*', fiscalYear: 0, allocatedBy: input.changedBy,
    });
  } catch (error) {
    if (error instanceof NumberRangeError) {
      throw new QuotaError(
        `No active internal ${QUOTA_OBJECT} number range stands, so no quota number can be drawn.`,
        error.remedy,
      );
    }
    throw error;
  }
  await tx.insert(purchasingQuotaArrangement).values({
    client: input.client,
    quotaNumber: drawn.display,
    materialNumber: prepared.materialNumber,
    plant: prepared.plant,
    validFrom: prepared.validFrom,
    validTo: prepared.validTo,
    createdBy: input.changedBy,
  });
  for (const item of prepared.items) {
    await tx.insert(purchasingQuotaArrangementItem).values({
      client: input.client,
      quotaNumber: drawn.display,
      itemNumber: item.itemNumber,
      partnerNumber: item.partnerNumber,
      purchasingOrg: item.purchasingOrg,
      quota: item.quota,
      quotaBaseQuantity: item.quotaBaseQuantity,
      createdBy: input.changedBy,
    });
  }
  const standing: StandingArrangement = {
    quotaNumber: drawn.display,
    materialNumber: prepared.materialNumber,
    plant: prepared.plant,
    validFrom: prepared.validFrom,
    validTo: prepared.validTo,
    markedForDeletion: false,
    version: 1,
    items: prepared.items,
  };
  await recordChange(tx, {
    client: input.client,
    objectClass: OBJECT_CLASS,
    objectKey: drawn.display,
    changeType: 'CREATE',
    changedBy: input.changedBy,
    transactionCode: QUOTA_CAPABILITY,
    after: snapshot(standing),
  });
  return { quotaNumber: drawn.display, version: 1 };
}

export async function previewQuotaChange(input: QuotaChangeInput): Promise<{
  quotaNumber: string;
  version: number;
  changes: Array<{ field: string; before: string | null; after: string | null }>;
}> {
  return withTenant(input.client, async (tx) => {
    const current = await loadArrangement(tx, input.client, input.quotaNumber.trim());
    const plan = planChange(input, current);
    for (const item of plan.added) {
      await judgeMasters(tx, input.client, current.materialNumber, current.plant, item.partnerNumber, item.purchasingOrg);
    }
    assertNoOverlap(
      await standingArrangements(tx, input.client, current.materialNumber, current.plant),
      plan.next,
    );
    return { quotaNumber: current.quotaNumber, version: plan.next.version, changes: plan.changes };
  });
}

export async function changeQuotaArrangement(input: QuotaChangeInput): Promise<{ quotaNumber: string; version: number }> {
  return withTenant(input.client, (tx) => writeQuotaChange(tx, input));
}

export async function writeQuotaChange(tx: Tx, input: QuotaChangeInput): Promise<{ quotaNumber: string; version: number }> {
  const named = input.quotaNumber.trim();
  const loaded = await loadArrangement(tx, input.client, named);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(input.client, loaded.materialNumber, loaded.plant)}, 0))`);
  const current = await loadArrangement(tx, input.client, named);
  const plan = planChange(input, current);
  for (const item of plan.added) {
    await judgeMasters(tx, input.client, current.materialNumber, current.plant, item.partnerNumber, item.purchasingOrg);
  }
  assertNoOverlap(
    await standingArrangements(tx, input.client, current.materialNumber, current.plant),
    plan.next,
  );
  await tx.update(purchasingQuotaArrangement).set({
    validFrom: plan.next.validFrom,
    validTo: plan.next.validTo,
    markedForDeletion: plan.next.markedForDeletion,
    version: plan.next.version,
    changedBy: input.changedBy,
    changedAt: new Date(),
  }).where(and(
    eq(purchasingQuotaArrangement.client, input.client),
    eq(purchasingQuotaArrangement.quotaNumber, current.quotaNumber),
  ));
  for (const item of plan.next.items) {
    const prior = current.items.find((row) => row.itemNumber === item.itemNumber);
    if (!prior) {
      await tx.insert(purchasingQuotaArrangementItem).values({
        client: input.client,
        quotaNumber: current.quotaNumber,
        itemNumber: item.itemNumber,
        partnerNumber: item.partnerNumber,
        purchasingOrg: item.purchasingOrg,
        quota: item.quota,
        quotaBaseQuantity: item.quotaBaseQuantity,
        markedForDeletion: item.markedForDeletion,
        createdBy: input.changedBy,
      });
      continue;
    }
    if (
      prior.quota === item.quota
      && prior.quotaBaseQuantity === item.quotaBaseQuantity
      && prior.markedForDeletion === item.markedForDeletion
    ) continue;
    await tx.update(purchasingQuotaArrangementItem).set({
      quota: item.quota,
      quotaBaseQuantity: item.quotaBaseQuantity,
      markedForDeletion: item.markedForDeletion,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(purchasingQuotaArrangementItem.client, input.client),
      eq(purchasingQuotaArrangementItem.quotaNumber, current.quotaNumber),
      eq(purchasingQuotaArrangementItem.itemNumber, item.itemNumber),
    ));
  }
  await recordChange(tx, {
    client: input.client,
    objectClass: OBJECT_CLASS,
    objectKey: current.quotaNumber,
    changeType: 'CHANGE',
    changedBy: input.changedBy,
    reason: assertReason(input.reason),
    transactionCode: QUOTA_CAPABILITY,
    before: snapshot(current),
    after: snapshot(plan.next),
  });
  return { quotaNumber: current.quotaNumber, version: plan.next.version };
}

export async function listQuotaArrangements(client: string, materialNumber: string, plantCode: string): Promise<StandingArrangement[]> {
  const materialKey = materialNumber.trim();
  const plantKey = plantCode.trim();
  if (!materialKey || !plantKey) return [];
  return withTenant(client, async (tx) => {
    const headers = await tx.select().from(purchasingQuotaArrangement).where(and(
      eq(purchasingQuotaArrangement.client, client),
      eq(purchasingQuotaArrangement.materialNumber, materialKey),
      eq(purchasingQuotaArrangement.plant, plantKey),
    )).orderBy(asc(purchasingQuotaArrangement.validFrom), asc(purchasingQuotaArrangement.quotaNumber));
    const arrangements: StandingArrangement[] = [];
    for (const row of headers) {
      arrangements.push({
        quotaNumber: row.quotaNumber,
        materialNumber: row.materialNumber,
        plant: row.plant,
        validFrom: row.validFrom,
        validTo: row.validTo,
        markedForDeletion: row.markedForDeletion,
        version: row.version,
        items: await loadItems(tx, client, row.quotaNumber),
      });
    }
    return arrangements;
  });
}

export async function listRecentQuotaArrangements(client: string): Promise<Array<{
  quotaNumber: string;
  materialNumber: string;
  plant: string;
  markedForDeletion: boolean;
}>> {
  return withTenant(client, (tx) => tx.select({
    quotaNumber: purchasingQuotaArrangement.quotaNumber,
    materialNumber: purchasingQuotaArrangement.materialNumber,
    plant: purchasingQuotaArrangement.plant,
    markedForDeletion: purchasingQuotaArrangement.markedForDeletion,
  }).from(purchasingQuotaArrangement).where(eq(purchasingQuotaArrangement.client, client))
    .orderBy(sql`${purchasingQuotaArrangement.quotaNumber} desc`)
    .limit(40));
}

export async function getQuotaArrangement(client: string, quotaNumber: string): Promise<StandingArrangement | null> {
  const named = quotaNumber.trim();
  return withTenant(client, async (tx) => {
    const [row] = await tx.select().from(purchasingQuotaArrangement).where(and(
      eq(purchasingQuotaArrangement.client, client),
      eq(purchasingQuotaArrangement.quotaNumber, named),
    ));
    if (!row) return null;
    return {
      quotaNumber: row.quotaNumber,
      materialNumber: row.materialNumber,
      plant: row.plant,
      validFrom: row.validFrom,
      validTo: row.validTo,
      markedForDeletion: row.markedForDeletion,
      version: row.version,
      items: await loadItems(tx, client, named),
    };
  });
}

export async function previewQuotaSelection(input: {
  client: string;
  materialNumber: string;
  plant: string;
  documentDate: string;
  allocatedByItem?: Record<string, string>;
}): Promise<QuotaSelection> {
  return withTenant(input.client, async (tx) => {
    assertDate(input.documentDate, 'The document date');
    const materialNumber = input.materialNumber.trim();
    const plantCode = input.plant.trim();
    const rows = await tx.select().from(purchasingQuotaArrangement).where(and(
      eq(purchasingQuotaArrangement.client, input.client),
      eq(purchasingQuotaArrangement.materialNumber, materialNumber),
      eq(purchasingQuotaArrangement.plant, plantCode),
      eq(purchasingQuotaArrangement.markedForDeletion, false),
      sql`${purchasingQuotaArrangement.validFrom} <= ${input.documentDate}`,
      sql`${purchasingQuotaArrangement.validTo} >= ${input.documentDate}`,
    )).orderBy(asc(purchasingQuotaArrangement.quotaNumber));
    if (rows.length > 1) {
      throw new QuotaError(
        `Quotas ${rows.map((row) => row.quotaNumber).join(' and ')} both cover ${input.documentDate}. One is not chosen.`,
      );
    }
    if (rows.length === 0) {
      return {
        quotaNumber: null,
        documentDate: input.documentDate,
        preferredItemNumber: null,
        fixedSourceNumber: null,
        fixedSourcePartner: null,
        nothingAllocated: input.allocatedByItem == null,
        message: `No quota arrangement applies for material ${materialNumber} at plant ${plantCode} on ${input.documentDate}.`,
        ratings: [],
      };
    }
    const header = rows[0];
    const items = await loadItems(tx, input.client, header.quotaNumber);
    let fixedSourceNumber: string | null = null;
    let fixedSourcePartner: string | null = null;
    const ratings: QuotaRating[] = [];
    for (const item of items) {
      const allocated = input.allocatedByItem?.[item.itemNumber] ?? '0';
      const rating = rateQuota({ quota: item.quota, baseQuantity: item.quotaBaseQuantity, allocatedQuantity: allocated });
      if (item.markedForDeletion) {
        ratings.push({
          itemNumber: item.itemNumber, partnerNumber: item.partnerNumber, purchasingOrg: item.purchasingOrg,
          quota: item.quota, baseQuantity: item.quotaBaseQuantity, allocatedQuantity: quantityText(allocated),
          rating, eligible: false, reason: 'The item is deactivated.',
        });
        continue;
      }
      const gate = await sourceGate(tx, input.client, materialNumber, plantCode, item.purchasingOrg, item.partnerNumber, input.documentDate);
      if (gate.fixedSourceNumber) {
        fixedSourceNumber = gate.fixedSourceNumber;
        fixedSourcePartner = gate.fixedSourcePartner;
      }
      ratings.push({
        itemNumber: item.itemNumber, partnerNumber: item.partnerNumber, purchasingOrg: item.purchasingOrg,
        quota: item.quota, baseQuantity: item.quotaBaseQuantity, allocatedQuantity: quantityText(allocated),
        rating, eligible: gate.eligible, reason: gate.reason,
      });
    }
    const ranked = ratings.filter((row) => row.eligible).sort((left, right) => {
      const compared = toScaled(left.rating, RATING_SCALE) - toScaled(right.rating, RATING_SCALE);
      if (compared !== 0n) return compared < 0n ? -1 : 1;
      return left.itemNumber < right.itemNumber ? -1 : left.itemNumber > right.itemNumber ? 1 : 0;
    });
    const preferred = ranked[0] ?? null;
    const nothingAllocated = input.allocatedByItem == null;
    const named = fixedSourceNumber
      ? `Fixed source ${fixedSourceNumber} for supplier ${fixedSourcePartner} stands on ${input.documentDate}. The order does not replace the supplier.`
      : preferred
        ? `Item ${preferred.itemNumber} is preferred at rating ${preferred.rating}.`
        : `Quota ${header.quotaNumber} has no eligible source on ${input.documentDate}.`;
    return {
      quotaNumber: header.quotaNumber,
      documentDate: input.documentDate,
      preferredItemNumber: preferred?.itemNumber ?? null,
      fixedSourceNumber,
      fixedSourcePartner,
      nothingAllocated,
      message: nothingAllocated ? `${named} Nothing has been allocated.` : named,
      ratings,
    };
  });
}

async function sourceGate(
  tx: Tx,
  client: string,
  materialNumber: string,
  plantCode: string,
  org: string,
  partner: string,
  documentDate: string,
): Promise<{ eligible: boolean; reason: string | null; fixedSourceNumber: string | null; fixedSourcePartner: string | null }> {
  const [list] = await tx.select({ required: purchasingSourceList.sourceListRequired }).from(purchasingSourceList).where(and(
    eq(purchasingSourceList.client, client),
    eq(purchasingSourceList.materialNumber, materialNumber),
    eq(purchasingSourceList.plant, plantCode),
  ));
  if (!list) return { eligible: true, reason: null, fixedSourceNumber: null, fixedSourcePartner: null };
  const blocked = await tx.select({
    sourceNumber: purchasingSourceListEntry.sourceNumber,
  }).from(purchasingSourceListEntry).where(and(
    eq(purchasingSourceListEntry.client, client),
    eq(purchasingSourceListEntry.materialNumber, materialNumber),
    eq(purchasingSourceListEntry.plant, plantCode),
    eq(purchasingSourceListEntry.purchasingOrg, org),
    eq(purchasingSourceListEntry.partnerNumber, partner),
    eq(purchasingSourceListEntry.blockedSource, true),
    eq(purchasingSourceListEntry.markedForDeletion, false),
    sql`${purchasingSourceListEntry.validFrom} <= ${documentDate}`,
    sql`${purchasingSourceListEntry.validTo} >= ${documentDate}`,
  )).limit(1);
  if (blocked[0]) {
    return {
      eligible: false,
      reason: `Source ${blocked[0].sourceNumber} is blocked.`,
      fixedSourceNumber: null,
      fixedSourcePartner: null,
    };
  }
  if (!list.required) return { eligible: true, reason: null, fixedSourceNumber: null, fixedSourcePartner: null };
  try {
    await resolveSourceList(tx, {
      client, materialNumber, plant: plantCode, purchasingOrg: org, partnerNumber: partner, documentDate,
    });
    return { eligible: true, reason: null, fixedSourceNumber: null, fixedSourcePartner: null };
  } catch (error) {
    if (!(error instanceof SourceListError)) throw error;
    const fixed = error.message.match(/^Fixed source (\S+) for supplier (\S+) /);
    return {
      eligible: false,
      reason: error.message,
      fixedSourceNumber: fixed?.[1] ?? null,
      fixedSourcePartner: fixed?.[2] ?? null,
    };
  }
}
