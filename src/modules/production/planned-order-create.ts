/**
 * Create planned order — MD11.
 *
 * A hand-created order is the same planned-order row planning writes. The
 * number comes from the planned-order range. The origin is MANUAL and the
 * order is firmed, so a later planning run does not overwrite it.
 *
 * A bought material is not a planned order here. This create does not make a
 * requisition, a production order, or a posting. It does not explode a bill
 * of material and does not select a production version. A missing date is
 * counted from the material's in-house days. That is not a factory calendar.
 *
 * Not stored, and refused by name: a planned-order profile, an MRP area, an
 * order type, a special procurement key, an opening date, a production version,
 * a BOM, a routing, a scheduler, a storage location, a sales order, a WBS
 * element, and a deletion flag. A caller-supplied number is refused.
 */
import { sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { allocateNumber, NumberRangeError } from '../../platform/numbering';
import { unitOfMeasure } from '../../platform/tables/reference';
import { getPlannedOrder, type PlannedOrderView } from './planned-order-display';

export const PLANNED_ORDER_CREATE_CAPABILITY = 'PROD.PLANNEDORDER.CREATE';
export const PLANNED_ORDER_CREATE_ROUTE = '/production/planned-order-create';
export const PLANNED_ORDER_CREATE_ALIAS = 'MD11';

const REFUSED: Record<string, string> = {
  profile: 'A planned-order profile is not stored. The material and plant decide the order.',
  mrpArea: 'An MRP area does not stand. The plant is the planning scope.',
  orderType: 'A planned-order type is not stored. A hand-created order is marked manual.',
  orderNumber: 'The planned order number is drawn from the number range. A typed number was not used.',
  specialProcurement: 'A special procurement key is not stored on the planned order.',
  openingDate: 'An opening date is not stored. The start and finish dates are.',
  productionVersion: 'A production version is not stored on the planned order. This create does not select one.',
  bom: 'A bill of material is not stored on the planned order. This create does not explode one.',
  routing: 'A routing is not stored on the planned order.',
  scheduler: 'A production scheduler is not stored on the planned order.',
  storageLocation: 'A storage location is not stored on the planned order.',
  salesOrder: 'A sales order is not stored on the planned order.',
  wbs: 'A WBS element is not stored on the planned order.',
  deletionIndicator: 'A deletion flag is not stored. Create does not remove an order.',
  companyCode: 'The company code is read from the plant. It is not a key of the order.',
  convert: 'Create does not convert the planned order.',
  firming: 'A hand-created order is firmed. Unfirm it later, on the change screen.',
  origin: 'The origin of a hand-created order is manual. It is not taken from the request.',
  post: 'Creating a planned order posts nothing.',
  schedule: 'Lead-time scheduling and finite capacity are not carried. A missing date is a count of in-house days.',
  reexplode: 'This create does not explode a bill of material.',
  availability: 'A component availability check is not carried on this create.',
};

export class PlannedOrderCreateError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'PlannedOrderCreateError';
  }
}

export interface PlannedOrderCreateInput {
  client: string;
  changedBy: string;
  requestKey: string;
  materialNumber?: string | null;
  plant?: string | null;
  quantity?: string | null;
  unit?: string | null;
  startDate?: string | null;
  finishDate?: string | null;
  referenceOrder?: string | null;
  named?: Record<string, string | null | undefined>;
}

export interface PlannedOrderCreateResult {
  order: PlannedOrderView;
  created: boolean;
  copied: boolean;
  warnings: string[];
}

function fail(message: string, remedy?: string): never {
  throw new PlannedOrderCreateError(message, remedy);
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function plannedOrderCreateRefusal(fields: Record<string, string | null | undefined> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    if (!value?.trim()) continue;
    return REFUSED[name] ?? `${name} is not a field of this create.`;
  }
  return null;
}

export function holdsPlannedOrderCreateAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], PLANNED_ORDER_CREATE_CAPABILITY);
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

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function quantityOf(value: string, decimals: number): string {
  if (!/^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/.test(value)) fail('The quantity is not a number. It was not rounded.');
  const fraction = value.split('.')[1] ?? '';
  if (fraction.length > Math.min(3, decimals)) fail('The quantity has more decimal places than the unit allows. It was not rounded.');
  if (Number(value) <= 0) fail('The quantity must be positive.');
  return value;
}

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return await tx.execute(query) as unknown as Array<Record<string, unknown>>;
}

function sameRequest(
  standing: Record<string, unknown>,
  materialNumber: string,
  plant: string,
  quantity: string,
  unit: string,
  startDate: string,
  finishDate: string,
): boolean {
  return String(standing.material_number) === materialNumber
    && String(standing.plant) === plant
    && String(standing.unit) === unit
    && String(standing.start_date) === startDate
    && String(standing.finish_date) === finishDate
    && Number(standing.quantity) === Number(quantity);
}

export async function createPlannedOrder(input: PlannedOrderCreateInput): Promise<PlannedOrderCreateResult> {
  const refusal = plannedOrderCreateRefusal(input.named);
  if (refusal) fail(refusal);
  const requestKey = clean(input.requestKey);
  if (!requestKey || requestKey.length > 64) fail('A request key is required.', 'Save again from the screen. The key keeps a repeated save from creating a second order.');
  const actor = clean(input.changedBy);
  if (!actor || actor.length > 60) fail('The user who created the order is required.');
  const referenceOrder = clean(input.referenceOrder);
  if (referenceOrder.length > 12) fail('The reference planned order number is too long.');

  const saved = await withTenant(input.client, async (tx) => {
    const reference = referenceOrder
      ? (await rows(tx, sql`
          select order_number, material_number, plant, quantity::text as quantity, unit,
                 start_date::text as start_date, finish_date::text as finish_date, version
            from planned_order
           where client = ${input.client} and order_number = ${referenceOrder}
        `))[0]
      : undefined;
    if (referenceOrder && !reference) fail(`Planned order ${referenceOrder} does not stand.`, 'Choose a reference in this tenant. The original is not changed.');
    const materialNumber = clean(input.materialNumber).toUpperCase() || String(reference?.material_number ?? '');
    const plant = clean(input.plant).toUpperCase() || String(reference?.plant ?? '');
    if (!materialNumber || materialNumber.length > 40) fail('A material is required.');
    if (!plant || plant.length > 10) fail('A plant is required.');
    const material = (await rows(tx, sql`
      select m.material_number, m.base_unit, m.is_blocked, m.marked_for_deletion,
             mp.procurement_type, mp.in_house_production_days
        from material m
        left join material_plant mp
          on mp.client = m.client and mp.material_number = m.material_number and mp.plant = ${plant}
       where m.client = ${input.client} and m.material_number = ${materialNumber}
    `))[0];
    if (!material) fail(`Material ${materialNumber} does not stand.`, 'Choose a material in this tenant.');
    if (material.is_blocked) fail(`Material ${materialNumber} is blocked.`, 'Use a material that is not blocked.');
    if (material.marked_for_deletion) fail(`Material ${materialNumber} is marked for deletion.`, 'Use a material that is not marked for deletion.');
    if (!material.procurement_type) fail(`Material ${materialNumber} is not extended to plant ${plant}.`, 'Extend the material to the plant before creating a planned order.');
    const procurement = String(material.procurement_type);
    if (procurement === 'BUY') {
      fail(
        `${materialNumber} is bought in plant ${plant}. A planned order is not a purchase requisition.`,
        'Plan the plant, or create the requisition in purchasing. This screen does not create one.',
      );
    }
    if (procurement !== 'MAKE' && procurement !== 'BOTH') {
      fail(`Procurement type ${procurement} is not a planned order.`, 'Use a material produced in the plant.');
    }
    const baseUnit = String(material.base_unit ?? '');
    const unit = clean(input.unit).toUpperCase() || String(reference?.unit ?? baseUnit);
    if (!unit) fail('The material has no base unit.');
    if (unit !== baseUnit) {
      fail(
        `The unit is the material base unit ${baseUnit}. ${unit} was not substituted.`,
        `Enter the quantity in ${baseUnit}.`,
      );
    }
    const [unitRow] = await tx.select({ decimalPlaces: unitOfMeasure.decimalPlaces }).from(unitOfMeasure).where(sql`${unitOfMeasure.code} = ${unit}`);
    if (!unitRow) fail(`Unit ${unit} does not exist.`);
    const quantityText = clean(input.quantity) || String(reference?.quantity ?? '');
    if (!quantityText) fail('A quantity is required.');
    const quantity = quantityOf(quantityText, unitRow.decimalPlaces);
    const productionDays = Number(material.in_house_production_days ?? 0);
    if (!Number.isInteger(productionDays) || productionDays < 0) {
      fail('The in-house production time is not a number of days.', 'Enter both dates. A factory calendar is not carried.');
    }
    let startDate = clean(input.startDate);
    let finishDate = clean(input.finishDate);
    const warnings: string[] = [
      'The order is firmed. Planning does not overwrite it.',
      'Component demand was not written. This create does not explode a bill of material.',
    ];
    if (!startDate && !finishDate) {
      startDate = String(reference?.start_date ?? '');
      finishDate = String(reference?.finish_date ?? '');
    }
    if (startDate && !finishDate && !clean(input.finishDate) && clean(input.startDate)) {
      finishDate = addDays(dateOf(startDate, 'The start date'), productionDays);
      warnings.push(`The finish date was counted as ${productionDays} in-house days. A factory calendar was not used.`);
    } else if (finishDate && !startDate && !clean(input.startDate) && clean(input.finishDate)) {
      startDate = addDays(dateOf(finishDate, 'The finish date'), -productionDays);
      warnings.push(`The start date was counted as ${productionDays} in-house days. A factory calendar was not used.`);
    }
    if (!startDate || !finishDate) fail('A start date or a finish date is required.', 'Enter one date. The other is counted from the in-house days when the material is extended.');
    startDate = dateOf(startDate, 'The start date');
    finishDate = dateOf(finishDate, 'The finish date');
    if (finishDate < startDate) fail('The finish date is before the start date.');
    const today = new Date().toISOString().slice(0, 10);
    if (startDate < today) warnings.push('The start date is before today. It was not moved.');
    const prior = (await rows(tx, sql`
      select order_number, material_number, plant, quantity::text as quantity, unit,
             start_date::text as start_date, finish_date::text as finish_date
        from planned_order
       where client = ${input.client} and request_key = ${requestKey}
    `))[0];
    if (prior) {
      if (!sameRequest(prior, materialNumber, plant, quantity, unit, startDate, finishDate)) {
        fail('This request already created a different planned order.', 'Use a new request to create another order.');
      }
      return { orderNumber: String(prior.order_number), created: false, copied: false, warnings: ['The same request returned the order already created.'] };
    }
    const [plantRow] = await rows(tx, sql`select plant from plant where client = ${input.client} and plant = ${plant}`);
    if (!plantRow) fail(`Plant ${plant} does not stand.`);
    let orderNumber = '';
    try {
      const drawn = await allocateNumber(tx, {
        client: input.client, objectCode: 'PLANORD', companyCode: '*', subObject: '*', fiscalYear: 0, allocatedBy: actor,
      });
      orderNumber = drawn.display;
    } catch (error) {
      if (error instanceof NumberRangeError) fail(error.message, error.remedy);
      throw error;
    }
    if (!orderNumber || orderNumber.length > 12) fail('The planned order number could not be drawn.');
    const inserted = await rows(tx, sql`
      insert into planned_order (
        client, order_number, material_number, plant, quantity, unit, start_date, finish_date,
        firming_status, origin, request_key, version, created_by
      ) values (
        ${input.client}, ${orderNumber}, ${materialNumber}, ${plant}, ${quantity}, ${unit},
        ${startDate}, ${finishDate}, 'FIRMED', 'MANUAL', ${requestKey}, 1, ${actor}
      )
      on conflict (client, request_key) do nothing
      returning order_number
    `);
    if (!inserted[0]) {
      const raced = (await rows(tx, sql`
        select order_number, material_number, plant, quantity::text as quantity, unit,
               start_date::text as start_date, finish_date::text as finish_date
          from planned_order
         where client = ${input.client} and request_key = ${requestKey}
      `))[0];
      if (raced && sameRequest(raced, materialNumber, plant, quantity, unit, startDate, finishDate)) {
        return { orderNumber: String(raced.order_number), created: false, copied: false, warnings: ['The same request returned the order already created.'] };
      }
      fail('This request already created a different planned order.', 'Use a new request to create another order.');
    }
    await tx.execute(sql`
      insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
      select client, material_number, plant, true, 'Planned order created', ${actor}
        from material_plant
       where client = ${input.client} and material_number = ${materialNumber} and plant = ${plant}
      on conflict (client, material_number, plant) do update
        set net_change = true, reason = excluded.reason, last_changed_by = excluded.last_changed_by, last_changed_at = now()
    `);
    await recordChange(tx, {
      client: input.client,
      objectClass: 'planned_order',
      objectKey: orderNumber,
      changeType: 'CREATE',
      changedBy: actor,
      transactionCode: PLANNED_ORDER_CREATE_ALIAS,
      after: {
        orderNumber, materialNumber, plant, quantity, unit, startDate, finishDate,
        firmingStatus: 'FIRMED', origin: 'MANUAL',
      },
      fieldLabels: {
        orderNumber: 'Planned order',
        materialNumber: 'Material',
        plant: 'Plant',
        quantity: 'Quantity',
        unit: 'Unit',
        startDate: 'Start date',
        finishDate: 'Finish date',
        firmingStatus: 'Firming',
        origin: 'Origin',
      },
    });
    return { orderNumber, created: true, copied: Boolean(reference), warnings };
  });

  const order = await getPlannedOrder(input.client, saved.orderNumber);
  if (!order) fail('The planned order was not created.');
  return { order, created: saved.created, copied: saved.copied, warnings: saved.warnings };
}
