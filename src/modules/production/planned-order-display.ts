/**
 * Display planned order — MD13.
 *
 * The number is the key. Display reads the standing order and does not firm,
 * change, convert, or delete it. It does not take a change lock and does not
 * touch the version or the timestamps.
 *
 * An MRP area, an order type, a special procurement key, an opening date, a
 * production version, a BOM, a routing, a scheduler, a storage location, a
 * sales order, a WBS element, and a deletion flag are not stored. They are
 * refused by name. Conversion is not inferred.
 */
import { sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { withTenant, type Tx } from '../../platform/db/client';

export const PLANNED_ORDER_DISPLAY_CAPABILITY = 'PROD.PLANNEDORDER.DISPLAY';
export const PLANNED_ORDER_DISPLAY_ROUTE = '/production/planned-order-display';
export const PLANNED_ORDER_DISPLAY_ALIAS = 'MD13';
export const PLANNED_ORDER_LIST_LIMIT = 25;

const REFUSED: Record<string, string> = {
  mrpArea: 'An MRP area does not stand. The plant on the order is the scope.',
  orderType: 'A planned-order type is not stored. The origin is planning or manual.',
  specialProcurement: 'A special procurement key is not stored on the planned order.',
  openingDate: 'An opening date is not stored. The start and finish dates are.',
  productionVersion: 'A production version is not stored on the planned order. It is selected when the order is exploded, and it is not copied here.',
  bom: 'A bill of material is not stored on the planned order.',
  routing: 'A routing is not stored on the planned order.',
  scheduler: 'A production scheduler is not stored on the planned order.',
  storageLocation: 'A storage location is not stored on the planned order.',
  salesOrder: 'A sales order is not stored on the planned order.',
  wbs: 'A WBS element is not stored on the planned order.',
  deletionIndicator: 'A deletion flag is not stored. Display does not remove the order.',
  firming: 'Display does not firm or unfirm the order.',
  change: 'Display does not change the order.',
  convert: 'Conversion is not done on this screen. A stored production order is shown when one stands. It is not inferred.',
  companyCode: 'The company code is read from the plant. It is not a key of the order.',
};

export class PlannedOrderDisplayError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'PlannedOrderDisplayError';
  }
}

export interface PlannedOrderDependentView {
  componentMaterial: string;
  componentDescription: string;
  quantity: string;
  unit: string;
  requirementDate: string;
  status: string;
  itemNumber: string;
}

export interface PlannedOrderView {
  orderNumber: string;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  plantName: string;
  companyCode: string;
  quantity: string;
  unit: string;
  startDate: string;
  finishDate: string;
  firmingStatus: 'OPEN' | 'FIRMED';
  origin: string;
  version: number;
  createdBy: string;
  createdAt: string;
  changedBy: string | null;
  changedAt: string | null;
  procurementType: string | null;
  mrpController: string | null;
  mrpControllerName: string | null;
  converted: boolean;
  productionOrderNumber: string | null;
  dependents: PlannedOrderDependentView[];
}

export interface PlannedOrderListRow {
  orderNumber: string;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  quantity: string;
  unit: string;
  finishDate: string;
  firmingStatus: string;
}

function fail(message: string, remedy?: string): never {
  throw new PlannedOrderDisplayError(message, remedy);
}

function clean(value: string | undefined | null): string {
  return value?.trim() ?? '';
}

export function plannedOrderDisplayRefusal(fields: Record<string, string | undefined> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    if (!value?.trim()) continue;
    return REFUSED[name] ?? `${name} is not a field of this display.`;
  }
  return null;
}

export function holdsPlannedOrderDisplayAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], PLANNED_ORDER_DISPLAY_CAPABILITY);
}

function orderNumberOf(value: string): string {
  const number = clean(value);
  if (!number) fail('A planned order number is required.', 'Enter the order number, or choose one from the list.');
  if (number.length > 12) fail('The planned order number is too long.', 'Use the number as it stands. It is not padded to ten digits.');
  return number;
}

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return await tx.execute(query) as unknown as Array<Record<string, unknown>>;
}

function viewOf(row: Record<string, unknown>, dependents: PlannedOrderDependentView[]): PlannedOrderView {
  const firming = String(row.firming_status) === 'FIRMED' ? 'FIRMED' : 'OPEN';
  return {
    orderNumber: String(row.order_number),
    materialNumber: String(row.material_number),
    materialDescription: String(row.material_description ?? ''),
    plant: String(row.plant),
    plantName: String(row.plant_name ?? ''),
    companyCode: String(row.company_code ?? ''),
    quantity: String(row.quantity),
    unit: String(row.unit),
    startDate: String(row.start_date),
    finishDate: String(row.finish_date),
    firmingStatus: firming,
    origin: String(row.origin),
    version: Number(row.version ?? 1),
    createdBy: String(row.created_by),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    changedBy: row.changed_by == null ? null : String(row.changed_by),
    changedAt: row.changed_at == null ? null : (row.changed_at instanceof Date ? row.changed_at.toISOString() : String(row.changed_at)),
    procurementType: row.procurement_type == null ? null : String(row.procurement_type),
    mrpController: row.mrp_controller == null ? null : String(row.mrp_controller),
    mrpControllerName: row.controller_name == null ? null : String(row.controller_name),
    converted: row.production_order_number != null,
    productionOrderNumber: row.production_order_number == null ? null : String(row.production_order_number),
    dependents,
  };
}

const ORDER_SQL = sql`
  select o.order_number, o.material_number, m.description as material_description, o.plant, p.name as plant_name,
         coalesce(p.company_code, '') as company_code, o.quantity::text as quantity, o.unit,
         o.start_date::text as start_date, o.finish_date::text as finish_date, o.firming_status, o.origin, o.version,
         o.created_by, o.created_at, o.changed_by, o.changed_at,
         mp.procurement_type, mp.mrp_controller, c.name as controller_name,
         conv.order_number as production_order_number
    from planned_order o
    join material m on m.client = o.client and m.material_number = o.material_number
    join plant p on p.client = o.client and p.plant = o.plant
    left join material_plant mp on mp.client = o.client and mp.material_number = o.material_number and mp.plant = o.plant
    left join mrp_controller c on c.client = o.client and c.controller = mp.mrp_controller
    left join production_order conv on conv.client = o.client and conv.planned_order_number = o.order_number
`;

export async function getPlannedOrder(client: string, orderNumber: string): Promise<PlannedOrderView | null> {
  const number = orderNumberOf(orderNumber);
  return withTenant(client, async (tx) => {
    const found = await rows(tx, sql`
      ${ORDER_SQL}
     where o.client = ${client} and o.order_number = ${number}
    `);
    if (!found[0]) return null;
    const dependents = await rows(tx, sql`
      select d.item_number, d.material_number, coalesce(m.description, '') as description,
             d.quantity::text as quantity, d.unit, d.requirement_date::text as requirement_date, d.status
        from mrp_dependent_requirement d
        left join material m on m.client = d.client and m.material_number = d.material_number
       where d.client = ${client} and d.parent_order_number = ${number}
       order by d.item_number, d.source_material
    `);
    return viewOf(found[0], dependents.map((row) => ({
      componentMaterial: String(row.material_number),
      componentDescription: String(row.description ?? ''),
      quantity: String(row.quantity),
      unit: String(row.unit),
      requirementDate: String(row.requirement_date),
      status: String(row.status),
      itemNumber: String(row.item_number),
    })));
  });
}

export async function listPlannedOrders(client: string, filter: {
  plant?: string | null;
  materialNumber?: string | null;
  offset?: number;
}): Promise<{ rows: PlannedOrderListRow[]; total: number; limit: number }> {
  const plant = clean(filter.plant).toUpperCase();
  const materialNumber = clean(filter.materialNumber).toUpperCase();
  if (!plant && !materialNumber) fail('A plant or a material is required to list planned orders.', 'Enter the order number, or name a plant.');
  if (plant.length > 10) fail('The plant is too long.');
  if (materialNumber.length > 40) fail('The material is too long.');
  const offset = Math.max(0, filter.offset ?? 0);
  return withTenant(client, async (tx) => {
    const count = await rows(tx, sql`
      select count(*)::int as total
        from planned_order
       where client = ${client}
         and (${plant}::text = '' or plant = ${plant})
         and (${materialNumber}::text = '' or material_number = ${materialNumber})
    `);
    const found = await rows(tx, sql`
      select o.order_number, o.material_number, m.description as material_description, o.plant,
             o.quantity::text as quantity, o.unit, o.finish_date::text as finish_date, o.firming_status
        from planned_order o
        join material m on m.client = o.client and m.material_number = o.material_number
       where o.client = ${client}
         and (${plant}::text = '' or o.plant = ${plant})
         and (${materialNumber}::text = '' or o.material_number = ${materialNumber})
       order by o.finish_date, o.order_number
       limit ${PLANNED_ORDER_LIST_LIMIT} offset ${offset}
    `);
    return {
      total: Number(count[0]?.total ?? 0),
      limit: PLANNED_ORDER_LIST_LIMIT,
      rows: found.map((row) => ({
        orderNumber: String(row.order_number),
        materialNumber: String(row.material_number),
        materialDescription: String(row.material_description ?? ''),
        plant: String(row.plant),
        quantity: String(row.quantity),
        unit: String(row.unit),
        finishDate: String(row.finish_date),
        firmingStatus: String(row.firming_status),
      })),
    };
  });
}
