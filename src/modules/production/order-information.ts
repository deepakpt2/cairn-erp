/**
 * Production order information — COOIS.
 *
 * A list. It does not create an order, change one, confirm one, or post.
 * A row is the record the list names. An order with two components is two
 * component rows and one header row. Header confirmed yield is the sum of
 * header confirmations only. Operation confirmations are not added to it.
 *
 * Operations, sequences, capacities, automatic goods movements, and purchase
 * documents are not stored for this list. They are refused, not shown as
 * empty data.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { withTenant, type Tx } from '../../platform/db/client';

export const ORDER_INFORMATION_CAPABILITY = 'PROD.ORDER.INFO';
export const ORDER_INFORMATION_ROUTE = '/production/order-information';
export const ORDER_INFORMATION_ALIAS = 'COOIS';
export const ORDER_INFORMATION_DEFAULT_LIMIT = 25;
export const ORDER_INFORMATION_MAX_LIMIT = 100;

const REFUSED: Record<string, string> = {
  orderType: 'An order type is not stored. Created and released are the production-order statuses.',
  productionSupervisor: 'A production supervisor is not stored.',
  productionVersion: 'A production version is not stored on the order. It was not used as a filter.',
  deletionIndicator: 'A deletion flag is not stored. Flagged records were not included, because none are stored.',
  archived: 'Archived records are not retrieved.',
  relativeDate: 'A relative date is not configured. Enter a from date, a to date, or both.',
  workCenter: 'Operations are not stored on the order. A work center does not select orders.',
  operation: 'Operations are not stored on the order. An operation is not a filter of this list.',
  operationStatus: 'An operation status is not stored.',
  sequence: 'Sequences are not stored.',
  capacity: 'Capacity is not stored. No capacity row was invented.',
  cost: 'Cost is not carried. It is not a column of this list.',
  price: 'A price is not a column of this list.',
  value: 'A value is not a column of this list.',
  automaticGoodsMovement: 'Automatic goods movements are not configured. None were listed.',
  goodsMovementError: 'A goods-movement error queue is not stored.',
  triggerPoint: 'A trigger point is not stored.',
  prt: 'A production resource or tool is not stored.',
  purchaseRequisition: 'A production order does not create a purchase requisition. None was inferred.',
  purchaseOrder: 'A purchase order is not linked to a production order here.',
  documentLink: 'A document link is not stored.',
  item: 'An order item is not stored. The produced material is the header.',
  productionList: 'A production list is not a separate read model.',
  co13: 'CO13 is not implemented. This list does not cancel a confirmation.',
  co14: 'CO14 is not implemented. A confirmation is listed here. It is not opened on another screen.',
  teco: 'Technical completion is not a status.',
  closed: 'A closed status is not stored.',
  reducedReading: 'Reduced reading is the reduced flag. A named profile was not applied.',
  overallProfile: 'An overall profile is not stored.',
  sharedLayout: 'A layout is private to the user who saved it. A shared layout is not stored.',
};

export class OrderInformationError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'OrderInformationError';
  }
}

export type OrderObject = 'PRODUCTION_ORDER' | 'PLANNED_ORDER';

export interface OrderInformationField {
  id: string;
  label: string;
}

export interface OrderInformationListType {
  id: string;
  label: string;
  available: boolean;
  reason: string | null;
  objects: OrderObject[];
}

export interface OrderInformationRow {
  [key: string]: string | null;
}

export interface OrderOverview {
  orderNumber: string;
  header: OrderInformationRow;
  components: OrderInformationRow[];
  confirmations: OrderInformationRow[];
  movements: OrderInformationRow[];
  dependents: OrderInformationRow[];
  reduced: boolean;
}

export interface OrderInformationResult {
  object: OrderObject;
  listType: string;
  columns: OrderInformationField[];
  rows: OrderInformationRow[];
  total: number;
  returned: number;
  limit: number;
  offset: number;
  truncated: boolean;
  overview: OrderOverview | null;
  notes: string[];
  written: false;
}

export interface OrderInformationLayout {
  layoutId: string;
  name: string;
  description: string;
  object: OrderObject;
  listType: string;
  fields: string[];
  sortField: string;
  sortDirection: 'ASC' | 'DESC';
  isDefault: boolean;
}

const NOTES = [
  'This list writes nothing. It does not change an order, a confirmation, or a material document.',
  'Header confirmed yield is the sum of header confirmations. An operation confirmation is not added to it, because each operation is not a share of one yield.',
  'Delivered quantity is the posted material-document quantity of the produced material, net of a reversal direction, and only while the document is posted. It is not the confirmed yield.',
  'Issued quantity uses the same posted sum as order display. Remaining is required minus issued, and it is not shown below zero.',
  'A component filter on the header list selects orders that have at least one matching component. It does not mean every component matched.',
  'Operations, sequences, and a production version are not stored on the order. Those lists are not available.',
  'Cancellation of a confirmation is not stored. Every standing confirmation is listed.',
  'Cost is not carried. Archived records are not included. A plant authorization object is not stored. The tenant is the boundary.',
];

const HEADER_FIELDS: OrderInformationField[] = [
  { id: 'orderNumber', label: 'Order' },
  { id: 'materialNumber', label: 'Material' },
  { id: 'materialDescription', label: 'Description' },
  { id: 'plant', label: 'Plant' },
  { id: 'orderQuantity', label: 'Order quantity' },
  { id: 'unit', label: 'Unit' },
  { id: 'scheduledStart', label: 'Scheduled start' },
  { id: 'scheduledFinish', label: 'Scheduled finish' },
  { id: 'status', label: 'Status' },
  { id: 'batch', label: 'Batch' },
  { id: 'mrpController', label: 'MRP controller' },
  { id: 'headerConfirmedYield', label: 'Header confirmed yield' },
  { id: 'deliveredQuantity', label: 'Delivered quantity' },
  { id: 'confirmationCount', label: 'Confirmation records' },
  { id: 'plannedOrderNumber', label: 'Planned order' },
];

const COMPONENT_FIELDS: OrderInformationField[] = [
  { id: 'orderNumber', label: 'Order' },
  { id: 'itemNumber', label: 'Item' },
  { id: 'materialNumber', label: 'Component' },
  { id: 'materialDescription', label: 'Description' },
  { id: 'plant', label: 'Plant' },
  { id: 'storageLocation', label: 'Storage location' },
  { id: 'requiredQuantity', label: 'Required' },
  { id: 'issuedQuantity', label: 'Issued' },
  { id: 'remainingQuantity', label: 'Remaining' },
  { id: 'unit', label: 'Unit' },
  { id: 'orderStatus', label: 'Order status' },
];

const CONFIRMATION_FIELDS: OrderInformationField[] = [
  { id: 'confirmationNumber', label: 'Confirmation' },
  { id: 'confirmationLevel', label: 'Level' },
  { id: 'orderNumber', label: 'Order' },
  { id: 'operationNumber', label: 'Operation' },
  { id: 'affectedOperations', label: 'Affected operations' },
  { id: 'confirmationType', label: 'Type' },
  { id: 'yieldQuantity', label: 'Yield' },
  { id: 'scrapQuantity', label: 'Scrap' },
  { id: 'reworkQuantity', label: 'Rework' },
  { id: 'unit', label: 'Unit' },
  { id: 'postingDate', label: 'Posting date' },
  { id: 'productionVersion', label: 'Production version' },
];

const MOVEMENT_FIELDS: OrderInformationField[] = [
  { id: 'materialDocumentNumber', label: 'Material document' },
  { id: 'lineNumber', label: 'Line' },
  { id: 'orderNumber', label: 'Order' },
  { id: 'productionOrderItem', label: 'Order item' },
  { id: 'movementType', label: 'Movement type' },
  { id: 'materialNumber', label: 'Material' },
  { id: 'quantity', label: 'Quantity' },
  { id: 'unit', label: 'Unit' },
  { id: 'plant', label: 'Plant' },
  { id: 'storageLocation', label: 'Storage location' },
  { id: 'batch', label: 'Batch' },
  { id: 'postingDate', label: 'Posting date' },
  { id: 'documentStatus', label: 'Document status' },
  { id: 'reversalOf', label: 'Reversal of' },
];

const PLANNED_FIELDS: OrderInformationField[] = [
  { id: 'orderNumber', label: 'Planned order' },
  { id: 'materialNumber', label: 'Material' },
  { id: 'materialDescription', label: 'Description' },
  { id: 'plant', label: 'Plant' },
  { id: 'quantity', label: 'Quantity' },
  { id: 'unit', label: 'Unit' },
  { id: 'startDate', label: 'Start' },
  { id: 'finishDate', label: 'Finish' },
  { id: 'firmingStatus', label: 'Firming' },
  { id: 'origin', label: 'Origin' },
  { id: 'mrpController', label: 'MRP controller' },
  { id: 'productionOrderNumber', label: 'Production order' },
];

const DEPENDENT_FIELDS: OrderInformationField[] = [
  { id: 'plannedOrderNumber', label: 'Planned order' },
  { id: 'itemNumber', label: 'Item' },
  { id: 'materialNumber', label: 'Component' },
  { id: 'materialDescription', label: 'Description' },
  { id: 'plant', label: 'Plant' },
  { id: 'quantity', label: 'Quantity' },
  { id: 'unit', label: 'Unit' },
  { id: 'requirementDate', label: 'Requirement date' },
  { id: 'status', label: 'Status' },
];

const UNAVAILABLE: OrderInformationListType[] = [
  { id: 'ITEMS', label: 'Items', available: false, objects: ['PRODUCTION_ORDER'], reason: 'An order item is not stored. The produced material is the header.' },
  { id: 'OPERATIONS', label: 'Operations', available: false, objects: ['PRODUCTION_ORDER'], reason: 'Operations are not stored on the order. A confirmation names a routing operation. It is not copied here.' },
  { id: 'AUTOMATIC_GOODS_MOVEMENTS', label: 'Automatic goods movements', available: false, objects: ['PRODUCTION_ORDER'], reason: 'Automatic goods movements are not configured.' },
  { id: 'GOODS_MOVEMENT_ERRORS', label: 'Goods movements with errors', available: false, objects: ['PRODUCTION_ORDER'], reason: 'A goods-movement error queue is not stored.' },
  { id: 'CAPACITIES', label: 'Capacities', available: false, objects: ['PRODUCTION_ORDER'], reason: 'Capacity is not stored.' },
  { id: 'PRODUCTION_LIST', label: 'Production list', available: false, objects: ['PRODUCTION_ORDER'], reason: 'A production list is not a separate read model.' },
  { id: 'SEQUENCES', label: 'Sequences', available: false, objects: ['PRODUCTION_ORDER'], reason: 'Sequences are not stored.' },
  { id: 'TRIGGER_POINTS', label: 'Trigger points', available: false, objects: ['PRODUCTION_ORDER'], reason: 'A trigger point is not stored.' },
  { id: 'PRT', label: 'Production resources/tools', available: false, objects: ['PRODUCTION_ORDER'], reason: 'A production resource or tool is not stored.' },
  { id: 'PURCHASE_REQUISITIONS', label: 'Purchase requisitions', available: false, objects: ['PRODUCTION_ORDER'], reason: 'A production order does not create a purchase requisition.' },
  { id: 'PURCHASE_ORDERS', label: 'Purchase orders', available: false, objects: ['PRODUCTION_ORDER'], reason: 'A purchase order is not linked to a production order here.' },
  { id: 'DOCUMENT_LINKS', label: 'Document links', available: false, objects: ['PRODUCTION_ORDER'], reason: 'A document link is not stored.' },
];

export function orderInformationLists(): OrderInformationListType[] {
  return [
    { id: 'HEADERS', label: 'Order headers', available: true, objects: ['PRODUCTION_ORDER', 'PLANNED_ORDER'], reason: null },
    { id: 'OVERVIEW', label: 'Object overview', available: true, objects: ['PRODUCTION_ORDER', 'PLANNED_ORDER'], reason: null },
    { id: 'COMPONENTS', label: 'Components', available: true, objects: ['PRODUCTION_ORDER', 'PLANNED_ORDER'], reason: null },
    { id: 'CONFIRMATIONS', label: 'Confirmations', available: true, objects: ['PRODUCTION_ORDER'], reason: null },
    { id: 'GOODS_MOVEMENTS', label: 'Documented goods movements', available: true, objects: ['PRODUCTION_ORDER'], reason: null },
    ...UNAVAILABLE,
  ];
}

export function orderInformationFields(object: OrderObject, listType: string): OrderInformationField[] {
  if (object === 'PLANNED_ORDER' && listType === 'HEADERS') return PLANNED_FIELDS;
  if (object === 'PLANNED_ORDER' && listType === 'COMPONENTS') return DEPENDENT_FIELDS;
  if (object === 'PLANNED_ORDER' && listType === 'OVERVIEW') return PLANNED_FIELDS;
  if (listType === 'HEADERS' || listType === 'OVERVIEW') return HEADER_FIELDS;
  if (listType === 'COMPONENTS') return COMPONENT_FIELDS;
  if (listType === 'CONFIRMATIONS') return CONFIRMATION_FIELDS;
  if (listType === 'GOODS_MOVEMENTS') return MOVEMENT_FIELDS;
  return [];
}

function fail(message: string, remedy?: string): never {
  throw new OrderInformationError(message, remedy);
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function orderInformationRefusal(fields: Record<string, string | null | undefined> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    if (!clean(value)) continue;
    return REFUSED[name] ?? `${name} is not a field of this list.`;
  }
  return null;
}

export function holdsOrderInformationAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], ORDER_INFORMATION_CAPABILITY);
}

function dateOf(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) {
    fail(`${label} is not a valid date.`);
  }
  return value;
}

function numbersOf(value: string, label: string): string[] {
  if (!value) return [];
  const numbers = value.split(',').map((part) => part.trim().toUpperCase()).filter(Boolean);
  if (numbers.length > 20) fail(`Name at most 20 ${label}.`, 'The list was not run.');
  for (const number of numbers) {
    if (number.length > 12) fail(`A ${label} number is too long.`);
  }
  return numbers;
}

function fragmentOf(value: string): string {
  return value.replace(/[%_\\]/g, '').slice(0, 40);
}

interface ParsedQuery {
  object: OrderObject;
  listType: string;
  plant: string;
  orders: string[];
  plannedOrders: string[];
  materialNumber: string;
  description: string;
  mrpController: string;
  statuses: string[];
  componentMaterial: string;
  storageLocation: string;
  batch: string;
  movementType: string;
  confirmationType: string;
  dateBasis: string;
  dateFrom: string;
  dateTo: string;
  fields: string[];
  sortField: string;
  sortDirection: 'ASC' | 'DESC';
  limit: number;
  offset: number;
  reduced: boolean;
  layoutId: string;
}

function parseQuery(input: {
  object?: string | null;
  listType?: string | null;
  plant?: string | null;
  orderNumber?: string | null;
  plannedOrderNumber?: string | null;
  materialNumber?: string | null;
  materialDescription?: string | null;
  mrpController?: string | null;
  status?: string | null;
  componentMaterial?: string | null;
  storageLocation?: string | null;
  batch?: string | null;
  movementType?: string | null;
  confirmationType?: string | null;
  dateBasis?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  fields?: string[] | null;
  sortField?: string | null;
  sortDirection?: string | null;
  limit?: number | null;
  offset?: number | null;
  reduced?: boolean | null;
  layoutId?: string | null;
  named?: Record<string, string | null | undefined>;
}): ParsedQuery {
  const refused = orderInformationRefusal(input.named);
  if (refused) fail(refused, 'The list was not run.');
  const object = clean(input.object).toUpperCase() || 'PRODUCTION_ORDER';
  if (object !== 'PRODUCTION_ORDER' && object !== 'PLANNED_ORDER') {
    fail('Name production orders or planned orders.', 'The two are not listed together.');
  }
  const listType = clean(input.listType).toUpperCase();
  if (!listType) fail('A list type is required.', 'Choose order headers, components, confirmations, goods movements, or an overview.');
  const known = orderInformationLists().find((row) => row.id === listType);
  if (!known) fail(`List ${listType} is not a list of this report.`);
  if (!known.available) fail(known.reason ?? `${known.label} is not available.`, 'Choose a list that reads a stored record.');
  if (!known.objects.includes(object)) {
    fail(`${known.label} does not list ${object === 'PLANNED_ORDER' ? 'planned orders' : 'production orders'}.`, 'Change the object or the list. The other was not dropped silently.');
  }
  const plant = clean(input.plant).toUpperCase();
  if (plant.length > 10) fail('The plant is too long.');
  const materialNumber = clean(input.materialNumber).toUpperCase();
  if (materialNumber.length > 40) fail('The material is too long.');
  const description = fragmentOf(clean(input.materialDescription));
  const mrpController = clean(input.mrpController).toUpperCase();
  if (mrpController.length > 3) fail('The MRP controller is too long.');
  const componentMaterial = clean(input.componentMaterial).toUpperCase();
  const storageLocation = clean(input.storageLocation).toUpperCase();
  const batch = clean(input.batch).toUpperCase();
  const movementType = clean(input.movementType).toUpperCase();
  const confirmationType = clean(input.confirmationType).toUpperCase();
  const dateBasis = clean(input.dateBasis).toUpperCase();
  const dateFrom = clean(input.dateFrom);
  const dateTo = clean(input.dateTo);
  if ((dateFrom || dateTo) && !dateBasis) {
    fail('A date needs a date basis.', 'Choose the date the filter applies to. It was not applied to another date.');
  }
  if (dateBasis && !dateFrom && !dateTo) fail('A date basis needs a from date, a to date, or both.');
  if (dateFrom) dateOf(dateFrom, 'The from date');
  if (dateTo) dateOf(dateTo, 'The to date');
  if (dateFrom && dateTo && dateFrom > dateTo) fail('The from date is after the to date.');
  const allowedBasis = dateBases(object, listType);
  if (dateBasis && !allowedBasis.includes(dateBasis)) {
    fail(`Date basis ${dateBasis} is not a date of this list.`, `Use ${allowedBasis.join(' or ')}. The date was not applied to another field.`);
  }
  if (movementType && listType !== 'GOODS_MOVEMENTS') {
    fail('A movement type filters documented goods movements only.', 'It was not applied to another list.');
  }
  if (confirmationType && listType !== 'CONFIRMATIONS') {
    fail('A confirmation type filters the confirmation list only.', 'It was not applied to another list.');
  }
  if (confirmationType && confirmationType !== 'PARTIAL' && confirmationType !== 'FINAL') {
    fail('A confirmation type is partial or final.', 'Automatic is not a stored rule.');
  }
  if (storageLocation && listType !== 'COMPONENTS' && listType !== 'GOODS_MOVEMENTS') {
    fail('A storage location filters components or goods movements.', 'It was not applied to the order header.');
  }
  if (batch && object === 'PLANNED_ORDER') fail('A batch is not stored on a planned order.');
  if (batch && listType !== 'HEADERS' && listType !== 'OVERVIEW' && listType !== 'GOODS_MOVEMENTS') {
    fail('A batch filters order headers or goods movements.', 'It is not stored on a confirmation.');
  }
  const statuses = clean(input.status).toUpperCase().split(',').map((part) => part.trim()).filter(Boolean);
  for (const status of statuses) {
    if (object === 'PLANNED_ORDER' && status !== 'OPEN' && status !== 'FIRMED') {
      fail(`Status ${status} is not a planned-order firming status.`, 'Use open or firmed. Created and released are production-order statuses.');
    }
    if (object === 'PRODUCTION_ORDER' && status !== 'CREATED' && status !== 'RELEASED') {
      fail(`Status ${status} is not a production-order status.`, 'Use created or released. Technical completion and closed are not stored.');
    }
  }
  const orders = numbersOf(clean(input.orderNumber), 'production-order');
  const plannedOrders = numbersOf(clean(input.plannedOrderNumber), 'planned-order');
  if (object === 'PLANNED_ORDER' && orders.length > 0) {
    fail('A production order number does not select planned orders.', 'Name the planned order, or list production orders.');
  }
  if (object === 'PRODUCTION_ORDER' && plannedOrders.length > 0 && listType !== 'HEADERS' && listType !== 'OVERVIEW') {
    fail('A planned order number filters production-order headers that were converted from it.', 'It was not applied to this list.');
  }
  const bounded = Boolean(plant || materialNumber || orders.length || plannedOrders.length || componentMaterial || mrpController || (dateFrom && dateTo));
  if (!bounded) {
    fail('Name a plant, a material, an order, a component, an MRP controller, or a from and to date.', 'An unbounded list was not loaded.');
  }
  const catalog = orderInformationFields(object, listType);
  const requestedFields = (input.fields ?? []).map((field) => clean(field)).filter(Boolean);
  for (const field of requestedFields) {
    if (!catalog.some((column) => column.id === field)) {
      fail(`Field ${field} is not a column of this list.`, 'Cost and price are not columns. An unknown field was not added.');
    }
  }
  const sortField = clean(input.sortField) || catalog[0]?.id || '';
  if (sortField && !catalog.some((column) => column.id === sortField)) {
    fail(`Sort field ${sortField} is not a column of this list.`);
  }
  const sortDirection = clean(input.sortDirection).toUpperCase() || 'ASC';
  if (sortDirection !== 'ASC' && sortDirection !== 'DESC') fail('Sort direction is ascending or descending.');
  const limit = input.limit ?? ORDER_INFORMATION_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ORDER_INFORMATION_MAX_LIMIT) {
    fail(`The result limit must be from 1 to ${ORDER_INFORMATION_MAX_LIMIT}. It was not reduced.`, 'Name a smaller limit.');
  }
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) fail('The list offset is not valid.');
  return {
    object,
    listType,
    plant,
    orders,
    plannedOrders,
    materialNumber,
    description,
    mrpController,
    statuses,
    componentMaterial,
    storageLocation,
    batch,
    movementType,
    confirmationType,
    dateBasis,
    dateFrom: dateFrom ? dateOf(dateFrom, 'The from date') : '',
    dateTo: dateTo ? dateOf(dateTo, 'The to date') : '',
    fields: requestedFields.length > 0 ? requestedFields : catalog.map((column) => column.id),
    sortField,
    sortDirection,
    limit,
    offset,
    reduced: input.reduced === true,
    layoutId: clean(input.layoutId),
  };
}

function dateBases(object: OrderObject, listType: string): string[] {
  if (object === 'PLANNED_ORDER' && listType === 'COMPONENTS') return ['REQUIREMENT'];
  if (object === 'PLANNED_ORDER') return ['START', 'FINISH'];
  if (listType === 'CONFIRMATIONS' || listType === 'GOODS_MOVEMENTS') return ['POSTING'];
  if (listType === 'COMPONENTS') return [];
  return ['SCHEDULED_START', 'SCHEDULED_FINISH', 'CREATED'];
}

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return await tx.execute(query) as unknown as Array<Record<string, unknown>>;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function inList(column: ReturnType<typeof sql>, values: string[]): ReturnType<typeof sql> {
  if (values.length === 0) return sql`true`;
  return sql`${column} in (${sql.join(values.map((value) => sql`${value}`), sql`, `)})`;
}

function project(row: OrderInformationRow, fields: string[]): OrderInformationRow {
  const projected: OrderInformationRow = {};
  for (const field of fields) projected[field] = row[field] ?? null;
  return projected;
}

function pageOf(found: OrderInformationRow[], total: number, query: ParsedQuery, notes: string[]): OrderInformationResult {
  return {
    object: query.object,
    listType: query.listType,
    columns: orderInformationFields(query.object, query.listType).filter((column) => query.fields.includes(column.id)),
    rows: found.map((row) => project(row, query.fields)),
    total,
    returned: found.length,
    limit: query.limit,
    offset: query.offset,
    truncated: total > query.offset + found.length,
    overview: null,
    notes,
    written: false,
  };
}

function directionSql(direction: 'ASC' | 'DESC'): ReturnType<typeof sql> {
  return direction === 'DESC' ? sql`desc` : sql`asc`;
}

async function productionHeaders(tx: Tx, client: string, query: ParsedQuery): Promise<{ rows: OrderInformationRow[]; total: number }> {
  const description = query.description ? `%${query.description}%` : '';
  const anyStatus = query.statuses.length === 0 ? 'Y' : '';
  const found = await rows(tx, sql`
    select o.order_number, o.material_number, coalesce(m.description, '') as material_description, o.plant,
           (count(*) over ())::int as total_count,
           o.order_quantity::text as order_quantity, o.unit_of_measure, o.scheduled_start, o.scheduled_finish,
           o.status, o.batch_number, mp.mrp_controller, o.planned_order_number,
           coalesce(confirmed.yield, 0)::text as header_yield,
           coalesce(confirmed.records, 0)::text as confirmation_count,
           coalesce(delivered.received, 0)::text as delivered
      from production_order o
      join material m on m.client = o.client and m.material_number = o.material_number
      left join material_plant mp
        on mp.client = o.client and mp.material_number = o.material_number and mp.plant = o.plant
      left join lateral (
        select coalesce(sum(yield_quantity) filter (where confirmation_level = 'HEADER'), 0) as yield,
               count(*) as records
          from production_confirmation c
         where c.client = o.client and c.order_number = o.order_number
      ) confirmed on true
      left join lateral (
        select coalesce(sum(case when mt.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end), 0) as received
          from material_document_line l
          join material_document d
            on d.client = l.client and d.material_document_number = l.material_document_number and d.status = 'POSTED'
          join movement_type mt on mt.client = l.client and mt.movement_type = l.movement_type
         where l.client = o.client and l.production_order_number = o.order_number
           and l.material_number = o.material_number
      ) delivered on true
     where o.client = ${client}
       and (${query.plant} = '' or o.plant = ${query.plant})
       and (${query.materialNumber} = '' or o.material_number = ${query.materialNumber})
       and (${description} = '' or m.description ilike ${description})
       and (${query.mrpController} = '' or mp.mrp_controller = ${query.mrpController})
       and (${query.batch} = '' or o.batch_number = ${query.batch})
       and (${anyStatus} = 'Y' or o.status in (${sql.join(query.statuses.length ? query.statuses.map((status) => sql`${status}`) : [sql`''`], sql`, `)}))
       and ${inList(sql`o.order_number`, query.orders)}
       and ${inList(sql`o.planned_order_number`, query.plannedOrders)}
       and (${query.componentMaterial} = '' or exists (
         select 1 from production_order_component c
          where c.client = o.client and c.order_number = o.order_number and c.material_number = ${query.componentMaterial}
       ))
       and (${query.dateBasis} <> 'SCHEDULED_START' or (
         (${query.dateFrom} = '' or o.scheduled_start >= ${query.dateFrom})
         and (${query.dateTo} = '' or o.scheduled_start <= ${query.dateTo})
       ))
       and (${query.dateBasis} <> 'SCHEDULED_FINISH' or (
         (${query.dateFrom} = '' or o.scheduled_finish >= ${query.dateFrom})
         and (${query.dateTo} = '' or o.scheduled_finish <= ${query.dateTo})
       ))
       and (${query.dateBasis} <> 'CREATED' or (
         (${query.dateFrom} = '' or o.created_at::date >= nullif(${query.dateFrom}, '')::date)
         and (${query.dateTo} = '' or o.created_at::date <= nullif(${query.dateTo}, '')::date)
       ))
     order by ${headerSort(query.sortField)} ${directionSql(query.sortDirection)}, o.order_number
     limit ${query.limit} offset ${query.offset}
  `);
  const mapped = found.map((row) => ({
    orderNumber: String(row.order_number),
    materialNumber: String(row.material_number),
    materialDescription: String(row.material_description ?? ''),
    plant: String(row.plant),
    orderQuantity: String(row.order_quantity),
    unit: String(row.unit_of_measure),
    scheduledStart: String(row.scheduled_start),
    scheduledFinish: String(row.scheduled_finish),
    status: String(row.status),
    batch: String(row.batch_number ?? ''),
    mrpController: text(row.mrp_controller),
    headerConfirmedYield: String(row.header_yield),
    deliveredQuantity: String(row.delivered),
    confirmationCount: String(row.confirmation_count),
    plannedOrderNumber: text(row.planned_order_number),
  }));
  return { rows: mapped, total: found[0] ? Number(found[0].total_count) : 0 };
}

function headerSort(field: string): ReturnType<typeof sql> {
  if (field === 'materialNumber') return sql`o.material_number`;
  if (field === 'scheduledFinish') return sql`o.scheduled_finish`;
  if (field === 'scheduledStart') return sql`o.scheduled_start`;
  if (field === 'status') return sql`o.status`;
  if (field === 'plant') return sql`o.plant`;
  return sql`o.order_number`;
}

async function productionComponents(tx: Tx, client: string, query: ParsedQuery): Promise<{ rows: OrderInformationRow[]; total: number }> {
  const anyStatus = query.statuses.length === 0 ? 'Y' : '';
  const found = await rows(tx, sql`
    select c.order_number, c.item_number, c.material_number, coalesce(m.description, '') as description,
           (count(*) over ())::int as total_count,
           c.plant, c.storage_location, c.required_quantity::text as required_quantity, c.unit_of_measure,
           o.status, coalesce(issued.issued, 0)::text as issued
      from production_order_component c
      join production_order o on o.client = c.client and o.order_number = c.order_number
      left join material m on m.client = c.client and m.material_number = c.material_number
      left join lateral (
        select sum(case when mt.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end) as issued
          from material_document_line l
          join material_document d
            on d.client = l.client and d.material_document_number = l.material_document_number and d.status = 'POSTED'
          join movement_type mt on mt.client = l.client and mt.movement_type = l.movement_type
         where l.client = c.client and l.production_order_number = c.order_number
           and l.production_order_item = c.item_number
      ) issued on true
     where c.client = ${client}
       and (${query.plant} = '' or c.plant = ${query.plant})
       and (${query.materialNumber} = '' or o.material_number = ${query.materialNumber})
       and (${query.componentMaterial} = '' or c.material_number = ${query.componentMaterial})
       and (${query.storageLocation} = '' or c.storage_location = ${query.storageLocation})
       and (${anyStatus} = 'Y' or o.status in (${sql.join(query.statuses.length ? query.statuses.map((status) => sql`${status}`) : [sql`''`], sql`, `)}))
       and ${inList(sql`c.order_number`, query.orders)}
     order by c.order_number, c.item_number
     limit ${query.limit} offset ${query.offset}
  `);
  const mapped = found.map((row) => {
    const required = Number(row.required_quantity);
    const issued = Number(row.issued);
    return {
      orderNumber: String(row.order_number),
      itemNumber: String(row.item_number),
      materialNumber: String(row.material_number),
      materialDescription: String(row.description ?? ''),
      plant: String(row.plant),
      storageLocation: text(row.storage_location),
      requiredQuantity: String(row.required_quantity),
      issuedQuantity: issued.toFixed(3),
      remainingQuantity: Math.max(0, required - issued).toFixed(3),
      unit: String(row.unit_of_measure),
      orderStatus: String(row.status),
    };
  });
  return { rows: mapped, total: found[0] ? Number(found[0].total_count) : 0 };
}

async function confirmations(tx: Tx, client: string, query: ParsedQuery): Promise<{ rows: OrderInformationRow[]; total: number }> {
  const found = await rows(tx, sql`
    select c.confirmation_number, c.confirmation_level, c.order_number, c.operation_number, c.confirmation_type,
           (count(*) over ())::int as total_count,
           c.yield_quantity::text as yield, c.scrap_quantity::text as scrap, c.rework_quantity::text as rework,
           c.unit, c.posting_date::text as posting_date, c.production_version,
           effects.operations as affected
      from production_confirmation c
      join production_order o on o.client = c.client and o.order_number = c.order_number
      left join lateral (
        select string_agg(operation_number, ', ' order by operation_number) as operations
          from production_confirmation_operation e
         where e.client = c.client and e.confirmation_number = c.confirmation_number
      ) effects on true
     where c.client = ${client}
       and (${query.plant} = '' or o.plant = ${query.plant})
       and (${query.materialNumber} = '' or o.material_number = ${query.materialNumber})
       and (${query.confirmationType} = '' or c.confirmation_type = ${query.confirmationType})
       and (${query.dateFrom} = '' or c.posting_date >= nullif(${query.dateFrom}, '')::date)
       and (${query.dateTo} = '' or c.posting_date <= nullif(${query.dateTo}, '')::date)
       and ${inList(sql`c.order_number`, query.orders)}
     order by c.confirmation_number
     limit ${query.limit} offset ${query.offset}
  `);
  const mapped = found.map((row) => ({
    confirmationNumber: String(row.confirmation_number),
    confirmationLevel: String(row.confirmation_level),
    orderNumber: String(row.order_number),
    operationNumber: text(row.operation_number),
    affectedOperations: text(row.affected),
    confirmationType: String(row.confirmation_type),
    yieldQuantity: String(row.yield),
    scrapQuantity: String(row.scrap),
    reworkQuantity: String(row.rework),
    unit: String(row.unit),
    postingDate: String(row.posting_date),
    productionVersion: String(row.production_version),
  }));
  return { rows: mapped, total: found[0] ? Number(found[0].total_count) : 0 };
}

async function movements(tx: Tx, client: string, query: ParsedQuery): Promise<{ rows: OrderInformationRow[]; total: number }> {
  if (query.movementType) {
    const known = await rows(tx, sql`
      select 1 from movement_type where client = ${client} and movement_type = ${query.movementType}
    `);
    if (!known[0]) fail(`Movement type ${query.movementType} does not stand.`, 'Enter a movement type that is configured. An empty list was not returned for an unknown type.');
  }
  const found = await rows(tx, sql`
    select l.material_document_number, l.line_number, l.production_order_number, l.production_order_item,
           (count(*) over ())::int as total_count,
           l.movement_type, l.material_number, l.base_quantity::text as quantity, l.base_unit, l.plant,
           l.storage_location, l.batch_number, d.posting_date, d.status, l.reversal_of_document
      from material_document_line l
      join material_document d on d.client = l.client and d.material_document_number = l.material_document_number
      join production_order o on o.client = l.client and o.order_number = l.production_order_number
     where l.client = ${client}
       and l.production_order_number is not null
       and (${query.plant} = '' or l.plant = ${query.plant})
       and (${query.materialNumber} = '' or l.material_number = ${query.materialNumber})
       and (${query.movementType} = '' or l.movement_type = ${query.movementType})
       and (${query.storageLocation} = '' or l.storage_location = ${query.storageLocation})
       and (${query.batch} = '' or l.batch_number = ${query.batch})
       and (${query.dateFrom} = '' or d.posting_date::date >= nullif(${query.dateFrom}, '')::date)
       and (${query.dateTo} = '' or d.posting_date::date <= nullif(${query.dateTo}, '')::date)
       and ${inList(sql`l.production_order_number`, query.orders)}
     order by d.posting_date, l.material_document_number, l.line_number
     limit ${query.limit} offset ${query.offset}
  `);
  const mapped = found.map((row) => ({
    materialDocumentNumber: String(row.material_document_number),
    lineNumber: String(row.line_number),
    orderNumber: String(row.production_order_number),
    productionOrderItem: text(row.production_order_item),
    movementType: String(row.movement_type),
    materialNumber: String(row.material_number),
    quantity: String(row.quantity),
    unit: String(row.base_unit),
    plant: String(row.plant),
    storageLocation: text(row.storage_location),
    batch: String(row.batch_number ?? ''),
    postingDate: String(row.posting_date),
    documentStatus: String(row.status),
    reversalOf: text(row.reversal_of_document),
  }));
  return { rows: mapped, total: found[0] ? Number(found[0].total_count) : 0 };
}

async function plannedHeaders(tx: Tx, client: string, query: ParsedQuery): Promise<{ rows: OrderInformationRow[]; total: number }> {
  const description = query.description ? `%${query.description}%` : '';
  const anyStatus = query.statuses.length === 0 ? 'Y' : '';
  const found = await rows(tx, sql`
    select o.order_number, o.material_number, coalesce(m.description, '') as description, o.plant,
           (count(*) over ())::int as total_count,
           o.quantity::text as quantity, o.unit, o.start_date::text as start_date, o.finish_date::text as finish_date,
           o.firming_status, o.origin, mp.mrp_controller, conv.order_number as production_order_number
      from planned_order o
      join material m on m.client = o.client and m.material_number = o.material_number
      left join material_plant mp
        on mp.client = o.client and mp.material_number = o.material_number and mp.plant = o.plant
      left join production_order conv on conv.client = o.client and conv.planned_order_number = o.order_number
     where o.client = ${client}
       and (${query.plant} = '' or o.plant = ${query.plant})
       and (${query.materialNumber} = '' or o.material_number = ${query.materialNumber})
       and (${description} = '' or m.description ilike ${description})
       and (${query.mrpController} = '' or mp.mrp_controller = ${query.mrpController})
       and (${anyStatus} = 'Y' or o.firming_status in (${sql.join(query.statuses.length ? query.statuses.map((status) => sql`${status}`) : [sql`''`], sql`, `)}))
       and ${inList(sql`o.order_number`, query.plannedOrders)}
       and (${query.dateBasis} <> 'START' or (
         (${query.dateFrom} = '' or o.start_date >= nullif(${query.dateFrom}, '')::date)
         and (${query.dateTo} = '' or o.start_date <= nullif(${query.dateTo}, '')::date)
       ))
       and (${query.dateBasis} <> 'FINISH' or (
         (${query.dateFrom} = '' or o.finish_date >= nullif(${query.dateFrom}, '')::date)
         and (${query.dateTo} = '' or o.finish_date <= nullif(${query.dateTo}, '')::date)
       ))
     order by o.order_number
     limit ${query.limit} offset ${query.offset}
  `);
  const mapped = found.map((row) => ({
    orderNumber: String(row.order_number),
    materialNumber: String(row.material_number),
    materialDescription: String(row.description ?? ''),
    plant: String(row.plant),
    quantity: String(row.quantity),
    unit: String(row.unit),
    startDate: String(row.start_date),
    finishDate: String(row.finish_date),
    firmingStatus: String(row.firming_status),
    origin: String(row.origin),
    mrpController: text(row.mrp_controller),
    productionOrderNumber: text(row.production_order_number),
  }));
  return { rows: mapped, total: found[0] ? Number(found[0].total_count) : 0 };
}

async function dependents(tx: Tx, client: string, query: ParsedQuery): Promise<{ rows: OrderInformationRow[]; total: number }> {
  const found = await rows(tx, sql`
    select d.parent_order_number, d.item_number, d.material_number, coalesce(m.description, '') as description,
           (count(*) over ())::int as total_count,
           d.plant, d.quantity::text as quantity, d.unit, d.requirement_date::text as requirement_date, d.status
      from mrp_dependent_requirement d
      join planned_order o on o.client = d.client and o.order_number = d.parent_order_number
      left join material m on m.client = d.client and m.material_number = d.material_number
     where d.client = ${client}
       and (${query.plant} = '' or d.plant = ${query.plant})
       and (${query.materialNumber} = '' or o.material_number = ${query.materialNumber})
       and (${query.componentMaterial} = '' or d.material_number = ${query.componentMaterial})
       and (${query.dateFrom} = '' or d.requirement_date >= nullif(${query.dateFrom}, '')::date)
       and (${query.dateTo} = '' or d.requirement_date <= nullif(${query.dateTo}, '')::date)
       and ${inList(sql`d.parent_order_number`, query.plannedOrders)}
     order by d.parent_order_number, d.item_number
     limit ${query.limit} offset ${query.offset}
  `);
  const mapped = found.map((row) => ({
    plannedOrderNumber: String(row.parent_order_number),
    itemNumber: String(row.item_number),
    materialNumber: String(row.material_number),
    materialDescription: String(row.description ?? ''),
    plant: String(row.plant),
    quantity: String(row.quantity),
    unit: String(row.unit),
    requirementDate: String(row.requirement_date),
    status: String(row.status),
  }));
  return { rows: mapped, total: found[0] ? Number(found[0].total_count) : 0 };
}

function notesFor(query: ParsedQuery): string[] {
  const notes = [...NOTES];
  if (query.componentMaterial && (query.listType === 'HEADERS' || query.listType === 'OVERVIEW') && query.object === 'PRODUCTION_ORDER') {
    notes.push('The component filter selected orders. The header row is still one row per order.');
  }
  if (query.object === 'PLANNED_ORDER' && query.listType === 'COMPONENTS') {
    notes.push('These rows are dependent requirements. They are not production-order components and not reservations.');
  }
  if (query.listType === 'GOODS_MOVEMENTS') {
    notes.push('A reversed document is listed with its status. It is not included in the delivered quantity.');
  }
  return notes;
}

export async function runOrderInformation(client: string, input: {
  object?: string | null;
  listType?: string | null;
  plant?: string | null;
  orderNumber?: string | null;
  plannedOrderNumber?: string | null;
  materialNumber?: string | null;
  materialDescription?: string | null;
  mrpController?: string | null;
  status?: string | null;
  componentMaterial?: string | null;
  storageLocation?: string | null;
  batch?: string | null;
  movementType?: string | null;
  confirmationType?: string | null;
  dateBasis?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  fields?: string[] | null;
  sortField?: string | null;
  sortDirection?: string | null;
  limit?: number | null;
  offset?: number | null;
  reduced?: boolean | null;
  layoutId?: string | null;
  owner?: string | null;
  named?: Record<string, string | null | undefined>;
}): Promise<OrderInformationResult> {
  const query = parseQuery(input);
  return withTenant(client, async (tx) => {
    if (query.layoutId) {
      const layout = await layoutOf(tx, client, clean(input.owner), query.layoutId);
      if (!layout || layout.object !== query.object || layout.listType !== query.listType) {
        fail('That layout does not stand for this list.', 'Choose a layout saved for this object and list. Another user\'s layout is not readable.');
      }
      query.fields = layout.fields;
      query.sortField = layout.sortField;
      query.sortDirection = layout.sortDirection;
    }
    const notes = notesFor(query);
    if (query.listType === 'OVERVIEW') {
      const single = query.object === 'PLANNED_ORDER' ? query.plannedOrders : query.orders;
      if (single.length !== 1) {
        const headers = query.object === 'PLANNED_ORDER'
          ? await plannedHeaders(tx, client, query)
          : await productionHeaders(tx, client, query);
        notes.push('Open one order to load its children. Children of every order were not loaded.');
        return pageOf(headers.rows, headers.total, query, notes);
      }
      const headers = query.object === 'PLANNED_ORDER'
        ? await plannedHeaders(tx, client, query)
        : await productionHeaders(tx, client, query);
      if (!headers.rows[0]) {
        return pageOf([], 0, query, notes);
      }
      const children = { ...query, limit: ORDER_INFORMATION_MAX_LIMIT, offset: 0 };
      const overview: OrderOverview = {
        orderNumber: String(headers.rows[0].orderNumber),
        header: project(headers.rows[0], query.fields),
        components: [],
        confirmations: [],
        movements: [],
        dependents: [],
        reduced: query.reduced,
      };
      if (!query.reduced && query.object === 'PRODUCTION_ORDER') {
        overview.components = (await productionComponents(tx, client, children)).rows.map((row) => project(row, COMPONENT_FIELDS.map((field) => field.id)));
        overview.confirmations = (await confirmations(tx, client, children)).rows.map((row) => project(row, CONFIRMATION_FIELDS.map((field) => field.id)));
        overview.movements = (await movements(tx, client, children)).rows.map((row) => project(row, MOVEMENT_FIELDS.map((field) => field.id)));
      }
      if (!query.reduced && query.object === 'PLANNED_ORDER') {
        overview.dependents = (await dependents(tx, client, children)).rows.map((row) => project(row, DEPENDENT_FIELDS.map((field) => field.id)));
      }
      if (query.reduced) notes.push('Reduced reading loaded the header only. Children were not loaded.');
      return {
        ...pageOf([headers.rows[0]], 1, query, notes),
        rows: [],
        returned: 0,
        overview,
      };
    }
    const found = query.object === 'PLANNED_ORDER'
      ? query.listType === 'COMPONENTS'
        ? await dependents(tx, client, query)
        : await plannedHeaders(tx, client, query)
      : query.listType === 'COMPONENTS'
        ? await productionComponents(tx, client, query)
        : query.listType === 'CONFIRMATIONS'
          ? await confirmations(tx, client, query)
          : query.listType === 'GOODS_MOVEMENTS'
            ? await movements(tx, client, query)
            : await productionHeaders(tx, client, query);
    return pageOf(found.rows, found.total, query, notes);
  });
}

async function layoutOf(tx: Tx, client: string, owner: string, layoutId: string): Promise<OrderInformationLayout | null> {
  if (!owner || !layoutId) return null;
  const found = await rows(tx, sql`
    select layout_id, name, description, object_category, list_type, field_ids, sort_field, sort_direction, is_default
      from report_layout
     where client = ${client} and owner = ${owner} and layout_id = ${layoutId}
  `);
  const row = found[0];
  if (!row) return null;
  return {
    layoutId: String(row.layout_id),
    name: String(row.name),
    description: String(row.description ?? ''),
    object: String(row.object_category) as OrderObject,
    listType: String(row.list_type),
    fields: String(row.field_ids).split(',').filter(Boolean),
    sortField: String(row.sort_field),
    sortDirection: String(row.sort_direction) === 'DESC' ? 'DESC' : 'ASC',
    isDefault: row.is_default === true || row.is_default === 't',
  };
}

export async function listOrderInformationLayouts(client: string, owner: string, object: string, listType: string): Promise<OrderInformationLayout[]> {
  const user = clean(owner);
  if (!user) return [];
  return withTenant(client, async (tx) => {
    const found = await rows(tx, sql`
      select layout_id, name, description, object_category, list_type, field_ids, sort_field, sort_direction, is_default
        from report_layout
       where client = ${client} and owner = ${user}
         and object_category = ${clean(object).toUpperCase()}
         and list_type = ${clean(listType).toUpperCase()}
       order by name
    `);
    return found.map((row) => ({
      layoutId: String(row.layout_id),
      name: String(row.name),
      description: String(row.description ?? ''),
      object: String(row.object_category) as OrderObject,
      listType: String(row.list_type),
      fields: String(row.field_ids).split(',').filter(Boolean),
      sortField: String(row.sort_field),
      sortDirection: String(row.sort_direction) === 'DESC' ? 'DESC' : 'ASC',
      isDefault: row.is_default === true || row.is_default === 't',
    }));
  });
}

export async function saveOrderInformationLayout(client: string, input: {
  owner: string;
  object: string;
  listType: string;
  name: string;
  description?: string | null;
  fields: string[];
  sortField: string;
  sortDirection?: string | null;
  isDefault?: boolean;
  named?: Record<string, string | null | undefined>;
}): Promise<OrderInformationLayout> {
  const refused = orderInformationRefusal(input.named);
  if (refused) fail(refused, 'The layout was not saved.');
  const owner = clean(input.owner);
  if (!owner || owner.length > 60) fail('The layout owner is required.');
  const object = clean(input.object).toUpperCase();
  const listType = clean(input.listType).toUpperCase();
  if (object !== 'PRODUCTION_ORDER' && object !== 'PLANNED_ORDER') fail('A layout names production orders or planned orders.');
  const catalog = orderInformationFields(object, listType);
  if (catalog.length === 0) fail('That list has no field catalog.', 'A layout was not saved for an unavailable list.');
  const fields = input.fields.map((field) => clean(field)).filter(Boolean);
  if (fields.length === 0) fail('A layout needs at least one field.');
  for (const field of fields) {
    if (!catalog.some((column) => column.id === field)) {
      fail(`Field ${field} is not a column of this list.`, 'The layout was not saved.');
    }
  }
  const sortField = clean(input.sortField) || fields[0]!;
  if (!fields.includes(sortField)) fail('The sort field must be one of the saved fields.');
  const sortDirection = clean(input.sortDirection).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const name = clean(input.name);
  if (!name || name.length > 40) fail('A layout name is required, and it is at most 40 characters.');
  const description = clean(input.description);
  if (description.length > 80) fail('The layout description is too long.');
  const fieldIds = fields.join(',');
  if (fieldIds.length > 400) fail('The layout has too many fields.');
  const layoutId = randomUUID();
  return withTenant(client, async (tx) => {
    if (input.isDefault) {
      await tx.execute(sql`
        update report_layout set is_default = false
         where client = ${client} and owner = ${owner} and object_category = ${object} and list_type = ${listType}
      `);
    }
    await tx.execute(sql`
      insert into report_layout (
        client, layout_id, owner, object_category, list_type, name, description, field_ids,
        sort_field, sort_direction, is_default, created_by
      ) values (
        ${client}, ${layoutId}, ${owner}, ${object}, ${listType}, ${name}, ${description}, ${fieldIds},
        ${sortField}, ${sortDirection}, ${input.isDefault === true}, ${owner}
      )
    `);
    const saved = await layoutOf(tx, client, owner, layoutId);
    if (!saved) fail('The layout was not saved.');
    return saved;
  });
}
