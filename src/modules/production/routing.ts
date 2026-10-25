/**
 * Standard routing — CA01 create, CA02 change, CA03 display.
 *
 * The key is task list type, group, and counter. The chart-of-accounts key CA01
 * is not this transaction. Material assignment is a separate row. Engineering
 * change management does not stand, so a change number is refused. A blank
 * valid-to is stored as 9999-12-31.
 *
 * Only sequence 000000 of type 0 is stored. Alternative and parallel sequences
 * are refused, not partially stored. Execution order is a separate positive
 * number. It is not taken from the operation number and it is not a second
 * sequence. A standard value is a parameter of the selected key, not a fixed
 * setup/machine/labor column. A formula key on the work center is read and not
 * calculated. Saving does not confirm, schedule, cost, or rewrite a production
 * order. External processing does not create a purchase order.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { unitOfMeasure } from '../../platform/tables/reference';
import { markActivityComplete } from '../../platform/tenancy';
import { plant as plantTable } from '../foundation/schema';
import { material, materialPlant, productionOrder } from '../inventory/schema';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import {
  materialBomItem,
  routing,
  routingComponentAllocation,
  routingControlKey,
  routingMaterialAssignment,
  routingOperation,
  routingOperationValue,
  routingSequence,
  routingStandardValueKey,
  routingStandardValueParameter,
  routingStatus,
  routingTaskListType,
  routingUsage,
  workCenter,
} from './schema';

export const ROUTING_ACTIVITY = 'CFG.PROD.ROUTING.DEFINE';
export const ROUTING_CREATE_CAPABILITY = 'PROD.ROUTING.CREATE';
export const ROUTING_CHANGE_CAPABILITY = 'PROD.ROUTING.CHANGE';
export const ROUTING_DISPLAY_CAPABILITY = 'PROD.ROUTING.DISPLAY';
export const ROUTING_ROUTE = '/production/routings';
export const ROUTING_DISPLAY_ROUTE = '/production/routing-display';
export const ROUTING_LOCK = 'ROUTING';
export const ROUTING_OBJECT = 'routing';
const OPEN_ENDED = '9999-12-31';
const STANDARD_SEQUENCE = '000000';

function executionOrderOf(value: string | number | null | undefined, operationNumber: string): number | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!/^[1-9][0-9]{0,3}$/.test(text)) {
    fail(
      `Operation ${operationNumber} has execution order ${text}. It must be a positive whole number from 1 to 9999. It was not taken from the operation number.`,
    );
  }
  return Number(text);
}

function assignExecutionOrders(
  operations: Array<{ operationNumber: string; executionOrder?: string | number | null }>,
  stored: Map<string, number>,
  omitted: Array<{ operationNumber: string; executionOrder: number }>,
): Map<string, number> {
  const specified = operations.map((row) => executionOrderOf(row.executionOrder, row.operationNumber));
  const present = specified.filter((value) => value != null).length;
  if (present > 0 && present !== operations.length) {
    fail(
      'Execution order was entered for some operations and omitted for others. Nothing was saved.',
      'Enter an order for every operation in this save, or omit it for all of them. The operation number was not used.',
    );
  }
  const assigned = new Map<string, number>();
  if (present === operations.length && operations.length > 0) {
    operations.forEach((row, index) => assigned.set(row.operationNumber, specified[index]!));
  } else {
    const used = new Set(omitted.map((row) => row.executionOrder));
    for (const row of operations) {
      const kept = stored.get(row.operationNumber);
      if (kept == null) continue;
      assigned.set(row.operationNumber, kept);
      used.add(kept);
    }
    // A new operation appends after every stored order, including a deletion-flagged
    // order. A gap is not filled: that would place it before an operation that
    // already has a later order, and it would not be the submitted list order.
    let next = used.size === 0 ? 1 : Math.max(...used) + 1;
    for (const row of operations) {
      if (assigned.has(row.operationNumber)) continue;
      while (used.has(next)) next += 1;
      if (next > 9999) fail(`Operation ${row.operationNumber} has no free execution order from 1 to 9999. Nothing was saved.`);
      assigned.set(row.operationNumber, next);
      used.add(next);
      next += 1;
    }
  }
  const seen = new Map<number, string>();
  for (const [operationNumber, order] of assigned) {
    const other = seen.get(order);
    if (other) {
      fail(
        `Execution order ${order} is used by operation ${other} and operation ${operationNumber}. Nothing was saved.`,
        'Give each operation its own order. The operation number was not used.',
      );
    }
    seen.set(order, operationNumber);
  }
  for (const row of omitted) {
    const other = seen.get(row.executionOrder);
    if (other) {
      fail(
        `Execution order ${row.executionOrder} is already used by operation ${row.operationNumber}, which is not in this save. It was not reassigned.`,
        'Include that operation and give it another order, or choose an order that is free.',
      );
    }
  }
  return assigned;
}

export class RoutingError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'RoutingError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new RoutingError(message, remedy);
}

export function routingCapability(mode: 'CREATE' | 'CHANGE' | 'DISPLAY'): string {
  if (mode === 'CREATE') return ROUTING_CREATE_CAPABILITY;
  if (mode === 'CHANGE') return ROUTING_CHANGE_CAPABILITY;
  return ROUTING_DISPLAY_CAPABILITY;
}

export function holdsRoutingAuthority(held: readonly string[], mode: 'CREATE' | 'CHANGE' | 'DISPLAY'): boolean {
  return hasCapability([...held], routingCapability(mode));
}

export interface RoutingValueInput {
  parameter: string;
  quantity: string;
  unit?: string | null;
}

export interface RoutingAllocationInput {
  materialNumber: string;
  plant?: string | null;
  bomUsage: string;
  alternative: string;
  itemNumber: string;
  quantity?: string | null;
}

export interface RoutingOperationInput {
  operationNumber?: string | null;
  shortText?: string | null;
  workCenter?: string | null;
  controlKey?: string | null;
  standardValueKey?: string | null;
  standardTextKey?: string | null;
  operationQuantity?: string | null;
  operationUnit?: string | null;
  baseQuantity?: string | null;
  baseUnit?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  deletionFlag?: string | null;
  suboperation?: string | null;
  sequenceType?: string | null;
  /** Positive whole number. Omitted means list order on create, stored order on change. */
  executionOrder?: string | number | null;
  values?: RoutingValueInput[];
  allocations?: RoutingAllocationInput[];
}

export interface RoutingAssignmentInput {
  materialNumber: string;
  plant?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  deletionFlag?: string | null;
}

export interface RoutingInput {
  client: string;
  changedBy: string;
  taskListType: string;
  routingGroup?: string | null;
  groupCounter?: string | null;
  plant: string;
  description?: string | null;
  usage: string;
  status?: string | null;
  baseQuantity: string;
  baseUnit: string;
  lotFrom?: string | null;
  lotTo?: string | null;
  validFrom: string;
  validTo?: string | null;
  deletionFlag?: string | null;
  changeNumber?: string | null;
  assignments?: RoutingAssignmentInput[];
  operations?: RoutingOperationInput[];
  version?: number;
  requestKey?: string | null;
  copyFrom?: { taskListType: string; routingGroup: string; groupCounter: string; copyOperations?: boolean } | null;
}

export interface RoutingValueView {
  parameter: string;
  description: string;
  quantity: string;
  unit: string;
}

export interface RoutingAllocationView {
  materialNumber: string;
  plant: string;
  bomUsage: string;
  alternative: string;
  itemNumber: string;
  allocatedQuantity: string | null;
  deletionFlag: 'X' | ' ';
}

export interface RoutingOperationView {
  operationNumber: string;
  sequence: string;
  sequenceType: '0';
  executionOrder: number;
  shortText: string | null;
  workCenter: string | null;
  workCenterDescription: string | null;
  controlKey: string | null;
  standardValueKey: string | null;
  standardTextKey: string | null;
  operationQuantity: string | null;
  operationUnit: string | null;
  baseQuantity: string | null;
  baseUnit: string | null;
  validFrom: string;
  validTo: string;
  deletionFlag: 'X' | ' ';
  schedulingFormula: string | null;
  processingFormula: string | null;
  teardownFormula: string | null;
  formulaCalculated: false;
  values: RoutingValueView[];
  allocations: RoutingAllocationView[];
}

export interface RoutingAssignmentView {
  materialNumber: string;
  materialDescription: string;
  plant: string;
  validFrom: string;
  validTo: string;
  deletionFlag: 'X' | ' ';
}

export interface RoutingView {
  taskListType: string;
  taskListTypeDescription: string;
  routingGroup: string;
  groupCounter: string;
  plant: string;
  plantName: string;
  description: string | null;
  usage: string;
  usageDescription: string;
  status: string | null;
  statusDescription: string | null;
  releasedForScheduling: 'X' | ' ';
  releasedForCosting: 'X' | ' ';
  releasedForOrders: 'X' | ' ';
  baseQuantity: string;
  baseUnit: string;
  lotFrom: string | null;
  lotTo: string | null;
  validFrom: string;
  validTo: string;
  deletionFlag: 'X' | ' ';
  version: number;
  requestKey: string | null;
  sequence: string;
  sequenceType: '0';
  assignments: RoutingAssignmentView[];
  operations: RoutingOperationView[];
  warnings: string[];
  effective: boolean;
  unchangedProductionOrders: number;
}

function dateOf(value: string, label: string): string {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${label} is not a calendar date.`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail(`${label} is not a calendar date.`);
  return text;
}

function flag(value: string | null | undefined, label: string): 'X' | ' ' {
  const text = (value ?? '').trim().toUpperCase();
  if (text === '' || text === ' ') return ' ';
  if (text === 'X') return 'X';
  fail(`${label} must be X or blank. It was not stored.`);
}

function textOf(value: string | null | undefined, label: string, max: number): string | null {
  if (value == null) return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) fail(`${label} is longer than ${max} characters. It was not truncated.`);
  return text;
}

function descriptionOf(value: string, label: string): string {
  const text = textOf(value, label, 40);
  if (!text) fail(`${label} is required.`);
  return text;
}

function codeOf(value: string, label: string, pattern: RegExp): string {
  const text = value.trim().toUpperCase();
  if (!pattern.test(text)) fail(`${label} ${value || '(blank)'} is not valid.`);
  return text;
}

function operationNumberOf(value: string): string {
  const text = value.trim().toUpperCase();
  if (/^[0-9]{1,4}$/.test(text)) {
    if (Number(text) === 0) fail('Operation number 0 is not used.');
    return text.padStart(4, '0');
  }
  if (!/^[A-Z0-9]{4}$/.test(text)) fail(`Operation number ${value} must be four characters, or a number up to 9999.`);
  return text;
}

function counterOf(value: string): string {
  const text = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,2}$/.test(text)) fail(`Group counter ${value} must be one or two letters or digits.`);
  return /^[0-9]$/.test(text) ? text.padStart(2, '0') : text;
}

async function decimalsOf(tx: Tx, code: string): Promise<number> {
  const [row] = await tx.select({ decimalPlaces: unitOfMeasure.decimalPlaces }).from(unitOfMeasure).where(eq(unitOfMeasure.code, code));
  if (!row) fail(`Unit of measure ${code} does not exist.`);
  return row.decimalPlaces;
}

function quantityOf(value: string, label: string, decimals: number): string {
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) fail(`${label} ${value} is not a quantity. It was not rounded.`);
  if ((text.split('.')[1] ?? '').length > Math.min(3, decimals)) fail(`${label} has more decimal places than the unit allows. It was not rounded.`);
  if (!(Number(text) > 0)) fail(`${label} must be positive.`);
  return text;
}

async function proveUnit(tx: Tx, client: string, materialNumber: string, unit: string): Promise<void> {
  try {
    await toBaseQuantity(tx, client, { materialNumber, quantity: 1, entryUnit: unit });
  } catch (error) {
    if (error instanceof UnitConversionError) fail(error.message, error.remedy);
    throw error;
  }
}

function effectiveOn(from: string, to: string, deletion: string, keyDate: string | null): boolean {
  if (deletion === 'X') return false;
  if (!keyDate) return true;
  return keyDate >= from && keyDate <= to;
}

async function readInTx(
  tx: Tx,
  client: string,
  taskListType: string,
  routingGroup: string,
  groupCounter: string,
  keyDate: string | null,
): Promise<RoutingView | null> {
  const [header] = await tx.select().from(routing).where(and(
    eq(routing.client, client),
    eq(routing.taskListType, taskListType),
    eq(routing.routingGroup, routingGroup),
    eq(routing.groupCounter, groupCounter),
  ));
  if (!header) return null;
  const [typeRow] = await tx.select().from(routingTaskListType).where(and(eq(routingTaskListType.client, client), eq(routingTaskListType.taskListType, taskListType)));
  const [usageRow] = await tx.select().from(routingUsage).where(and(eq(routingUsage.client, client), eq(routingUsage.usage, header.usage)));
  const [statusRow] = header.status
    ? await tx.select().from(routingStatus).where(and(eq(routingStatus.client, client), eq(routingStatus.status, header.status)))
    : [undefined];
  const [plantRow] = await tx.select({ name: plantTable.name }).from(plantTable).where(and(eq(plantTable.client, client), eq(plantTable.plant, header.plant)));
  const assignments = await tx.select().from(routingMaterialAssignment).where(and(
    eq(routingMaterialAssignment.client, client),
    eq(routingMaterialAssignment.taskListType, taskListType),
    eq(routingMaterialAssignment.routingGroup, routingGroup),
    eq(routingMaterialAssignment.groupCounter, groupCounter),
  )).orderBy(asc(routingMaterialAssignment.materialNumber));
  const materials = assignments.length === 0 ? [] : await tx.select({
    materialNumber: material.materialNumber,
    description: material.description,
  }).from(material).where(eq(material.client, client));
  const names = new Map(materials.map((row) => [row.materialNumber, row.description]));
  const operations = await tx.select().from(routingOperation).where(and(
    eq(routingOperation.client, client),
    eq(routingOperation.taskListType, taskListType),
    eq(routingOperation.routingGroup, routingGroup),
    eq(routingOperation.groupCounter, groupCounter),
  )).orderBy(asc(routingOperation.executionOrder), asc(routingOperation.operationNumber));
  const centers = await tx.select().from(workCenter).where(and(eq(workCenter.client, client), eq(workCenter.plant, header.plant)));
  const centerByKey = new Map(centers.map((row) => [row.workCenter, row]));
  const values = await tx.select().from(routingOperationValue).where(and(
    eq(routingOperationValue.client, client),
    eq(routingOperationValue.taskListType, taskListType),
    eq(routingOperationValue.routingGroup, routingGroup),
    eq(routingOperationValue.groupCounter, groupCounter),
  ));
  const parameters = await tx.select().from(routingStandardValueParameter).where(eq(routingStandardValueParameter.client, client));
  const parameterNames = new Map(parameters.map((row) => [`${row.standardValueKey}/${row.parameter}`, row.description]));
  const allocations = await tx.select().from(routingComponentAllocation).where(and(
    eq(routingComponentAllocation.client, client),
    eq(routingComponentAllocation.taskListType, taskListType),
    eq(routingComponentAllocation.routingGroup, routingGroup),
    eq(routingComponentAllocation.groupCounter, groupCounter),
  ));
  const [orderCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(productionOrder).where(and(
    eq(productionOrder.client, client),
    eq(productionOrder.plant, header.plant),
  ));
  return {
    taskListType,
    taskListTypeDescription: typeRow?.description ?? '',
    routingGroup,
    groupCounter,
    plant: header.plant,
    plantName: plantRow?.name ?? '',
    description: header.description,
    usage: header.usage,
    usageDescription: usageRow?.description ?? '',
    status: header.status,
    statusDescription: statusRow?.description ?? null,
    releasedForScheduling: statusRow?.releasedForScheduling === 'X' ? 'X' : ' ',
    releasedForCosting: statusRow?.releasedForCosting === 'X' ? 'X' : ' ',
    releasedForOrders: statusRow?.releasedForOrders === 'X' ? 'X' : ' ',
    baseQuantity: header.baseQuantity,
    baseUnit: header.baseUnit,
    lotFrom: header.lotFrom,
    lotTo: header.lotTo,
    validFrom: header.validFrom,
    validTo: header.validTo,
    deletionFlag: header.deletionFlag === 'X' ? 'X' : ' ',
    version: header.version,
    requestKey: header.requestKey,
    sequence: STANDARD_SEQUENCE,
    sequenceType: '0',
    assignments: assignments.map((row) => ({
      materialNumber: row.materialNumber,
      materialDescription: names.get(row.materialNumber) ?? '',
      plant: row.plant,
      validFrom: row.validFrom,
      validTo: row.validTo,
      deletionFlag: row.deletionFlag === 'X' ? 'X' : ' ',
    })),
    operations: operations.map((row) => {
      const center = row.workCenter ? centerByKey.get(row.workCenter) : undefined;
      return {
        operationNumber: row.operationNumber,
        sequence: STANDARD_SEQUENCE,
        sequenceType: '0' as const,
        executionOrder: row.executionOrder,
        shortText: row.shortText,
        workCenter: row.workCenter,
        workCenterDescription: center?.description ?? null,
        controlKey: row.controlKey,
        standardValueKey: row.standardValueKey,
        standardTextKey: row.standardTextKey,
        operationQuantity: row.operationQuantity,
        operationUnit: row.operationUnit,
        baseQuantity: row.baseQuantity,
        baseUnit: row.baseUnit,
        validFrom: row.validFrom,
        validTo: row.validTo,
        deletionFlag: row.deletionFlag === 'X' ? 'X' : ' ',
        schedulingFormula: center?.schedulingSetupFormula ?? null,
        processingFormula: center?.schedulingProcessingFormula ?? null,
        teardownFormula: center?.schedulingTeardownFormula ?? null,
        formulaCalculated: false as const,
        values: values.filter((value) => value.operationNumber === row.operationNumber).map((value) => ({
          parameter: value.parameter,
          description: parameterNames.get(`${value.standardValueKey}/${value.parameter}`) ?? '',
          quantity: value.quantity,
          unit: value.unit,
        })),
        allocations: allocations.filter((item) => item.operationNumber === row.operationNumber).map((item) => ({
          materialNumber: item.materialNumber,
          plant: item.plant,
          bomUsage: item.bomUsage,
          alternative: item.alternative,
          itemNumber: item.itemNumber,
          allocatedQuantity: item.allocatedQuantity,
          deletionFlag: item.deletionFlag === 'X' ? 'X' as const : ' ' as const,
        })),
      };
    }),
    warnings: [],
    effective: effectiveOn(header.validFrom, header.validTo, header.deletionFlag, keyDate),
    unchangedProductionOrders: orderCount?.n ?? 0,
  };
}

function snapshot(view: RoutingView): Record<string, unknown> {
  const flat: Record<string, unknown> = {
    description: view.description,
    usage: view.usage,
    status: view.status,
    baseQuantity: view.baseQuantity,
    baseUnit: view.baseUnit,
    lotFrom: view.lotFrom,
    lotTo: view.lotTo,
    validFrom: view.validFrom,
    validTo: view.validTo,
    deletionFlag: view.deletionFlag,
    sequence: view.sequence,
  };
  for (const assignment of view.assignments) {
    flat[`assignment.${assignment.materialNumber}`] = assignment.deletionFlag;
  }
  for (const operation of view.operations) {
    const prefix = `operation.${operation.operationNumber}`;
    flat[`${prefix}.text`] = operation.shortText;
    flat[`${prefix}.executionOrder`] = operation.executionOrder;
    flat[`${prefix}.workCenter`] = operation.workCenter;
    flat[`${prefix}.controlKey`] = operation.controlKey;
    flat[`${prefix}.deletion`] = operation.deletionFlag;
    for (const value of operation.values) flat[`${prefix}.${value.parameter}`] = value.quantity;
  }
  return flat;
}

async function nextGroup(tx: Tx, client: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/routing-group`}, 0))`);
  const [row] = await tx.select({ n: sql<string | null>`max(${routing.routingGroup})` }).from(routing);
  const current = row?.n && /^[0-9]{8}$/.test(row.n) ? Number(row.n) : 0;
  const next = String(current + 1).padStart(8, '0');
  if (next.length > 8) fail('No routing group remains.');
  return next;
}

async function nextCounter(tx: Tx, client: string, taskListType: string, routingGroup: string): Promise<string> {
  const rows = await tx.select({ groupCounter: routing.groupCounter }).from(routing).where(and(
    eq(routing.client, client), eq(routing.taskListType, taskListType), eq(routing.routingGroup, routingGroup),
  ));
  const used = new Set(rows.map((row) => row.groupCounter));
  for (let n = 1; n <= 99; n += 1) {
    const key = String(n).padStart(2, '0');
    if (!used.has(key)) return key;
  }
  fail('No group counter from 01 to 99 is free.');
}

async function writeRouting(input: RoutingInput, mode: 'CREATE' | 'CHANGE'): Promise<RoutingView> {
  if ((input.changeNumber ?? '').trim()) {
    fail('Engineering change management is not implemented. A change number is not stored.', 'Save without a change number. Validity is the from and to dates.');
  }
  if ((input.operations ?? []).some((operation) => (operation.suboperation ?? '').trim())) {
    fail('A suboperation is not implemented.');
  }
  if ((input.operations ?? []).some((operation) => {
    const sequenceType = (operation.sequenceType ?? '').trim();
    return sequenceType !== '' && sequenceType !== '0';
  })) {
    fail('Alternative and parallel sequences are not implemented. Sequence type 0 is the only sequence.', 'Use the standard sequence. It was not stored as a flat list of another type.');
  }
  const taskListType = codeOf(input.taskListType, 'Task list type', /^[A-Z0-9]$/);
  const plant = input.plant.trim();
  if (!plant) fail('Plant is required.');
  const usage = codeOf(input.usage, 'Routing usage', /^[A-Z0-9]{1,3}$/);
  const validFrom = dateOf(input.validFrom, 'Valid from');
  const validTo = input.validTo?.trim() ? dateOf(input.validTo, 'Valid to') : OPEN_ENDED;
  if (validTo < validFrom) fail('Valid-to is before valid-from.');
  const description = textOf(input.description, 'Description', 40);
  const baseUnit = input.baseUnit.trim().toUpperCase();
  if (!baseUnit) fail('Base unit is required.');
  const lotFromText = (input.lotFrom ?? '').trim();
  const lotToText = (input.lotTo ?? '').trim();
  if ((lotFromText && !lotToText) || (!lotFromText && lotToText)) fail('Lot-size from and to must both be entered, or both left blank.');
  const requestKey = textOf(input.requestKey, 'Request key', 64);

  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/routing/${taskListType}`}, 0))`);
    if (mode === 'CREATE' && requestKey) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/routing-request/${requestKey}`}, 0))`);
      const [prior] = await tx.select().from(routing).where(and(eq(routing.client, input.client), eq(routing.requestKey, requestKey)));
      if (prior) {
        const standing = await readInTx(tx, input.client, prior.taskListType, prior.routingGroup, prior.groupCounter, null);
        if (!standing) fail('The earlier request could not be read.');
        standing.warnings = ['This request was already saved. The standing routing was returned. The new values were not applied.'];
        return standing;
      }
    }
    const [typeRow] = await tx.select().from(routingTaskListType).where(and(
      eq(routingTaskListType.client, input.client), eq(routingTaskListType.taskListType, taskListType),
    ));
    if (!typeRow) fail(`Task list type ${taskListType} is not defined.`);
    const [usageRow] = await tx.select().from(routingUsage).where(and(eq(routingUsage.client, input.client), eq(routingUsage.usage, usage)));
    if (!usageRow) fail(`Routing usage ${usage} is not defined.`);
    const [plantRow] = await tx.select({ plant: plantTable.plant }).from(plantTable).where(and(eq(plantTable.client, input.client), eq(plantTable.plant, plant)));
    if (!plantRow) fail(`Plant ${plant} does not exist.`);
    const baseDecimals = await decimalsOf(tx, baseUnit);
    const baseQuantity = quantityOf(input.baseQuantity, 'Base quantity', baseDecimals);
    let lotFrom: string | null = null;
    let lotTo: string | null = null;
    if (lotFromText) {
      if (!/^\d+(\.\d+)?$/.test(lotFromText) || Number(lotFromText) < 0) fail('Lot-size from must be zero or positive. It was not rounded.');
      if ((lotFromText.split('.')[1] ?? '').length > 3) fail('Lot-size from has more than three decimal places. It was not rounded.');
      lotFrom = lotFromText;
      if (!/^\d+(\.\d+)?$/.test(lotToText) || Number(lotToText) < 0) fail('Lot-size to must be zero or positive. It was not rounded.');
      if ((lotToText.split('.')[1] ?? '').length > 3) fail('Lot-size to has more than three decimal places. It was not rounded.');
      lotTo = lotToText;
      if (Number(lotTo) < Number(lotFrom)) fail('Lot-size from is above lot-size to.');
    }
    const routingGroup = input.routingGroup?.trim()
      ? codeOf(input.routingGroup, 'Routing group', /^[A-Z0-9]{1,8}$/)
      : mode === 'CREATE' ? await nextGroup(tx, input.client) : fail('Routing group is required to change a routing.');
    const groupCounter = input.groupCounter?.trim()
      ? counterOf(input.groupCounter)
      : mode === 'CREATE' ? await nextCounter(tx, input.client, taskListType, routingGroup) : fail('Group counter is required to change a routing.');
    const [beforeRow] = await tx.select().from(routing).where(and(
      eq(routing.client, input.client),
      eq(routing.taskListType, taskListType),
      eq(routing.routingGroup, routingGroup),
      eq(routing.groupCounter, groupCounter),
    ));
    if (mode === 'CREATE' && beforeRow) fail(`Routing ${taskListType} ${routingGroup} ${groupCounter} already exists.`);
    if (mode === 'CHANGE' && !beforeRow) fail(`Routing ${taskListType} ${routingGroup} ${groupCounter} does not exist.`);
    if (mode === 'CHANGE' && beforeRow!.plant !== plant) fail('The plant cannot be changed.');
    if (mode === 'CHANGE' && (input.version == null || input.version !== beforeRow!.version)) {
      fail('The routing was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    let status: string | null = mode === 'CHANGE' ? beforeRow?.status ?? null : null;
    if (input.status !== undefined) {
      status = input.status?.trim() ? codeOf(input.status, 'Routing status', /^[A-Z0-9]{1,3}$/) : null;
      if (status) {
        const [statusRow] = await tx.select().from(routingStatus).where(and(eq(routingStatus.client, input.client), eq(routingStatus.status, status)));
        if (!statusRow) fail(`Routing status ${status} is not defined.`);
      }
    }
    const before = beforeRow ? await readInTx(tx, input.client, taskListType, routingGroup, groupCounter, null) : null;
    let sourceOperations = input.operations;
    if (mode === 'CREATE' && input.copyFrom && input.copyFrom.copyOperations !== false && (!sourceOperations || sourceOperations.length === 0)) {
      const copied = await readInTx(tx, input.client, codeOf(input.copyFrom.taskListType, 'Task list type', /^[A-Z0-9]$/), codeOf(input.copyFrom.routingGroup, 'Routing group', /^[A-Z0-9]{1,8}$/), counterOf(input.copyFrom.groupCounter), null);
      if (!copied) fail('The reference routing does not exist.');
      sourceOperations = copied.operations.filter((operation) => operation.deletionFlag !== 'X').map((operation) => ({
        ...operation,
        deletionFlag: ' ',
        values: operation.values,
        allocations: [],
      }));
    }
    const assignmentInput = input.assignments ?? [];
    const preparedAssignments = [];
    for (const raw of assignmentInput) {
      const materialNumber = raw.materialNumber.trim();
      if (!materialNumber) fail('A material assignment needs a material.');
      const assignmentPlant = (raw.plant ?? '').trim() || plant;
      if (assignmentPlant !== plant) fail(`Material ${materialNumber} cannot be assigned in plant ${assignmentPlant}. The routing plant is ${plant}.`);
      const [extended] = await tx.select({ materialNumber: materialPlant.materialNumber }).from(materialPlant).where(and(
        eq(materialPlant.client, input.client), eq(materialPlant.materialNumber, materialNumber), eq(materialPlant.plant, plant),
      ));
      if (!extended) fail(`Material ${materialNumber} is not extended to plant ${plant}.`);
      await proveUnit(tx, input.client, materialNumber, baseUnit);
      const assignmentFrom = raw.validFrom?.trim() ? dateOf(raw.validFrom, 'Assignment valid from') : validFrom;
      const assignmentTo = raw.validTo?.trim() ? dateOf(raw.validTo, 'Assignment valid to') : validTo;
      if (assignmentTo < assignmentFrom || assignmentFrom < validFrom || assignmentTo > validTo) fail(`The assignment for ${materialNumber} is outside the routing validity.`);
      preparedAssignments.push({
        materialNumber,
        plant,
        validFrom: assignmentFrom,
        validTo: assignmentTo,
        deletionFlag: mode === 'CHANGE' ? flag(raw.deletionFlag, 'Assignment deletion flag') : ' ' as const,
      });
    }
    const controls = await tx.select().from(routingControlKey).where(eq(routingControlKey.client, input.client));
    const controlByKey = new Map(controls.map((row) => [row.controlKey, row]));
    const valueKeys = await tx.select().from(routingStandardValueParameter).where(eq(routingStandardValueParameter.client, input.client));
    const reserved = new Set((before?.operations ?? []).map((operation) => operation.operationNumber));
    const preparedOperations = [];
    const used = new Set<string>();
    let cursor = 10;
    for (const raw of sourceOperations ?? []) {
      let operationNumber = raw.operationNumber?.trim() ? operationNumberOf(raw.operationNumber) : '';
      if (!operationNumber) {
        while (cursor <= 9990 && (used.has(String(cursor).padStart(4, '0')) || reserved.has(String(cursor).padStart(4, '0')))) cursor += 10;
        if (cursor > 9990) fail('No operation number remains.');
        operationNumber = String(cursor).padStart(4, '0');
        cursor += 10;
      }
      if (used.has(operationNumber)) fail(`Operation number ${operationNumber} is repeated.`);
      used.add(operationNumber);
      const workCenterCode = (raw.workCenter ?? '').trim().toUpperCase();
      let center = null;
      if (workCenterCode) {
        const [row] = await tx.select().from(workCenter).where(and(
          eq(workCenter.client, input.client), eq(workCenter.plant, plant), eq(workCenter.workCenter, workCenterCode),
        ));
        if (!row) fail(`Work center ${workCenterCode} does not exist in plant ${plant}.`);
        if (row.deletionFlag === 'X') fail(`Work center ${workCenterCode} is marked for deletion.`);
        center = row;
      }
      let controlKey = (raw.controlKey ?? '').trim().toUpperCase() || center?.controlKey || '';
      if (controlKey) controlKey = codeOf(controlKey, 'Control key', /^[A-Z0-9]{1,4}$/);
      if (!controlKey && typeRow.requireControlKey === 'X') fail(`Operation ${operationNumber} requires a control key.`);
      const control = controlKey ? controlByKey.get(controlKey) : undefined;
      if (controlKey && !control) fail(`Control key ${controlKey} is not defined.`);
      if (control?.requireWorkCenter === 'X' && !workCenterCode) fail(`Control key ${controlKey} requires a work center.`);
      let standardValueKey = (raw.standardValueKey ?? '').trim().toUpperCase() || center?.standardValueKey || '';
      if (standardValueKey) {
        standardValueKey = codeOf(standardValueKey, 'Standard value key', /^[A-Z0-9]{1,4}$/);
        const [keyRow] = await tx.select().from(routingStandardValueKey).where(and(
          eq(routingStandardValueKey.client, input.client), eq(routingStandardValueKey.standardValueKey, standardValueKey),
        ));
        if (!keyRow) fail(`Standard value key ${standardValueKey} is not defined.`);
      }
      const parameters = valueKeys.filter((row) => row.standardValueKey === standardValueKey);
      const values = [];
      for (const value of raw.values ?? []) {
        const parameter = codeOf(value.parameter, 'Standard value parameter', /^[A-Z0-9]{1,6}$/);
        const definition = parameters.find((row) => row.parameter === parameter);
        if (!definition) fail(`Parameter ${parameter} is not defined for standard value key ${standardValueKey || '(none)'}.`);
        const unit = (value.unit ?? '').trim().toUpperCase() || definition.unit || '';
        if (!unit) fail(`Parameter ${parameter} needs a unit.`);
        if (definition.unit && unit !== definition.unit) fail(`Parameter ${parameter} must use unit ${definition.unit}. ${unit} was not substituted.`);
        await decimalsOf(tx, unit);
        values.push({ parameter, quantity: quantityOf(value.quantity, `Parameter ${parameter}`, await decimalsOf(tx, unit)), unit });
      }
      for (const definition of parameters) {
        if (definition.required === 'X' && !values.some((value) => value.parameter === definition.parameter)) {
          fail(`Parameter ${definition.parameter} is required for standard value key ${standardValueKey}.`);
        }
      }
      const operationUnit = (raw.operationUnit ?? '').trim().toUpperCase();
      const operationQuantity = (raw.operationQuantity ?? '').trim();
      if (operationQuantity && !operationUnit) fail(`Operation ${operationNumber} has a quantity and no unit.`);
      if (operationQuantity) {
        await decimalsOf(tx, operationUnit);
        quantityOf(operationQuantity, `Operation ${operationNumber} quantity`, await decimalsOf(tx, operationUnit));
      }
      const operationBaseUnit = (raw.baseUnit ?? '').trim().toUpperCase() || baseUnit;
      const operationBaseQuantity = (raw.baseQuantity ?? '').trim()
        ? quantityOf(raw.baseQuantity ?? '', `Operation ${operationNumber} base quantity`, await decimalsOf(tx, operationBaseUnit))
        : baseQuantity;
      await decimalsOf(tx, operationBaseUnit);
      const standardTextKey = textOf(raw.standardTextKey, 'Standard text key', 7);
      if (standardTextKey && !/^[A-Z0-9]{1,7}$/.test(standardTextKey.toUpperCase())) fail(`Standard text key ${standardTextKey} is not valid. No text catalog was read.`);
      const operationFrom = raw.validFrom?.trim() ? dateOf(raw.validFrom, `Operation ${operationNumber} valid from`) : validFrom;
      const operationTo = raw.validTo?.trim() ? dateOf(raw.validTo, `Operation ${operationNumber} valid to`) : validTo;
      if (operationTo < operationFrom || operationFrom < validFrom || operationTo > validTo) fail(`Operation ${operationNumber} validity is outside the routing validity.`);
      preparedOperations.push({
        operationNumber,
        shortText: textOf(raw.shortText, 'Operation short text', 40),
        workCenter: workCenterCode || null,
        controlKey: controlKey || null,
        standardValueKey: standardValueKey || null,
        standardTextKey: standardTextKey ? standardTextKey.toUpperCase() : null,
        operationQuantity: operationQuantity || null,
        operationUnit: operationQuantity ? operationUnit : null,
        baseQuantity: operationBaseQuantity,
        baseUnit: operationBaseUnit,
        validFrom: operationFrom,
        validTo: operationTo,
        deletionFlag: mode === 'CHANGE' ? flag(raw.deletionFlag, 'Operation deletion flag') : ' ' as const,
        executionOrder: raw.executionOrder,
        values,
        allocations: raw.allocations ?? [],
      });
    }
    const activeAssignments = new Set(preparedAssignments.filter((row) => row.deletionFlag !== 'X').map((row) => row.materialNumber));
    for (const existing of before?.assignments ?? []) {
      if (!preparedAssignments.some((row) => row.materialNumber === existing.materialNumber) && existing.deletionFlag !== 'X') {
        activeAssignments.add(existing.materialNumber);
      }
    }
    const preparedAllocations = [];
    for (const operation of preparedOperations) {
      for (const raw of operation.allocations) {
        const materialNumber = raw.materialNumber.trim();
        const bomUsage = codeOf(raw.bomUsage, 'BOM usage', /^[A-Z0-9]$/);
        const alternative = counterOf(raw.alternative);
        const itemNumber = operationNumberOf(raw.itemNumber);
        if (!activeAssignments.has(materialNumber)) fail(`Material ${materialNumber} is not assigned to this routing. The BOM was not changed.`);
        const [item] = await tx.select().from(materialBomItem).where(and(
          eq(materialBomItem.client, input.client),
          eq(materialBomItem.materialNumber, materialNumber),
          eq(materialBomItem.plant, plant),
          eq(materialBomItem.usage, bomUsage),
          eq(materialBomItem.alternative, alternative),
          eq(materialBomItem.itemNumber, itemNumber),
        ));
        if (!item || item.deletionFlag === 'X') fail(`BOM item ${itemNumber} does not exist for ${materialNumber}. It was not created.`);
        let allocatedQuantity: string | null = null;
        if ((raw.quantity ?? '').trim()) {
          if (!item.quantity || !item.unit) fail(`BOM item ${itemNumber} has no quantity to allocate.`);
          allocatedQuantity = quantityOf(raw.quantity ?? '', 'Allocated quantity', await decimalsOf(tx, item.unit));
          if (Number(allocatedQuantity) > Number(item.quantity)) fail(`Allocated quantity is above the BOM item quantity. It was not clamped.`);
        }
        preparedAllocations.push({
          operationNumber: operation.operationNumber,
          materialNumber,
          plant,
          bomUsage,
          alternative,
          itemNumber,
          allocatedQuantity,
          deletionFlag: ' ' as const,
        });
      }
    }
    const storedOrders = new Map((before?.operations ?? []).map((row) => [row.operationNumber, row.executionOrder]));
    const omitted = (before?.operations ?? [])
      .filter((row) => !preparedOperations.some((operation) => operation.operationNumber === row.operationNumber))
      .map((row) => ({ operationNumber: row.operationNumber, executionOrder: row.executionOrder }));
    const executionOrders = assignExecutionOrders(preparedOperations, storedOrders, omitted);
    const deletionFlag = mode === 'CREATE' ? ' ' : flag(input.deletionFlag, 'Deletion flag');
    if (mode === 'CREATE') {
      await tx.insert(routing).values({
        client: input.client, taskListType, routingGroup, groupCounter, plant, description, usage, status,
        baseQuantity, baseUnit, lotFrom, lotTo, validFrom, validTo, deletionFlag, requestKey, createdBy: input.changedBy,
      });
      await tx.insert(routingSequence).values({
        client: input.client, taskListType, routingGroup, groupCounter, sequence: STANDARD_SEQUENCE, sequenceType: '0', createdBy: input.changedBy,
      });
      await markActivityComplete(tx, input.client, ROUTING_ACTIVITY, input.changedBy);
    } else {
      const updated = await tx.update(routing).set({
        description, usage, status, baseQuantity, baseUnit, lotFrom, lotTo, validFrom, validTo, deletionFlag,
        version: beforeRow!.version + 1, changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(routing.client, input.client), eq(routing.taskListType, taskListType), eq(routing.routingGroup, routingGroup),
        eq(routing.groupCounter, groupCounter), eq(routing.version, beforeRow!.version),
      )).returning({ version: routing.version });
      if (updated.length === 0) fail('The routing was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    const headerKey = and(
      eq(routingOperation.client, input.client), eq(routingOperation.taskListType, taskListType),
      eq(routingOperation.routingGroup, routingGroup), eq(routingOperation.groupCounter, groupCounter),
    );
    const existingOperations = mode === 'CHANGE' ? await tx.select().from(routingOperation).where(headerKey) : [];
    const incomingNumbers = new Set(preparedOperations.map((operation) => operation.operationNumber));
    for (const row of existingOperations) {
      if (incomingNumbers.has(row.operationNumber)) continue;
      await tx.update(routingOperation).set({ deletionFlag: 'X', changedBy: input.changedBy, changedAt: new Date() })
        .where(and(headerKey, eq(routingOperation.operationNumber, row.operationNumber)));
    }
    for (const operation of preparedOperations) {
      const values = {
        shortText: operation.shortText, plant, workCenter: operation.workCenter, controlKey: operation.controlKey,
        standardValueKey: operation.standardValueKey, standardTextKey: operation.standardTextKey,
        operationQuantity: operation.operationQuantity, operationUnit: operation.operationUnit,
        baseQuantity: operation.baseQuantity, baseUnit: operation.baseUnit, validFrom: operation.validFrom,
        validTo: operation.validTo, deletionFlag: operation.deletionFlag, sequence: STANDARD_SEQUENCE,
        executionOrder: executionOrders.get(operation.operationNumber)!,
      };
      if (existingOperations.some((row) => row.operationNumber === operation.operationNumber)) {
        await tx.update(routingOperation).set({ ...values, changedBy: input.changedBy, changedAt: new Date() })
          .where(and(headerKey, eq(routingOperation.operationNumber, operation.operationNumber)));
        await tx.delete(routingOperationValue).where(and(
          eq(routingOperationValue.client, input.client), eq(routingOperationValue.taskListType, taskListType),
          eq(routingOperationValue.routingGroup, routingGroup), eq(routingOperationValue.groupCounter, groupCounter),
          eq(routingOperationValue.operationNumber, operation.operationNumber),
        ));
      } else {
        await tx.insert(routingOperation).values({
          client: input.client, taskListType, routingGroup, groupCounter, operationNumber: operation.operationNumber, ...values, createdBy: input.changedBy,
        });
      }
      for (const value of operation.values) {
        await tx.insert(routingOperationValue).values({
          client: input.client, taskListType, routingGroup, groupCounter, operationNumber: operation.operationNumber,
          standardValueKey: operation.standardValueKey!, parameter: value.parameter, quantity: value.quantity, unit: value.unit, createdBy: input.changedBy,
        });
      }
    }
    const existingAssignments = mode === 'CHANGE' ? await tx.select().from(routingMaterialAssignment).where(and(
      eq(routingMaterialAssignment.client, input.client), eq(routingMaterialAssignment.taskListType, taskListType),
      eq(routingMaterialAssignment.routingGroup, routingGroup), eq(routingMaterialAssignment.groupCounter, groupCounter),
    )) : [];
    const incomingMaterials = new Set(preparedAssignments.map((row) => row.materialNumber));
    for (const row of existingAssignments) {
      if (incomingMaterials.has(row.materialNumber)) continue;
      await tx.update(routingMaterialAssignment).set({ deletionFlag: 'X', changedBy: input.changedBy, changedAt: new Date() }).where(and(
        eq(routingMaterialAssignment.client, input.client), eq(routingMaterialAssignment.taskListType, taskListType),
        eq(routingMaterialAssignment.routingGroup, routingGroup), eq(routingMaterialAssignment.groupCounter, groupCounter),
        eq(routingMaterialAssignment.materialNumber, row.materialNumber), eq(routingMaterialAssignment.plant, plant),
      ));
    }
    for (const assignment of preparedAssignments) {
      if (existingAssignments.some((row) => row.materialNumber === assignment.materialNumber)) {
        await tx.update(routingMaterialAssignment).set({ ...assignment, changedBy: input.changedBy, changedAt: new Date() }).where(and(
          eq(routingMaterialAssignment.client, input.client), eq(routingMaterialAssignment.taskListType, taskListType),
          eq(routingMaterialAssignment.routingGroup, routingGroup), eq(routingMaterialAssignment.groupCounter, groupCounter),
          eq(routingMaterialAssignment.materialNumber, assignment.materialNumber),
        ));
      } else {
        await tx.insert(routingMaterialAssignment).values({
          client: input.client, taskListType, routingGroup, groupCounter, ...assignment, createdBy: input.changedBy,
        });
      }
    }
    const existingAllocations = mode === 'CHANGE' ? await tx.select().from(routingComponentAllocation).where(and(
      eq(routingComponentAllocation.client, input.client), eq(routingComponentAllocation.taskListType, taskListType),
      eq(routingComponentAllocation.routingGroup, routingGroup), eq(routingComponentAllocation.groupCounter, groupCounter),
    )) : [];
    const incomingAllocation = new Set(preparedAllocations.map((row) => `${row.operationNumber}/${row.materialNumber}/${row.bomUsage}/${row.alternative}/${row.itemNumber}`));
    for (const row of existingAllocations) {
      const key = `${row.operationNumber}/${row.materialNumber}/${row.bomUsage}/${row.alternative}/${row.itemNumber}`;
      if (incomingAllocation.has(key)) continue;
      await tx.update(routingComponentAllocation).set({ deletionFlag: 'X', changedBy: input.changedBy, changedAt: new Date() }).where(and(
        eq(routingComponentAllocation.client, input.client), eq(routingComponentAllocation.taskListType, taskListType),
        eq(routingComponentAllocation.routingGroup, routingGroup), eq(routingComponentAllocation.groupCounter, groupCounter),
        eq(routingComponentAllocation.operationNumber, row.operationNumber), eq(routingComponentAllocation.itemNumber, row.itemNumber),
      ));
    }
    for (const allocation of preparedAllocations) {
      const standing = existingAllocations.find((row) => row.operationNumber === allocation.operationNumber && row.itemNumber === allocation.itemNumber && row.materialNumber === allocation.materialNumber);
      if (standing) {
        await tx.update(routingComponentAllocation).set({ allocatedQuantity: allocation.allocatedQuantity, deletionFlag: ' ', changedBy: input.changedBy, changedAt: new Date() }).where(and(
          eq(routingComponentAllocation.client, input.client), eq(routingComponentAllocation.operationNumber, allocation.operationNumber),
          eq(routingComponentAllocation.itemNumber, allocation.itemNumber), eq(routingComponentAllocation.routingGroup, routingGroup),
        ));
      } else {
        await tx.insert(routingComponentAllocation).values({
          client: input.client, taskListType, routingGroup, groupCounter, ...allocation, createdBy: input.changedBy,
        });
      }
    }
    const after = await readInTx(tx, input.client, taskListType, routingGroup, groupCounter, null);
    if (!after) fail('The routing was not saved.');
    await recordChange(tx, {
      client: input.client, objectClass: ROUTING_OBJECT, objectKey: `${taskListType}/${routingGroup}/${groupCounter}`,
      changeType: mode === 'CREATE' ? 'CREATE' : 'CHANGE', changedBy: input.changedBy,
      transactionCode: mode === 'CREATE' ? 'CA01' : 'CA02', correlationId: requestKey ?? undefined,
      before: before ? snapshot(before) : undefined, after: snapshot(after),
    });
    return after;
  });
}

export function createRouting(input: RoutingInput): Promise<RoutingView> {
  return writeRouting(input, 'CREATE');
}

export function changeRouting(input: RoutingInput): Promise<RoutingView> {
  return writeRouting(input, 'CHANGE');
}

export async function getRouting(client: string, taskListType: string, routingGroup: string, groupCounter: string, keyDate?: string | null): Promise<RoutingView | null> {
  return withTenant(client, (tx) => readInTx(
    tx, client, codeOf(taskListType, 'Task list type', /^[A-Z0-9]$/), codeOf(routingGroup, 'Routing group', /^[A-Z0-9]{1,8}$/), counterOf(groupCounter), keyDate?.trim() ? dateOf(keyDate, 'Key date') : null,
  ));
}

export async function listRoutings(client: string, filter: { materialNumber?: string; plant?: string; taskListType?: string } = {}) {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(routing).where(eq(routing.client, client)).orderBy(asc(routing.routingGroup), asc(routing.groupCounter));
    const assignments = await tx.select().from(routingMaterialAssignment).where(eq(routingMaterialAssignment.client, client));
    return rows.filter((row) => {
      if (filter.plant && row.plant !== filter.plant.trim()) return false;
      if (filter.taskListType && row.taskListType !== codeOf(filter.taskListType, 'Task list type', /^[A-Z0-9]$/)) return false;
      if (filter.materialNumber) {
        return assignments.some((assignment) => assignment.taskListType === row.taskListType && assignment.routingGroup === row.routingGroup && assignment.groupCounter === row.groupCounter && assignment.materialNumber === filter.materialNumber!.trim() && assignment.deletionFlag !== 'X');
      }
      return true;
    }).map((row) => ({
      taskListType: row.taskListType,
      routingGroup: row.routingGroup,
      groupCounter: row.groupCounter,
      plant: row.plant,
      usage: row.usage,
      status: row.status,
      validFrom: row.validFrom,
      validTo: row.validTo,
      deletionFlag: row.deletionFlag,
      materials: assignments.filter((assignment) => assignment.routingGroup === row.routingGroup && assignment.groupCounter === row.groupCounter && assignment.deletionFlag !== 'X').map((assignment) => assignment.materialNumber),
    }));
  });
}

export async function resolveRouting(client: string, filter: { taskListType?: string; routingGroup?: string; groupCounter?: string; materialNumber?: string; plant?: string; keyDate?: string | null }): Promise<RoutingView | null> {
  if (filter.taskListType && filter.routingGroup && filter.groupCounter) {
    return getRouting(client, filter.taskListType, filter.routingGroup, filter.groupCounter, filter.keyDate);
  }
  const rows = await listRoutings(client, filter);
  const dated = filter.keyDate?.trim()
    ? rows.filter((row) => row.deletionFlag !== 'X' && filter.keyDate! >= row.validFrom && filter.keyDate! <= row.validTo)
    : rows;
  if (dated.length === 0) return null;
  if (dated.length > 1) {
    fail(`More than one routing matches. Choose a group and counter: ${dated.map((row) => `${row.routingGroup}/${row.groupCounter}`).join(', ')}.`, 'The first row was not opened.');
  }
  return getRouting(client, dated[0].taskListType, dated[0].routingGroup, dated[0].groupCounter, filter.keyDate);
}

/** Downstream selection. Does not write. CO01 and costing do not call this. */
export async function selectEffectiveRouting(client: string, input: {
  materialNumber: string;
  plant: string;
  keyDate: string;
  lotSize?: string | null;
  taskListType?: string | null;
  routingGroup?: string | null;
  groupCounter?: string | null;
  forUse?: 'SCHEDULING' | 'COSTING' | 'ORDER' | null;
}): Promise<RoutingView | null> {
  const keyDate = dateOf(input.keyDate, 'Key date');
  const lotSize = (input.lotSize ?? '').trim();
  return withTenant(client, async (tx) => {
    const assignments = await tx.select().from(routingMaterialAssignment).where(and(
      eq(routingMaterialAssignment.client, client),
      eq(routingMaterialAssignment.materialNumber, input.materialNumber.trim()),
      eq(routingMaterialAssignment.plant, input.plant.trim()),
      eq(routingMaterialAssignment.deletionFlag, ' '),
    ));
    const headers = await tx.select().from(routing).where(and(eq(routing.client, client), eq(routing.plant, input.plant.trim()), eq(routing.deletionFlag, ' ')));
    const matches = headers.filter((header) => {
      if (input.taskListType && header.taskListType !== codeOf(input.taskListType, 'Task list type', /^[A-Z0-9]$/)) return false;
      if (input.routingGroup && header.routingGroup !== codeOf(input.routingGroup, 'Routing group', /^[A-Z0-9]{1,8}$/)) return false;
      if (input.groupCounter && header.groupCounter !== counterOf(input.groupCounter)) return false;
      if (keyDate < header.validFrom || keyDate > header.validTo) return false;
      if (lotSize && header.lotFrom != null && header.lotTo != null && (Number(lotSize) < Number(header.lotFrom) || Number(lotSize) > Number(header.lotTo))) return false;
      return assignments.some((assignment) => assignment.taskListType === header.taskListType && assignment.routingGroup === header.routingGroup && assignment.groupCounter === header.groupCounter && keyDate >= assignment.validFrom && keyDate <= assignment.validTo);
    });
    if (!input.routingGroup || !input.groupCounter) {
      if (matches.length === 0) return null;
      if (matches.length > 1) fail(`More than one routing is effective on ${keyDate}. Choose a group and counter: ${matches.map((row) => `${row.routingGroup}/${row.groupCounter}`).join(', ')}.`);
    }
    const chosen = matches[0];
    if (!chosen) return null;
    const view = await readInTx(tx, client, chosen.taskListType, chosen.routingGroup, chosen.groupCounter, keyDate);
    if (!view || !view.effective) return null;
    if (input.forUse) {
      const released = input.forUse === 'SCHEDULING' ? view.releasedForScheduling : input.forUse === 'COSTING' ? view.releasedForCosting : view.releasedForOrders;
      if (released !== 'X') fail(`Routing status ${view.status ?? '(none)'} is not released for ${input.forUse}. The routing was not selected.`);
    }
    return { ...view, operations: view.operations.filter((operation) => operation.deletionFlag !== 'X') };
  });
}

async function saveConfig<T extends { client: string; changedBy: string; version?: number }>(
  input: T,
  load: (tx: Tx) => Promise<{ version: number } | undefined>,
  insert: (tx: Tx) => Promise<void>,
  update: (tx: Tx, version: number) => Promise<void>,
) {
  return withTenant(input.client, async (tx) => {
    const existing = await load(tx);
    if (existing && input.version != null && existing.version !== input.version) fail('The configuration was changed by someone else. Nothing was saved.');
    if (existing) await update(tx, existing.version);
    else await insert(tx);
  });
}

export async function saveRoutingTaskListType(input: { client: string; changedBy: string; taskListType: string; description: string; requireControlKey?: string | null; version?: number }) {
  const taskListType = codeOf(input.taskListType, 'Task list type', /^[A-Z0-9]$/);
  const description = descriptionOf(input.description, 'Task list type description');
  const requireControlKey = flag(input.requireControlKey, 'Require control key');
  await saveConfig(input,
    (tx) => tx.select().from(routingTaskListType).where(and(eq(routingTaskListType.client, input.client), eq(routingTaskListType.taskListType, taskListType))).then((rows) => rows[0]),
    (tx) => tx.insert(routingTaskListType).values({ client: input.client, taskListType, description, requireControlKey, createdBy: input.changedBy }).then(() => undefined),
    (tx, version) => tx.update(routingTaskListType).set({ description, requireControlKey, version: version + 1, changedBy: input.changedBy, changedAt: new Date() }).where(and(eq(routingTaskListType.client, input.client), eq(routingTaskListType.taskListType, taskListType), eq(routingTaskListType.version, version))).then(() => undefined),
  );
  return { taskListType };
}

export async function saveRoutingUsage(input: { client: string; changedBy: string; usage: string; description: string; version?: number }) {
  const usage = codeOf(input.usage, 'Routing usage', /^[A-Z0-9]{1,3}$/);
  const description = descriptionOf(input.description, 'Usage description');
  await saveConfig(input,
    (tx) => tx.select().from(routingUsage).where(and(eq(routingUsage.client, input.client), eq(routingUsage.usage, usage))).then((rows) => rows[0]),
    (tx) => tx.insert(routingUsage).values({ client: input.client, usage, description, createdBy: input.changedBy }).then(() => undefined),
    (tx, version) => tx.update(routingUsage).set({ description, version: version + 1, changedBy: input.changedBy, changedAt: new Date() }).where(and(eq(routingUsage.client, input.client), eq(routingUsage.usage, usage), eq(routingUsage.version, version))).then(() => undefined),
  );
  return { usage };
}

export async function saveRoutingStatus(input: { client: string; changedBy: string; status: string; description: string; releasedForScheduling?: string | null; releasedForCosting?: string | null; releasedForOrders?: string | null; version?: number }) {
  const status = codeOf(input.status, 'Routing status', /^[A-Z0-9]{1,3}$/);
  const description = descriptionOf(input.description, 'Status description');
  const flags = {
    releasedForScheduling: flag(input.releasedForScheduling, 'Released for scheduling'),
    releasedForCosting: flag(input.releasedForCosting, 'Released for costing'),
    releasedForOrders: flag(input.releasedForOrders, 'Released for orders'),
  };
  await saveConfig(input,
    (tx) => tx.select().from(routingStatus).where(and(eq(routingStatus.client, input.client), eq(routingStatus.status, status))).then((rows) => rows[0]),
    (tx) => tx.insert(routingStatus).values({ client: input.client, status, description, ...flags, createdBy: input.changedBy }).then(() => undefined),
    (tx, version) => tx.update(routingStatus).set({ description, ...flags, version: version + 1, changedBy: input.changedBy, changedAt: new Date() }).where(and(eq(routingStatus.client, input.client), eq(routingStatus.status, status), eq(routingStatus.version, version))).then(() => undefined),
  );
  return { status };
}

export async function saveRoutingControlKey(input: { client: string; changedBy: string; controlKey: string; description: string; scheduling?: string | null; costing?: string | null; confirmation?: string | null; externalProcessing?: string | null; requireWorkCenter?: string | null; version?: number }) {
  const controlKey = codeOf(input.controlKey, 'Control key', /^[A-Z0-9]{1,4}$/);
  const description = descriptionOf(input.description, 'Control key description');
  const flags = {
    scheduling: flag(input.scheduling, 'Scheduling'),
    costing: flag(input.costing, 'Costing'),
    confirmation: flag(input.confirmation, 'Confirmation'),
    externalProcessing: flag(input.externalProcessing, 'External processing'),
    requireWorkCenter: flag(input.requireWorkCenter, 'Require work center'),
  };
  await saveConfig(input,
    (tx) => tx.select().from(routingControlKey).where(and(eq(routingControlKey.client, input.client), eq(routingControlKey.controlKey, controlKey))).then((rows) => rows[0]),
    (tx) => tx.insert(routingControlKey).values({ client: input.client, controlKey, description, ...flags, createdBy: input.changedBy }).then(() => undefined),
    (tx, version) => tx.update(routingControlKey).set({ description, ...flags, version: version + 1, changedBy: input.changedBy, changedAt: new Date() }).where(and(eq(routingControlKey.client, input.client), eq(routingControlKey.controlKey, controlKey), eq(routingControlKey.version, version))).then(() => undefined),
  );
  return { controlKey };
}

export async function saveRoutingStandardValueKey(input: { client: string; changedBy: string; standardValueKey: string; description: string; parameters?: Array<{ parameter: string; description: string; unit?: string | null; required?: string | null }>; version?: number }) {
  const standardValueKey = codeOf(input.standardValueKey, 'Standard value key', /^[A-Z0-9]{1,4}$/);
  const description = descriptionOf(input.description, 'Standard value key description');
  const parameters = (input.parameters ?? []).map((row) => ({
    parameter: codeOf(row.parameter, 'Parameter', /^[A-Z0-9]{1,6}$/),
    description: descriptionOf(row.description, 'Parameter description'),
    unit: (row.unit ?? '').trim().toUpperCase() || null,
    required: flag(row.required, 'Required'),
  }));
  if (new Set(parameters.map((row) => row.parameter)).size !== parameters.length) fail('A standard value parameter is repeated.');
  await withTenant(input.client, async (tx) => {
    for (const parameter of parameters) if (parameter.unit) await decimalsOf(tx, parameter.unit);
    const [existing] = await tx.select().from(routingStandardValueKey).where(and(eq(routingStandardValueKey.client, input.client), eq(routingStandardValueKey.standardValueKey, standardValueKey)));
    if (existing && input.version != null && existing.version !== input.version) fail('The standard value key was changed by someone else. Nothing was saved.');
    if (existing) {
      await tx.update(routingStandardValueKey).set({ description, version: existing.version + 1, changedBy: input.changedBy, changedAt: new Date() }).where(and(eq(routingStandardValueKey.client, input.client), eq(routingStandardValueKey.standardValueKey, standardValueKey), eq(routingStandardValueKey.version, existing.version)));
    } else {
      await tx.insert(routingStandardValueKey).values({ client: input.client, standardValueKey, description, createdBy: input.changedBy });
    }
    const standing = await tx.select().from(routingStandardValueParameter).where(and(eq(routingStandardValueParameter.client, input.client), eq(routingStandardValueParameter.standardValueKey, standardValueKey)));
    const incoming = new Set(parameters.map((row) => row.parameter));
    for (const row of standing) {
      if (incoming.has(row.parameter)) continue;
      await tx.delete(routingStandardValueParameter).where(and(eq(routingStandardValueParameter.client, input.client), eq(routingStandardValueParameter.standardValueKey, standardValueKey), eq(routingStandardValueParameter.parameter, row.parameter)));
    }
    for (const parameter of parameters) {
      if (standing.some((row) => row.parameter === parameter.parameter)) {
        await tx.update(routingStandardValueParameter).set({ description: parameter.description, unit: parameter.unit, required: parameter.required, changedBy: input.changedBy, changedAt: new Date() }).where(and(eq(routingStandardValueParameter.client, input.client), eq(routingStandardValueParameter.standardValueKey, standardValueKey), eq(routingStandardValueParameter.parameter, parameter.parameter)));
      } else {
        await tx.insert(routingStandardValueParameter).values({ client: input.client, standardValueKey, ...parameter, createdBy: input.changedBy });
      }
    }
  });
  return { standardValueKey };
}

export async function listRoutingConfiguration(client: string) {
  return withTenant(client, async (tx) => ({
    types: await tx.select().from(routingTaskListType).where(eq(routingTaskListType.client, client)).orderBy(asc(routingTaskListType.taskListType)),
    usages: await tx.select().from(routingUsage).where(eq(routingUsage.client, client)).orderBy(asc(routingUsage.usage)),
    statuses: await tx.select().from(routingStatus).where(eq(routingStatus.client, client)).orderBy(asc(routingStatus.status)),
    controlKeys: await tx.select().from(routingControlKey).where(eq(routingControlKey.client, client)).orderBy(asc(routingControlKey.controlKey)),
    standardValueKeys: await tx.select().from(routingStandardValueKey).where(eq(routingStandardValueKey.client, client)).orderBy(asc(routingStandardValueKey.standardValueKey)),
    parameters: await tx.select().from(routingStandardValueParameter).where(eq(routingStandardValueParameter.client, client)).orderBy(asc(routingStandardValueParameter.parameter)),
  }));
}
