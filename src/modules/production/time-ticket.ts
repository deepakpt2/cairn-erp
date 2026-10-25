/**
 * Enter time ticket — CO11N.
 *
 * A confirmation names one operation of a released production order. The
 * operation is read from the production version. It is not copied onto the
 * order, and the order status is not changed. A technically completed order
 * may still be confirmed. This screen does not complete or revoke it.
 *
 * A posted confirmation is not edited here. Cancellation is not this screen.
 *
 * The confirmation and the goods movements it causes are one unit of work. A component
 * whose material is marked for backflush is withdrawn against the order, and a final
 * confirmation of a material marked for automatic goods receipt receives the finished
 * good. Both are posted by the goods-movement services MIGO uses, inside the
 * transaction this screen already holds: a movement that is refused takes the
 * confirmation with it, and a confirmation never stands beside a movement it was owed.
 * A material that carries neither mark behaves exactly as this screen always did — a
 * confirmation and no movement.
 */
import { sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import {
  confirmationBlockReason,
  parseProductionOrderStatus,
  productionOrderMayBeCharged,
  type ProductionOrderStatus,
} from './production-order-status';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { acquireLock } from '../../platform/lock';
import { allocateNumber } from '../../platform/numbering';
import { toScaled } from '../../platform/posting/decimal';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import { postGoodsIssue } from '../inventory/goods-issue';
import { postProductionReceipt } from '../inventory/production-receipt';
import {
  CONFIRMATION_MOVEMENT_CODES,
  movementRequestKey,
  movementConfiguration,
  planConfirmationMovements,
  plannedMovements,
  postedMovements,
  type ConfirmationMovement,
  type MovementPlan,
} from './confirmation-movements';

export type { ConfirmationMovement } from './confirmation-movements';

export const TIME_TICKET_CAPABILITY = 'PROD.CONFIRM.ENTER';
export const TIME_TICKET_ROUTE = '/production/time-ticket';
export const TIME_TICKET_ALIAS = 'CO11N';
export const TIME_TICKET_LOCK = 'PRODUCTION_ORDER';

const REFUSED: Record<string, string> = {
  confirmationProfile: 'A confirmation profile is not configured. Choose partial or final. Automatic is not a stored rule.',
  automatic: 'Automatic confirmation is not a stored rule. Choose partial or final.',
  sequence: 'Only standard sequence 000000 is stored. Execution order is not written into the confirmation. Confirm the operation number. An alternative or parallel sequence is refused.',
  suboperation: 'A suboperation is not stored.',
  personnel: 'A personnel number is not validated. None was stored.',
  shift: 'A shift is not stored.',
  // The marks are read from the material. A caller cannot set one on a confirmation, and
  // cannot ask this screen to move stock it has not been told to move.
  backflush: 'A confirmation carries no backflush mark. The mark belongs to the component material in the plant. No material was changed here.',
  automaticGoodsReceipt: 'A confirmation carries no automatic receipt mark. The mark belongs to the material in the plant. No material was changed here.',
  goodsMovement: 'A goods movement is not entered on this screen. A movement is caused by the material mark, never by a line typed here.',
  clearOpenReservations: 'This order has no reservation. Open reservations were not cleared, and a backflush does not withdraw one.',
  confirmationNumber: 'A posted confirmation is not overwritten. Cancellation is not this screen.',
  co13: 'Cancellation is not this screen. Open CO13. A posted confirmation was not cancelled.',
  co14: 'CO14 is not implemented. Open the confirmation from this result, or the order from CO03.',
  co15: 'CO15 is order confirmation. This screen confirms one operation.',
  cost: 'Activity cost is not calculated. No cost was posted.',
  workCenter: 'The work center is read from the operation. It was not changed.',
  milestone: 'A milestone confirmation is not configured.',
  progress: 'A progress confirmation is not configured.',
  wipBatch: 'A WIP batch is not created by a confirmation.',
  batch: 'A batch is not determined by a confirmation. The order batch, if one stands, is not posted here.',
  storageLocation: 'A storage location is not a confirmation field. The component is issued from the location on the order, and a receipt takes the plant default.',
};

export class TimeTicketError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'TimeTicketError';
  }
}

export interface TimeTicketActivityInput {
  parameter: string;
  quantity: string;
  unit?: string | null;
}

export interface TimeTicketActivityView {
  parameter: string;
  description: string;
  unit: string;
  required: boolean;
  suggested: string | null;
  actual: string | null;
}

export const ORDER_OPERATION_SNAPSHOT_MISSING = 'This order has no operation snapshot. Operations were not copied, and the routing was not read.';

export interface TimeTicketOperationView {
  operationNumber: string;
  sequence: string;
  executionOrder: number;
  shortText: string | null;
  workCenter: string | null;
  workCenterPlant: string;
  controlKey: string;
  taskListType: string;
  routingGroup: string;
  groupCounter: string;
  productionVersion: string;
  confirmable: boolean;
  blockingReason: string | null;
  /** Active CO11N yield plus header effects. A scaled effect is included here and is not header production. */
  yieldQuantity: string;
  /** Active yield stored in the order unit: a time ticket, or a header effect with basis ORDER_QUANTITY. */
  orderUnitYield: string;
  /** Active yield from a header effect with basis OPERATION_QUANTITY. Not added to header yield. */
  operationQuantityYield: string;
  scrapQuantity: string;
  reworkQuantity: string;
  remainingQuantity: string;
  finallyConfirmed: boolean;
  cancellationNote: string | null;
  operationQuantity: string | null;
  operationUnit: string | null;
  baseQuantity: string | null;
  baseUnit: string | null;
  activities: TimeTicketActivityView[];
}

export interface TimeTicketLoad {
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
  taskListType: string | null;
  routingGroup: string | null;
  groupCounter: string | null;
  /** The marks this order's materials carry. Nothing is posted by reading them. */
  movementConfig: Awaited<ReturnType<typeof movementConfiguration>>;
  operations: TimeTicketOperationView[];
  selected: TimeTicketOperationView | null;
  blockingReason: string | null;
  gaps: string[];
}

export interface TimeTicketView {
  confirmationNumber: string;
  orderNumber: string;
  operationNumber: string;
  confirmationType: 'PARTIAL' | 'FINAL';
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  unit: string;
  postingDate: string;
  executionStart: string | null;
  executionFinish: string | null;
  productionVersion: string;
  workCenter: string | null;
  controlKey: string;
  shortText: string | null;
  note: string | null;
  requestKey: string;
  orderStatus: ProductionOrderStatus;
  activities: Array<{ parameter: string; quantity: string; unit: string; suggested: string | null }>;
  /**
   * One row per movement the confirmation causes or would cause. A preview row carries no
   * document number; a saved row names the material document that stands behind it.
   */
  movements: ConfirmationMovement[];
  /**
   * The reading the movements were derived from, on a preview. Null once a confirmation is
   * stored: the documents are the record then, and what is outstanding has changed with them.
   */
  movementPlan: TimeTicketMovementPlan | null;
  movementsPosted: number;
  movementNote: string;
  written: boolean;
  /** True when this request had already been saved. Nothing new was written. */
  replayed: boolean;
}

/** What the screen may state about the marks it read, without restating the movement rows. */
export type TimeTicketMovementPlan = Omit<MovementPlan, 'issues' | 'receipt'>;

const GAPS = [
  'The operation is the one stored on the production order. A later routing edit is not read, and it does not change this confirmation.',
  'Only standard sequence 000000 is stored on the confirmation. Execution order is not written there. Predecessor and successor are not stored. An earlier operation does not have to be confirmed first.',
  'A confirmation profile is not configured. Automatic confirmation is refused.',
  'A movement follows the material marks only. Scrap is not grossed into a component quantity, no order type switches a receipt on or off, and a reservation is not cleared.',
  'Personnel, a shift, and activity cost are not stored.',
  'Cancellation is CO13. This screen does not cancel a posted confirmation. CO14 is not implemented.',
  'The order status is not changed. Technical completion is a separate CO02 action.',
];

function fail(message: string, remedy?: string): never {
  throw new TimeTicketError(message, remedy);
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function timeTicketRefusal(fields: Record<string, string | null | undefined> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    if (!clean(value)) continue;
    return REFUSED[name] ?? `${name} is not a field of this confirmation.`;
  }
  return null;
}

export function holdsTimeTicketAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], TIME_TICKET_CAPABILITY);
}

export async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return await tx.execute(query) as unknown as Array<Record<string, unknown>>;
}

export function dateOf(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) {
    fail(`${label} is not a valid date.`);
  }
  return value;
}

export function quantityText(value: string, decimals: number, label: string, allowZero: boolean): string {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/.test(text)) fail(`${label} is not a number. It was not rounded.`);
  const fraction = (text.split('.')[1] ?? '').replace(/0+$/, '');
  if (fraction.length > Math.min(3, decimals)) fail(`${label} has more decimal places than the unit allows. It was not rounded.`);
  if (toScaled(text, 3) < 0n) fail(`${label} cannot be negative.`);
  if (!allowZero && toScaled(text, 3) === 0n) fail(`${label} must be entered.`);
  return text;
}

export function clock(date: string, time: string, label: string): string | null {
  if (!date && !time) return null;
  if (!date || !time) fail(`${label} needs both a date and a time.`, 'Enter both, or neither.');
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) fail(`${label} is not a time.`, 'Enter the time as HH:MM.');
  const [hour, minute, second = '00'] = time.split(':');
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) fail(`${label} is not a time.`);
  return `${dateOf(date, label)} ${hour}:${minute}:${second.padStart(2, '0')}`;
}

function sameQuantity(left: string, right: string): boolean {
  return toScaled(left, 3) === toScaled(right, 3);
}

export function plainQuantity(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

export async function decimalsOf(tx: Tx, unit: string): Promise<number> {
  const found = await rows(tx, sql`select decimal_places from unit_of_measure where code = ${unit}`);
  if (!found[0]) fail(`Unit ${unit} does not exist.`);
  return Number(found[0].decimal_places);
}

export async function orderQuantityOf(
  tx: Tx,
  client: string,
  materialNumber: string,
  quantity: string,
  entryUnit: string,
  orderUnit: string,
  entryDecimals: number,
  orderDecimals: number,
  label: string,
): Promise<string> {
  const entered = quantityText(quantity, entryDecimals, label, true);
  if (entryUnit === orderUnit) return entered;
  try {
    const from = await toBaseQuantity(tx, client, { materialNumber, quantity: Number(entered), entryUnit });
    const one = await toBaseQuantity(tx, client, { materialNumber, quantity: 1, entryUnit: orderUnit });
    if (one.baseQuantity === 0) fail(`Unit ${orderUnit} has no conversion.`);
    const raw = from.baseQuantity / one.baseQuantity;
    const places = Math.min(3, orderDecimals);
    const factor = 10 ** places;
    const scaled = raw * factor;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
      fail(`${label} does not convert exactly to ${orderUnit}. It was not rounded.`, `Enter the quantity in ${orderUnit}.`);
    }
    return (Math.round(scaled) / factor).toFixed(places);
  } catch (error) {
    if (error instanceof UnitConversionError) fail(error.message, error.remedy);
    throw error;
  }
}

export interface OrderHeader {
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
}

export async function headerOf(tx: Tx, client: string, orderNumber: string): Promise<OrderHeader> {
  const found = await rows(tx, sql`
    select o.order_number, o.material_number, coalesce(m.description, '') as description, o.plant,
           o.order_quantity::text as quantity, o.unit_of_measure, o.scheduled_start, o.scheduled_finish,
           o.status, o.version
      from production_order o
      join material m on m.client = o.client and m.material_number = o.material_number
     where o.client = ${client} and o.order_number = ${orderNumber}
  `);
  const header = found[0];
  if (!header) fail(`Production order ${orderNumber} does not stand.`, 'Enter an order in this tenant.');
  const status = parseProductionOrderStatus(header.status);
  if (!status) {
    fail(
      `Status ${String(header.status)} is not a production-order status.`,
      'The stored status is unsupported. It was not treated as created.',
    );
  }
  return {
    orderNumber: String(header.order_number),
    materialNumber: String(header.material_number),
    materialDescription: String(header.description ?? ''),
    plant: String(header.plant),
    orderQuantity: String(header.quantity),
    unit: String(header.unit_of_measure),
    scheduledStart: String(header.scheduled_start),
    scheduledFinish: String(header.scheduled_finish),
    status,
    version: Number(header.version),
  };
}

async function activitiesOf(
  tx: Tx,
  client: string,
  orderNumber: string,
  operationNumber: string,
): Promise<TimeTicketActivityView[]> {
  const found = await rows(tx, sql`
    select parameter, description, unit, required, quantity::text as suggested
      from production_order_operation_value
     where client = ${client} and order_number = ${orderNumber} and operation_number = ${operationNumber}
     order by parameter
  `);
  return found.map((row) => ({
    parameter: String(row.parameter),
    description: String(row.description),
    unit: String(row.unit ?? ''),
    required: String(row.required) === 'X',
    suggested: row.suggested == null ? null : String(row.suggested),
    actual: null,
  }));
}

export async function operationsOf(
  tx: Tx,
  client: string,
  header: OrderHeader,
): Promise<TimeTicketOperationView[]> {
  const found = await rows(tx, sql`
    select operation_number, sequence, execution_order, short_text, work_center, work_center_plant, control_key,
           confirmation, external_processing, task_list_type, routing_group, group_counter, production_version,
           operation_quantity::text as operation_quantity, operation_unit,
           base_quantity::text as base_quantity, base_unit
      from production_order_operation
     where client = ${client} and order_number = ${header.orderNumber}
     order by execution_order, operation_number
  `);
  const posted = await rows(tx, sql`
    select operation_number,
           coalesce(sum(yield_quantity), 0)::text as yield,
           coalesce(sum(scrap_quantity), 0)::text as scrap,
           coalesce(sum(rework_quantity), 0)::text as rework,
           coalesce(sum(yield_quantity) filter (where quantity_basis = 'ORDER_QUANTITY'), 0)::text as order_yield,
           coalesce(sum(yield_quantity) filter (where quantity_basis = 'OPERATION_QUANTITY'), 0)::text as operation_yield,
           bool_or(confirmation_type = 'FINAL') as final
      from (
        select c.operation_number, c.yield_quantity, c.scrap_quantity, c.rework_quantity, c.confirmation_type,
               'ORDER_QUANTITY'::text as quantity_basis
          from production_confirmation c
         where c.client = ${client} and c.order_number = ${header.orderNumber}
           and c.confirmation_level = 'OPERATION'
           and not exists (
             select 1 from production_confirmation_cancellation x
              where x.client = c.client and x.confirmation_number = c.confirmation_number
           )
        union all
        select e.operation_number, e.yield_quantity, e.scrap_quantity, e.rework_quantity, e.confirmation_type,
               e.quantity_basis
          from production_confirmation_operation e
         where e.client = ${client} and e.order_number = ${header.orderNumber}
           and not exists (
             select 1 from production_confirmation_cancellation x
              where x.client = e.client and x.confirmation_number = e.confirmation_number
           )
      ) posted
     group by operation_number
  `);
  const cancelled = await rows(tx, sql`
    select operation_number, confirmation_number, cancellation_number
      from (
        select c.operation_number, c.confirmation_number, x.cancellation_number
          from production_confirmation c
          join production_confirmation_cancellation x
            on x.client = c.client and x.confirmation_number = c.confirmation_number
         where c.client = ${client} and c.order_number = ${header.orderNumber}
           and c.confirmation_level = 'OPERATION'
           and c.confirmation_type = 'FINAL'
        union all
        select e.operation_number, e.confirmation_number, x.cancellation_number
          from production_confirmation_operation e
          join production_confirmation_cancellation x
            on x.client = e.client and x.confirmation_number = e.confirmation_number
         where e.client = ${client} and e.order_number = ${header.orderNumber}
           and e.confirmation_type = 'FINAL'
      ) cancelled
     order by cancellation_number desc
  `);
  const cancelledByOperation = new Map<string, { confirmationNumber: string; cancellationNumber: string }>();
  for (const row of cancelled) {
    const operationNumber = String(row.operation_number);
    if (!cancelledByOperation.has(operationNumber)) {
      cancelledByOperation.set(operationNumber, {
        confirmationNumber: String(row.confirmation_number),
        cancellationNumber: String(row.cancellation_number),
      });
    }
  }
  const totals = new Map(posted.map((row) => [String(row.operation_number), row]));
    return Promise.all(found.map(async (row) => {
    const operationNumber = String(row.operation_number);
    const prior = totals.get(operationNumber);
    const yieldQuantity = String(prior?.yield ?? '0');
    const final = prior?.final === true || prior?.final === 't' || prior?.final === 'true';
    let blockingReason: string | null = null;
    if (String(row.external_processing) === 'X') blockingReason = 'External processing is not confirmed on this screen.';
    else if (String(row.confirmation) !== 'X') blockingReason = 'The control key does not allow confirmation.';
    else if (final) {
      blockingReason = 'A final confirmation already stands. Another confirmation is refused.';
    }
    return {
      operationNumber,
      sequence: String(row.sequence),
      executionOrder: Number(row.execution_order),
      shortText: row.short_text == null ? null : String(row.short_text),
      workCenter: row.work_center == null ? null : String(row.work_center),
      workCenterPlant: String(row.work_center_plant),
      controlKey: String(row.control_key ?? ''),
      taskListType: String(row.task_list_type),
      routingGroup: String(row.routing_group),
      groupCounter: String(row.group_counter),
      productionVersion: String(row.production_version),
      confirmable: blockingReason == null,
      blockingReason,
      yieldQuantity,
      orderUnitYield: String(prior?.order_yield ?? '0'),
      operationQuantityYield: String(prior?.operation_yield ?? '0'),
      scrapQuantity: String(prior?.scrap ?? '0'),
      reworkQuantity: String(prior?.rework ?? '0'),
      remainingQuantity: remainingText(toScaled(header.orderQuantity, 3) - toScaled(yieldQuantity, 3)),
      finallyConfirmed: final,
      cancellationNote: final || !cancelledByOperation.get(operationNumber)
        ? null
        : `Final confirmation ${cancelledByOperation.get(operationNumber)?.confirmationNumber} was cancelled by ${cancelledByOperation.get(operationNumber)?.cancellationNumber}. Another confirmation is allowed.`,
      operationQuantity: row.operation_quantity == null ? null : String(row.operation_quantity),
      operationUnit: row.operation_unit == null ? null : String(row.operation_unit),
      baseQuantity: row.base_quantity == null ? null : String(row.base_quantity),
      baseUnit: row.base_unit == null ? null : String(row.base_unit),
      activities: await activitiesOf(tx, client, header.orderNumber, operationNumber),
    };
  }));
}

export function remainingText(scaled: bigint): string {
  const negative = scaled < 0n;
  const absolute = (negative ? -scaled : scaled).toString().padStart(4, '0');
  const text = `${absolute.slice(0, -3)}.${absolute.slice(-3)}`;
  return negative ? `-${text}` : text;
}

export async function loadTimeTicket(client: string, input: {
  orderNumber: string;
  operationNumber?: string | null;
  productionVersion?: string | null;
  postingDate?: string | null;
}): Promise<TimeTicketLoad> {
  const orderNumber = clean(input.orderNumber).toUpperCase();
  if (!orderNumber) fail('A production order is required.', 'Enter the order to confirm.');
  const askedDate = clean(input.postingDate);
  if (askedDate) dateOf(askedDate, 'The posting date');
  return withTenant(client, async (tx) => {
    const header = await headerOf(tx, client, orderNumber);
    let blockingReason: string | null = confirmationBlockReason(header.status);
    const operations = await operationsOf(tx, client, header);
    const identity = operations[0] ?? null;
    if (!blockingReason && operations.length === 0) blockingReason = ORDER_OPERATION_SNAPSHOT_MISSING;
    const asked = clean(input.operationNumber).toUpperCase();
    const selected = asked ? operations.find((row) => row.operationNumber === asked) ?? null : null;
    if (asked && operations.length > 0 && !selected) {
      blockingReason = `Operation ${asked} does not stand on production order ${header.orderNumber}. The routing was not read.`;
    }
    const gaps = [...GAPS];
    const movementConfig = await movementConfiguration(tx, client, header);
    const namedVersion = clean(input.productionVersion).toUpperCase();
    if (namedVersion && identity && namedVersion !== identity.productionVersion) {
      gaps.push(`Production version ${namedVersion} was not used. The order stores ${identity.productionVersion}. The routing was not re-read.`);
    }
    return {
      ...header,
      productionVersion: identity?.productionVersion ?? null,
      taskListType: identity?.taskListType ?? null,
      routingGroup: identity?.routingGroup ?? null,
      groupCounter: identity?.groupCounter ?? null,
      operations,
      selected,
      blockingReason,
      gaps,
      movementConfig,
    };
  });
}

interface PreparedActivity {
  parameter: string;
  quantity: string;
  unit: string;
  suggested: string | null;
}

interface Prepared {
  header: OrderHeader;
  operation: TimeTicketOperationView;
  version: { taskListType: string; routingGroup: string; groupCounter: string; productionVersion: string };
  confirmationType: 'PARTIAL' | 'FINAL';
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  postingDate: string;
  executionStart: string | null;
  executionFinish: string | null;
  note: string | null;
  activities: PreparedActivity[];
  movements: MovementPlan;
}

async function prepare(tx: Tx, client: string, input: {
  orderNumber: string;
  operationNumber: string;
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
  activities?: TimeTicketActivityInput[];
  expectedVersion: number;
  confirmFinal?: boolean;
  simulationOnly?: boolean;
}): Promise<Prepared> {
  const header = await headerOf(tx, client, input.orderNumber);
  if (header.version !== input.expectedVersion) {
    fail('The production order was changed by someone else. Nothing was saved.', 'Open the order again, then confirm.');
  }
  if (!productionOrderMayBeCharged(header.status)) {
    fail('The order is not released. Nothing was saved.', 'Release the order, then confirm. This screen does not release it.');
  }
  const confirmationType = clean(input.confirmationType).toUpperCase();
  if (confirmationType === 'AUTOMATIC' || confirmationType === 'AUTO') fail(REFUSED.automatic);
  if (confirmationType !== 'PARTIAL' && confirmationType !== 'FINAL') {
    fail('A confirmation type is required.', 'Choose partial or final. Automatic is not a stored rule.');
  }
  if (confirmationType === 'FINAL' && input.confirmFinal !== true && input.simulationOnly !== true) {
    fail(
      'A final confirmation blocks another confirmation of this operation. It does not clear a reservation, post a goods movement, or change the order status.',
      'Confirm that consequence, or choose partial.',
    );
  }
  const postingDate = dateOf(input.postingDate, 'The posting date');
  const operations = await operationsOf(tx, client, header);
  if (operations.length === 0) {
    fail(
      ORDER_OPERATION_SNAPSHOT_MISSING,
      'Create the order from a production version so the routing is copied. A later routing change is not applied to this order.',
    );
  }
  const operation = operations.find((row) => row.operationNumber === input.operationNumber);
  if (!operation) {
    fail(
      `Operation ${input.operationNumber} does not stand on production order ${header.orderNumber}. The routing was not read.`,
      'Choose an operation stored on the order.',
    );
  }
  const version = {
    taskListType: operation.taskListType,
    routingGroup: operation.routingGroup,
    groupCounter: operation.groupCounter,
    productionVersion: operation.productionVersion,
  };
  if (!operation.confirmable) fail(operation.blockingReason ?? 'The operation is not confirmable.', 'Choose an operation whose control key allows confirmation.');
  if (toScaled(operation.operationQuantityYield, 3) > 0n) {
    fail(
      `Operation ${operation.operationNumber} already has an operation-quantity effect from a header confirmation. A time-ticket quantity was not added to it.`,
      'Cancel that header confirmation on CO13, or confirm this operation only when no scaled effect stands. The two quantities were not converted.',
    );
  }
  const orderDecimals = await decimalsOf(tx, header.unit);
  const entryUnit = clean(input.unit).toUpperCase() || header.unit;
  const entryDecimals = entryUnit === header.unit ? orderDecimals : await decimalsOf(tx, entryUnit);
  const yieldQuantity = await orderQuantityOf(tx, client, header.materialNumber, clean(input.yieldQuantity) || '0', entryUnit, header.unit, entryDecimals, orderDecimals, 'Yield');
  const scrapQuantity = await orderQuantityOf(tx, client, header.materialNumber, clean(input.scrapQuantity) || '0', entryUnit, header.unit, entryDecimals, orderDecimals, 'Scrap');
  const reworkQuantity = await orderQuantityOf(tx, client, header.materialNumber, clean(input.reworkQuantity) || '0', entryUnit, header.unit, entryDecimals, orderDecimals, 'Rework');
  const entered = new Map((input.activities ?? []).filter((row) => clean(row.quantity) !== '').map((row) => [clean(row.parameter).toUpperCase(), row]));
  const known = new Set(operation.activities.map((row) => row.parameter));
  for (const parameter of entered.keys()) {
    if (!known.has(parameter)) fail(`Activity ${parameter} is not configured on operation ${operation.operationNumber}. It was not stored.`, 'Enter only an activity the operation carries.');
  }
  const activities: PreparedActivity[] = [];
  for (const activity of operation.activities) {
    const given = entered.get(activity.parameter);
    if (!given) {
      if (activity.required) fail(`Activity ${activity.parameter} is required. The standard value was not substituted.`, 'Enter the actual quantity, including zero.');
      continue;
    }
    const unit = clean(given.unit).toUpperCase() || activity.unit;
    if (unit !== activity.unit) fail(`Activity ${activity.parameter} is stored in ${activity.unit}. ${unit} was not converted.`);
    const activityDecimals = await decimalsOf(tx, activity.unit);
    activities.push({
      parameter: activity.parameter,
      quantity: quantityText(clean(given.quantity), activityDecimals, `Activity ${activity.parameter}`, true),
      unit: activity.unit,
      suggested: activity.suggested,
    });
  }
  if (toScaled(yieldQuantity, 3) + toScaled(scrapQuantity, 3) + toScaled(reworkQuantity, 3) === 0n && activities.length === 0) {
    fail('A confirmation needs a quantity or an activity. Nothing was saved.');
  }
  const tolerance = await rows(tx, sql`
    select overdelivery_tolerance::text as tolerance
      from material_plant
     where client = ${client} and material_number = ${header.materialNumber} and plant = ${header.plant}
  `);
  const toleranceScaled = toScaled(String(tolerance[0]?.tolerance ?? '0'), 2);
  const limit = toScaled(header.orderQuantity, 3) * (10000n + toleranceScaled) / 10000n;
  const cumulative = toScaled(operation.yieldQuantity, 3) + toScaled(yieldQuantity, 3);
  if (cumulative > limit) {
    fail(
      `Yield ${yieldQuantity} ${header.unit} would take the confirmed yield above the order quantity and the overdelivery tolerance. It was not reduced.`,
      'Enter a yield within the tolerance, or raise the tolerance on the material plant. The quantity was not clamped.',
    );
  }
  const executionStart = clock(clean(input.executionStartDate), clean(input.executionStartTime), 'The actual start');
  const executionFinish = clock(clean(input.executionFinishDate), clean(input.executionFinishTime), 'The actual finish');
  if (executionStart && executionFinish && executionFinish < executionStart) {
    fail('The actual finish stands before the actual start.', 'Enter a finish at or after the start. No factory calendar was applied.');
  }
  const note = clean(input.note);
  if (note.length > 200) fail('The note is too long.');
  const movements = await planConfirmationMovements(tx, client, {
    orderNumber: header.orderNumber,
    materialNumber: header.materialNumber,
    plant: header.plant,
    orderQuantity: header.orderQuantity,
    unit: header.unit,
    yieldQuantity,
    confirmationType,
  });
  return {
    header,
    operation,
    version,
    confirmationType,
    yieldQuantity,
    scrapQuantity,
    reworkQuantity,
    postingDate,
    executionStart,
    executionFinish,
    note: note || null,
    activities,
    movements,
  };
}

function viewOf(number: string, requestKey: string, prepared: Prepared, written: boolean): TimeTicketView {
  return {
    confirmationNumber: number,
    orderNumber: prepared.header.orderNumber,
    operationNumber: prepared.operation.operationNumber,
    confirmationType: prepared.confirmationType,
    yieldQuantity: prepared.yieldQuantity,
    scrapQuantity: prepared.scrapQuantity,
    reworkQuantity: prepared.reworkQuantity,
    unit: prepared.header.unit,
    postingDate: prepared.postingDate,
    executionStart: prepared.executionStart,
    executionFinish: prepared.executionFinish,
    productionVersion: prepared.version.productionVersion,
    workCenter: prepared.operation.workCenter,
    controlKey: prepared.operation.controlKey,
    shortText: prepared.operation.shortText,
    note: prepared.note,
    requestKey,
    orderStatus: prepared.header.status,
    activities: prepared.activities,
    movements: plannedMovements(prepared.movements),
    movementPlan: {
      markedComponents: prepared.movements.markedComponents,
      automaticGoodsReceipt: prepared.movements.automaticGoodsReceipt,
      skipped: prepared.movements.skipped,
      note: prepared.movements.note,
    },
    movementsPosted: 0,
    movementNote: prepared.movements.note,
    written,
    replayed: false,
  };
}

/** `replayed` is stated by the caller: only the write path can tell a re-issued request from a new one. */
async function storedView(
  tx: Tx, client: string, confirmationNumber: string, replayed = false,
): Promise<TimeTicketView | null> {
  const found = await rows(tx, sql`
    select c.confirmation_number, c.order_number, c.operation_number, c.confirmation_type,
           c.yield_quantity::text as yield, c.scrap_quantity::text as scrap, c.rework_quantity::text as rework,
           c.unit, c.posting_date::text as posting_date, c.execution_start::text as execution_start,
           c.execution_finish::text as execution_finish, c.production_version, c.work_center, c.control_key,
           c.short_text, c.note, c.request_key, o.status
      from production_confirmation c
      join production_order o on o.client = c.client and o.order_number = c.order_number
     where c.client = ${client} and c.confirmation_number = ${confirmationNumber}
       and c.confirmation_level = 'OPERATION'
  `);
  const header = found[0];
  if (!header) return null;
  const activities = await rows(tx, sql`
    select parameter, quantity::text as quantity, unit, suggested_quantity::text as suggested
      from production_confirmation_activity
     where client = ${client} and confirmation_number = ${confirmationNumber}
     order by parameter
  `);
  const status = parseProductionOrderStatus(header.status);
  if (!status) fail(`Status ${String(header.status)} is not a production-order status.`, 'The stored status is unsupported. It was not treated as created.');
  const movements = await postedMovements(tx, client, String(header.request_key));
  return {
    confirmationNumber: String(header.confirmation_number),
    orderNumber: String(header.order_number),
    operationNumber: String(header.operation_number),
    confirmationType: String(header.confirmation_type) as 'PARTIAL' | 'FINAL',
    yieldQuantity: String(header.yield),
    scrapQuantity: String(header.scrap),
    reworkQuantity: String(header.rework),
    unit: String(header.unit),
    postingDate: String(header.posting_date),
    executionStart: header.execution_start == null ? null : String(header.execution_start),
    executionFinish: header.execution_finish == null ? null : String(header.execution_finish),
    productionVersion: String(header.production_version),
    workCenter: header.work_center == null ? null : String(header.work_center),
    controlKey: String(header.control_key),
    shortText: header.short_text == null ? null : String(header.short_text),
    note: header.note == null ? null : String(header.note),
    requestKey: String(header.request_key),
    orderStatus: status,
    activities: activities.map((row) => ({
      parameter: String(row.parameter),
      quantity: String(row.quantity),
      unit: String(row.unit),
      suggested: row.suggested == null ? null : String(row.suggested),
    })),
    movements,
    movementPlan: null,
    movementsPosted: movements.filter((row) => row.posted).length,
    movementNote: movementNoteFor(movements),
    written: true,
    replayed,
  };
}

/**
 * What a saved confirmation moved, in its own words: the material documents its request
 * caused. A document reversed on the goods-movement screen is reported as not standing, so
 * a confirmation read back after that reversal does not claim a movement that is gone.
 */
function movementNoteFor(movements: ConfirmationMovement[]): string {
  const posted = movements.filter((row) => row.posted);
  if (!posted.length) return 'No goods movement was caused by this confirmation.';
  const standing = posted.filter((row) => row.standing);
  const numbers = [...new Set(posted.map((row) => row.materialDocumentNumber))].join(' and ');
  const kinds = [...new Set(posted.map((row) => row.kind === 'ISSUE' ? 'issue' : 'receipt'))].join(' and ');
  if (!standing.length) return `The ${kinds} material document ${numbers} posted with this confirmation was reversed. Stock is not changed by reading this confirmation.`;
  const suffix = standing.length === posted.length ? '' : ' A reversal stands among them.';
  return `The ${kinds} material document ${numbers} was posted with this confirmation.${suffix}`;
}

function matches(stored: TimeTicketView, prepared: Prepared): boolean {
  if (stored.orderNumber !== prepared.header.orderNumber || stored.operationNumber !== prepared.operation.operationNumber) return false;
  if (stored.confirmationType !== prepared.confirmationType) return false;
  if (!sameQuantity(stored.yieldQuantity, prepared.yieldQuantity)) return false;
  if (!sameQuantity(stored.scrapQuantity, prepared.scrapQuantity)) return false;
  if (!sameQuantity(stored.reworkQuantity, prepared.reworkQuantity)) return false;
  if (stored.postingDate !== prepared.postingDate) return false;
  if ((stored.executionStart ?? '') !== (prepared.executionStart ?? '')) return false;
  if ((stored.executionFinish ?? '') !== (prepared.executionFinish ?? '')) return false;
  if (stored.activities.length !== prepared.activities.length) return false;
  return prepared.activities.every((row) => stored.activities.some((storedRow) => storedRow.parameter === row.parameter && sameQuantity(storedRow.quantity, row.quantity)));
}

export async function previewTimeTicket(client: string, input: {
  orderNumber: string;
  operationNumber: string;
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
  activities?: TimeTicketActivityInput[];
  expectedVersion: number;
  named?: Record<string, string | null | undefined>;
}): Promise<TimeTicketView> {
  const refused = timeTicketRefusal(input.named);
  if (refused) fail(refused, 'Confirm one operation. A check writes nothing.');
  return withTenant(client, async (tx) => {
    const prepared = await prepare(tx, client, { ...input, orderNumber: clean(input.orderNumber).toUpperCase(), operationNumber: clean(input.operationNumber).toUpperCase(), simulationOnly: true });
    return viewOf('', '', prepared, false);
  });
}

export async function enterTimeTicket(client: string, input: {
  requestedBy: string;
  requestKey: string;
  orderNumber: string;
  operationNumber: string;
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
  activities?: TimeTicketActivityInput[];
  expectedVersion: number;
  confirmFinal?: boolean;
  named?: Record<string, string | null | undefined>;
}): Promise<TimeTicketView> {
  const refused = timeTicketRefusal(input.named);
  if (refused) fail(refused, 'Confirm one operation. Nothing was saved.');
  const requestKey = clean(input.requestKey);
  if (!requestKey || requestKey.length > 64) fail('A request key is required.');
  const orderNumber = clean(input.orderNumber).toUpperCase();
  const operationNumber = clean(input.operationNumber).toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(operationNumber)) fail('The operation number is not an operation.', 'Enter the four-character operation from the overview.');
  return withTenant(client, async (tx) => {
    await acquireLock(tx, { objectCode: TIME_TICKET_LOCK, keys: [client, orderNumber] }, {
      client, requestedBy: input.requestedBy, transactionCode: TIME_TICKET_ALIAS,
    });
    const existing = await rows(tx, sql`
      select confirmation_number, confirmation_level from production_confirmation
       where client = ${client} and request_key = ${requestKey}
    `);
    if (existing[0]) {
      if (String(existing[0].confirmation_level) === 'HEADER') {
        fail('This request was already saved as an order confirmation. It was not posted again.', 'Use a new request on CO11N.');
      }
      const stored = await storedView(tx, client, String(existing[0].confirmation_number), true);
      if (!stored) fail('The earlier confirmation could not be read.');
      const prepared = await prepare(tx, client, { ...input, orderNumber, operationNumber });
      if (!matches(stored, prepared)) {
        fail('This request was already saved with different quantities. The posted confirmation was not changed.', 'Use a new request. Cancellation is not this screen.');
      }
      return stored;
    }
    const prepared = await prepare(tx, client, { ...input, orderNumber, operationNumber, confirmFinal: input.confirmFinal });
    const allocated = await allocateNumber(tx, { client, objectCode: 'PRODCONF', allocatedBy: input.requestedBy });
    const confirmationNumber = allocated.display;
    // sequence is the standard-sequence identity 000000. Execution order is not stored on the confirmation.
    await tx.execute(sql`
      insert into production_confirmation (
        client, confirmation_number, order_number, operation_number, sequence, task_list_type, routing_group,
        group_counter, production_version, work_center, work_center_plant, control_key, short_text, confirmation_type,
        confirmation_level,
        yield_quantity, scrap_quantity, rework_quantity, unit, posting_date, execution_start, execution_finish, note,
        request_key, order_version, created_by
      ) values (
        ${client}, ${confirmationNumber}, ${orderNumber}, ${operationNumber}, '000000', ${prepared.version.taskListType},
        ${prepared.version.routingGroup}, ${prepared.version.groupCounter}, ${prepared.version.productionVersion},
        ${prepared.operation.workCenter}, ${prepared.operation.workCenterPlant}, ${prepared.operation.controlKey},
        ${prepared.operation.shortText}, ${prepared.confirmationType}, 'OPERATION', ${prepared.yieldQuantity}, ${prepared.scrapQuantity},
        ${prepared.reworkQuantity}, ${prepared.header.unit}, ${prepared.postingDate}, ${prepared.executionStart},
        ${prepared.executionFinish}, ${prepared.note}, ${requestKey}, ${prepared.header.version}, ${input.requestedBy}
      )
    `);
    for (const activity of prepared.activities) {
      await tx.execute(sql`
        insert into production_confirmation_activity (
          client, confirmation_number, parameter, quantity, unit, suggested_quantity, created_by
        ) values (
          ${client}, ${confirmationNumber}, ${activity.parameter}, ${activity.quantity}, ${activity.unit},
          ${activity.suggested}, ${input.requestedBy}
        )
      `);
    }
    // The movements, inside the transaction that inserted the confirmation and before its
    // change document. Each kind carries its own request key, derived from this one, so the
    // two documents are distinct, replay finds both, and neither can be posted twice. Every
    // rule the goods-movement screen enforces — the open amount on the order, the period,
    // stock, a batch, the component and plant, the order status, a locked inventory count —
    // applies unchanged, and its refusal aborts the confirmation with it.
    const documents: string[] = [];
    // A request key is required above, so a derived key always exists. The guard is the
    // type's, not a rule: no movement is ever posted under an empty key.
    const issueKey = movementRequestKey(requestKey, 'ISSUE');
    if (prepared.movements.issues.length && issueKey) {
      const issued = await postGoodsIssue({
        client,
        changedBy: input.requestedBy,
        movementTypeCode: CONFIRMATION_MOVEMENT_CODES.issue,
        postingDate: prepared.postingDate,
        documentDate: prepared.postingDate,
        headerText: `CO11N ${confirmationNumber}`.slice(0, 25),
        requestKey: issueKey,
        lines: prepared.movements.issues.map((line) => ({
          materialNumber: line.materialNumber,
          plant: line.plant,
          storageLocation: line.storageLocation ?? undefined,
          // Held in the material's base unit, which is what the service measures an order
          // line in. No entry unit is claimed, so no conversion is invented here.
          quantity: Number(line.quantity),
          productionOrderNumber: orderNumber,
          productionOrderItem: line.itemNumber,
        })),
      }, 'MIGO', { tx });
      documents.push(issued.materialDocumentNumber);
    }
    const receiptKey = movementRequestKey(requestKey, 'RECEIPT');
    if (prepared.movements.receipt && receiptKey) {
      const received = await postProductionReceipt({
        client,
        changedBy: input.requestedBy,
        orderNumber,
        postingDate: prepared.postingDate,
        documentDate: prepared.postingDate,
        headerText: `CO11N ${confirmationNumber}`.slice(0, 25),
        requestKey: receiptKey,
        lines: [{ quantity: Number(prepared.movements.receipt.quantity) }],
      }, { tx });
      documents.push(received.materialDocumentNumber);
    }
    await recordChange(tx, {
      client,
      objectClass: 'production_confirmation',
      objectKey: confirmationNumber,
      changeType: 'CREATE',
      changedBy: input.requestedBy,
      transactionCode: TIME_TICKET_ALIAS,
      reason: `Time ticket ${confirmationNumber} for order ${orderNumber} operation ${operationNumber}`,
      after: {
        orderNumber,
        operationNumber,
        confirmationType: prepared.confirmationType,
        yieldQuantity: prepared.yieldQuantity,
        scrapQuantity: prepared.scrapQuantity,
        reworkQuantity: prepared.reworkQuantity,
        postingDate: prepared.postingDate,
        goodsMovementDocuments: documents,
      },
    });
    const stored = await storedView(tx, client, confirmationNumber);
    if (!stored) fail('The confirmation was not saved.');
    return stored;
  });
}

export async function getTimeTicket(client: string, confirmationNumber: string): Promise<TimeTicketView | null> {
  const number = clean(confirmationNumber).toUpperCase();
  if (!number) return null;
  return withTenant(client, (tx) => storedView(tx, client, number));
}
