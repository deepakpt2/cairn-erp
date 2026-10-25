/**
 * Enter order confirmation — CO15.
 *
 * One confirmation number is drawn for the order. The header row stores the
 * entered yield, scrap, and rework once. That row is the confirmed production
 * quantity. It is not the sum of operation effects.
 *
 * Each operation whose control key allows confirmation, and which is not
 * already finally confirmed, receives one effect. The effect is not a time
 * ticket and is not given its own confirmation number. A posted time ticket
 * is not overwritten.
 *
 * Allocation, and only this allocation:
 * - No operation quantity on the snapshot: the effect quantity equals the
 *   header quantity (ORDER_QUANTITY). It is not split across operations, and
 *   it is not a second receipt. Copying it onto every such operation does not
 *   add it again to the header yield.
 * - Operation quantity and base quantity stored in the order unit, and the
 *   header quantity divides exactly by the base: the effect is
 *   header * operation quantity / base quantity (OPERATION_QUANTITY). The
 *   ratio is the one stored on the operation. It is not an equal split and
 *   not a guessed routing rule. An inexact division is refused. A unit that
 *   differs from the order unit is refused. The scaled quantity is not added
 *   to the header yield.
 * - A time ticket already standing on that operation is an order-unit
 *   quantity. A scaled effect is not added to it, and a time ticket is not
 *   added to a scaled effect. No conversion between those quantities exists.
 * - An operation that requires an activity is not given a standard value.
 *   Times are not allocated. The whole confirmation is refused.
 * - No operation snapshot: nothing is saved. The live routing is not read.
 *
 * No confirmation profile is stored, so automatic final is refused. No
 * component is marked for backflush, and automatic goods receipt is not
 * configured, so no goods movement is proposed. The order status is not
 * changed.
 */
import { sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { acquireLock } from '../../platform/lock';
import { allocateNumber } from '../../platform/numbering';
import { toScaled } from '../../platform/posting/decimal';
import {
  ORDER_OPERATION_SNAPSHOT_MISSING,
  TIME_TICKET_LOCK,
  TimeTicketError,
  type TimeTicketOperationView,
  clock,
  dateOf,
  decimalsOf,
  headerOf,
  operationsOf,
  orderQuantityOf,
  remainingText,
  rows,
} from './time-ticket';
import {
  confirmationBlockReason,
  parseProductionOrderStatus,
  productionOrderMayBeCharged,
  type ProductionOrderStatus,
} from './production-order-status';

export const ORDER_CONFIRMATION_CAPABILITY = 'PROD.CONFIRM.ORDER';
export const ORDER_CONFIRMATION_ROUTE = '/production/order-confirmation';
export const ORDER_CONFIRMATION_ALIAS = 'CO15';

const REFUSED: Record<string, string> = {
  confirmationProfile: 'A confirmation profile is not configured. Choose partial or final. Automatic final is not a stored rule.',
  automatic: 'Automatic confirmation is not a stored rule. Choose partial or final.',
  automaticFinal: 'Automatic final confirmation is not a stored rule. No confirmation profile stands. Choose partial or final.',
  sequence: 'Only standard sequence 000000 is stored. Execution order is not written into the confirmation. An alternative or parallel sequence is refused.',
  suboperation: 'A suboperation is not stored.',
  personnel: 'A personnel number is not validated. None was stored.',
  shift: 'A shift is not stored.',
  backflush: 'No component is marked for backflush. Nothing was issued.',
  automaticGoodsReceipt: 'Automatic goods receipt is not configured. A final confirmation does not receive the finished good.',
  goodsMovement: 'A goods movement is not posted from this confirmation.',
  clearOpenReservations: 'This order has no reservation. Open reservations were not cleared.',
  confirmationNumber: 'A posted confirmation is not overwritten. Cancellation is not this screen.',
  operation: 'An operation is confirmed on CO11N. This screen confirms every eligible operation. One operation was not selected.',
  operationNumber: 'An operation is confirmed on CO11N. This screen confirms every eligible operation. One operation was not selected.',
  co11n: 'CO11N confirms one operation. This screen confirms the order.',
  co13: 'Cancellation is not this screen. Open CO13. A posted confirmation was not cancelled.',
  co14: 'CO14 is not implemented. Open the order from CO03.',
  cost: 'Activity cost is not calculated. No cost was posted.',
  capacity: 'Capacity is not updated by a confirmation.',
  quality: 'A quality inspection is not stored. None was created.',
  serial: 'A serial number is not confirmed here.',
  batch: 'A batch is not determined by a confirmation. The order batch, if one stands, is not posted here.',
  storageLocation: 'A storage location is not a confirmation field. No goods movement was proposed.',
  orderType: 'An order type is not stored. Confirmation was not defaulted from one.',
  referenceConfirmation: 'A reference confirmation is not copied. Enter the quantities. The earlier confirmation was not posted again.',
  longText: 'A long text is not stored. The note is limited to the confirmation text.',
  varianceReason: 'A variance reason is not stored. None was applied.',
  milestone: 'A milestone confirmation is not configured. Preceding operations were not confirmed from a milestone.',
  progress: 'A progress confirmation is not configured.',
  postingPeriod: 'No document is posted, so a financial period was not applied. The posting date is the date entered.',
  wipBatch: 'A WIP batch is not created by a confirmation.',
  coProduct: 'A co-product is not stored. None was received.',
  workCenter: 'The work center is read from the operation. It was not changed.',
};

export class OrderConfirmationError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'OrderConfirmationError';
  }
}

export interface OrderConfirmationEffect {
  operationNumber: string;
  shortText: string | null;
  workCenter: string | null;
  controlKey: string;
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  quantityBasis: 'ORDER_QUANTITY' | 'OPERATION_QUANTITY';
  previouslyConfirmed: string;
}

export interface OrderConfirmationSkipped {
  operationNumber: string;
  reason: string;
}

export interface OrderConfirmationView {
  confirmationNumber: string;
  confirmationLevel: 'HEADER';
  orderNumber: string;
  confirmationType: 'PARTIAL' | 'FINAL';
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  unit: string;
  postingDate: string;
  executionStart: string | null;
  executionFinish: string | null;
  productionVersion: string;
  note: string | null;
  requestKey: string;
  orderStatus: ProductionOrderStatus;
  effects: OrderConfirmationEffect[];
  skipped: OrderConfirmationSkipped[];
  movementsPosted: 0;
  movementNote: string;
  written: boolean;
}

export interface OrderConfirmationLoad {
  orderNumber: string;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  orderQuantity: string;
  unit: string;
  scheduledStart: string;
  scheduledFinish: string;
  status: ProductionOrderStatus;
  version: number;
  productionVersion: string | null;
  previouslyConfirmed: string;
  previouslyScrapped: string;
  previouslyReworked: string;
  remainingQuantity: string;
  operations: TimeTicketOperationView[];
  eligible: string[];
  skipped: OrderConfirmationSkipped[];
  blockingReason: string | null;
  gaps: string[];
}

const GAPS = [
  'Eligible operations are the ones stored on the order. Each receives an effect. A time-ticket number is not created. A later routing edit is not read.',
  'No confirmation profile is stored. Automatic final confirmation is refused. Partial and final are the only types.',
  'The header row stores the entered quantity once. That is the confirmed production quantity. Operation effects are not added to it, and they are not added across operations.',
  'An operation without its own quantity receives the header quantity as an effect. That quantity is not split, and it is not a second receipt. An operation quantity is scaled by its stored base quantity. An inexact scale is refused rather than rounded. A time ticket is not added to a scaled effect.',
  'An operation that requires an activity is not given a standard value. Confirm that operation on CO11N.',
  'No component is marked for backflush. Automatic goods receipt is not configured. No goods movement is proposed.',
  'The order status is not changed. Technical completion is a separate CO02 action. A final confirmation blocks another confirmation of each affected operation. It does not complete the order.',
  'Underdelivery tolerance is stored on the material plant and is not executed here. No financial period is applied, because no document is posted.',
  'CO11N confirms one operation. Cancellation is CO13, not this screen. CO14 is not implemented. A posted confirmation is not edited here.',
  'Effects follow the stored execution order. The confirmation sequence stays 000000. It is not the execution order, and an earlier operation does not have to be confirmed first.',
];

const MOVEMENT_NOTE = 'No goods movement was proposed. Backflush is not configured, and automatic goods receipt is not configured. Stock was not changed.';

function fail(message: string, remedy?: string): never {
  throw new OrderConfirmationError(message, remedy);
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function sameQuantity(left: string, right: string): boolean {
  return toScaled(left, 3) === toScaled(right, 3);
}

export function orderConfirmationRefusal(fields: Record<string, string | null | undefined> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    if (!clean(value)) continue;
    return REFUSED[name] ?? `${name} is not a field of this confirmation.`;
  }
  return null;
}

export function holdsOrderConfirmationAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], ORDER_CONFIRMATION_CAPABILITY);
}

export function operationEffectQuantity(
  headerQuantity: string,
  operationQuantity: string | null,
  baseQuantity: string | null,
  operationNumber: string,
): { quantity: string; basis: 'ORDER_QUANTITY' | 'OPERATION_QUANTITY' } {
  if (!operationQuantity) return { quantity: headerQuantity, basis: 'ORDER_QUANTITY' };
  const base = toScaled(baseQuantity ?? '0', 3);
  if (base === 0n) {
    fail(`Operation ${operationNumber} has a quantity and no base quantity. The header quantity was not assigned.`);
  }
  const header = toScaled(headerQuantity, 3);
  const operation = toScaled(operationQuantity, 3);
  if (header * operation % base !== 0n) {
    fail(
      `Operation ${operationNumber} does not divide the header quantity exactly. It was not rounded and no residual was assigned.`,
      'Enter a quantity that divides exactly, or confirm that operation on CO11N.',
    );
  }
  return { quantity: remainingText(header * operation / base), basis: 'OPERATION_QUANTITY' };
}

/** Same stored ratio as the effect. No rounding, and no addition of an order-unit time ticket. */
export function scaledEffectWithinLimit(
  priorOperationYield: string,
  effectQuantity: string,
  operationQuantity: string,
  baseQuantity: string,
  orderLimit: bigint,
): boolean {
  const base = toScaled(baseQuantity, 3);
  const operation = toScaled(operationQuantity, 3);
  if (base === 0n || operation === 0n) return false;
  return (toScaled(priorOperationYield, 3) + toScaled(effectQuantity, 3)) * base <= orderLimit * operation;
}

function activityBlock(operations: TimeTicketOperationView[]): string | null {
  const blocked = operations.filter((row) => row.confirmable && row.activities.some((activity) => activity.required));
  if (blocked.length === 0) return null;
  const detail = blocked.map((row) => {
    const parameters = row.activities.filter((activity) => activity.required).map((activity) => activity.parameter).join(', ');
    return `${row.operationNumber} (${parameters})`;
  }).join(', ');
  return `Operation ${detail} requires an activity. The standard value was not substituted.`;
}

function skippedOf(operations: TimeTicketOperationView[]): OrderConfirmationSkipped[] {
  return operations.filter((row) => !row.confirmable).map((row) => ({
    operationNumber: row.operationNumber,
    reason: row.blockingReason ?? 'The operation is not confirmable.',
  }));
}

interface Prepared {
  header: Awaited<ReturnType<typeof headerOf>>;
  version: { taskListType: string; routingGroup: string; groupCounter: string; productionVersion: string };
  confirmationType: 'PARTIAL' | 'FINAL';
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  postingDate: string;
  executionStart: string | null;
  executionFinish: string | null;
  note: string | null;
  effects: OrderConfirmationEffect[];
  skipped: OrderConfirmationSkipped[];
}

async function headerProgress(tx: Tx, client: string, orderNumber: string): Promise<{ yield: string; scrap: string; rework: string }> {
  const found = await rows(tx, sql`
    select coalesce(sum(yield_quantity), 0)::text as yield,
           coalesce(sum(scrap_quantity), 0)::text as scrap,
           coalesce(sum(rework_quantity), 0)::text as rework
      from production_confirmation c
     where c.client = ${client} and c.order_number = ${orderNumber} and c.confirmation_level = 'HEADER'
       and not exists (
         select 1 from production_confirmation_cancellation x
          where x.client = c.client and x.confirmation_number = c.confirmation_number
       )
  `);
  return {
    yield: String(found[0]?.yield ?? '0'),
    scrap: String(found[0]?.scrap ?? '0'),
    rework: String(found[0]?.rework ?? '0'),
  };
}

async function toleranceLimit(tx: Tx, client: string, materialNumber: string, plant: string, orderQuantity: string): Promise<bigint> {
  const tolerance = await rows(tx, sql`
    select overdelivery_tolerance::text as tolerance
      from material_plant
     where client = ${client} and material_number = ${materialNumber} and plant = ${plant}
  `);
  const toleranceScaled = toScaled(String(tolerance[0]?.tolerance ?? '0'), 2);
  return toScaled(orderQuantity, 3) * (10000n + toleranceScaled) / 10000n;
}

async function prepare(tx: Tx, client: string, input: {
  orderNumber: string;
  productionVersion?: string | null;
  confirmationType: string;
  yieldQuantity?: string | null;
  scrapQuantity?: string | null;
  reworkQuantity?: string | null;
  unit?: string | null;
  postingDate: string;
  executionStartDate?: string | null;
  executionStartTime?: string | null;
  executionFinishDate?: string | null;
  executionFinishTime?: string | null;
  note?: string | null;
  expectedVersion: number;
  confirmFinal?: boolean;
  simulationOnly?: boolean;
}): Promise<Prepared> {
  let header;
  try {
    header = await headerOf(tx, client, input.orderNumber);
  } catch (error) {
    if (error instanceof TimeTicketError) fail(error.message, error.remedy);
    throw error;
  }
  if (header.version !== input.expectedVersion) {
    fail('The production order was changed by someone else. Nothing was saved.', 'Open the order again, then confirm.');
  }
  if (!productionOrderMayBeCharged(header.status)) {
    fail('The order is not released. Nothing was saved.', 'Release the order, then confirm. This screen does not release it.');
  }
  const confirmationType = clean(input.confirmationType).toUpperCase();
  if (confirmationType === 'AUTOMATIC' || confirmationType === 'AUTO' || confirmationType === 'AUTOMATIC_FINAL') {
    fail(REFUSED.automaticFinal);
  }
  if (confirmationType !== 'PARTIAL' && confirmationType !== 'FINAL') {
    fail('A confirmation type is required.', 'Choose partial or final. Automatic final is not a stored rule.');
  }
  if (confirmationType === 'FINAL' && input.confirmFinal !== true && input.simulationOnly !== true) {
    fail(
      'A final confirmation blocks another confirmation of each affected operation. It does not post a goods movement or change the order status.',
      'Confirm that consequence, or choose partial.',
    );
  }
  let postingDate: string;
  try {
    postingDate = dateOf(input.postingDate, 'The posting date');
  } catch (error) {
    if (error instanceof TimeTicketError) fail(error.message, error.remedy);
    throw error;
  }
  let operations;
  try {
    operations = await operationsOf(tx, client, header);
  } catch (error) {
    if (error instanceof TimeTicketError) fail(error.message, error.remedy);
    throw error;
  }
  if (operations.length === 0) {
    fail(
      ORDER_OPERATION_SNAPSHOT_MISSING,
      'Create the order from a production version so the routing is copied. A header confirmation was not saved against the live routing.',
    );
  }
  const version = {
    taskListType: operations[0].taskListType,
    routingGroup: operations[0].routingGroup,
    groupCounter: operations[0].groupCounter,
    productionVersion: operations[0].productionVersion,
  };
  const activity = activityBlock(operations);
  if (activity) {
    fail(activity, 'Confirm that operation on CO11N. This screen does not invent an actual.');
  }
  const eligible = operations.filter((row) => row.confirmable);
  if (eligible.length === 0) {
    fail('No operation can be confirmed from the header. Nothing was saved.', 'Use CO11N for an operation that is still open, or open an order whose control key allows confirmation.');
  }
  const orderDecimals = await decimalsOf(tx, header.unit);
  const entryUnit = clean(input.unit).toUpperCase() || header.unit;
  const entryDecimals = entryUnit === header.unit ? orderDecimals : await decimalsOf(tx, entryUnit);
  let yieldQuantity: string;
  let scrapQuantity: string;
  let reworkQuantity: string;
  try {
    yieldQuantity = await orderQuantityOf(tx, client, header.materialNumber, clean(input.yieldQuantity) || '0', entryUnit, header.unit, entryDecimals, orderDecimals, 'Yield');
    scrapQuantity = await orderQuantityOf(tx, client, header.materialNumber, clean(input.scrapQuantity) || '0', entryUnit, header.unit, entryDecimals, orderDecimals, 'Scrap');
    reworkQuantity = await orderQuantityOf(tx, client, header.materialNumber, clean(input.reworkQuantity) || '0', entryUnit, header.unit, entryDecimals, orderDecimals, 'Rework');
  } catch (error) {
    if (error instanceof TimeTicketError) fail(error.message, error.remedy);
    throw error;
  }
  if (toScaled(yieldQuantity, 3) + toScaled(scrapQuantity, 3) + toScaled(reworkQuantity, 3) === 0n) {
    fail('A confirmation needs a quantity. Nothing was saved.');
  }
  const limit = await toleranceLimit(tx, client, header.materialNumber, header.plant, header.orderQuantity);
  const prior = await headerProgress(tx, client, header.orderNumber);
  if (toScaled(prior.yield, 3) + toScaled(yieldQuantity, 3) > limit) {
    fail(
      `Yield ${yieldQuantity} ${header.unit} would take the confirmed header yield above the order quantity and the overdelivery tolerance. It was not reduced.`,
      'Enter a yield within the tolerance, or raise the tolerance on the material plant. The quantity was not clamped.',
    );
  }
  const effects: OrderConfirmationEffect[] = [];
  for (const operation of eligible) {
    if (operation.operationQuantity) {
      if (operation.operationUnit && operation.operationUnit !== header.unit) {
        fail(`Operation ${operation.operationNumber} quantity is in ${operation.operationUnit}. It was not converted to ${header.unit}.`, 'Confirm that operation on CO11N, or store the operation quantity in the order unit.');
      }
      if (operation.baseUnit && operation.baseUnit !== header.unit) {
        fail(`Operation ${operation.operationNumber} base quantity is in ${operation.baseUnit}. It was not converted to ${header.unit}.`);
      }
    }
    const yieldEffect = operationEffectQuantity(yieldQuantity, operation.operationQuantity, operation.baseQuantity, operation.operationNumber);
    const scrapEffect = operationEffectQuantity(scrapQuantity, operation.operationQuantity, operation.baseQuantity, operation.operationNumber);
    const reworkEffect = operationEffectQuantity(reworkQuantity, operation.operationQuantity, operation.baseQuantity, operation.operationNumber);
    if (yieldEffect.basis === 'OPERATION_QUANTITY') {
      if (toScaled(operation.orderUnitYield, 3) > 0n) {
        fail(
          `Operation ${operation.operationNumber} already has a confirmation in the order unit. The operation quantity was not added to it.`,
          'Cancel that time ticket on CO13 before confirming the order, or confirm an operation that has no time ticket. The quantities were not converted.',
        );
      }
      if (!scaledEffectWithinLimit(operation.operationQuantityYield, yieldEffect.quantity, operation.operationQuantity ?? '0', operation.baseQuantity ?? '0', limit)) {
        fail(
          `Yield ${yieldEffect.quantity} ${header.unit} would take operation ${operation.operationNumber} above the order quantity at its stored operation quantity. It was not reduced.`,
          'Enter a yield within the tolerance. A posted confirmation was not changed.',
        );
      }
    } else if (toScaled(operation.orderUnitYield, 3) + toScaled(yieldEffect.quantity, 3) > limit) {
      fail(
        `Yield ${yieldEffect.quantity} ${header.unit} would take operation ${operation.operationNumber} above the order quantity and the overdelivery tolerance. It was not reduced.`,
        'Enter a yield within the tolerance. A posted confirmation was not changed.',
      );
    }
    effects.push({
      operationNumber: operation.operationNumber,
      shortText: operation.shortText,
      workCenter: operation.workCenter,
      controlKey: operation.controlKey,
      yieldQuantity: yieldEffect.quantity,
      scrapQuantity: scrapEffect.quantity,
      reworkQuantity: reworkEffect.quantity,
      quantityBasis: yieldEffect.basis,
      previouslyConfirmed: operation.yieldQuantity,
    });
  }
  let executionStart: string | null;
  let executionFinish: string | null;
  try {
    executionStart = clock(clean(input.executionStartDate), clean(input.executionStartTime), 'The actual start');
    executionFinish = clock(clean(input.executionFinishDate), clean(input.executionFinishTime), 'The actual finish');
  } catch (error) {
    if (error instanceof TimeTicketError) fail(error.message, error.remedy);
    throw error;
  }
  if (executionStart && executionFinish && executionFinish < executionStart) {
    fail('The actual finish stands before the actual start.', 'Enter a finish at or after the start. No factory calendar was applied.');
  }
  const note = clean(input.note);
  if (note.length > 200) fail('The note is too long.', 'A long text is not stored.');
  return {
    header,
    version,
    confirmationType,
    yieldQuantity,
    scrapQuantity,
    reworkQuantity,
    postingDate,
    executionStart,
    executionFinish,
    note: note || null,
    effects,
    skipped: skippedOf(operations),
  };
}

function viewOf(number: string, requestKey: string, prepared: Prepared, written: boolean): OrderConfirmationView {
  return {
    confirmationNumber: number,
    confirmationLevel: 'HEADER',
    orderNumber: prepared.header.orderNumber,
    confirmationType: prepared.confirmationType,
    yieldQuantity: prepared.yieldQuantity,
    scrapQuantity: prepared.scrapQuantity,
    reworkQuantity: prepared.reworkQuantity,
    unit: prepared.header.unit,
    postingDate: prepared.postingDate,
    executionStart: prepared.executionStart,
    executionFinish: prepared.executionFinish,
    productionVersion: prepared.version.productionVersion,
    note: prepared.note,
    requestKey,
    orderStatus: prepared.header.status,
    effects: prepared.effects,
    skipped: prepared.skipped,
    movementsPosted: 0,
    movementNote: MOVEMENT_NOTE,
    written,
  };
}

async function storedView(tx: Tx, client: string, confirmationNumber: string): Promise<OrderConfirmationView | null> {
  const found = await rows(tx, sql`
    select c.confirmation_number, c.order_number, c.confirmation_type, c.confirmation_level,
           c.yield_quantity::text as yield, c.scrap_quantity::text as scrap, c.rework_quantity::text as rework,
           c.unit, c.posting_date::text as posting_date, c.execution_start::text as execution_start,
           c.execution_finish::text as execution_finish, c.production_version, c.note, c.request_key, o.status
      from production_confirmation c
      join production_order o on o.client = c.client and o.order_number = c.order_number
     where c.client = ${client} and c.confirmation_number = ${confirmationNumber}
       and c.confirmation_level = 'HEADER'
  `);
  const header = found[0];
  if (!header) return null;
  const effects = await rows(tx, sql`
    select e.operation_number, e.short_text, e.work_center, e.control_key, e.quantity_basis,
           e.yield_quantity::text as yield, e.scrap_quantity::text as scrap, e.rework_quantity::text as rework
      from production_confirmation_operation e
      left join production_order_operation op
        on op.client = e.client and op.order_number = e.order_number and op.operation_number = e.operation_number
     where e.client = ${client} and e.confirmation_number = ${confirmationNumber}
     order by op.execution_order nulls last, e.operation_number
  `);
  const status = parseProductionOrderStatus(header.status);
  if (!status) fail(`Status ${String(header.status)} is not a production-order status.`, 'The stored status is unsupported. It was not treated as created.');
  return {
    confirmationNumber: String(header.confirmation_number),
    confirmationLevel: 'HEADER',
    orderNumber: String(header.order_number),
    confirmationType: String(header.confirmation_type) as 'PARTIAL' | 'FINAL',
    yieldQuantity: String(header.yield),
    scrapQuantity: String(header.scrap),
    reworkQuantity: String(header.rework),
    unit: String(header.unit),
    postingDate: String(header.posting_date),
    executionStart: header.execution_start == null ? null : String(header.execution_start),
    executionFinish: header.execution_finish == null ? null : String(header.execution_finish),
    productionVersion: String(header.production_version),
    note: header.note == null ? null : String(header.note),
    requestKey: String(header.request_key),
    orderStatus: status,
    effects: effects.map((row) => ({
      operationNumber: String(row.operation_number),
      shortText: row.short_text == null ? null : String(row.short_text),
      workCenter: row.work_center == null ? null : String(row.work_center),
      controlKey: String(row.control_key),
      yieldQuantity: String(row.yield),
      scrapQuantity: String(row.scrap),
      reworkQuantity: String(row.rework),
      quantityBasis: String(row.quantity_basis) === 'OPERATION_QUANTITY' ? 'OPERATION_QUANTITY' : 'ORDER_QUANTITY',
      previouslyConfirmed: '0',
    })),
    skipped: [],
    movementsPosted: 0,
    movementNote: MOVEMENT_NOTE,
    written: true,
  };
}

async function sameRequest(tx: Tx, client: string, stored: OrderConfirmationView, input: {
  orderNumber: string;
  productionVersion?: string | null;
  confirmationType: string;
  yieldQuantity?: string | null;
  scrapQuantity?: string | null;
  reworkQuantity?: string | null;
  unit?: string | null;
  postingDate: string;
  executionStartDate?: string | null;
  executionStartTime?: string | null;
  executionFinishDate?: string | null;
  executionFinishTime?: string | null;
  note?: string | null;
}): Promise<boolean> {
  if (stored.orderNumber !== input.orderNumber) return false;
  const namedVersion = clean(input.productionVersion).toUpperCase();
  if (namedVersion && namedVersion !== stored.productionVersion) return false;
  if (clean(input.confirmationType).toUpperCase() !== stored.confirmationType) return false;
  if (dateOf(input.postingDate, 'The posting date') !== stored.postingDate) return false;
  const header = await headerOf(tx, client, input.orderNumber);
  const orderDecimals = await decimalsOf(tx, header.unit);
  const entryUnit = clean(input.unit).toUpperCase() || header.unit;
  const entryDecimals = entryUnit === header.unit ? orderDecimals : await decimalsOf(tx, entryUnit);
  const yieldQuantity = await orderQuantityOf(tx, client, header.materialNumber, clean(input.yieldQuantity) || '0', entryUnit, header.unit, entryDecimals, orderDecimals, 'Yield');
  const scrapQuantity = await orderQuantityOf(tx, client, header.materialNumber, clean(input.scrapQuantity) || '0', entryUnit, header.unit, entryDecimals, orderDecimals, 'Scrap');
  const reworkQuantity = await orderQuantityOf(tx, client, header.materialNumber, clean(input.reworkQuantity) || '0', entryUnit, header.unit, entryDecimals, orderDecimals, 'Rework');
  if (!sameQuantity(stored.yieldQuantity, yieldQuantity)) return false;
  if (!sameQuantity(stored.scrapQuantity, scrapQuantity)) return false;
  if (!sameQuantity(stored.reworkQuantity, reworkQuantity)) return false;
  if ((stored.note ?? '') !== (clean(input.note) || '')) return false;
  const executionStart = clock(clean(input.executionStartDate), clean(input.executionStartTime), 'The actual start');
  const executionFinish = clock(clean(input.executionFinishDate), clean(input.executionFinishTime), 'The actual finish');
  if ((stored.executionStart ?? '') !== (executionStart ?? '')) return false;
  if ((stored.executionFinish ?? '') !== (executionFinish ?? '')) return false;
  return true;
}

export async function loadOrderConfirmation(client: string, input: {
  orderNumber: string;
  productionVersion?: string | null;
  postingDate?: string | null;
}): Promise<OrderConfirmationLoad> {
  const orderNumber = clean(input.orderNumber).toUpperCase();
  if (!orderNumber) fail('A production order is required.', 'Enter the order to confirm.');
  const askedDate = clean(input.postingDate);
  if (askedDate) dateOf(askedDate, 'The posting date');
  return withTenant(client, async (tx) => {
    let header;
    try {
      header = await headerOf(tx, client, orderNumber);
    } catch (error) {
      if (error instanceof TimeTicketError) fail(error.message, error.remedy);
      throw error;
    }
    let blockingReason: string | null = confirmationBlockReason(header.status);
    const operations = await operationsOf(tx, client, header);
    const identity = operations[0] ?? null;
    if (!blockingReason && operations.length === 0) blockingReason = ORDER_OPERATION_SNAPSHOT_MISSING;
    const activity = activityBlock(operations);
    if (!blockingReason && activity) blockingReason = activity;
    const progress = await headerProgress(tx, client, header.orderNumber);
    const eligible = activity ? [] : operations.filter((row) => row.confirmable).map((row) => row.operationNumber);
    if (!blockingReason && operations.length > 0 && eligible.length === 0) {
      blockingReason = 'No operation can be confirmed from the header.';
    }
    const gaps = [...GAPS];
    const namedVersion = clean(input.productionVersion).toUpperCase();
    if (namedVersion && identity && namedVersion !== identity.productionVersion) {
      gaps.push(`Production version ${namedVersion} was not used. The order stores ${identity.productionVersion}. The routing was not re-read.`);
    }
    return {
      ...header,
      productionVersion: identity?.productionVersion ?? null,
      previouslyConfirmed: progress.yield,
      previouslyScrapped: progress.scrap,
      previouslyReworked: progress.rework,
      remainingQuantity: remainingText(toScaled(header.orderQuantity, 3) - toScaled(progress.yield, 3)),
      operations,
      eligible,
      skipped: skippedOf(operations),
      blockingReason,
      gaps,
    };
  });
}

export async function previewOrderConfirmation(client: string, input: {
  orderNumber: string;
  productionVersion?: string | null;
  confirmationType: string;
  yieldQuantity?: string | null;
  scrapQuantity?: string | null;
  reworkQuantity?: string | null;
  unit?: string | null;
  postingDate: string;
  executionStartDate?: string | null;
  executionStartTime?: string | null;
  executionFinishDate?: string | null;
  executionFinishTime?: string | null;
  note?: string | null;
  expectedVersion: number;
  named?: Record<string, string | null | undefined>;
}): Promise<OrderConfirmationView> {
  const refused = orderConfirmationRefusal(input.named);
  if (refused) fail(refused, 'Confirm the order. A check writes nothing.');
  return withTenant(client, async (tx) => {
    const prepared = await prepare(tx, client, {
      ...input,
      orderNumber: clean(input.orderNumber).toUpperCase(),
      simulationOnly: true,
    });
    return viewOf('', '', prepared, false);
  });
}

export async function enterOrderConfirmation(client: string, input: {
  requestedBy: string;
  requestKey: string;
  orderNumber: string;
  productionVersion?: string | null;
  confirmationType: string;
  yieldQuantity?: string | null;
  scrapQuantity?: string | null;
  reworkQuantity?: string | null;
  unit?: string | null;
  postingDate: string;
  executionStartDate?: string | null;
  executionStartTime?: string | null;
  executionFinishDate?: string | null;
  executionFinishTime?: string | null;
  note?: string | null;
  expectedVersion: number;
  confirmFinal?: boolean;
  named?: Record<string, string | null | undefined>;
}): Promise<OrderConfirmationView> {
  const refused = orderConfirmationRefusal(input.named);
  if (refused) fail(refused, 'Confirm the order. Nothing was saved.');
  const requestKey = clean(input.requestKey);
  if (!requestKey || requestKey.length > 64) fail('A request key is required.');
  const orderNumber = clean(input.orderNumber).toUpperCase();
  const namedVersion = clean(input.productionVersion).toUpperCase();
  return withTenant(client, async (tx) => {
    await acquireLock(tx, { objectCode: TIME_TICKET_LOCK, keys: [client, orderNumber] }, {
      client, requestedBy: input.requestedBy, transactionCode: ORDER_CONFIRMATION_ALIAS,
    });
    const existing = await rows(tx, sql`
      select confirmation_number, confirmation_level from production_confirmation
       where client = ${client} and request_key = ${requestKey}
    `);
    if (existing[0]) {
      if (String(existing[0].confirmation_level) !== 'HEADER') {
        fail('This request was already saved as a time ticket. It was not posted again.', 'Use a new request on CO15.');
      }
      const stored = await storedView(tx, client, String(existing[0].confirmation_number));
      if (!stored) fail('The earlier confirmation could not be read.');
      let same = false;
      try {
        same = await sameRequest(tx, client, stored, { ...input, orderNumber, productionVersion: namedVersion });
      } catch (error) {
        if (error instanceof TimeTicketError) fail(error.message, error.remedy);
        throw error;
      }
      if (!same) {
        fail('This request was already saved with different quantities. The posted confirmation was not changed.', 'Use a new request. Cancellation is not this screen.');
      }
      return stored;
    }
    const prepared = await prepare(tx, client, { ...input, orderNumber, confirmFinal: input.confirmFinal });
    const allocated = await allocateNumber(tx, { client, objectCode: 'PRODCONF', allocatedBy: input.requestedBy });
    const confirmationNumber = allocated.display;
    await tx.execute(sql`
      insert into production_confirmation (
        client, confirmation_number, order_number, operation_number, sequence, task_list_type, routing_group,
        group_counter, production_version, work_center, work_center_plant, control_key, short_text, confirmation_type,
        confirmation_level, yield_quantity, scrap_quantity, rework_quantity, unit, posting_date, execution_start,
        execution_finish, note, request_key, order_version, created_by
      ) values (
        ${client}, ${confirmationNumber}, ${orderNumber}, null, '000000', ${prepared.version.taskListType},
        ${prepared.version.routingGroup}, ${prepared.version.groupCounter}, ${prepared.version.productionVersion},
        null, null, null, null, ${prepared.confirmationType}, 'HEADER', ${prepared.yieldQuantity},
        ${prepared.scrapQuantity}, ${prepared.reworkQuantity}, ${prepared.header.unit}, ${prepared.postingDate},
        ${prepared.executionStart}, ${prepared.executionFinish}, ${prepared.note}, ${requestKey},
        ${prepared.header.version}, ${input.requestedBy}
      )
    `);
    for (const effect of prepared.effects) {
      await tx.execute(sql`
        insert into production_confirmation_operation (
          client, confirmation_number, order_number, operation_number, confirmation_type,
          yield_quantity, scrap_quantity, rework_quantity, unit, work_center, control_key, short_text,
          quantity_basis, created_by
        ) values (
          ${client}, ${confirmationNumber}, ${orderNumber}, ${effect.operationNumber}, ${prepared.confirmationType},
          ${effect.yieldQuantity}, ${effect.scrapQuantity}, ${effect.reworkQuantity}, ${prepared.header.unit},
          ${effect.workCenter}, ${effect.controlKey}, ${effect.shortText}, ${effect.quantityBasis}, ${input.requestedBy}
        )
      `);
    }
    await recordChange(tx, {
      client,
      objectClass: 'production_confirmation',
      objectKey: confirmationNumber,
      changeType: 'CREATE',
      changedBy: input.requestedBy,
      transactionCode: ORDER_CONFIRMATION_ALIAS,
      reason: `Order confirmation ${confirmationNumber} for order ${orderNumber}`,
      after: {
        orderNumber,
        confirmationLevel: 'HEADER',
        confirmationType: prepared.confirmationType,
        yieldQuantity: prepared.yieldQuantity,
        scrapQuantity: prepared.scrapQuantity,
        reworkQuantity: prepared.reworkQuantity,
        postingDate: prepared.postingDate,
        operations: prepared.effects.map((row) => row.operationNumber),
      },
    });
    const stored = await storedView(tx, client, confirmationNumber);
    if (!stored) fail('The confirmation was not saved.');
    return { ...stored, skipped: prepared.skipped };
  });
}

export async function getOrderConfirmation(client: string, confirmationNumber: string): Promise<OrderConfirmationView | null> {
  const number = clean(confirmationNumber).toUpperCase();
  if (!number) return null;
  return withTenant(client, (tx) => storedView(tx, client, number));
}
