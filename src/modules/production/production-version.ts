/**
 * Production version — C223.
 *
 * The key is material, plant, and version. The version names one material BOM
 * alternative and one standard routing. It does not copy either master.
 * Engineering change management does not stand, so a change number is refused.
 * A blank valid-to is stored as 9999-12-31.
 *
 * Overlap is allowed unless the tenant refuses it. Selection never picks the
 * first of several matches. A lock prevents selection. A stored check is stale
 * when the BOM, routing, or plant view has changed since the check.
 *
 * Not stored, because the system does not execute them: repetitive manufacturing,
 * a rate routing, a separate planning task list, a costing lot size, and a
 * backflush. MD01 does not call this selector. CO01 does not read it, and a
 * saved order is not rewritten. Product costing does not stand.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { unitOfMeasure } from '../../platform/tables/reference';
import { markActivityComplete } from '../../platform/tenancy';
import { storageLocation } from '../foundation/schema';
import { material, materialPlant, productionOrder } from '../inventory/schema';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import {
  bomStatus,
  materialBom,
  plannedOrder,
  productionVersion,
  productionVersionFinding,
  productionVersionRule,
  routing,
  routingMaterialAssignment,
  routingStatus,
} from './schema';

export const PRODUCTION_VERSION_ACTIVITY = 'CFG.PROD.VERSION.DEFINE';
export const PRODUCTION_VERSION_CREATE_CAPABILITY = 'PROD.VERSION.CREATE';
export const PRODUCTION_VERSION_CHANGE_CAPABILITY = 'PROD.VERSION.CHANGE';
export const PRODUCTION_VERSION_DISPLAY_CAPABILITY = 'PROD.VERSION.DISPLAY';
export const PRODUCTION_VERSION_CHECK_CAPABILITY = 'PROD.VERSION.CHECK';
export const PRODUCTION_VERSION_LOCK_CAPABILITY = 'PROD.VERSION.LOCK';
export const PRODUCTION_VERSION_DELETE_CAPABILITY = 'PROD.VERSION.DELETE';
export const PRODUCTION_VERSION_ROUTE = '/production/production-versions';
export const PRODUCTION_VERSION_DISPLAY_ROUTE = '/production/production-version-display';
export const PRODUCTION_VERSION_LOCK = 'PRODUCTION_VERSION';
export const PRODUCTION_VERSION_OBJECT = 'production_version';
const OPEN_ENDED = '9999-12-31';

export class ProductionVersionError extends Error {
  readonly code: string;
  remedy?: string;
  constructor(code: string, message: string, remedy?: string) {
    super(message);
    this.name = 'ProductionVersionError';
    this.code = code;
    this.remedy = remedy;
  }
}

function fail(code: string, message: string, remedy?: string): never {
  throw new ProductionVersionError(code, message, remedy);
}

export type VersionMode = 'CREATE' | 'CHANGE' | 'DISPLAY' | 'CHECK' | 'LOCK' | 'DELETE';

export function productionVersionCapability(mode: VersionMode): string {
  if (mode === 'CREATE') return PRODUCTION_VERSION_CREATE_CAPABILITY;
  if (mode === 'CHANGE') return PRODUCTION_VERSION_CHANGE_CAPABILITY;
  if (mode === 'CHECK') return PRODUCTION_VERSION_CHECK_CAPABILITY;
  if (mode === 'LOCK') return PRODUCTION_VERSION_LOCK_CAPABILITY;
  if (mode === 'DELETE') return PRODUCTION_VERSION_DELETE_CAPABILITY;
  return PRODUCTION_VERSION_DISPLAY_CAPABILITY;
}

export function holdsProductionVersionAuthority(held: readonly string[], mode: VersionMode): boolean {
  return hasCapability([...held], productionVersionCapability(mode));
}

export interface ProductionVersionInput {
  client: string;
  changedBy: string;
  materialNumber: string;
  plant: string;
  productionVersion?: string | null;
  description?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  lotFrom?: string | null;
  lotTo?: string | null;
  lotUnit?: string | null;
  bomUsage?: string | null;
  bomAlternative?: string | null;
  taskListType?: string | null;
  routingGroup?: string | null;
  groupCounter?: string | null;
  receivingStorageLocation?: string | null;
  changeNumber?: string | null;
  version?: number;
  requestKey?: string | null;
}

export interface ProductionVersionFindingView {
  code: string;
  severity: 'E' | 'W';
  message: string;
  fieldName: string | null;
  referencedObject: string | null;
}

export interface ProductionVersionView {
  materialNumber: string;
  materialDescription: string;
  plant: string;
  productionVersion: string;
  description: string | null;
  validFrom: string;
  validTo: string;
  lotFrom: string;
  lotTo: string;
  lotUnit: string;
  bomUsage: string;
  bomAlternative: string;
  bomDescription: string | null;
  bomValidFrom: string | null;
  bomValidTo: string | null;
  taskListType: string;
  routingGroup: string;
  groupCounter: string;
  routingDescription: string | null;
  routingValidFrom: string | null;
  routingValidTo: string | null;
  receivingStorageLocation: string | null;
  lockIndicator: ' ' | '1';
  deletionFlag: 'X' | ' ';
  checkStatus: ' ' | '1' | '2' | '3';
  checkedAt: string | null;
  checkedBy: string | null;
  stale: boolean;
  version: number;
  requestKey: string | null;
  findings: ProductionVersionFindingView[];
  warnings: string[];
}

interface FindingDraft {
  code: string;
  severity: 'E' | 'W';
  message: string;
  fieldName: string | null;
  referencedObject: string | null;
}

function dateOf(value: string, label: string): string {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail('DATE', `${label} is not a calendar date.`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail('DATE', `${label} is not a calendar date.`);
  return text;
}

function textOf(value: string | null | undefined, label: string, max: number): string | null {
  if (value == null) return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) fail('LENGTH', `${label} is longer than ${max} characters. It was not truncated.`);
  return text;
}

function versionCodeOf(value: string): string {
  const text = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(text)) fail('VERSION', `Production version ${value || '(blank)'} must be one to four letters or digits.`);
  return text;
}

function counterOf(value: string, label: string): string {
  const text = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,2}$/.test(text)) fail('KEY', `${label} ${value || '(blank)'} must be one or two letters or digits.`);
  return /^[0-9]$/.test(text) ? text.padStart(2, '0') : text;
}

function rangesOverlap(leftFrom: string, leftTo: string, rightFrom: string, rightTo: string): boolean {
  return leftFrom <= rightTo && rightFrom <= leftTo;
}

async function decimalsOf(tx: Tx, code: string): Promise<number> {
  const [row] = await tx.select({ decimalPlaces: unitOfMeasure.decimalPlaces }).from(unitOfMeasure).where(eq(unitOfMeasure.code, code));
  if (!row) fail('UNIT', `Unit of measure ${code} does not exist.`);
  return row.decimalPlaces;
}

function quantityText(value: string, label: string, decimals: number): string {
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) fail('LOT', `${label} ${value || '(blank)'} is not a quantity. It was not rounded.`);
  if ((text.split('.')[1] ?? '').length > Math.min(3, decimals)) fail('LOT', `${label} has more decimal places than the unit allows. It was not rounded.`);
  if (Number(text) < 0) fail('LOT', `${label} must be zero or positive.`);
  return text;
}

async function baseQuantity(tx: Tx, client: string, materialNumber: string, value: string, unit: string, label: string): Promise<{ quantity: string; unit: string }> {
  const decimals = await decimalsOf(tx, unit.trim().toUpperCase());
  const entered = quantityText(value, label, decimals);
  try {
    const converted = await toBaseQuantity(tx, client, { materialNumber, quantity: Number(entered), entryUnit: unit });
    const stored = converted.baseQuantity.toFixed(3);
    if (Math.abs(Number(stored) - converted.baseQuantity) > 1e-9) fail('LOT', `${label} converts to more than three decimal places. It was not rounded.`);
    return { quantity: stored, unit: converted.baseUnit };
  } catch (error) {
    if (error instanceof UnitConversionError) fail('UNIT', error.message, error.remedy);
    throw error;
  }
}

async function readInTx(tx: Tx, client: string, materialNumber: string, plant: string, productionVersionCode: string): Promise<ProductionVersionView | null> {
  const [header] = await tx.select().from(productionVersion).where(and(
    eq(productionVersion.client, client),
    eq(productionVersion.materialNumber, materialNumber),
    eq(productionVersion.plant, plant),
    eq(productionVersion.productionVersion, productionVersionCode),
  ));
  if (!header) return null;
  const [materialRow] = await tx.select({ description: material.description }).from(material).where(and(
    eq(material.client, client), eq(material.materialNumber, materialNumber),
  ));
  const [bom] = await tx.select().from(materialBom).where(and(
    eq(materialBom.client, client),
    eq(materialBom.materialNumber, materialNumber),
    eq(materialBom.plant, plant),
    eq(materialBom.usage, header.bomUsage),
    eq(materialBom.alternative, header.bomAlternative),
  ));
  const [route] = await tx.select().from(routing).where(and(
    eq(routing.client, client),
    eq(routing.taskListType, header.taskListType),
    eq(routing.routingGroup, header.routingGroup),
    eq(routing.groupCounter, header.groupCounter),
  ));
  const [plantView] = await tx.select({ version: materialPlant.version }).from(materialPlant).where(and(
    eq(materialPlant.client, client), eq(materialPlant.materialNumber, materialNumber), eq(materialPlant.plant, plant),
  ));
  const findings = await tx.select().from(productionVersionFinding).where(and(
    eq(productionVersionFinding.client, client),
    eq(productionVersionFinding.materialNumber, materialNumber),
    eq(productionVersionFinding.plant, plant),
    eq(productionVersionFinding.productionVersion, productionVersionCode),
  )).orderBy(asc(productionVersionFinding.code));
  const stale = header.checkStatus !== ' ' && (
    header.checkedBomVersion !== (bom?.version ?? null)
    || header.checkedRoutingVersion !== (route?.version ?? null)
    || header.checkedPlantVersion !== (plantView?.version ?? null)
  );
  return {
    materialNumber,
    materialDescription: materialRow?.description ?? '',
    plant,
    productionVersion: productionVersionCode,
    description: header.description,
    validFrom: header.validFrom,
    validTo: header.validTo,
    lotFrom: header.lotFrom,
    lotTo: header.lotTo,
    lotUnit: header.lotUnit,
    bomUsage: header.bomUsage,
    bomAlternative: header.bomAlternative,
    bomDescription: bom?.headerText ?? null,
    bomValidFrom: bom?.validFrom ?? null,
    bomValidTo: bom?.validTo ?? null,
    taskListType: header.taskListType,
    routingGroup: header.routingGroup,
    groupCounter: header.groupCounter,
    routingDescription: route?.description ?? null,
    routingValidFrom: route?.validFrom ?? null,
    routingValidTo: route?.validTo ?? null,
    receivingStorageLocation: header.receivingStorageLocation,
    lockIndicator: header.lockIndicator === '1' ? '1' : ' ',
    deletionFlag: header.deletionFlag === 'X' ? 'X' : ' ',
    checkStatus: ([' ', '1', '2', '3'].includes(header.checkStatus) ? header.checkStatus : ' ') as ProductionVersionView['checkStatus'],
    checkedAt: header.checkedAt ? header.checkedAt.toISOString() : null,
    checkedBy: header.checkedBy,
    stale,
    version: header.version,
    requestKey: header.requestKey,
    findings: findings.map((row) => ({
      code: row.code,
      severity: row.severity === 'W' ? 'W' : 'E',
      message: row.message,
      fieldName: row.fieldName,
      referencedObject: row.referencedObject,
    })),
    warnings: [],
  };
}

function snapshot(view: ProductionVersionView): Record<string, unknown> {
  return {
    description: view.description,
    validFrom: view.validFrom,
    validTo: view.validTo,
    lotFrom: view.lotFrom,
    lotTo: view.lotTo,
    bomUsage: view.bomUsage,
    bomAlternative: view.bomAlternative,
    taskListType: view.taskListType,
    routingGroup: view.routingGroup,
    groupCounter: view.groupCounter,
    receivingStorageLocation: view.receivingStorageLocation,
    lockIndicator: view.lockIndicator,
    deletionFlag: view.deletionFlag,
    checkStatus: view.checkStatus,
  };
}

async function findingsFor(
  tx: Tx,
  client: string,
  header: {
    materialNumber: string;
    plant: string;
    validFrom: string;
    validTo: string;
    bomUsage: string;
    bomAlternative: string;
    taskListType: string;
    routingGroup: string;
    groupCounter: string;
  },
): Promise<{ findings: FindingDraft[]; bomVersion: number | null; routingVersion: number | null; plantVersion: number | null }> {
  const findings: FindingDraft[] = [];
  const [plantView] = await tx.select().from(materialPlant).where(and(
    eq(materialPlant.client, client), eq(materialPlant.materialNumber, header.materialNumber), eq(materialPlant.plant, header.plant),
  ));
  const [materialRow] = await tx.select().from(material).where(and(eq(material.client, client), eq(material.materialNumber, header.materialNumber)));
  if (materialRow?.markedForDeletion || materialRow?.isBlocked) {
    findings.push({ code: 'MATERIAL_BLOCKED', severity: 'E', message: `Material ${header.materialNumber} is blocked or marked for deletion.`, fieldName: 'materialNumber', referencedObject: header.materialNumber });
  }
  const [bom] = await tx.select().from(materialBom).where(and(
    eq(materialBom.client, client), eq(materialBom.materialNumber, header.materialNumber), eq(materialBom.plant, header.plant),
    eq(materialBom.usage, header.bomUsage), eq(materialBom.alternative, header.bomAlternative),
  ));
  if (!bom || bom.deletionFlag === 'X') {
    findings.push({ code: 'BOM_MISSING', severity: 'E', message: 'The BOM alternative is missing or marked for deletion.', fieldName: 'bomAlternative', referencedObject: `${header.bomUsage}/${header.bomAlternative}` });
  } else if (bom.validFrom > header.validFrom || bom.validTo < header.validTo) {
    findings.push({ code: 'BOM_VALIDITY', severity: 'E', message: `The BOM is valid ${bom.validFrom} to ${bom.validTo}. That does not cover this production version.`, fieldName: 'validFrom', referencedObject: `${header.bomUsage}/${header.bomAlternative}` });
  }
  if (bom?.status) {
    const [status] = await tx.select().from(bomStatus).where(and(eq(bomStatus.client, client), eq(bomStatus.status, bom.status)));
    if (status && status.releasedForOrders !== 'X') {
      findings.push({ code: 'BOM_STATUS', severity: 'W', message: `BOM status ${bom.status} is not released for orders. The flag is stored and is not executed here.`, fieldName: 'bomAlternative', referencedObject: bom.status });
    }
  }
  const [route] = await tx.select().from(routing).where(and(
    eq(routing.client, client), eq(routing.taskListType, header.taskListType),
    eq(routing.routingGroup, header.routingGroup), eq(routing.groupCounter, header.groupCounter),
  ));
  if (!route || route.deletionFlag === 'X' || route.plant !== header.plant) {
    findings.push({ code: 'ROUTING_MISSING', severity: 'E', message: 'The routing is missing, marked for deletion, or belongs to another plant.', fieldName: 'routingGroup', referencedObject: `${header.taskListType}/${header.routingGroup}/${header.groupCounter}` });
  } else if (route.validFrom > header.validFrom || route.validTo < header.validTo) {
    findings.push({ code: 'ROUTING_VALIDITY', severity: 'E', message: `The routing is valid ${route.validFrom} to ${route.validTo}. That does not cover this production version.`, fieldName: 'routingGroup', referencedObject: `${header.routingGroup}/${header.groupCounter}` });
  }
  if (route?.status) {
    const [status] = await tx.select().from(routingStatus).where(and(eq(routingStatus.client, client), eq(routingStatus.status, route.status)));
    if (status && status.releasedForOrders !== 'X') {
      findings.push({ code: 'ROUTING_STATUS', severity: 'W', message: `Routing status ${route.status} is not released for orders. The flag is stored and is not executed here.`, fieldName: 'routingGroup', referencedObject: route.status });
    }
  }
  const assignments = route ? await tx.select().from(routingMaterialAssignment).where(and(
    eq(routingMaterialAssignment.client, client),
    eq(routingMaterialAssignment.taskListType, header.taskListType),
    eq(routingMaterialAssignment.routingGroup, header.routingGroup),
    eq(routingMaterialAssignment.groupCounter, header.groupCounter),
    eq(routingMaterialAssignment.materialNumber, header.materialNumber),
    eq(routingMaterialAssignment.plant, header.plant),
    eq(routingMaterialAssignment.deletionFlag, ' '),
  )) : [];
  const covering = assignments.find((row) => row.validFrom <= header.validFrom && row.validTo >= header.validTo);
  if (route && !covering) {
    findings.push({ code: 'ROUTING_ASSIGNMENT', severity: 'E', message: 'The routing is not assigned to this material for the whole production-version period.', fieldName: 'routingGroup', referencedObject: header.materialNumber });
  }
  return {
    findings,
    bomVersion: bom?.version ?? null,
    routingVersion: route?.version ?? null,
    plantVersion: plantView?.version ?? null,
  };
}

async function replaceFindings(tx: Tx, client: string, materialNumber: string, plant: string, productionVersionCode: string, actor: string, findings: FindingDraft[]) {
  await tx.delete(productionVersionFinding).where(and(
    eq(productionVersionFinding.client, client),
    eq(productionVersionFinding.materialNumber, materialNumber),
    eq(productionVersionFinding.plant, plant),
    eq(productionVersionFinding.productionVersion, productionVersionCode),
  ));
  for (const finding of findings) {
    await tx.insert(productionVersionFinding).values({
      client, materialNumber, plant, productionVersion: productionVersionCode, ...finding, createdBy: actor,
    });
  }
}

function statusOf(findings: FindingDraft[]): '1' | '2' | '3' {
  if (findings.some((row) => row.severity === 'E')) return '3';
  if (findings.length > 0) return '2';
  return '1';
}

async function assertReferences(tx: Tx, client: string, input: {
  materialNumber: string;
  plant: string;
  bomUsage: string;
  bomAlternative: string;
  taskListType: string;
  routingGroup: string;
  groupCounter: string;
  receivingStorageLocation: string | null;
}) {
  const [extended] = await tx.select().from(materialPlant).where(and(
    eq(materialPlant.client, client), eq(materialPlant.materialNumber, input.materialNumber), eq(materialPlant.plant, input.plant),
  ));
  if (!extended) fail('MATERIAL_PLANT', `Material ${input.materialNumber} is not extended to plant ${input.plant}.`);
  if (extended.procurementType !== 'MAKE' && extended.procurementType !== 'BOTH') {
    fail('MATERIAL_PLANT', `Material ${input.materialNumber} is not produced in plant ${input.plant}.`, 'Set procurement to make or both on the plant view. A purchased material is not given a production version.');
  }
  const [bom] = await tx.select({ alternative: materialBom.alternative }).from(materialBom).where(and(
    eq(materialBom.client, client), eq(materialBom.materialNumber, input.materialNumber), eq(materialBom.plant, input.plant),
    eq(materialBom.usage, input.bomUsage), eq(materialBom.alternative, input.bomAlternative),
  ));
  if (!bom) fail('BOM_MISSING', `BOM alternative ${input.bomAlternative} does not exist for usage ${input.bomUsage}.`, 'Create the BOM first. This screen does not maintain one.');
  const [route] = await tx.select().from(routing).where(and(
    eq(routing.client, client), eq(routing.taskListType, input.taskListType),
    eq(routing.routingGroup, input.routingGroup), eq(routing.groupCounter, input.groupCounter),
  ));
  if (!route || route.plant !== input.plant) fail('ROUTING_MISSING', `Routing ${input.taskListType} ${input.routingGroup}/${input.groupCounter} does not exist in plant ${input.plant}.`, 'Create the routing first. This screen does not maintain one.');
  const [assignment] = await tx.select({ materialNumber: routingMaterialAssignment.materialNumber }).from(routingMaterialAssignment).where(and(
    eq(routingMaterialAssignment.client, client),
    eq(routingMaterialAssignment.taskListType, input.taskListType),
    eq(routingMaterialAssignment.routingGroup, input.routingGroup),
    eq(routingMaterialAssignment.groupCounter, input.groupCounter),
    eq(routingMaterialAssignment.materialNumber, input.materialNumber),
    eq(routingMaterialAssignment.plant, input.plant),
  ));
  if (!assignment) fail('ROUTING_MISSING', `Routing ${input.routingGroup}/${input.groupCounter} is not assigned to material ${input.materialNumber}.`);
  if (input.receivingStorageLocation) {
    const [location] = await tx.select().from(storageLocation).where(and(
      eq(storageLocation.client, client), eq(storageLocation.plant, input.plant), eq(storageLocation.storageLocation, input.receivingStorageLocation),
    ));
    if (!location || !location.isActive) fail('STORAGE', `Storage location ${input.receivingStorageLocation} does not exist in plant ${input.plant}.`);
  }
}

async function assertNoProhibitedOverlap(tx: Tx, client: string, input: {
  materialNumber: string;
  plant: string;
  productionVersion: string;
  validFrom: string;
  validTo: string;
  lotFrom: string;
  lotTo: string;
}) {
  const [rule] = await tx.select().from(productionVersionRule).where(eq(productionVersionRule.client, client));
  if (rule?.refuseOverlap !== 'X') return;
  const others = await tx.select().from(productionVersion).where(and(
    eq(productionVersion.client, client),
    eq(productionVersion.materialNumber, input.materialNumber),
    eq(productionVersion.plant, input.plant),
    eq(productionVersion.deletionFlag, ' '),
  ));
  const hit = others.find((row) => row.productionVersion !== input.productionVersion
    && rangesOverlap(row.validFrom, row.validTo, input.validFrom, input.validTo)
    && rangesOverlap(row.lotFrom, row.lotTo, input.lotFrom, input.lotTo));
  if (hit) fail('OVERLAP', `Production version ${hit.productionVersion} already covers this date and lot-size range.`, 'Change the dates or the lot range, or allow overlap and choose the version at selection.');
}

async function writeVersion(input: ProductionVersionInput, mode: 'CREATE' | 'CHANGE'): Promise<ProductionVersionView> {
  if ((input.changeNumber ?? '').trim()) {
    fail('CHANGE_NUMBER', 'Engineering change management is not implemented. A change number is not stored.', 'Save without a change number. Validity is the from and to dates.');
  }
  const materialNumber = input.materialNumber.trim();
  const plant = input.plant.trim();
  if (!materialNumber || !plant) fail('MATERIAL_PLANT', 'Material and plant are required.');
  const requestKey = textOf(input.requestKey, 'Request key', 64);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/production-version/${plant}/${materialNumber}`}, 0))`);
    if (mode === 'CREATE' && requestKey) {
      const [prior] = await tx.select().from(productionVersion).where(and(eq(productionVersion.client, input.client), eq(productionVersion.requestKey, requestKey)));
      if (prior) {
        const standing = await readInTx(tx, input.client, prior.materialNumber, prior.plant, prior.productionVersion);
        if (!standing) fail('REQUEST', 'The earlier request could not be read.');
        standing.warnings = ['This request was already saved. The standing production version was returned. The new values were not applied.'];
        return standing;
      }
    }
    const productionVersionCode = input.productionVersion?.trim()
      ? versionCodeOf(input.productionVersion)
      : fail('VERSION', 'Production version is required.');
    const [beforeRow] = await tx.select().from(productionVersion).where(and(
      eq(productionVersion.client, input.client), eq(productionVersion.materialNumber, materialNumber),
      eq(productionVersion.plant, plant), eq(productionVersion.productionVersion, productionVersionCode),
    ));
    if (mode === 'CREATE' && beforeRow) fail('DUPLICATE', `Production version ${productionVersionCode} already exists for ${materialNumber} in plant ${plant}.`);
    if (mode === 'CHANGE' && !beforeRow) fail('MISSING', `Production version ${productionVersionCode} does not exist.`);
    if (mode === 'CHANGE' && input.version !== beforeRow!.version) {
      fail('CONCURRENT', 'The production version was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    const validFrom = input.validFrom !== undefined && input.validFrom !== null
      ? dateOf(input.validFrom, 'Valid from')
      : mode === 'CHANGE' ? beforeRow!.validFrom : fail('DATE', 'Valid from is required.');
    const validTo = input.validTo === undefined
      ? (mode === 'CHANGE' ? beforeRow!.validTo : OPEN_ENDED)
      : input.validTo.trim() ? dateOf(input.validTo, 'Valid to') : OPEN_ENDED;
    if (validTo < validFrom) fail('DATE_RANGE', 'Valid-to is before valid-from.');
    const description = input.description === undefined ? (mode === 'CHANGE' ? beforeRow!.description : null) : textOf(input.description, 'Description', 40);
    const lotUnitInput = (input.lotUnit ?? '').trim().toUpperCase();
    let lotFrom = mode === 'CHANGE' ? beforeRow!.lotFrom : '';
    let lotTo = mode === 'CHANGE' ? beforeRow!.lotTo : '';
    let lotUnit = mode === 'CHANGE' ? beforeRow!.lotUnit : '';
    if (mode === 'CREATE' || input.lotFrom !== undefined || input.lotTo !== undefined || input.lotUnit !== undefined) {
      const fromText = input.lotFrom ?? (mode === 'CHANGE' ? beforeRow!.lotFrom : '');
      const toText = input.lotTo ?? (mode === 'CHANGE' ? beforeRow!.lotTo : '');
      const unit = lotUnitInput || (mode === 'CHANGE' ? beforeRow!.lotUnit : '');
      if (!unit) fail('UNIT', 'Lot-size unit is required.');
      const from = await baseQuantity(tx, input.client, materialNumber, fromText, unit, 'Minimum lot size');
      const to = await baseQuantity(tx, input.client, materialNumber, toText, unit, 'Maximum lot size');
      if (from.unit !== to.unit) fail('UNIT', 'Minimum and maximum lot size must use the same material unit.');
      if (Number(to.quantity) < Number(from.quantity)) fail('LOT_RANGE', 'Maximum lot size is below minimum lot size.');
      lotFrom = from.quantity;
      lotTo = to.quantity;
      lotUnit = from.unit;
    }
    const bomUsage = input.bomUsage !== undefined && input.bomUsage !== null
      ? input.bomUsage.trim().toUpperCase()
      : mode === 'CHANGE' ? beforeRow!.bomUsage : fail('BOM_MISSING', 'BOM usage is required.');
    if (!/^[A-Z0-9]$/.test(bomUsage)) fail('BOM_MISSING', `BOM usage ${bomUsage || '(blank)'} is not valid.`);
    const bomAlternative = input.bomAlternative !== undefined && input.bomAlternative !== null
      ? counterOf(input.bomAlternative, 'BOM alternative')
      : mode === 'CHANGE' ? beforeRow!.bomAlternative : fail('BOM_MISSING', 'BOM alternative is required.');
    const taskListType = input.taskListType !== undefined && input.taskListType !== null
      ? input.taskListType.trim().toUpperCase()
      : mode === 'CHANGE' ? beforeRow!.taskListType : fail('ROUTING_MISSING', 'Task list type is required.');
    if (!/^[A-Z0-9]$/.test(taskListType)) fail('ROUTING_MISSING', `Task list type ${taskListType || '(blank)'} is not valid.`);
    const routingGroup = input.routingGroup !== undefined && input.routingGroup !== null
      ? input.routingGroup.trim().toUpperCase()
      : mode === 'CHANGE' ? beforeRow!.routingGroup : fail('ROUTING_MISSING', 'Routing group is required.');
    if (!/^[A-Z0-9]{1,8}$/.test(routingGroup)) fail('ROUTING_MISSING', `Routing group ${routingGroup || '(blank)'} is not valid.`);
    const groupCounter = input.groupCounter !== undefined && input.groupCounter !== null
      ? counterOf(input.groupCounter, 'Group counter')
      : mode === 'CHANGE' ? beforeRow!.groupCounter : fail('ROUTING_MISSING', 'Group counter is required.');
    const receivingStorageLocation = input.receivingStorageLocation === undefined
      ? (mode === 'CHANGE' ? beforeRow!.receivingStorageLocation : null)
      : textOf(input.receivingStorageLocation, 'Receiving storage location', 10)?.toUpperCase() ?? null;
    await assertReferences(tx, input.client, {
      materialNumber, plant, bomUsage, bomAlternative, taskListType, routingGroup, groupCounter, receivingStorageLocation,
    });
    await assertNoProhibitedOverlap(tx, input.client, { materialNumber, plant, productionVersion: productionVersionCode, validFrom, validTo, lotFrom, lotTo });
    const before = beforeRow ? await readInTx(tx, input.client, materialNumber, plant, productionVersionCode) : null;
    if (mode === 'CREATE') {
      await tx.insert(productionVersion).values({
        client: input.client, materialNumber, plant, productionVersion: productionVersionCode, description,
        validFrom, validTo, lotFrom, lotTo, lotUnit, bomUsage, bomAlternative, taskListType, routingGroup, groupCounter,
        receivingStorageLocation, requestKey, createdBy: input.changedBy,
      });
      await markActivityComplete(tx, input.client, PRODUCTION_VERSION_ACTIVITY, input.changedBy);
    } else {
      const updated = await tx.update(productionVersion).set({
        description, validFrom, validTo, lotFrom, lotTo, lotUnit, bomUsage, bomAlternative, taskListType, routingGroup, groupCounter,
        receivingStorageLocation, version: beforeRow!.version + 1, changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(productionVersion.client, input.client), eq(productionVersion.materialNumber, materialNumber),
        eq(productionVersion.plant, plant), eq(productionVersion.productionVersion, productionVersionCode),
        eq(productionVersion.version, beforeRow!.version),
      )).returning({ version: productionVersion.version });
      if (updated.length === 0) fail('CONCURRENT', 'The production version was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    const evaluated = await findingsFor(tx, input.client, { materialNumber, plant, validFrom, validTo, bomUsage, bomAlternative, taskListType, routingGroup, groupCounter });
    await replaceFindings(tx, input.client, materialNumber, plant, productionVersionCode, input.changedBy, evaluated.findings);
    await tx.update(productionVersion).set({
      checkStatus: statusOf(evaluated.findings),
      checkedAt: new Date(),
      checkedBy: input.changedBy,
      checkedBomVersion: evaluated.bomVersion,
      checkedRoutingVersion: evaluated.routingVersion,
      checkedPlantVersion: evaluated.plantVersion,
    }).where(and(
      eq(productionVersion.client, input.client), eq(productionVersion.materialNumber, materialNumber),
      eq(productionVersion.plant, plant), eq(productionVersion.productionVersion, productionVersionCode),
    ));
    const after = await readInTx(tx, input.client, materialNumber, plant, productionVersionCode);
    if (!after) fail('SAVE', 'The production version was not saved.');
    await recordChange(tx, {
      client: input.client, objectClass: PRODUCTION_VERSION_OBJECT, objectKey: `${plant}/${materialNumber}/${productionVersionCode}`,
      changeType: mode === 'CREATE' ? 'CREATE' : 'CHANGE', changedBy: input.changedBy, transactionCode: 'C223',
      correlationId: requestKey ?? undefined, before: before ? snapshot(before) : undefined, after: snapshot(after),
    });
    return after;
  });
}

export function createProductionVersion(input: ProductionVersionInput): Promise<ProductionVersionView> {
  return writeVersion(input, 'CREATE');
}

export function changeProductionVersion(input: ProductionVersionInput): Promise<ProductionVersionView> {
  return writeVersion(input, 'CHANGE');
}

export async function copyProductionVersion(input: ProductionVersionInput & { newProductionVersion: string }): Promise<ProductionVersionView> {
  const source = await getProductionVersion(input.client, input.materialNumber, input.plant, input.productionVersion ?? '');
  if (!source) fail('MISSING', 'The production version to copy does not exist.');
  return createProductionVersion({
    ...input,
    productionVersion: input.newProductionVersion,
    description: input.description === undefined ? source.description : input.description,
    validFrom: input.validFrom === undefined ? source.validFrom : input.validFrom,
    validTo: input.validTo === undefined ? source.validTo : input.validTo,
    lotFrom: input.lotFrom === undefined ? source.lotFrom : input.lotFrom,
    lotTo: input.lotTo === undefined ? source.lotTo : input.lotTo,
    lotUnit: input.lotUnit === undefined ? source.lotUnit : input.lotUnit,
    bomUsage: input.bomUsage === undefined ? source.bomUsage : input.bomUsage,
    bomAlternative: input.bomAlternative === undefined ? source.bomAlternative : input.bomAlternative,
    taskListType: input.taskListType === undefined ? source.taskListType : input.taskListType,
    routingGroup: input.routingGroup === undefined ? source.routingGroup : input.routingGroup,
    groupCounter: input.groupCounter === undefined ? source.groupCounter : input.groupCounter,
    receivingStorageLocation: input.receivingStorageLocation === undefined ? source.receivingStorageLocation : input.receivingStorageLocation,
    requestKey: input.requestKey,
  });
}

export async function getProductionVersion(client: string, materialNumber: string, plant: string, productionVersionCode: string): Promise<ProductionVersionView | null> {
  if (!materialNumber.trim() || !plant.trim() || !productionVersionCode.trim()) return null;
  return withTenant(client, (tx) => readInTx(tx, client, materialNumber.trim(), plant.trim(), versionCodeOf(productionVersionCode)));
}

export async function listProductionVersions(client: string, filter: {
  plant: string;
  materialNumber?: string;
  productionVersion?: string;
  mrpController?: string;
  keyDate?: string;
  consistency?: 'unchecked' | 'valid' | 'warning' | 'error' | 'stale' | '';
  includeLocked?: boolean;
  includeExpired?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}) {
  const plant = filter.plant.trim();
  if (!plant) fail('MATERIAL_PLANT', 'Plant is required to search.');
  const keyDate = filter.keyDate?.trim() ? dateOf(filter.keyDate, 'Key date') : null;
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  const offset = Math.max(filter.offset ?? 0, 0);
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(productionVersion).where(eq(productionVersion.client, client)).orderBy(
      asc(productionVersion.materialNumber), asc(productionVersion.productionVersion),
    );
    const plants = await tx.select({
      materialNumber: materialPlant.materialNumber,
      plant: materialPlant.plant,
      mrpController: materialPlant.mrpController,
    }).from(materialPlant).where(and(eq(materialPlant.client, client), eq(materialPlant.plant, plant)));
    const controllers = new Map(plants.map((row) => [row.materialNumber, row.mrpController]));
    const materials = await tx.select({ materialNumber: material.materialNumber, description: material.description }).from(material).where(eq(material.client, client));
    const names = new Map(materials.map((row) => [row.materialNumber, row.description]));
    const asOf = keyDate ?? new Date().toISOString().slice(0, 10);
    const matched = [];
    for (const row of rows) {
      if (row.plant !== plant) continue;
      if (filter.materialNumber && row.materialNumber !== filter.materialNumber.trim()) continue;
      if (filter.productionVersion && !row.productionVersion.startsWith(filter.productionVersion.trim().toUpperCase())) continue;
      if (filter.mrpController && controllers.get(row.materialNumber) !== filter.mrpController.trim().toUpperCase()) continue;
      if (!filter.includeDeleted && row.deletionFlag === 'X') continue;
      if (!filter.includeLocked && row.lockIndicator === '1') continue;
      if (!filter.includeExpired && row.validTo < asOf) continue;
      if (keyDate && (keyDate < row.validFrom || keyDate > row.validTo)) continue;
      const view = await readInTx(tx, client, row.materialNumber, row.plant, row.productionVersion);
      if (!view) continue;
      if (filter.consistency === 'unchecked' && (view.checkStatus !== ' ' || view.stale)) continue;
      if (filter.consistency === 'valid' && (view.checkStatus !== '1' || view.stale)) continue;
      if (filter.consistency === 'warning' && (view.checkStatus !== '2' || view.stale)) continue;
      if (filter.consistency === 'error' && (view.checkStatus !== '3' || view.stale)) continue;
      if (filter.consistency === 'stale' && !view.stale) continue;
      matched.push({
        ...view,
        materialDescription: names.get(row.materialNumber) ?? view.materialDescription,
        mrpController: controllers.get(row.materialNumber) ?? null,
      });
    }
    return { rows: matched.slice(offset, offset + limit), total: matched.length, limit, offset };
  });
}

export async function checkProductionVersion(client: string, materialNumber: string, plant: string, productionVersionCode: string, changedBy: string): Promise<ProductionVersionView> {
  const code = versionCodeOf(productionVersionCode);
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(productionVersion).where(and(
      eq(productionVersion.client, client), eq(productionVersion.materialNumber, materialNumber.trim()),
      eq(productionVersion.plant, plant.trim()), eq(productionVersion.productionVersion, code),
    ));
    if (!header) fail('MISSING', 'The production version does not exist.');
    const before = await readInTx(tx, client, header.materialNumber, header.plant, code);
    const evaluated = await findingsFor(tx, client, header);
    await replaceFindings(tx, client, header.materialNumber, header.plant, code, changedBy, evaluated.findings);
    const updated = await tx.update(productionVersion).set({
      checkStatus: statusOf(evaluated.findings),
      checkedAt: new Date(),
      checkedBy: changedBy,
      checkedBomVersion: evaluated.bomVersion,
      checkedRoutingVersion: evaluated.routingVersion,
      checkedPlantVersion: evaluated.plantVersion,
      version: header.version + 1,
      changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(productionVersion.client, client), eq(productionVersion.materialNumber, header.materialNumber),
      eq(productionVersion.plant, header.plant), eq(productionVersion.productionVersion, code), eq(productionVersion.version, header.version),
    )).returning({ version: productionVersion.version });
    if (updated.length === 0) fail('CONCURRENT', 'The production version was changed by someone else. Nothing was saved.');
    const after = await readInTx(tx, client, header.materialNumber, header.plant, code);
    if (!after) fail('CHECK', 'The consistency check was not saved.');
    await recordChange(tx, {
      client, objectClass: PRODUCTION_VERSION_OBJECT, objectKey: `${header.plant}/${header.materialNumber}/${code}`,
      changeType: 'CHANGE', changedBy, transactionCode: 'C223', before: before ? snapshot(before) : undefined, after: snapshot(after),
    });
    return after;
  });
}

export async function lockProductionVersion(client: string, materialNumber: string, plant: string, productionVersionCode: string, changedBy: string, locked: boolean, expectedVersion: number): Promise<ProductionVersionView> {
  const code = versionCodeOf(productionVersionCode);
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(productionVersion).where(and(
      eq(productionVersion.client, client), eq(productionVersion.materialNumber, materialNumber.trim()),
      eq(productionVersion.plant, plant.trim()), eq(productionVersion.productionVersion, code),
    ));
    if (!header) fail('MISSING', 'The production version does not exist.');
    if (header.version !== expectedVersion) fail('CONCURRENT', 'The production version was changed by someone else. Nothing was saved.');
    const before = await readInTx(tx, client, header.materialNumber, header.plant, code);
    await tx.update(productionVersion).set({
      lockIndicator: locked ? '1' : ' ',
      version: header.version + 1,
      changedBy,
      changedAt: new Date(),
    }).where(and(eq(productionVersion.client, client), eq(productionVersion.productionVersion, code), eq(productionVersion.version, header.version), eq(productionVersion.materialNumber, header.materialNumber), eq(productionVersion.plant, header.plant)));
    const after = await readInTx(tx, client, header.materialNumber, header.plant, code);
    if (!after) fail('LOCK', 'The lock was not saved.');
    await recordChange(tx, {
      client, objectClass: PRODUCTION_VERSION_OBJECT, objectKey: `${header.plant}/${header.materialNumber}/${code}`,
      changeType: locked ? 'BLOCK' : 'UNBLOCK', changedBy, transactionCode: 'C223',
      before: before ? snapshot(before) : undefined, after: snapshot(after),
    });
    return after;
  });
}

export async function deleteProductionVersion(client: string, materialNumber: string, plant: string, productionVersionCode: string, changedBy: string, expectedVersion: number): Promise<{ mode: 'DELETED' | 'DEACTIVATED' }> {
  const code = versionCodeOf(productionVersionCode);
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(productionVersion).where(and(
      eq(productionVersion.client, client), eq(productionVersion.materialNumber, materialNumber.trim()),
      eq(productionVersion.plant, plant.trim()), eq(productionVersion.productionVersion, code),
    ));
    if (!header) fail('MISSING', 'The production version does not exist.');
    if (header.version !== expectedVersion) fail('CONCURRENT', 'The production version was changed by someone else. Nothing was saved.');
    const before = await readInTx(tx, client, header.materialNumber, header.plant, code);
    const [orders] = await tx.select({ n: sql<number>`count(*)::int` }).from(productionOrder).where(and(
      eq(productionOrder.client, client), eq(productionOrder.materialNumber, header.materialNumber), eq(productionOrder.plant, header.plant),
    ));
    const [plans] = await tx.select({ n: sql<number>`count(*)::int` }).from(plannedOrder).where(and(
      eq(plannedOrder.client, client), eq(plannedOrder.materialNumber, header.materialNumber), eq(plannedOrder.plant, header.plant),
    ));
    const referenced = (orders?.n ?? 0) + (plans?.n ?? 0) > 0;
    if (referenced) {
      const updated = await tx.update(productionVersion).set({
        deletionFlag: 'X', version: header.version + 1, changedBy, changedAt: new Date(),
      }).where(and(eq(productionVersion.client, client), eq(productionVersion.productionVersion, code), eq(productionVersion.version, header.version), eq(productionVersion.materialNumber, header.materialNumber))).returning({ version: productionVersion.version });
      if (updated.length === 0) fail('CONCURRENT', 'The production version was changed by someone else. Nothing was saved.');
      const after = await readInTx(tx, client, header.materialNumber, header.plant, code);
      await recordChange(tx, {
        client, objectClass: PRODUCTION_VERSION_OBJECT, objectKey: `${header.plant}/${header.materialNumber}/${code}`,
        changeType: 'CHANGE', changedBy, transactionCode: 'C223', reason: 'Referenced by a production or planned order. Marked inactive. The row was not removed.',
        before: before ? snapshot(before) : undefined, after: after ? snapshot(after) : undefined,
      });
      return { mode: 'DEACTIVATED' as const };
    }
    await tx.delete(productionVersion).where(and(
      eq(productionVersion.client, client), eq(productionVersion.materialNumber, header.materialNumber),
      eq(productionVersion.plant, header.plant), eq(productionVersion.productionVersion, code),
    ));
    await recordChange(tx, {
      client, objectClass: PRODUCTION_VERSION_OBJECT, objectKey: `${header.plant}/${header.materialNumber}/${code}`,
      changeType: 'DELETE', changedBy, transactionCode: 'C223', before: before ? snapshot(before) : undefined,
    });
    return { mode: 'DELETED' as const };
  });
}

/** Shared selector. Does not write. The plant run and CO01 do not call this. Single-item planning does. Conversion may call it inside its own transaction. Costing does not stand. */
export async function selectProductionVersion(client: string, input: {
  materialNumber: string;
  plant: string;
  keyDate: string;
  quantity: string;
  unit?: string | null;
  productionVersion?: string | null;
  context?: 'PLANNING' | 'ORDER' | 'COSTING' | null;
}, externalTx?: Tx): Promise<ProductionVersionView> {
  if (input.context === 'COSTING') {
    fail('COSTING', 'Product costing is not implemented. A production version is not costed.');
  }
  const keyDate = dateOf(input.keyDate, 'Key date');
  const materialNumber = input.materialNumber.trim();
  const plant = input.plant.trim();
  const run = async (tx: Tx) => {
    const converted = await baseQuantity(tx, client, materialNumber, input.quantity, input.unit ?? '', 'Quantity');
    const rows = await tx.select().from(productionVersion).where(and(
      eq(productionVersion.client, client),
      eq(productionVersion.materialNumber, materialNumber),
      eq(productionVersion.plant, plant),
      eq(productionVersion.deletionFlag, ' '),
    ));
    const named = input.productionVersion?.trim() ? versionCodeOf(input.productionVersion) : null;
    const dated = rows.filter((row) => (!named || row.productionVersion === named) && keyDate >= row.validFrom && keyDate <= row.validTo);
    if (named && dated.length === 0) fail('NONE_ELIGIBLE', `Production version ${named} is not valid on ${keyDate}.`);
    const sized = dated.filter((row) => Number(converted.quantity) >= Number(row.lotFrom) && Number(converted.quantity) <= Number(row.lotTo));
    if (sized.length === 0) fail('NONE_ELIGIBLE', `No production version covers ${converted.quantity} ${converted.unit} on ${keyDate}.`, 'Maintain a version whose lot-size range includes the quantity, or choose another date.');
    const unlocked = sized.filter((row) => row.lockIndicator !== '1');
    if (unlocked.length === 0) fail('LOCKED', 'Every matching production version is locked. A locked version is not selected.');
    const views = [];
    for (const row of unlocked) {
      const view = await readInTx(tx, client, row.materialNumber, row.plant, row.productionVersion);
      if (view) views.push(view);
    }
    const current = views.filter((view) => !view.stale && (view.checkStatus === '1' || view.checkStatus === '2'));
    if (current.length === 0 && views.some((view) => view.stale)) {
      fail('STALE', 'The consistency check is stale. Run it again before selecting the production version.', 'Open C223 and check the version. The previous result was not reused.');
    }
    if (current.length === 0) fail('NONE_ELIGIBLE', 'No production version has a current consistency check without errors.', 'Run the consistency check. An unchecked or failed version is not selected.');
    if (!named && current.length > 1) {
      fail('AMBIGUOUS', `More than one production version is eligible. Choose one: ${current.map((view) => view.productionVersion).join(', ')}.`, 'The first row was not selected.');
    }
    return current[0];
  };
  return externalTx ? run(externalTx) : withTenant(client, run);
}

export async function saveProductionVersionRule(input: { client: string; changedBy: string; refuseOverlap?: string | null; version?: number }) {
  const refuseOverlap = (input.refuseOverlap ?? '').trim().toUpperCase() === 'X' ? 'X' : ' ';
  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(productionVersionRule).where(eq(productionVersionRule.client, input.client));
    if (existing && input.version != null && existing.version !== input.version) fail('CONCURRENT', 'The selection rule was changed by someone else. Nothing was saved.');
    if (existing) {
      await tx.update(productionVersionRule).set({ refuseOverlap, version: existing.version + 1, changedBy: input.changedBy, changedAt: new Date() }).where(and(eq(productionVersionRule.client, input.client), eq(productionVersionRule.version, existing.version)));
    } else {
      await tx.insert(productionVersionRule).values({ client: input.client, refuseOverlap, createdBy: input.changedBy });
    }
    return { refuseOverlap };
  });
}

export async function listProductionVersionChoices(client: string, materialNumber: string, plant: string) {
  return withTenant(client, async (tx) => {
    const boms = await tx.select().from(materialBom).where(and(
      eq(materialBom.client, client), eq(materialBom.materialNumber, materialNumber.trim()), eq(materialBom.plant, plant.trim()),
    ));
    const assignments = await tx.select().from(routingMaterialAssignment).where(and(
      eq(routingMaterialAssignment.client, client),
      eq(routingMaterialAssignment.materialNumber, materialNumber.trim()),
      eq(routingMaterialAssignment.plant, plant.trim()),
      eq(routingMaterialAssignment.deletionFlag, ' '),
    ));
    const locations = await tx.select({ storageLocation: storageLocation.storageLocation, name: storageLocation.name }).from(storageLocation).where(and(
      eq(storageLocation.client, client), eq(storageLocation.plant, plant.trim()), eq(storageLocation.isActive, true),
    ));
    return {
      boms: boms.map((row) => ({ usage: row.usage, alternative: row.alternative, validFrom: row.validFrom, validTo: row.validTo, deletionFlag: row.deletionFlag })),
      routings: assignments.map((row) => ({ taskListType: row.taskListType, routingGroup: row.routingGroup, groupCounter: row.groupCounter })),
      storageLocations: locations,
    };
  });
}
