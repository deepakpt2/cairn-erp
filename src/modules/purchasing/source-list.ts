/**
 * Purchasing source list — SCR-153.
 *
 * Who may supply a material at a plant. It does not create a requisition,
 * an order, a goods movement or a journal. The requirement flag defaults
 * off. Overlap is refused under the lock; another entry is not closed to
 * make room. The order calls the resolver inside its own transaction and
 * stores the source it used. A check writes nothing.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber, NumberRangeError } from '../../platform/numbering';
import { plant, purchasingOrg, purchasingOrgPlant } from '../foundation/schema';
import { businessPartner, bpRole } from '../foundation/business-partner-schema';
import { supplierPurchasing } from '../foundation/supplier-purchasing-schema';
import { material, materialPlant } from '../inventory/schema';
import { purchasingSourceList, purchasingSourceListEntry } from './schema';

export const SOURCE_LIST_CAPABILITY = 'PROC.SOURCE.LIST.MAINTAIN';
export const SOURCE_LIST_OBJECT = 'SOURCELIST';
export const SOURCE_LIST_ROUTE = '/purchasing/source-list';
const OBJECT_CLASS = 'purchasing_source_list';

export class SourceListError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SourceListError';
    this.remedy = remedy;
  }
}

export interface SourceListCreateInput {
  client: string;
  changedBy: string;
  materialNumber: string;
  plant: string;
  partnerNumber: string;
  purchasingOrg: string;
  validFrom: string;
  validTo: string;
  fixedSource?: boolean;
  blockedSource?: boolean;
  mrpRelevant?: boolean;
  /** Explicit. Omitted leaves the flag off, including on the first entry. */
  sourceListRequired?: boolean;
  sourceNumber?: string | null;
  agreementNumber?: string | null;
  agreementItem?: number | null;
  schedulingAgreement?: string | null;
  price?: number | null;
  currency?: string | null;
  quota?: number | null;
  ranking?: number | null;
  companyCode?: string | null;
  infoRecordNumber?: string | null;
  requestKey?: string | null;
  deleteEntry?: boolean;
}

export interface SourceListChangeInput {
  client: string;
  changedBy: string;
  reason: string;
  sourceNumber: string;
  expectedVersion: number;
  expectedListVersion?: number | null;
  materialNumber?: string | null;
  plant?: string | null;
  partnerNumber?: string | null;
  purchasingOrg?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  fixedSource?: boolean;
  blockedSource?: boolean;
  mrpRelevant?: boolean;
  sourceListRequired?: boolean;
  markDeleted?: boolean;
  reactivate?: boolean;
  agreementNumber?: string | null;
  agreementItem?: number | null;
  schedulingAgreement?: string | null;
  price?: number | null;
  quota?: number | null;
  ranking?: number | null;
  companyCode?: string | null;
  infoRecordNumber?: string | null;
  requestKey?: string | null;
  deleteEntry?: boolean;
}

export interface SourceListPreview {
  sourceNumber: null;
  materialNumber: string;
  plant: string;
  partnerNumber: string;
  purchasingOrg: string;
  validFrom: string;
  validTo: string;
  fixedSource: boolean;
  blockedSource: boolean;
  mrpRelevant: boolean;
  sourceListRequired: boolean;
}

export interface SourceListChangePreview {
  sourceNumber: string;
  version: number;
  listVersion: number;
  changes: Array<{ field: string; before: string | null; after: string | null }>;
}

export interface SourceListResolution {
  required: boolean;
  sourceNumber: string | null;
}

interface StandingEntry {
  sourceNumber: string;
  partnerNumber: string;
  purchasingOrg: string;
  validFrom: string;
  validTo: string;
  fixedSource: boolean;
  blockedSource: boolean;
  mrpRelevant: boolean;
  markedForDeletion: boolean;
  version: number;
}

function blank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function lockKey(client: string, materialNumber: string, plantCode: string): string {
  return `${client}/purchasing_source_list/${materialNumber}/${plantCode}`;
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SourceListError(`${label} is not a date.`);
}

function overlaps(from: string, to: string, otherFrom: string, otherTo: string): boolean {
  return from <= otherTo && otherFrom <= to;
}

function refuseCuts(input: {
  agreementNumber?: string | null;
  agreementItem?: number | null;
  schedulingAgreement?: string | null;
  price?: number | null;
  currency?: string | null;
  quota?: number | null;
  ranking?: number | null;
  companyCode?: string | null;
  infoRecordNumber?: string | null;
  requestKey?: string | null;
  deleteEntry?: boolean;
}): void {
  if (blank(input.agreementNumber) || input.agreementItem != null || blank(input.schedulingAgreement)) {
    throw new SourceListError(
      'An agreement is not a source. There is no purchasing agreement in this round.',
    );
  }
  if (input.price != null || blank(input.currency)) {
    throw new SourceListError('A source entry does not carry a price. The info record holds the price.');
  }
  if (input.quota != null) throw new SourceListError('A quota is not stored on the source list.');
  if (input.ranking != null) throw new SourceListError('A source ranking is not stored.');
  if (blank(input.companyCode)) {
    throw new SourceListError('A source list has no company code. The plant carries the company.');
  }
  if (blank(input.infoRecordNumber)) throw new SourceListError('A source does not create an info record.');
  if (blank(input.requestKey)) {
    throw new SourceListError('A source list has no request key. A retry that still carries the loaded version is a stale refusal.');
  }
  if (input.deleteEntry) {
    throw new SourceListError('A standing entry is not physically deleted. Deactivation marks it.');
  }
}

function assertInterval(validFrom: string, validTo: string): void {
  assertDate(validFrom, 'The validity start');
  assertDate(validTo, 'The validity end');
  if (validTo < validFrom) throw new SourceListError('The validity end is before the start.');
}

async function judgeMasters(
  tx: Tx,
  client: string,
  materialNumber: string,
  plantCode: string,
  partner: string,
  org: string,
): Promise<void> {
  if (!materialNumber) throw new SourceListError('A material is required.');
  if (!plantCode) throw new SourceListError('A plant is required.');
  if (!partner) throw new SourceListError('A supplier is required.');
  if (!org) throw new SourceListError('A purchasing organisation is required.');

  const [mat] = await tx.select().from(material).where(and(
    eq(material.client, client), eq(material.materialNumber, materialNumber),
  ));
  if (!mat) throw new SourceListError(`Material ${materialNumber} does not exist.`);
  const [site] = await tx.select().from(plant).where(and(eq(plant.client, client), eq(plant.plant, plantCode)));
  if (!site) throw new SourceListError(`Plant ${plantCode} does not exist.`);
  const [extension] = await tx.select().from(materialPlant).where(and(
    eq(materialPlant.client, client),
    eq(materialPlant.materialNumber, materialNumber),
    eq(materialPlant.plant, plantCode),
  ));
  if (!extension) {
    throw new SourceListError(
      `Material ${materialNumber} is not extended to plant ${plantCode}.`,
      'Extend the material to the plant, or choose another plant.',
    );
  }
  if (extension.procurementType === 'MAKE') {
    throw new SourceListError(
      `Material ${materialNumber} is procured only by production at plant ${plantCode}. A source list is not created.`,
    );
  }
  const [organisation] = await tx.select().from(purchasingOrg).where(and(
    eq(purchasingOrg.client, client), eq(purchasingOrg.purchasingOrg, org),
  ));
  if (!organisation?.isActive) {
    throw new SourceListError(`Purchasing organisation ${org} does not exist or is inactive.`);
  }
  const [assigned] = await tx.select().from(purchasingOrgPlant).where(and(
    eq(purchasingOrgPlant.client, client),
    eq(purchasingOrgPlant.purchasingOrg, org),
    eq(purchasingOrgPlant.plant, plantCode),
  ));
  if (!assigned) {
    throw new SourceListError(`Plant ${plantCode} is not assigned to purchasing organisation ${org}.`);
  }
  const [partnerRow] = await tx.select().from(businessPartner).where(and(
    eq(businessPartner.client, client), eq(businessPartner.partnerNumber, partner),
  ));
  if (!partnerRow) throw new SourceListError(`Supplier ${partner} does not exist.`);
  if (partnerRow.isBlocked) throw new SourceListError(`Supplier ${partner} is blocked.`);
  const [role] = await tx.select().from(bpRole).where(and(
    eq(bpRole.client, client), eq(bpRole.partnerNumber, partner), eq(bpRole.roleCode, 'SUPPLIER'),
  ));
  if (!role?.isActive) throw new SourceListError(`Supplier ${partner} has no supplier role.`);
  const [assignment] = await tx.select().from(supplierPurchasing).where(and(
    eq(supplierPurchasing.client, client),
    eq(supplierPurchasing.partnerNumber, partner),
    eq(supplierPurchasing.purchasingOrg, org),
  ));
  if (!assignment || assignment.purchasingStatus === 'INCOMPLETE') {
    throw new SourceListError(`Supplier ${partner} has no purchasing assignment for organisation ${org}.`);
  }
  if (assignment.isBlocked) {
    throw new SourceListError(`Supplier ${partner} is blocked for purchasing organisation ${org}.`);
  }
}

async function standingEntries(tx: Tx, client: string, materialNumber: string, plantCode: string): Promise<StandingEntry[]> {
  return tx.select({
    sourceNumber: purchasingSourceListEntry.sourceNumber,
    partnerNumber: purchasingSourceListEntry.partnerNumber,
    purchasingOrg: purchasingSourceListEntry.purchasingOrg,
    validFrom: purchasingSourceListEntry.validFrom,
    validTo: purchasingSourceListEntry.validTo,
    fixedSource: purchasingSourceListEntry.fixedSource,
    blockedSource: purchasingSourceListEntry.blockedSource,
    mrpRelevant: purchasingSourceListEntry.mrpRelevant,
    markedForDeletion: purchasingSourceListEntry.markedForDeletion,
    version: purchasingSourceListEntry.version,
  }).from(purchasingSourceListEntry).where(and(
    eq(purchasingSourceListEntry.client, client),
    eq(purchasingSourceListEntry.materialNumber, materialNumber),
    eq(purchasingSourceListEntry.plant, plantCode),
  )).for('update');
}

function assertNoOverlap(
  entries: StandingEntry[],
  next: { sourceNumber?: string; partnerNumber: string; purchasingOrg: string; validFrom: string; validTo: string; fixedSource: boolean },
): void {
  for (const other of entries) {
    if (next.sourceNumber && other.sourceNumber === next.sourceNumber) continue;
    if (!overlaps(next.validFrom, next.validTo, other.validFrom, other.validTo)) continue;
    if (other.partnerNumber === next.partnerNumber && other.purchasingOrg === next.purchasingOrg) {
      throw new SourceListError(
        `Source ${other.sourceNumber} for supplier ${next.partnerNumber} already covers ${other.validFrom} to ${other.validTo}. A change does not close it.`,
        'Move the validity so the intervals do not overlap.',
      );
    }
    if (next.fixedSource && other.fixedSource) {
      throw new SourceListError(
        `Fixed source ${other.sourceNumber} for supplier ${other.partnerNumber} already covers ${other.validFrom} to ${other.validTo}. Two fixed sources may not overlap.`,
      );
    }
  }
}

async function headerOf(tx: Tx, client: string, materialNumber: string, plantCode: string) {
  const [row] = await tx.select().from(purchasingSourceList).where(and(
    eq(purchasingSourceList.client, client),
    eq(purchasingSourceList.materialNumber, materialNumber),
    eq(purchasingSourceList.plant, plantCode),
  )).for('update');
  return row ?? null;
}

function snapshot(entry: {
  partnerNumber: string;
  purchasingOrg: string;
  validFrom: string;
  validTo: string;
  fixedSource: boolean;
  blockedSource: boolean;
  mrpRelevant: boolean;
  markedForDeletion: boolean;
}, sourceListRequired: boolean): Record<string, unknown> {
  return {
    supplier: entry.partnerNumber,
    purchasingOrg: entry.purchasingOrg,
    validFrom: entry.validFrom,
    validTo: entry.validTo,
    fixedSource: entry.fixedSource,
    blockedSource: entry.blockedSource,
    mrpRelevant: entry.mrpRelevant,
    markedForDeletion: entry.markedForDeletion,
    sourceListRequired,
  };
}

/** The same judgement as create, and it writes nothing. */
export async function previewSourceListEntry(input: SourceListCreateInput): Promise<SourceListPreview> {
  refuseCuts(input);
  if (blank(input.sourceNumber)) {
    throw new SourceListError('The client does not assign the source number.');
  }
  const materialNumber = input.materialNumber.trim();
  const plantCode = input.plant.trim();
  const partner = input.partnerNumber.trim();
  const org = input.purchasingOrg.trim();
  assertInterval(input.validFrom, input.validTo);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(input.client, materialNumber, plantCode)}, 0))`);
    await judgeMasters(tx, input.client, materialNumber, plantCode, partner, org);
    const header = await headerOf(tx, input.client, materialNumber, plantCode);
    const required = input.sourceListRequired ?? false;
    if (header && input.sourceListRequired != null && input.sourceListRequired !== header.sourceListRequired) {
      throw new SourceListError(
        'The requirement flag is a change of the list, not of an entry.',
        'Change the list after the entry stands.',
      );
    }
    assertNoOverlap(await standingEntries(tx, input.client, materialNumber, plantCode), {
      partnerNumber: partner,
      purchasingOrg: org,
      validFrom: input.validFrom,
      validTo: input.validTo,
      fixedSource: input.fixedSource ?? false,
    });
    return {
      sourceNumber: null,
      materialNumber,
      plant: plantCode,
      partnerNumber: partner,
      purchasingOrg: org,
      validFrom: input.validFrom,
      validTo: input.validTo,
      fixedSource: input.fixedSource ?? false,
      blockedSource: input.blockedSource ?? false,
      mrpRelevant: input.mrpRelevant ?? false,
      sourceListRequired: header?.sourceListRequired ?? required,
    };
  });
}

export async function createSourceListEntry(input: SourceListCreateInput): Promise<{
  sourceNumber: string;
  version: number;
  sourceListRequired: boolean;
}> {
  return withTenant(input.client, (tx) => writeSourceListEntry(tx, input));
}

export async function writeSourceListEntry(tx: Tx, input: SourceListCreateInput): Promise<{
  sourceNumber: string;
  version: number;
  sourceListRequired: boolean;
}> {
  refuseCuts(input);
  if (blank(input.sourceNumber)) {
    throw new SourceListError('The client does not assign the source number.');
  }
  const materialNumber = input.materialNumber.trim();
  const plantCode = input.plant.trim();
  const partner = input.partnerNumber.trim();
  const org = input.purchasingOrg.trim();
  assertInterval(input.validFrom, input.validTo);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(input.client, materialNumber, plantCode)}, 0))`);
  await judgeMasters(tx, input.client, materialNumber, plantCode, partner, org);
  const header = await headerOf(tx, input.client, materialNumber, plantCode);
  if (header && input.sourceListRequired != null && input.sourceListRequired !== header.sourceListRequired) {
    throw new SourceListError('The requirement flag is a change of the list, not of an entry.');
  }
  const fixedSource = input.fixedSource ?? false;
  assertNoOverlap(await standingEntries(tx, input.client, materialNumber, plantCode), {
    partnerNumber: partner, purchasingOrg: org, validFrom: input.validFrom, validTo: input.validTo, fixedSource,
  });
  const required = header?.sourceListRequired ?? input.sourceListRequired ?? false;
  if (!header) {
    await tx.insert(purchasingSourceList).values({
      client: input.client,
      materialNumber,
      plant: plantCode,
      sourceListRequired: required,
      createdBy: input.changedBy,
    });
  }
  let drawn;
  try {
    drawn = await allocateNumber(tx, {
      client: input.client, objectCode: SOURCE_LIST_OBJECT, companyCode: '*',
      subObject: '*', fiscalYear: 0, allocatedBy: input.changedBy,
    });
  } catch (error) {
    if (error instanceof NumberRangeError) {
      throw new SourceListError(
        `No active internal ${SOURCE_LIST_OBJECT} number range stands, so no source number can be drawn.`,
        error.remedy,
      );
    }
    throw error;
  }
  await tx.insert(purchasingSourceListEntry).values({
    client: input.client,
    sourceNumber: drawn.display,
    materialNumber,
    plant: plantCode,
    partnerNumber: partner,
    purchasingOrg: org,
    validFrom: input.validFrom,
    validTo: input.validTo,
    fixedSource,
    blockedSource: input.blockedSource ?? false,
    mrpRelevant: input.mrpRelevant ?? false,
    createdBy: input.changedBy,
  });
  await recordChange(tx, {
    client: input.client,
    objectClass: OBJECT_CLASS,
    objectKey: drawn.display,
    changeType: 'CREATE',
    changedBy: input.changedBy,
    transactionCode: SOURCE_LIST_CAPABILITY,
    after: snapshot({
      partnerNumber: partner,
      purchasingOrg: org,
      validFrom: input.validFrom,
      validTo: input.validTo,
      fixedSource,
      blockedSource: input.blockedSource ?? false,
      mrpRelevant: input.mrpRelevant ?? false,
      markedForDeletion: false,
    }, required),
  });
  return { sourceNumber: drawn.display, version: 1, sourceListRequired: required };
}

function assertReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 3 || trimmed.length > 500) {
    throw new SourceListError('A change needs a reason of three to five hundred characters.');
  }
  return trimmed;
}

function planChange(
  input: SourceListChangeInput,
  entry: StandingEntry & { materialNumber: string; plant: string },
  listRequired: boolean,
  listVersion: number,
): {
  next: StandingEntry;
  required: boolean;
  nextListVersion: number;
  nextVersion: number;
  changes: Array<{ field: string; before: string | null; after: string | null }>;
} {
  refuseCuts(input);
  assertReason(input.reason);
  if (input.markDeleted && input.reactivate) {
    throw new SourceListError('An entry cannot be deactivated and reactivated in the same change.');
  }
  const sentMaterial = blank(input.materialNumber);
  const sentPlant = blank(input.plant);
  const sentPartner = blank(input.partnerNumber);
  const sentOrg = blank(input.purchasingOrg);
  if (
    (sentMaterial && sentMaterial !== entry.materialNumber)
    || (sentPlant && sentPlant !== entry.plant)
    || (sentPartner && sentPartner !== entry.partnerNumber)
    || (sentOrg && sentOrg !== entry.purchasingOrg)
  ) {
    throw new SourceListError('Material, plant, supplier and purchasing organisation are not retargeted.');
  }
  if (input.expectedVersion !== entry.version) {
    throw new SourceListError(
      `Source ${entry.sourceNumber} stands at version ${entry.version}.`,
      'Reload the entry before changing it.',
    );
  }
  if (input.sourceListRequired != null && input.expectedListVersion == null) {
    throw new SourceListError('The source list version is required to change the requirement flag.');
  }
  if (input.sourceListRequired != null && input.expectedListVersion !== listVersion) {
    throw new SourceListError(
      `Source list for material ${entry.materialNumber} at plant ${entry.plant} stands at version ${listVersion}.`,
      'Reload the list before changing the requirement flag.',
    );
  }
  const validFrom = input.validFrom ?? entry.validFrom;
  const validTo = input.validTo ?? entry.validTo;
  assertInterval(validFrom, validTo);
  const marked = input.reactivate ? false : input.markDeleted ? true : entry.markedForDeletion;
  const next: StandingEntry = {
    ...entry,
    validFrom,
    validTo,
    fixedSource: input.fixedSource ?? entry.fixedSource,
    blockedSource: input.blockedSource ?? entry.blockedSource,
    mrpRelevant: input.mrpRelevant ?? entry.mrpRelevant,
    markedForDeletion: marked,
  };
  const required = input.sourceListRequired ?? listRequired;
  const changes: Array<{ field: string; before: string | null; after: string | null }> = [];
  const compare: Array<[string, string, string]> = [
    ['validFrom', entry.validFrom, next.validFrom],
    ['validTo', entry.validTo, next.validTo],
    ['fixedSource', String(entry.fixedSource), String(next.fixedSource)],
    ['blockedSource', String(entry.blockedSource), String(next.blockedSource)],
    ['mrpRelevant', String(entry.mrpRelevant), String(next.mrpRelevant)],
    ['markedForDeletion', String(entry.markedForDeletion), String(next.markedForDeletion)],
    ['sourceListRequired', String(listRequired), String(required)],
  ];
  for (const [field, before, after] of compare) {
    if (before !== after) changes.push({ field, before, after });
  }
  if (changes.length === 0) {
    throw new SourceListError('Nothing on the source list is changed.');
  }
  return {
    next,
    required,
    nextListVersion: required === listRequired ? listVersion : listVersion + 1,
    nextVersion: changes.some((row) => row.field !== 'sourceListRequired') ? entry.version + 1 : entry.version,
    changes,
  };
}

export async function previewSourceListChange(input: SourceListChangeInput): Promise<SourceListChangePreview> {
  return withTenant(input.client, async (tx) => {
    const entry = await loadEntry(tx, input.client, input.sourceNumber.trim());
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(input.client, entry.materialNumber, entry.plant)}, 0))`);
    const current = await loadEntry(tx, input.client, entry.sourceNumber);
    const header = await headerOf(tx, input.client, current.materialNumber, current.plant);
    if (!header) throw new SourceListError(`Source list for ${current.sourceNumber} does not exist.`);
    const plan = planChange(input, current, header.sourceListRequired, header.version);
    assertNoOverlap(await standingEntries(tx, input.client, current.materialNumber, current.plant), {
      sourceNumber: current.sourceNumber,
      partnerNumber: current.partnerNumber,
      purchasingOrg: current.purchasingOrg,
      validFrom: plan.next.validFrom,
      validTo: plan.next.validTo,
      fixedSource: plan.next.fixedSource,
    });
    return {
      sourceNumber: current.sourceNumber,
      version: plan.nextVersion,
      listVersion: plan.nextListVersion,
      changes: plan.changes,
    };
  });
}

async function loadEntry(tx: Tx, client: string, sourceNumber: string): Promise<StandingEntry & { materialNumber: string; plant: string }> {
  const [row] = await tx.select().from(purchasingSourceListEntry).where(and(
    eq(purchasingSourceListEntry.client, client),
    eq(purchasingSourceListEntry.sourceNumber, sourceNumber),
  )).for('update');
  if (!row) throw new SourceListError(`Source ${sourceNumber} does not exist.`);
  return {
    sourceNumber: row.sourceNumber,
    materialNumber: row.materialNumber,
    plant: row.plant,
    partnerNumber: row.partnerNumber,
    purchasingOrg: row.purchasingOrg,
    validFrom: row.validFrom,
    validTo: row.validTo,
    fixedSource: row.fixedSource,
    blockedSource: row.blockedSource,
    mrpRelevant: row.mrpRelevant,
    markedForDeletion: row.markedForDeletion,
    version: row.version,
  };
}

export async function changeSourceListEntry(input: SourceListChangeInput): Promise<{
  sourceNumber: string;
  version: number;
  listVersion: number;
}> {
  return withTenant(input.client, (tx) => writeSourceListChange(tx, input));
}

export async function writeSourceListChange(tx: Tx, input: SourceListChangeInput): Promise<{
  sourceNumber: string;
  version: number;
  listVersion: number;
}> {
  const named = input.sourceNumber.trim();
  const loaded = await loadEntry(tx, input.client, named);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(input.client, loaded.materialNumber, loaded.plant)}, 0))`);
  const entry = await loadEntry(tx, input.client, named);
  const header = await headerOf(tx, input.client, entry.materialNumber, entry.plant);
  if (!header) throw new SourceListError(`Source list for ${named} does not exist.`);
  const plan = planChange(input, entry, header.sourceListRequired, header.version);
  assertNoOverlap(await standingEntries(tx, input.client, entry.materialNumber, entry.plant), {
    sourceNumber: entry.sourceNumber,
    partnerNumber: entry.partnerNumber,
    purchasingOrg: entry.purchasingOrg,
    validFrom: plan.next.validFrom,
    validTo: plan.next.validTo,
    fixedSource: plan.next.fixedSource,
  });
  if (plan.nextVersion !== entry.version) {
    await tx.update(purchasingSourceListEntry).set({
      validFrom: plan.next.validFrom,
      validTo: plan.next.validTo,
      fixedSource: plan.next.fixedSource,
      blockedSource: plan.next.blockedSource,
      mrpRelevant: plan.next.mrpRelevant,
      markedForDeletion: plan.next.markedForDeletion,
      version: plan.nextVersion,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(purchasingSourceListEntry.client, input.client),
      eq(purchasingSourceListEntry.sourceNumber, entry.sourceNumber),
    ));
  }
  if (plan.nextListVersion !== header.version) {
    await tx.update(purchasingSourceList).set({
      sourceListRequired: plan.required,
      version: plan.nextListVersion,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(purchasingSourceList.client, input.client),
      eq(purchasingSourceList.materialNumber, entry.materialNumber),
      eq(purchasingSourceList.plant, entry.plant),
    ));
  }
  await recordChange(tx, {
    client: input.client,
    objectClass: OBJECT_CLASS,
    objectKey: entry.sourceNumber,
    changeType: 'CHANGE',
    changedBy: input.changedBy,
    reason: assertReason(input.reason),
    transactionCode: SOURCE_LIST_CAPABILITY,
    before: snapshot(entry, header.sourceListRequired),
    after: snapshot(plan.next, plan.required),
  });
  return { sourceNumber: entry.sourceNumber, version: plan.nextVersion, listVersion: plan.nextListVersion };
}

/**
 * What the order may use on the document date. A required list refuses here.
 * A list that does not require a source does not block. The caller stores the
 * source number and does not replace the supplier.
 */
export async function resolveSourceList(tx: Tx, input: {
  client: string;
  materialNumber: string;
  plant: string;
  purchasingOrg: string;
  partnerNumber: string;
  documentDate: string;
}): Promise<SourceListResolution> {
  const materialNumber = input.materialNumber.trim();
  const plantCode = input.plant.trim();
  const org = input.purchasingOrg.trim();
  const partner = input.partnerNumber.trim();
  const [header] = await tx.select({
    required: purchasingSourceList.sourceListRequired,
  }).from(purchasingSourceList).where(and(
    eq(purchasingSourceList.client, input.client),
    eq(purchasingSourceList.materialNumber, materialNumber),
    eq(purchasingSourceList.plant, plantCode),
  ));
  if (!header) return { required: false, sourceNumber: null };
  const rows = await tx.select({
    sourceNumber: purchasingSourceListEntry.sourceNumber,
    partnerNumber: purchasingSourceListEntry.partnerNumber,
    fixedSource: purchasingSourceListEntry.fixedSource,
  }).from(purchasingSourceListEntry).where(and(
    eq(purchasingSourceListEntry.client, input.client),
    eq(purchasingSourceListEntry.materialNumber, materialNumber),
    eq(purchasingSourceListEntry.plant, plantCode),
    eq(purchasingSourceListEntry.purchasingOrg, org),
    eq(purchasingSourceListEntry.markedForDeletion, false),
    eq(purchasingSourceListEntry.blockedSource, false),
    sql`${purchasingSourceListEntry.validFrom} <= ${input.documentDate}`,
    sql`${purchasingSourceListEntry.validTo} >= ${input.documentDate}`,
  )).orderBy(asc(purchasingSourceListEntry.sourceNumber));
  const named = rows.filter((row) => row.partnerNumber === partner);
  const fixedOther = rows.filter((row) => row.fixedSource && row.partnerNumber !== partner);
  if (header.required && fixedOther.length > 0) {
    const fixed = fixedOther[0];
    throw new SourceListError(
      `Fixed source ${fixed.sourceNumber} for supplier ${fixed.partnerNumber} stands on ${input.documentDate}. The order does not replace the supplier.`,
      'Order from that supplier, or choose a date when that fixed source does not stand.',
    );
  }
  if (named.length > 1) {
    throw new SourceListError(
      `Supplier ${partner} has more than one eligible source on ${input.documentDate}.`,
    );
  }
  if (header.required && named.length === 0) {
    throw new SourceListError(
      `Source list for material ${materialNumber} at plant ${plantCode} requires a source, and supplier ${partner} has no eligible entry on ${input.documentDate}.`,
    );
  }
  return { required: header.required, sourceNumber: named[0]?.sourceNumber ?? null };
}

export async function getSourceListEntry(client: string, sourceNumber: string): Promise<{
  sourceNumber: string;
  materialNumber: string;
  plant: string;
  partnerNumber: string;
  purchasingOrg: string;
  validFrom: string;
  validTo: string;
  fixedSource: boolean;
  blockedSource: boolean;
  mrpRelevant: boolean;
  markedForDeletion: boolean;
  version: number;
  sourceListRequired: boolean;
  listVersion: number;
} | null> {
  return withTenant(client, async (tx) => {
    const [entry] = await tx.select().from(purchasingSourceListEntry).where(and(
      eq(purchasingSourceListEntry.client, client),
      eq(purchasingSourceListEntry.sourceNumber, sourceNumber.trim()),
    ));
    if (!entry) return null;
    const header = await headerOf(tx, client, entry.materialNumber, entry.plant);
    return {
      sourceNumber: entry.sourceNumber,
      materialNumber: entry.materialNumber,
      plant: entry.plant,
      partnerNumber: entry.partnerNumber,
      purchasingOrg: entry.purchasingOrg,
      validFrom: entry.validFrom,
      validTo: entry.validTo,
      fixedSource: entry.fixedSource,
      blockedSource: entry.blockedSource,
      mrpRelevant: entry.mrpRelevant,
      markedForDeletion: entry.markedForDeletion,
      version: entry.version,
      sourceListRequired: header?.sourceListRequired ?? false,
      listVersion: header?.version ?? 1,
    };
  });
}

export interface SourceListDocument {
  materialNumber: string;
  plant: string;
  sourceListRequired: boolean;
  version: number;
  entries: Array<{
    sourceNumber: string;
    partnerNumber: string;
    purchasingOrg: string;
    validFrom: string;
    validTo: string;
    fixedSource: boolean;
    blockedSource: boolean;
    mrpRelevant: boolean;
    markedForDeletion: boolean;
    version: number;
  }>;
}

export async function getSourceList(client: string, materialNumber: string, plantCode: string): Promise<SourceListDocument | null> {
  const materialKey = materialNumber.trim();
  const plantKey = plantCode.trim();
  if (!materialKey || !plantKey) return null;
  return withTenant(client, async (tx) => {
    const header = await headerOf(tx, client, materialKey, plantKey);
    if (!header) return null;
    const entries = await tx.select({
      sourceNumber: purchasingSourceListEntry.sourceNumber,
      partnerNumber: purchasingSourceListEntry.partnerNumber,
      purchasingOrg: purchasingSourceListEntry.purchasingOrg,
      validFrom: purchasingSourceListEntry.validFrom,
      validTo: purchasingSourceListEntry.validTo,
      fixedSource: purchasingSourceListEntry.fixedSource,
      blockedSource: purchasingSourceListEntry.blockedSource,
      mrpRelevant: purchasingSourceListEntry.mrpRelevant,
      markedForDeletion: purchasingSourceListEntry.markedForDeletion,
      version: purchasingSourceListEntry.version,
    }).from(purchasingSourceListEntry).where(and(
      eq(purchasingSourceListEntry.client, client),
      eq(purchasingSourceListEntry.materialNumber, materialKey),
      eq(purchasingSourceListEntry.plant, plantKey),
    )).orderBy(asc(purchasingSourceListEntry.validFrom), asc(purchasingSourceListEntry.sourceNumber));
    return {
      materialNumber: header.materialNumber,
      plant: header.plant,
      sourceListRequired: header.sourceListRequired,
      version: header.version,
      entries,
    };
  });
}

export async function listRecentSourceEntries(client: string): Promise<Array<{
  sourceNumber: string;
  materialNumber: string;
  plant: string;
  partnerNumber: string;
  markedForDeletion: boolean;
}>> {
  return withTenant(client, (tx) => tx.select({
    sourceNumber: purchasingSourceListEntry.sourceNumber,
    materialNumber: purchasingSourceListEntry.materialNumber,
    plant: purchasingSourceListEntry.plant,
    partnerNumber: purchasingSourceListEntry.partnerNumber,
    markedForDeletion: purchasingSourceListEntry.markedForDeletion,
  }).from(purchasingSourceListEntry).where(eq(purchasingSourceListEntry.client, client))
    .orderBy(sql`${purchasingSourceListEntry.sourceNumber} desc`)
    .limit(40));
}
