/**
 * Display production order — CO03.
 *
 * The number is the key. Display reads the standing order and does not
 * change it, release it, or take a change lock. It does not touch the
 * version or the timestamps.
 *
 * An order type, a controlling area, scrap, a production version, a
 * scheduling type, a priority, operations, and sequences are not stored
 * on the order. They are refused as keys. Issued and received quantities
 * are read from material documents. Confirmations are listed when they
 * stand. This display does not enter or cancel one.
 */
import { sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { withTenant, type Tx } from '../../platform/db/client';

export const PRODUCTION_ORDER_DISPLAY_CAPABILITY = 'PROD.ORDER.DISPLAY';
export const PRODUCTION_ORDER_DISPLAY_ROUTE = '/production/production-order-display';
export const PRODUCTION_ORDER_DISPLAY_ALIAS = 'CO03';
export const PRODUCTION_ORDER_LIST_LIMIT = 25;

const REFUSED: Record<string, string> = {
  orderType: 'An order type is not stored. Created and released are the statuses.',
  controllingArea: 'A controlling area is not a key. The company code is read from the plant.',
  scrap: 'A scrap quantity is not stored on the production order.',
  productionVersion: 'A production version is not stored on the production order. It was read at conversion and was not copied here.',
  schedulingType: 'A scheduling type is not stored. The start and finish dates are.',
  priority: 'A priority is not stored on the production order.',
  operation: 'Operations are not stored on the production order.',
  sequence: 'Sequences are not stored. There is no standard, alternative, or parallel sequence to display.',
  availability: 'Component availability is not checked on this display.',
  cost: 'Cost is not carried on the production order.',
  confirmation: 'A confirmation number is not the key of this display. Confirmations that stand are listed with the order.',
  teco: 'Technical completion is not a status. Created and released are the statuses.',
  closed: 'A closed status is not stored.',
  deletionIndicator: 'A deletion flag is not stored. Display does not remove the order.',
  release: 'Display does not release the order.',
  change: 'Display does not change the order.',
};

export class ProductionOrderDisplayError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'ProductionOrderDisplayError';
  }
}

export interface ProductionOrderComponentDisplay {
  itemNumber: number;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  storageLocation: string | null;
  requiredQuantity: string;
  unit: string;
  issuedQuantity: string;
  remainingQuantity: string;
}

export interface ProductionOrderDocumentDisplay {
  materialDocumentNumber: string;
  lineNumber: number;
  movementType: string;
  materialNumber: string;
  quantity: string;
  postingDate: string;
  status: string;
  productionOrderItem: number | null;
}

export interface ProductionOrderConfirmationDisplay {
  confirmationNumber: string;
  confirmationLevel: 'HEADER' | 'OPERATION';
  operationNumber: string | null;
  confirmationType: string;
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  unit: string;
  postingDate: string;
  executionStart: string | null;
  executionFinish: string | null;
}

export interface ProductionOrderHistoryDisplay {
  changedAt: string;
  changeType: string;
  transactionCode: string | null;
  changedBy: string;
  reason: string | null;
}

export interface ProductionOrderDisplay {
  orderNumber: string;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  plantName: string;
  companyCode: string;
  quantity: string;
  unit: string;
  scheduledStart: string;
  scheduledFinish: string;
  status: 'CREATED' | 'RELEASED';
  batch: string;
  schedulingProfile: string;
  releaseOnCreate: string;
  batchCreation: string;
  plannedOrderNumber: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  receivedQuantity: string;
  version: number;
  createdBy: string;
  createdAt: string;
  changedBy: string | null;
  changedAt: string | null;
  components: ProductionOrderComponentDisplay[];
  documents: ProductionOrderDocumentDisplay[];
  confirmations: ProductionOrderConfirmationDisplay[];
  history: ProductionOrderHistoryDisplay[];
  gaps: string[];
}

export interface ProductionOrderListRow {
  orderNumber: string;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  quantity: string;
  unit: string;
  scheduledFinish: string;
  status: string;
}

function fail(message: string, remedy?: string): never {
  throw new ProductionOrderDisplayError(message, remedy);
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function productionOrderDisplayRefusal(fields: Record<string, string | null | undefined> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    if (!clean(value)) continue;
    return REFUSED[name] ?? `${name} is not a field of this display.`;
  }
  return null;
}

export function holdsProductionOrderDisplayAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], PRODUCTION_ORDER_DISPLAY_CAPABILITY);
}

function orderNumberOf(value: string): string {
  const number = clean(value);
  if (!number) fail('A production order number is required.', 'Enter the order number, or choose one from the list.');
  if (number.length > 12) fail('The production order number is too long.', 'Use the number as it stands.');
  return number;
}

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return await tx.execute(query) as unknown as Array<Record<string, unknown>>;
}

function stamp(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

const GAPS = [
  'Operations are not stored on the production order. A confirmation names a routing operation. It is not copied here.',
  'Sequences are not stored.',
  'A production version is not stored on the order.',
  'Confirmations are listed when they stand. This display does not enter or cancel one. Actual start and finish stand on the confirmation, not on the order.',
  'Cost is not carried.',
  'Component availability is not checked.',
  'No reservation is created by displaying the order.',
];

export async function getProductionOrderDisplay(client: string, orderNumber: string): Promise<ProductionOrderDisplay | null> {
  const number = orderNumberOf(orderNumber);
  return withTenant(client, async (tx) => {
    const found = await rows(tx, sql`
      select o.order_number, o.material_number, m.description as material_description, o.plant, p.name as plant_name,
             coalesce(p.company_code, '') as company_code, o.order_quantity::text as quantity, o.unit_of_measure,
             o.scheduled_start, o.scheduled_finish, o.status, o.batch_number, o.scheduling_profile,
             o.release_on_create, o.batch_creation, o.planned_order_number, o.released_by, o.released_at,
             o.version, o.created_by, o.created_at, o.changed_by, o.changed_at
        from production_order o
        join material m on m.client = o.client and m.material_number = o.material_number
        join plant p on p.client = o.client and p.plant = o.plant
       where o.client = ${client} and o.order_number = ${number}
    `);
    const header = found[0];
    if (!header) return null;
    const components = await rows(tx, sql`
      select c.item_number, c.material_number, coalesce(m.description, '') as description, c.plant,
             c.storage_location, c.required_quantity::text as required_quantity, c.unit_of_measure,
             coalesce(issued.issued, 0)::text as issued
        from production_order_component c
        left join material m on m.client = c.client and m.material_number = c.material_number
        left join (
          select l.production_order_item,
                 sum(case when mt.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end) as issued
            from material_document_line l
            join material_document d
              on d.client = l.client and d.material_document_number = l.material_document_number and d.status = 'POSTED'
            join movement_type mt on mt.client = l.client and mt.movement_type = l.movement_type
           where l.client = ${client} and l.production_order_number = ${number} and l.production_order_item is not null
           group by l.production_order_item
        ) issued on issued.production_order_item = c.item_number
       where c.client = ${client} and c.order_number = ${number}
       order by c.item_number
    `);
    const received = await rows(tx, sql`
      select coalesce(sum(case when mt.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end), 0)::text as received
        from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number and d.status = 'POSTED'
        join movement_type mt on mt.client = l.client and mt.movement_type = l.movement_type
       where l.client = ${client} and l.production_order_number = ${number}
         and l.material_number = ${String(header.material_number)}
    `);
    const documents = await rows(tx, sql`
      select l.material_document_number, l.line_number, l.movement_type, l.material_number,
             l.base_quantity::text as quantity, d.posting_date, d.status, l.production_order_item
        from material_document_line l
        join material_document d on d.client = l.client and d.material_document_number = l.material_document_number
       where l.client = ${client} and l.production_order_number = ${number}
       order by d.posting_date, l.material_document_number, l.line_number
    `);
    const confirmations = await rows(tx, sql`
      select confirmation_number, confirmation_level, operation_number, confirmation_type, yield_quantity::text as yield,
             scrap_quantity::text as scrap, rework_quantity::text as rework, unit,
             posting_date::text as posting_date, execution_start::text as execution_start,
             execution_finish::text as execution_finish
        from production_confirmation
       where client = ${client} and order_number = ${number}
       order by confirmation_number
    `);
    const history = await rows(tx, sql`
      select changed_at, change_type, transaction_code, changed_by, reason
        from change_document
       where client = ${client} and object_class = 'production_order' and object_key = ${number}
       order by changed_at
    `);
    const status = String(header.status) === 'RELEASED' ? 'RELEASED' : 'CREATED';
    return {
      orderNumber: String(header.order_number),
      materialNumber: String(header.material_number),
      materialDescription: String(header.material_description ?? ''),
      plant: String(header.plant),
      plantName: String(header.plant_name ?? ''),
      companyCode: String(header.company_code ?? ''),
      quantity: String(header.quantity),
      unit: String(header.unit_of_measure),
      scheduledStart: String(header.scheduled_start),
      scheduledFinish: String(header.scheduled_finish),
      status,
      batch: String(header.batch_number ?? ''),
      schedulingProfile: String(header.scheduling_profile ?? ''),
      releaseOnCreate: String(header.release_on_create ?? ' '),
      batchCreation: String(header.batch_creation ?? ' '),
      plannedOrderNumber: header.planned_order_number == null ? null : String(header.planned_order_number),
      releasedBy: header.released_by == null ? null : String(header.released_by),
      releasedAt: stamp(header.released_at),
      receivedQuantity: Number(received[0]?.received ?? 0).toFixed(3),
      version: Number(header.version ?? 1),
      createdBy: String(header.created_by),
      createdAt: stamp(header.created_at) ?? '',
      changedBy: header.changed_by == null ? null : String(header.changed_by),
      changedAt: stamp(header.changed_at),
      components: components.map((row) => {
        const required = Number(row.required_quantity);
        const issued = Number(row.issued);
        return {
          itemNumber: Number(row.item_number),
          materialNumber: String(row.material_number),
          materialDescription: String(row.description ?? ''),
          plant: String(row.plant),
          storageLocation: row.storage_location == null ? null : String(row.storage_location),
          requiredQuantity: String(row.required_quantity),
          unit: String(row.unit_of_measure),
          issuedQuantity: issued.toFixed(3),
          remainingQuantity: Math.max(0, required - issued).toFixed(3),
        };
      }),
      confirmations: confirmations.map((row) => ({
        confirmationNumber: String(row.confirmation_number),
        confirmationLevel: String(row.confirmation_level) === 'HEADER' ? 'HEADER' : 'OPERATION',
        operationNumber: row.operation_number == null ? null : String(row.operation_number),
        confirmationType: String(row.confirmation_type),
        yieldQuantity: String(row.yield),
        scrapQuantity: String(row.scrap),
        reworkQuantity: String(row.rework),
        unit: String(row.unit),
        postingDate: String(row.posting_date),
        executionStart: row.execution_start == null ? null : String(row.execution_start),
        executionFinish: row.execution_finish == null ? null : String(row.execution_finish),
      })),
      documents: documents.map((row) => ({
        materialDocumentNumber: String(row.material_document_number),
        lineNumber: Number(row.line_number),
        movementType: String(row.movement_type),
        materialNumber: String(row.material_number),
        quantity: String(row.quantity),
        postingDate: String(row.posting_date),
        status: String(row.status),
        productionOrderItem: row.production_order_item == null ? null : Number(row.production_order_item),
      })),
      history: history.map((row) => ({
        changedAt: stamp(row.changed_at) ?? '',
        changeType: String(row.change_type),
        transactionCode: row.transaction_code == null ? null : String(row.transaction_code),
        changedBy: String(row.changed_by),
        reason: row.reason == null ? null : String(row.reason),
      })),
      gaps: GAPS,
    };
  });
}

export async function listProductionOrders(client: string, filter: {
  plant?: string | null;
  materialNumber?: string | null;
  status?: string | null;
  offset?: number | null;
}): Promise<{ rows: ProductionOrderListRow[]; total: number; truncated: boolean }> {
  const plant = clean(filter.plant).toUpperCase();
  const materialNumber = clean(filter.materialNumber).toUpperCase();
  const status = clean(filter.status).toUpperCase();
  if (!plant && !materialNumber) fail('A plant or a material is required to list production orders.', 'Enter the order number, or name a plant.');
  if (status && status !== 'CREATED' && status !== 'RELEASED') {
    fail(`Status ${status} is not a production-order status.`, 'Use created or released. Technical completion and closed are not stored.');
  }
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) fail('The list offset is not valid.');
  return withTenant(client, async (tx) => {
    const found = await rows(tx, sql`
      select o.order_number, o.material_number, m.description as material_description, o.plant,
             o.order_quantity::text as quantity, o.unit_of_measure, o.scheduled_finish, o.status
        from production_order o
        join material m on m.client = o.client and m.material_number = o.material_number
       where o.client = ${client}
         and (${plant} = '' or o.plant = ${plant})
         and (${materialNumber} = '' or o.material_number = ${materialNumber})
         and (${status} = '' or o.status = ${status})
       order by o.order_number
       limit ${PRODUCTION_ORDER_LIST_LIMIT + 1}
       offset ${offset}
    `);
    const totalRows = await rows(tx, sql`
      select count(*)::int as total
        from production_order
       where client = ${client}
         and (${plant} = '' or plant = ${plant})
         and (${materialNumber} = '' or material_number = ${materialNumber})
         and (${status} = '' or status = ${status})
    `);
    return {
      total: Number(totalRows[0]?.total ?? 0),
      truncated: found.length > PRODUCTION_ORDER_LIST_LIMIT,
      rows: found.slice(0, PRODUCTION_ORDER_LIST_LIMIT).map((row) => ({
        orderNumber: String(row.order_number),
        materialNumber: String(row.material_number),
        materialDescription: String(row.material_description ?? ''),
        plant: String(row.plant),
        quantity: String(row.quantity),
        unit: String(row.unit_of_measure),
        scheduledFinish: String(row.scheduled_finish),
        status: String(row.status),
      })),
    };
  });
}
