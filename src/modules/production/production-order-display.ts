/**
 * Display production order — CO03.
 *
 * The number is the key. Display reads the standing order and does not
 * change it, release it, or take a change lock. It does not touch the
 * version or the timestamps.
 *
 * A production version, BOM usage, and BOM alternative are shown when they
 * were stored with the snapshot. A blank value was not recorded. Display
 * does not re-read the bill of material, and the stored values are not
 * proof that the current bill of material still matches the components.
 * A production version is not a search key. An order type is stored on the
 * order and is not a search key. A controlling area, scrap, a scheduling
 * type, a priority, and a sequence are not search keys. Operations are
 * listed when they were copied onto the order. An order with none was not
 * given a routing snapshot. Issued and received quantities
 * are read from material documents. Confirmations are listed when they
 * stand. This display does not enter or cancel one.
 */
import { sql } from 'drizzle-orm';

import { JOURNAL_ACCOUNTING_NOTE } from '../inventory/material-document-accounting';
import { lineNotReversed, lineReversalDisagreement, OPEN_PRODUCTION_DOCUMENT, REVERSAL_QUANTITY_DISAGREEMENT } from '../inventory/production-document-quantity';

import { hasCapability } from '../../platform/auth/session';
import { withTenant, type Tx } from '../../platform/db/client';
import { toScaled } from '../../platform/posting/decimal';
import { parseProductionOrderStatus, type ProductionOrderStatus } from './production-order-status';

export const PRODUCTION_ORDER_DISPLAY_CAPABILITY = 'PROD.ORDER.DISPLAY';
export const PRODUCTION_ORDER_DISPLAY_ROUTE = '/production/production-order-display';
export const PRODUCTION_ORDER_DISPLAY_ALIAS = 'CO03';
export const PRODUCTION_ORDER_LIST_LIMIT = 25;

const REFUSED: Record<string, string> = {
  orderType: 'An order type is stored on the order. It is not a search key.',
  controllingArea: 'A controlling area is not a key. The company code is read from the plant.',
  scrap: 'A scrap quantity is not stored on the production order.',
  productionVersion: 'A production version is not a search key. When one was stored, it is shown on the order as the version that selected the snapshot. Display does not re-read the bill of material.',
  schedulingType: 'A scheduling type is not stored. The start and finish dates are.',
  priority: 'A priority is not stored on the production order.',
  operation: 'An operation is not a search key. Stored operations are listed on the order. A missing snapshot is not stored as a search.',
  sequence: 'Only the copied standard sequence is stored. An alternative or parallel sequence is not a search key.',
  availability: 'Component availability is not checked on this display.',
  cost: 'Cost is not carried on the production order.',
  confirmation: 'A confirmation number is not the key of this display. Confirmations that stand are listed with the order.',
  teco: 'Technical completion is a CO02 action, not a display key. Filter the list by status if that is what is needed.',
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
  /** Order component line. This is not the bill-of-material item. */
  itemNumber: number;
  /** Original BOM item. Null when the line was not derived from a BOM. */
  bomItem: string | null;
  /** Material whose BOM the item came from. Null when the line was not derived. */
  sourceMaterial: string | null;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  storageLocation: string | null;
  requiredQuantity: string;
  unit: string;
  /** Null when conversion did not copy a matching dependent requirement date. */
  requirementDate: string | null;
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
  cancelled: boolean;
  cancellationNumber: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
}

export interface ProductionOrderHistoryDisplay {
  changedAt: string;
  changeType: string;
  transactionCode: string | null;
  changedBy: string;
  reason: string | null;
}

export interface ProductionOrderOperationDisplay {
  operationNumber: string;
  sequence: string;
  executionOrder: number;
  shortText: string | null;
  workCenter: string | null;
  controlKey: string | null;
  taskListType: string;
  routingGroup: string;
  groupCounter: string;
  productionVersion: string;
  routingVersion: number;
  confirmation: string;
  confirmedYield: string;
  confirmedScrap: string;
  confirmedRework: string;
  /** UNCONFIRMED is a stored operation with no active confirmation. It is not a missing snapshot. */
  progress: 'UNCONFIRMED' | 'PARTIAL' | 'FINAL';
  values: Array<{ parameter: string; description: string; quantity: string | null; unit: string; required: string }>;
}

export interface ProductionOrderDisplay {
  orderNumber: string;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  /** Null when the order was saved without a type. It was not filled in. */
  orderType: string | null;
  plantName: string;
  companyCode: string;
  quantity: string;
  unit: string;
  scheduledStart: string;
  scheduledFinish: string;
  status: ProductionOrderStatus;
  technicallyCompletedBy: string | null;
  technicallyCompletedAt: string | null;
  batch: string;
  schedulingProfile: string;
  releaseOnCreate: string;
  batchCreation: string;
  plannedOrderNumber: string | null;
  /** Null when creation did not record a production version. Not inferred. */
  productionVersion: string | null;
  bomUsage: string | null;
  bomAlternative: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  receivedQuantity: string;
  /** Active header confirmations only. Operation yields are not added. Cancelled header confirmations are excluded. */
  headerConfirmedYield: string;
  headerConfirmedScrap: string;
  headerConfirmedRework: string;
  version: number;
  createdBy: string;
  createdAt: string;
  changedBy: string | null;
  changedAt: string | null;
  components: ProductionOrderComponentDisplay[];
  operations: ProductionOrderOperationDisplay[];
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
  orderType: string | null;
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

/** A partial material reversal does not reverse the journal. CO03 must say so. */
async function journalAccountingGaps(tx: Tx, client: string, number: string): Promise<string[]> {
  const found = await rows(tx, sql`
    select distinct d.status, coalesce(j.status, 'ABSENT') as journal_status
      from material_document_line l
      join material_document d
        on d.client = l.client and d.material_document_number = l.material_document_number
      left join journal_entry j
        on d.journal_document_number is not null
       and split_part(d.journal_document_number, '/', 2) ~ '^[0-9]+$'
       and j.client = d.client
       and j.document_number = d.journal_document_number
       and j.fiscal_year = split_part(d.journal_document_number, '/', 2)::int
     where l.client = ${client}
       and l.production_order_number = ${number}
       and d.reversal_of is null
       and d.journal_document_number is not null
       and (
         (d.status = 'PARTIALLY_REVERSED' and coalesce(j.status, 'ABSENT') = 'POSTED')
         or (d.status = 'REVERSED' and coalesce(j.status, 'ABSENT') <> 'REVERSED')
         or (d.status <> 'REVERSED' and j.status = 'REVERSED')
       )
  `);
  const notes = new Set<string>();
  for (const row of found) {
    const status = String(row.status);
    const journalStatus = String(row.journal_status);
    if (status === 'PARTIALLY_REVERSED' && journalStatus === 'POSTED') notes.add(JOURNAL_ACCOUNTING_NOTE.partial);
    else if (status === 'REVERSED' && journalStatus !== 'REVERSED') notes.add(JOURNAL_ACCOUNTING_NOTE.missing);
    else if (status !== 'REVERSED' && journalStatus === 'REVERSED') notes.add(JOURNAL_ACCOUNTING_NOTE.mismatch);
  }
  return [...notes];
}

async function operationDisplays(tx: Tx, client: string, orderNumber: string): Promise<ProductionOrderOperationDisplay[]> {
  const found = await rows(tx, sql`
    select op.operation_number, op.sequence, op.execution_order, op.short_text, op.work_center, op.control_key,
           op.task_list_type, op.routing_group, op.group_counter, op.production_version,
           op.routing_version, op.confirmation,
           coalesce(progress.yield, 0)::text as yield,
           coalesce(progress.scrap, 0)::text as scrap,
           coalesce(progress.rework, 0)::text as rework,
           coalesce(progress.final, false) as final
      from production_order_operation op
      left join lateral (
        select coalesce(sum(yield_quantity), 0) as yield,
               coalesce(sum(scrap_quantity), 0) as scrap,
               coalesce(sum(rework_quantity), 0) as rework,
               bool_or(confirmation_type = 'FINAL') as final
          from (
            select c.yield_quantity, c.scrap_quantity, c.rework_quantity, c.confirmation_type
              from production_confirmation c
             where c.client = op.client and c.order_number = op.order_number
               and c.confirmation_level = 'OPERATION' and c.operation_number = op.operation_number
               and not exists (
                 select 1 from production_confirmation_cancellation x
                  where x.client = c.client and x.confirmation_number = c.confirmation_number
               )
            union all
            select e.yield_quantity, e.scrap_quantity, e.rework_quantity, e.confirmation_type
              from production_confirmation_operation e
             where e.client = op.client and e.order_number = op.order_number
               and e.operation_number = op.operation_number
               and not exists (
                 select 1 from production_confirmation_cancellation x
                  where x.client = e.client and x.confirmation_number = e.confirmation_number
               )
          ) posted
      ) progress on true
     where op.client = ${client} and op.order_number = ${orderNumber}
     order by op.execution_order, op.operation_number
  `);
  const values = await rows(tx, sql`
    select operation_number, parameter, description, quantity::text as quantity, unit, required
      from production_order_operation_value
     where client = ${client} and order_number = ${orderNumber}
     order by operation_number, parameter
  `);
  return found.map((row) => {
    const final = row.final === true || row.final === 't' || row.final === 'true';
    const yieldQuantity = String(row.yield ?? '0');
    const scrapQuantity = String(row.scrap ?? '0');
    const reworkQuantity = String(row.rework ?? '0');
    const active = Number(yieldQuantity) + Number(scrapQuantity) + Number(reworkQuantity) > 0;
    return {
      operationNumber: String(row.operation_number),
      sequence: String(row.sequence),
      executionOrder: Number(row.execution_order),
      shortText: recorded(row.short_text),
      workCenter: recorded(row.work_center),
      controlKey: recorded(row.control_key),
      taskListType: String(row.task_list_type),
      routingGroup: String(row.routing_group),
      groupCounter: String(row.group_counter),
      productionVersion: String(row.production_version),
      routingVersion: Number(row.routing_version),
      confirmation: String(row.confirmation),
      confirmedYield: yieldQuantity,
      confirmedScrap: scrapQuantity,
      confirmedRework: reworkQuantity,
      progress: final ? 'FINAL' : active ? 'PARTIAL' : 'UNCONFIRMED',
      values: values.filter((value) => String(value.operation_number) === String(row.operation_number)).map((value) => ({
        parameter: String(value.parameter),
        description: String(value.description),
        quantity: value.quantity == null ? null : String(value.quantity),
        unit: String(value.unit),
        required: String(value.required),
      })),
    };
  });
}

function stamp(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function recorded(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function quantitySum(rows: Array<Record<string, unknown>>, field: string): string {
  const total = rows.reduce((sum, row) => sum + toScaled(String(row[field] ?? '0'), 3), 0n);
  const absolute = total.toString().padStart(4, '0');
  return `${absolute.slice(0, -3)}.${absolute.slice(-3)}`;
}

function gapsOf(versionRecorded: boolean, undatedComponents: number, operationCount: number): string[] {
  return [
    operationCount > 0
      ? `${operationCount} operation(s) were copied onto this order. A later routing change does not rewrite them. Predecessor and successor are not stored.`
      : 'Operations are not stored on the production order. None were copied, and none were read from a routing.',
    operationCount > 0
      ? 'The stored sequence is standard sequence 000000. Execution order is stored separately and is not the operation number. An order created with this column copies the routing execution order. A row that had no execution order received the operation-number display order instead. That assignment is not proof of an earlier routing order. A later routing change does not rewrite either value. Another sequence was not invented.'
      : 'Sequences are not stored.',
    'A confirmation is posted against the operation number. Its sequence stays 000000. Execution order is not written there, and an earlier operation does not have to be confirmed first.',
    versionRecorded
      ? 'The stored production version and bill of material are the determination that selected this snapshot. Display does not re-read the bill of material. A later BOM change or component edit is not applied here.'
      : 'A production version and bill of material were not recorded on this order. None was inferred.',
    undatedComponents > 0
      ? `${undatedComponents} component line(s) have no requirement date. They are not planning demand. The order start, the order finish, the bill of material date, and today were not used.`
      : 'Each component requirement date was copied from a matching dependent requirement. That dated component is the active demand. The closed dependent requirement is not counted again. Planning counts the copied date. It was not taken from the order start or finish.',
    'Changing the scheduled start or finish does not move a component requirement date. No component scheduling calculation exists. The receipt uses the scheduled finish and is separate from component demand.',
    'Header confirmed yield counts each active header confirmation once. A cancelled header confirmation is excluded. Operation confirmed yields are not added to it, and they are not added across operations.',
    'Confirmations are listed when they stand, including a cancellation reference. This display does not enter or cancel one. Actual start and finish stand on the confirmation, not on the order.',
    'Cost is not carried.',
    'Component availability is not checked.',
    'No reservation is created by displaying the order.',
  ];
}

export async function getProductionOrderDisplay(client: string, orderNumber: string): Promise<ProductionOrderDisplay | null> {
  const number = orderNumberOf(orderNumber);
  return withTenant(client, async (tx) => {
    const found = await rows(tx, sql`
      select o.order_number, o.material_number, m.description as material_description, o.plant, p.name as plant_name,
             coalesce(p.company_code, '') as company_code, o.order_quantity::text as quantity, o.unit_of_measure,
             o.scheduled_start, o.scheduled_finish, o.status, o.order_type, o.batch_number, o.scheduling_profile,
             o.release_on_create, o.batch_creation, o.planned_order_number, o.released_by, o.released_at,
             o.production_version, o.bom_usage, o.bom_alternative,
             o.technically_completed_by, o.technically_completed_at,
             o.version, o.created_by, o.created_at, o.changed_by, o.changed_at
        from production_order o
        join material m on m.client = o.client and m.material_number = o.material_number
        join plant p on p.client = o.client and p.plant = o.plant
       where o.client = ${client} and o.order_number = ${number}
    `);
    const header = found[0];
    if (!header) return null;
    const components = await rows(tx, sql`
      select c.item_number, c.bom_item, c.source_material, c.material_number, coalesce(m.description, '') as description, c.plant,
             c.storage_location, c.required_quantity::text as required_quantity, c.unit_of_measure,
             c.requirement_date::text as requirement_date,
             coalesce(issued.issued, 0)::text as issued
        from production_order_component c
        left join material m on m.client = c.client and m.material_number = c.material_number
        left join lateral (
          select coalesce(sum(l.base_quantity), 0) as issued
            from material_document_line l
            join material_document d
              on d.client = l.client and d.material_document_number = l.material_document_number
             and ${OPEN_PRODUCTION_DOCUMENT}
           where l.client = c.client and l.production_order_number = c.order_number
             and l.production_order_item = c.item_number
             and l.material_number = c.material_number
             and ${lineNotReversed('l')}
        ) issued on true
       where c.client = ${client} and c.order_number = ${number}
       order by c.item_number
    `);
    const received = await rows(tx, sql`
      select coalesce(sum(l.base_quantity), 0)::text as received
        from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number
         and ${OPEN_PRODUCTION_DOCUMENT}
       where l.client = ${client} and l.production_order_number = ${number}
         and l.material_number = ${String(header.material_number)}
         and l.production_order_item is null
         and ${lineNotReversed('l')}
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
      select c.confirmation_number, c.confirmation_level, c.operation_number, c.confirmation_type,
             c.yield_quantity::text as yield, c.scrap_quantity::text as scrap, c.rework_quantity::text as rework, c.unit,
             c.posting_date::text as posting_date, c.execution_start::text as execution_start,
             c.execution_finish::text as execution_finish,
             x.cancellation_number, x.created_by as cancelled_by, x.created_at as cancelled_at
        from production_confirmation c
        left join production_confirmation_cancellation x
          on x.client = c.client and x.confirmation_number = c.confirmation_number
       where c.client = ${client} and c.order_number = ${number}
       order by c.confirmation_number
    `);
    const operations = await operationDisplays(tx, client, number);
    const history = await rows(tx, sql`
      select changed_at, change_type, transaction_code, changed_by, reason
        from change_document
       where client = ${client} and object_class = 'production_order' and object_key = ${number}
       order by changed_at
    `);
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
      materialDescription: String(header.material_description ?? ''),
      plant: String(header.plant),
      orderType: header.order_type == null || String(header.order_type) === '' ? null : String(header.order_type),
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
      productionVersion: recorded(header.production_version),
      bomUsage: recorded(header.bom_usage),
      bomAlternative: recorded(header.bom_alternative),
      releasedBy: header.released_by == null ? null : String(header.released_by),
      releasedAt: stamp(header.released_at),
      technicallyCompletedBy: header.technically_completed_by == null ? null : String(header.technically_completed_by),
      technicallyCompletedAt: stamp(header.technically_completed_at),
      receivedQuantity: Number(received[0]?.received ?? 0).toFixed(3),
      headerConfirmedYield: quantitySum(confirmations.filter((row) => String(row.confirmation_level) === 'HEADER' && row.cancellation_number == null), 'yield'),
      headerConfirmedScrap: quantitySum(confirmations.filter((row) => String(row.confirmation_level) === 'HEADER' && row.cancellation_number == null), 'scrap'),
      headerConfirmedRework: quantitySum(confirmations.filter((row) => String(row.confirmation_level) === 'HEADER' && row.cancellation_number == null), 'rework'),
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
          bomItem: recorded(row.bom_item),
          sourceMaterial: recorded(row.source_material),
          materialNumber: String(row.material_number),
          materialDescription: String(row.description ?? ''),
          plant: String(row.plant),
          storageLocation: row.storage_location == null ? null : String(row.storage_location),
          requiredQuantity: String(row.required_quantity),
          unit: String(row.unit_of_measure),
          requirementDate: recorded(row.requirement_date),
          issuedQuantity: issued.toFixed(3),
          remainingQuantity: Math.max(0, required - issued).toFixed(3),
        };
      }),
      operations,
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
        cancelled: row.cancellation_number != null,
        cancellationNumber: row.cancellation_number == null ? null : String(row.cancellation_number),
        cancelledBy: row.cancelled_by == null ? null : String(row.cancelled_by),
        cancelledAt: row.cancelled_at == null ? null : stamp(row.cancelled_at),
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
      gaps: [
        ...gapsOf(
          recorded(header.production_version) != null,
          components.filter((row) => recorded(row.requirement_date) == null).length,
          operations.length,
        ),
        ...((await rows(tx, sql`
          select 1 as hit
            from material_document_line l
           where l.client = ${client} and l.production_order_number = ${number}
             and ${lineReversalDisagreement('l')}
           limit 1
        `)).length > 0 ? [REVERSAL_QUANTITY_DISAGREEMENT] : []),
        ...(await journalAccountingGaps(tx, client, number)),
      ],
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
  if (status && !parseProductionOrderStatus(status)) {
    fail(`Status ${status} is not a production-order status.`, 'Use created, released, or technically completed. Closed and delivered are not stored.');
  }
  const offset = filter.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) fail('The list offset is not valid.');
  return withTenant(client, async (tx) => {
    const found = await rows(tx, sql`
      select o.order_number, o.material_number, m.description as material_description, o.plant, o.order_type,
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
        orderType: row.order_type == null || String(row.order_type) === '' ? null : String(row.order_type),
        quantity: String(row.quantity),
        unit: String(row.unit_of_measure),
        scheduledFinish: String(row.scheduled_finish),
        status: String(row.status),
      })),
    };
  });
}
