/**
 * Enter time ticket — CO11N.
 *
 * A confirmation names one operation of a released production order. The
 * operation is read from the production version. It is not copied onto the
 * order, and the order status is not changed. Created and released remain
 * the only statuses.
 *
 * A posted confirmation is not edited here. Cancellation is not this screen.
 * No component is issued and no finished good is received: backflush and
 * automatic goods receipt are not configured, so none is proposed.
 */
import { sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { acquireLock } from '../../platform/lock';
import { allocateNumber } from '../../platform/numbering';
import { toScaled } from '../../platform/posting/decimal';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import { ProductionVersionError, selectProductionVersion } from './production-version';

export const TIME_TICKET_CAPABILITY = 'PROD.CONFIRM.ENTER';
export const TIME_TICKET_ROUTE = '/production/time-ticket';
export const TIME_TICKET_ALIAS = 'CO11N';
export const TIME_TICKET_LOCK = 'PRODUCTION_ORDER';

const REFUSED: Record<string, string> = {
  confirmationProfile: 'A confirmation profile is not configured. Choose partial or final. Automatic is not a stored rule.',
  automatic: 'Automatic confirmation is not a stored rule. Choose partial or final.',
  sequence: 'Only the standard sequence is stored. An alternative or parallel sequence is refused.',
  suboperation: 'A suboperation is not stored.',
  personnel: 'A personnel number is not validated. None was stored.',
  shift: 'A shift is not stored.',
  backflush: 'No component is marked for backflush. Nothing was issued.',
  automaticGoodsReceipt: 'Automatic goods receipt is not configured. A final confirmation does not receive the finished good.',
  goodsMovement: 'A goods movement is not posted from this confirmation.',
  clearOpenReservations: 'This order has no reservation. Open reservations were not cleared.',
  confirmationNumber: 'A posted confirmation is not overwritten. Cancellation is not this screen.',
  co13: 'CO13 is not implemented. A posted confirmation was not cancelled.',
  co14: 'CO14 is not implemented. Open the confirmation from this result, or the order from CO03.',
  co15: 'CO15 is order confirmation. This screen confirms one operation.',
  cost: 'Activity cost is not calculated. No cost was posted.',
  workCenter: 'The work center is read from the operation. It was not changed.',
  milestone: 'A milestone confirmation is not configured.',
  progress: 'A progress confirmation is not configured.',
  wipBatch: 'A WIP batch is not created by a confirmation.',
  batch: 'A batch is not determined by a confirmation. The order batch, if one stands, is not posted here.',
  storageLocation: 'A storage location is not a confirmation field. No goods movement was proposed.',
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

export interface TimeTicketOperationView {
  operationNumber: string;
  shortText: string | null;
  workCenter: string | null;
  workCenterPlant: string;
  controlKey: string;
  confirmable: boolean;
  blockingReason: string | null;
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  remainingQuantity: string;
  finallyConfirmed: boolean;
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
  status: 'CREATED' | 'RELEASED';
  version: number;
  productionVersion: string | null;
  taskListType: string | null;
  routingGroup: string | null;
  groupCounter: string | null;
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
  orderStatus: 'CREATED' | 'RELEASED';
  activities: Array<{ parameter: string; quantity: string; unit: string; suggested: string | null }>;
  movementsPosted: 0;
  movementNote: string;
  written: boolean;
}

const GAPS = [
  'The order does not store an operation. The operation is read from the production version at entry and snapshotted on the confirmation.',
  'Only the standard sequence is stored.',
  'A confirmation profile is not configured. Automatic confirmation is refused.',
  'No component is marked for backflush. Automatic goods receipt is not configured. No goods movement is proposed.',
  'Personnel, a shift, and activity cost are not stored.',
  'CO13 and CO14 are not implemented. A posted confirmation is not edited here.',
  'The order status stays created or released. Technical completion is not done.',
];

const MOVEMENT_NOTE = 'No goods movement was proposed. Backflush is not configured, and automatic goods receipt is not configured. Stock was not changed.';

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
  status: 'CREATED' | 'RELEASED';
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
  const status = String(header.status);
  if (status !== 'CREATED' && status !== 'RELEASED') fail(`Status ${status} is not a production-order status.`);
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
  taskListType: string,
  routingGroup: string,
  groupCounter: string,
  operationNumber: string,
): Promise<TimeTicketActivityView[]> {
  const found = await rows(tx, sql`
    select p.parameter, p.description, p.unit, p.required, v.quantity::text as suggested
      from routing_operation o
      join routing_standard_value_parameter p
        on p.client = o.client and p.standard_value_key = o.standard_value_key
      left join routing_operation_value v
        on v.client = o.client and v.task_list_type = o.task_list_type and v.routing_group = o.routing_group
       and v.group_counter = o.group_counter and v.operation_number = o.operation_number and v.parameter = p.parameter
     where o.client = ${client} and o.task_list_type = ${taskListType} and o.routing_group = ${routingGroup}
       and o.group_counter = ${groupCounter} and o.operation_number = ${operationNumber}
     order by p.parameter
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
  version: { taskListType: string; routingGroup: string; groupCounter: string; productionVersion: string },
  keyDate: string,
): Promise<TimeTicketOperationView[]> {
  const found = await rows(tx, sql`
    select o.operation_number, o.short_text, o.work_center, o.plant, o.control_key, k.confirmation, k.external_processing,
           o.operation_quantity::text as operation_quantity, o.operation_unit,
           o.base_quantity::text as base_quantity, o.base_unit
      from routing_operation o
      left join routing_control_key k on k.client = o.client and k.control_key = o.control_key
     where o.client = ${client} and o.task_list_type = ${version.taskListType}
       and o.routing_group = ${version.routingGroup} and o.group_counter = ${version.groupCounter}
       and o.sequence = '000000' and o.deletion_flag = ' '
       and o.valid_from <= ${keyDate}::date and o.valid_to >= ${keyDate}::date
     order by o.operation_number
  `);
  const posted = await rows(tx, sql`
    select operation_number,
           coalesce(sum(yield_quantity), 0)::text as yield,
           coalesce(sum(scrap_quantity), 0)::text as scrap,
           coalesce(sum(rework_quantity), 0)::text as rework,
           bool_or(confirmation_type = 'FINAL') as final
      from (
        select operation_number, yield_quantity, scrap_quantity, rework_quantity, confirmation_type
          from production_confirmation
         where client = ${client} and order_number = ${header.orderNumber}
           and confirmation_level = 'OPERATION'
        union all
        select operation_number, yield_quantity, scrap_quantity, rework_quantity, confirmation_type
          from production_confirmation_operation
         where client = ${client} and order_number = ${header.orderNumber}
      ) posted
     group by operation_number
  `);
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
      shortText: row.short_text == null ? null : String(row.short_text),
      workCenter: row.work_center == null ? null : String(row.work_center),
      workCenterPlant: String(row.plant),
      controlKey: String(row.control_key ?? ''),
      confirmable: blockingReason == null,
      blockingReason,
      yieldQuantity,
      scrapQuantity: String(prior?.scrap ?? '0'),
      reworkQuantity: String(prior?.rework ?? '0'),
      remainingQuantity: remainingText(toScaled(header.orderQuantity, 3) - toScaled(yieldQuantity, 3)),
      finallyConfirmed: final,
      operationQuantity: row.operation_quantity == null ? null : String(row.operation_quantity),
      operationUnit: row.operation_unit == null ? null : String(row.operation_unit),
      baseQuantity: row.base_quantity == null ? null : String(row.base_quantity),
      baseUnit: row.base_unit == null ? null : String(row.base_unit),
      activities: await activitiesOf(tx, client, version.taskListType, version.routingGroup, version.groupCounter, operationNumber),
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
  const postingDate = askedDate ? dateOf(askedDate, 'The posting date') : '';
  return withTenant(client, async (tx) => {
    const header = await headerOf(tx, client, orderNumber);
    const keyDate = postingDate || header.scheduledStart;
    let blockingReason: string | null = header.status === 'RELEASED' ? null : 'The order is not released. Confirmation does not release it.';
    let version: { taskListType: string; routingGroup: string; groupCounter: string; productionVersion: string } | null = null;
    if (!blockingReason) {
      try {
        const selected = await selectProductionVersion(client, {
          materialNumber: header.materialNumber,
          plant: header.plant,
          keyDate,
          quantity: plainQuantity(header.orderQuantity),
          unit: header.unit,
          productionVersion: clean(input.productionVersion) || null,
          context: 'ORDER',
        }, tx);
        version = selected;
      } catch (error) {
        if (error instanceof ProductionVersionError) blockingReason = error.message;
        else throw error;
      }
    }
    const operations = version ? await operationsOf(tx, client, header, version, keyDate) : [];
    const asked = clean(input.operationNumber).toUpperCase();
    const selected = asked ? operations.find((row) => row.operationNumber === asked) ?? null : null;
    if (asked && version && !selected) {
      blockingReason = `Operation ${asked} does not stand on production version ${version.productionVersion}.`;
    }
    return {
      ...header,
      productionVersion: version?.productionVersion ?? null,
      taskListType: version?.taskListType ?? null,
      routingGroup: version?.routingGroup ?? null,
      groupCounter: version?.groupCounter ?? null,
      operations,
      selected,
      blockingReason,
      gaps: GAPS,
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
  if (header.status !== 'RELEASED') {
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
  let version;
  try {
    version = await selectProductionVersion(client, {
      materialNumber: header.materialNumber,
      plant: header.plant,
      keyDate: postingDate,
      quantity: plainQuantity(header.orderQuantity),
      unit: header.unit,
      productionVersion: clean(input.productionVersion) || null,
      context: 'ORDER',
    }, tx);
  } catch (error) {
    if (error instanceof ProductionVersionError) fail(error.message, error.remedy);
    throw error;
  }
  const operations = await operationsOf(tx, client, header, version, postingDate);
  const operation = operations.find((row) => row.operationNumber === input.operationNumber);
  if (!operation) fail(`Operation ${input.operationNumber} does not stand on production version ${version.productionVersion}.`);
  if (!operation.confirmable) fail(operation.blockingReason ?? 'The operation is not confirmable.', 'Choose an operation whose control key allows confirmation.');
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
    movementsPosted: 0,
    movementNote: MOVEMENT_NOTE,
    written,
  };
}

async function storedView(tx: Tx, client: string, confirmationNumber: string): Promise<TimeTicketView | null> {
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
  const status = String(header.status) === 'RELEASED' ? 'RELEASED' : 'CREATED';
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
    movementsPosted: 0,
    movementNote: MOVEMENT_NOTE,
    written: true,
  };
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
      const stored = await storedView(tx, client, String(existing[0].confirmation_number));
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
