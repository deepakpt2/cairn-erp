/**
 * Change planned order — MD12.
 *
 * The standing planned order is the record. There is no second order table.
 * The number, material, plant, and origin stay fixed. A save can change the
 * quantity, the dates, and the firming indicator. It does not convert the
 * order, explode a bill of material, schedule capacity, or post.
 *
 * A change of quantity or dates firms the order. A later save can unfirm it.
 * Planning already leaves a firmed order, and a quantity changed after the last
 * proposal, untouched. This screen does not add a second planning rule.
 *
 * Not stored, and refused by name: an MRP area, an order type, a special
 * procurement key, an opening date, a production version, a BOM, a routing, a
 * scheduler, a storage location, a sales order, a WBS element, and a deletion
 * flag. Conversion is not inferred, and a unit is not substituted.
 */
import { sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { toScaled } from '../../platform/posting/decimal';
import { unitOfMeasure } from '../../platform/tables/reference';
import { getPlannedOrder, type PlannedOrderView } from './planned-order-display';

export const PLANNED_ORDER_CHANGE_CAPABILITY = 'PROD.PLANNEDORDER.CHANGE';
export const PLANNED_ORDER_CHANGE_ROUTE = '/production/planned-order-change';
export const PLANNED_ORDER_CHANGE_ALIAS = 'MD12';
export const PLANNED_ORDER_LOCK = 'PLANNED_ORDER';

const REFUSED: Record<string, string> = {
  mrpArea: 'An MRP area does not stand. The plant on the order is the scope.',
  orderType: 'A planned-order type is not stored. The origin stays as it was stored.',
  specialProcurement: 'A special procurement key is not stored on the planned order.',
  openingDate: 'An opening date is not stored. The start and finish dates are.',
  productionVersion: 'A production version is not stored on the planned order. It is not copied onto the order by a change.',
  bom: 'A bill of material is not stored on the planned order. This save does not explode one.',
  routing: 'A routing is not stored on the planned order.',
  scheduler: 'A production scheduler is not stored on the planned order.',
  storageLocation: 'A storage location is not stored on the planned order.',
  salesOrder: 'A sales order is not stored on the planned order.',
  wbs: 'A WBS element is not stored on the planned order.',
  deletionIndicator: 'A deletion flag is not stored. Change does not remove the order.',
  companyCode: 'The company code is read from the plant. It is not a key of the order.',
  convert: 'Change does not convert the planned order. No production order and no requisition is created.',
  delete: 'Change does not delete the planned order.',
  reexplode: 'Re-explosion is not this save. Component demand is left as it stands.',
  schedule: 'Lead-time scheduling and finite capacity are not carried. The start and finish dates are stored as entered.',
  availability: 'A component availability check is not carried on this change.',
  newOrderNumber: 'The planned order number is fixed.',
  post: 'A planned-order change posts nothing.',
};

export class PlannedOrderChangeError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'PlannedOrderChangeError';
  }
}

export interface PlannedOrderChangeInput {
  client: string;
  changedBy: string;
  orderNumber: string;
  expectedVersion: number;
  quantity?: string | null;
  unit?: string | null;
  startDate?: string | null;
  finishDate?: string | null;
  firmingStatus?: string | null;
  materialNumber?: string | null;
  plant?: string | null;
  named?: Record<string, string | null | undefined>;
}

export interface PlannedOrderChangeResult {
  order: PlannedOrderView;
  changed: boolean;
  firmedByChange: boolean;
  warnings: string[];
}

function fail(message: string, remedy?: string): never {
  throw new PlannedOrderChangeError(message, remedy);
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function plannedOrderChangeRefusal(fields: Record<string, string | null | undefined> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    if (!value?.trim()) continue;
    return REFUSED[name] ?? `${name} is not a field of this change.`;
  }
  return null;
}

export function holdsPlannedOrderChangeAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], PLANNED_ORDER_CHANGE_CAPABILITY);
}

function orderNumberOf(value: string): string {
  const number = clean(value);
  if (!number) fail('A planned order number is required.', 'Enter the order number.');
  if (number.length > 12) fail('The planned order number is too long.', 'Use the number as it stands. It is not padded to ten digits.');
  return number;
}

function dateOf(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} is not a date.`, 'Use a calendar date. A factory calendar is not carried.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) {
    fail(`${label} is not a valid date.`);
  }
  return value;
}

function quantityOf(value: string, decimals: number): string {
  if (!/^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/.test(value)) fail('The quantity is not a number. It was not rounded.');
  const fraction = value.split('.')[1] ?? '';
  if (fraction.length > Math.min(3, decimals)) fail('The quantity has more decimal places than the unit allows. It was not rounded.');
  if (Number(value) <= 0) fail('The quantity must be positive.');
  return value;
}

function sameQuantity(left: string, right: string): boolean {
  return toScaled(left, 3) === toScaled(right, 3);
}

interface Standing {
  orderNumber: string;
  materialNumber: string;
  plant: string;
  quantity: string;
  unit: string;
  startDate: string;
  finishDate: string;
  firmingStatus: string;
  origin: string;
  version: number;
}

function snapshot(row: Standing): Record<string, unknown> {
  return {
    quantity: row.quantity,
    unit: row.unit,
    startDate: row.startDate,
    finishDate: row.finishDate,
    firmingStatus: row.firmingStatus,
    origin: row.origin,
  };
}

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return await tx.execute(query) as unknown as Array<Record<string, unknown>>;
}

export async function changePlannedOrder(input: PlannedOrderChangeInput): Promise<PlannedOrderChangeResult> {
  const refusal = plannedOrderChangeRefusal(input.named);
  if (refusal) fail(refusal);
  const orderNumber = orderNumberOf(input.orderNumber);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    fail('Open the order again. The record version is required.', 'Display the order, then change it.');
  }
  const actor = clean(input.changedBy);
  if (!actor || actor.length > 60) fail('The user who changed the order is required.');

  const saved = await withTenant(input.client, async (tx) => {
    const found = await rows(tx, sql`
      select order_number, material_number, plant, quantity::text as quantity, unit,
             start_date::text as start_date, finish_date::text as finish_date,
             firming_status, origin, version
        from planned_order
       where client = ${input.client} and order_number = ${orderNumber}
       for update
    `);
    const row = found[0];
    if (!row) fail(`Planned order ${orderNumber} does not stand.`, 'Choose an order that stands in this tenant.');
    const standing: Standing = {
      orderNumber: String(row.order_number),
      materialNumber: String(row.material_number),
      plant: String(row.plant),
      quantity: String(row.quantity),
      unit: String(row.unit),
      startDate: String(row.start_date),
      finishDate: String(row.finish_date),
      firmingStatus: String(row.firming_status),
      origin: String(row.origin),
      version: Number(row.version),
    };
    if (standing.version !== input.expectedVersion) {
      fail('The planned order was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    const linked = await rows(tx, sql`
      select order_number from production_order
       where client = ${input.client} and planned_order_number = ${orderNumber}
    `);
    if (linked[0]) {
      fail(
        `Planned order ${orderNumber} was converted to production order ${String(linked[0].order_number)}. It was not changed.`,
        'Change the production order. The planned order was not deleted.',
      );
    }
    const materialNumber = clean(input.materialNumber).toUpperCase();
    const plant = clean(input.plant).toUpperCase();
    if (materialNumber && materialNumber !== standing.materialNumber) {
      fail('The material is fixed.', 'Create another planned order for a different material. MD11 is not this screen.');
    }
    if (plant && plant !== standing.plant) {
      fail('The plant is fixed.', 'The plant on the order is the planning scope.');
    }
    const unit = clean(input.unit).toUpperCase() || standing.unit;
    if (unit !== standing.unit) {
      fail(
        `The unit is stored as ${standing.unit}. A different unit was not substituted.`,
        `Enter the quantity in ${standing.unit}. Planning compares that quantity as stored.`,
      );
    }
    const [unitRow] = await tx.select({ decimalPlaces: unitOfMeasure.decimalPlaces }).from(unitOfMeasure).where(sql`${unitOfMeasure.code} = ${unit}`);
    if (!unitRow) fail(`Unit ${unit} does not exist.`);
    const quantity = clean(input.quantity) ? quantityOf(clean(input.quantity), unitRow.decimalPlaces) : standing.quantity;
    const startDate = clean(input.startDate) ? dateOf(clean(input.startDate), 'The start date') : standing.startDate;
    const finishDate = clean(input.finishDate) ? dateOf(clean(input.finishDate), 'The finish date') : standing.finishDate;
    if (finishDate < startDate) fail('The finish date is before the start date.', 'Enter a finish date on or after the start date.');
    const explicitFirming = clean(input.firmingStatus).toUpperCase();
    if (explicitFirming && explicitFirming !== 'OPEN' && explicitFirming !== 'FIRMED') {
      fail('Firming is open or firmed.', 'Leave the indicator, or choose one of those two.');
    }
    const planningChanged = !sameQuantity(quantity, standing.quantity) || startDate !== standing.startDate || finishDate !== standing.finishDate;
    const nextFirming = planningChanged ? 'FIRMED' : (explicitFirming || standing.firmingStatus);
    const firmingChanged = nextFirming !== standing.firmingStatus;
    if (!planningChanged && !firmingChanged) {
      return { changed: false, firmedByChange: false, warnings: [] as string[] };
    }
    const updated = await rows(tx, sql`
      update planned_order
         set quantity = ${quantity}, unit = ${unit}, start_date = ${startDate}, finish_date = ${finishDate},
             firming_status = ${nextFirming}, version = version + 1, changed_by = ${actor}, changed_at = now()
       where client = ${input.client} and order_number = ${standing.orderNumber} and version = ${standing.version}
      returning quantity::text as quantity, unit, start_date::text as start_date, finish_date::text as finish_date,
                firming_status, origin, version
    `);
    if (!updated[0]) fail('The planned order was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    const after: Standing = {
      ...standing,
      quantity: String(updated[0].quantity),
      unit: String(updated[0].unit),
      startDate: String(updated[0].start_date),
      finishDate: String(updated[0].finish_date),
      firmingStatus: String(updated[0].firming_status),
      version: Number(updated[0].version),
    };
    await tx.execute(sql`
      insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
      select client, material_number, plant, true, 'Planned order changed', ${actor}
        from material_plant
       where client = ${input.client} and material_number = ${standing.materialNumber} and plant = ${standing.plant}
      on conflict (client, material_number, plant) do update
        set net_change = true, reason = excluded.reason, last_changed_by = excluded.last_changed_by, last_changed_at = now()
    `);
    await recordChange(tx, {
      client: input.client,
      objectClass: 'planned_order',
      objectKey: standing.orderNumber,
      changeType: 'CHANGE',
      changedBy: actor,
      transactionCode: PLANNED_ORDER_CHANGE_ALIAS,
      before: snapshot(standing),
      after: snapshot(after),
      fieldLabels: {
        quantity: 'Quantity',
        unit: 'Unit',
        startDate: 'Start date',
        finishDate: 'Finish date',
        firmingStatus: 'Firming',
        origin: 'Origin',
      },
    });
    const dependents = await rows(tx, sql`
      select count(*)::int as total
        from mrp_dependent_requirement
       where client = ${input.client} and parent_order_number = ${standing.orderNumber}
    `);
    const warnings: string[] = [];
    if (planningChanged && standing.firmingStatus !== 'FIRMED') {
      warnings.push('The change firmed the order. A later save can unfirm it. Planning does not overwrite a firmed order.');
    }
    if (planningChanged && Number(dependents[0]?.total ?? 0) > 0) {
      warnings.push('Component demand was not recalculated. Re-explosion is not this save.');
    }
    return { changed: true, firmedByChange: planningChanged && standing.firmingStatus !== 'FIRMED', warnings };
  });

  const order = await getPlannedOrder(input.client, orderNumber);
  if (!order) fail(`Planned order ${orderNumber} does not stand.`);
  return { order, ...saved };
}
