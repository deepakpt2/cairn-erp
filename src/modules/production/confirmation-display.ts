/**
 * CO14 — display one production-order confirmation.
 *
 * The authoritative record is production_confirmation. CO15's per-operation rows are
 * effects, not separate confirmation numbers; CO13 writes a linked cancellation row and
 * never rewrites the original. This service is read-only and relies on tenant RLS through
 * withTenant. No personnel/operator field exists in this model: created_by identifies the
 * recorder, not the person who performed the work.
 */
import { sql, type SQL } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { movementRequestKey } from './confirmation-movements';

export const CONFIRMATION_DISPLAY_ROUTE = '/production/confirmation-display';
export const CONFIRMATION_DISPLAY_PAGE_SIZE = 25;
export const CONFIRMATION_DISPLAY_MAX_PAGE = 100_000;

export type ConfirmationDisplaySort =
  | 'confirmation'
  | 'order'
  | 'operation'
  | 'plant'
  | 'recorded'
  | 'posting'
  | 'yield';
export type ConfirmationDisplayDirection = 'asc' | 'desc';

export interface ConfirmationDisplaySelection {
  confirmationNumber: string;
  productionOrder: string;
  operation: string;
  plant: string;
  recordedFrom: string;
  recordedTo: string;
  postingFrom: string;
  postingTo: string;
  page: number;
  sort: ConfirmationDisplaySort;
  direction: ConfirmationDisplayDirection;
}

export interface ConfirmationDisplayListRow {
  confirmationNumber: string;
  counter: string;
  confirmationLevel: 'OPERATION' | 'HEADER';
  confirmationType: 'PARTIAL' | 'FINAL';
  productionOrder: string;
  operationNumber: string | null;
  operationCount: number;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  workCenter: string | null;
  workCenterDescription: string | null;
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  unit: string;
  recordedAt: string;
  postingDate: string;
  cancelled: boolean;
  cancellationNumber: string | null;
}

export interface ConfirmationDisplayPage {
  rows: ConfirmationDisplayListRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  sort: ConfirmationDisplaySort;
  direction: ConfirmationDisplayDirection;
  selection: ConfirmationDisplaySelection;
}

export interface ConfirmationDisplayEffect {
  operationNumber: string;
  confirmationType: 'PARTIAL' | 'FINAL';
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  unit: string;
  workCenter: string | null;
  workCenterDescription: string | null;
  controlKey: string | null;
  shortText: string | null;
  quantityBasis: string;
}

export interface ConfirmationDisplayActivity {
  parameter: string;
  description: string;
  quantity: string;
  unit: string;
  suggestedQuantity: string | null;
}

export interface ConfirmationDisplayMaterialDocument {
  materialDocumentNumber: string;
  documentYear: number;
  lineNumber: number;
  documentDate: string;
  postingDate: string;
  status: string;
  reversalOf: string | null;
  reversedBy: string | null;
  reversalYear: number | null;
  movementType: string;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  entryQuantity: string;
  entryUnit: string;
  baseQuantity: string;
  baseUnit: string;
  productionOrderItem: number | null;
  reversalOfDocument: string | null;
  reversalOfLine: number | null;
}

export interface ConfirmationDisplayDetail {
  confirmationNumber: string;
  counter: string;
  confirmationLevel: 'OPERATION' | 'HEADER';
  confirmationType: 'PARTIAL' | 'FINAL';
  productionOrder: string;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  plantName: string;
  companyCode: string;
  operationNumber: string | null;
  sequence: string;
  workCenter: string | null;
  workCenterDescription: string | null;
  controlKey: string | null;
  operationText: string | null;
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  unit: string;
  postingDate: string;
  recordedAt: string;
  executionStart: string | null;
  executionFinish: string | null;
  note: string | null;
  recordedBy: string;
  cancelled: boolean;
  cancellationNumber: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  effects: ConfirmationDisplayEffect[];
  activities: ConfirmationDisplayActivity[];
  materialDocuments: ConfirmationDisplayMaterialDocument[];
}

export class ConfirmationDisplayError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'ConfirmationDisplayError';
  }
}

const SORT_COLUMNS: Record<ConfirmationDisplaySort, string> = {
  confirmation: 'c.confirmation_number',
  order: 'c.order_number',
  operation: 'c.operation_number',
  plant: 'o.plant',
  recorded: 'c.created_at',
  posting: 'c.posting_date',
  yield: 'c.yield_quantity',
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(message: string, remedy?: string): never {
  throw new ConfirmationDisplayError(message, remedy);
}

function dateOf(value: string, label: string): string {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} must be a valid calendar date.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    fail(`${label} must be a valid calendar date.`);
  }
  return value;
}

/** Normalize and validate the supported selection fields before a tenant query runs. */
export function validateConfirmationDisplaySelection(
  input: Partial<ConfirmationDisplaySelection>,
): ConfirmationDisplaySelection {
  const confirmationNumber = clean(input.confirmationNumber).toUpperCase();
  const productionOrder = clean(input.productionOrder).toUpperCase();
  const operation = clean(input.operation).toUpperCase();
  const plant = clean(input.plant).toUpperCase();
  const recordedFrom = dateOf(clean(input.recordedFrom), 'Recorded-from date');
  const recordedTo = dateOf(clean(input.recordedTo), 'Recorded-to date');
  const postingFrom = dateOf(clean(input.postingFrom), 'Posting-from date');
  const postingTo = dateOf(clean(input.postingTo), 'Posting-to date');

  if (confirmationNumber && !/^[A-Z0-9-]{1,12}$/.test(confirmationNumber)) {
    fail('Confirmation number may contain only letters, digits, and hyphens (up to 12 characters).');
  }
  if (productionOrder && !/^[A-Z0-9-]{1,12}$/.test(productionOrder)) {
    fail('Production order may contain only letters, digits, and hyphens (up to 12 characters).');
  }
  if (operation && !/^[A-Z0-9]{4}$/.test(operation)) {
    fail('Operation must be a four-character operation number.');
  }
  if (plant && !/^[A-Z0-9-]{1,10}$/.test(plant)) {
    fail('Plant may contain only letters, digits, and hyphens (up to 10 characters).');
  }
  if (recordedFrom && recordedTo && recordedFrom > recordedTo) fail('Recorded-from date must be on or before recorded-to date.');
  if (postingFrom && postingTo && postingFrom > postingTo) fail('Posting-from date must be on or before posting-to date.');

  const hasSelection = Boolean(
    confirmationNumber || productionOrder || operation || plant
      || recordedFrom || recordedTo || postingFrom || postingTo,
  );
  if (!hasSelection) {
    fail('Enter at least one selection criterion before searching.', 'Use a confirmation number, order, operation, plant, recorded date, or posting date.');
  }

  const page = Number.isInteger(input.page) && Number(input.page) >= 1
    ? Math.min(Number(input.page), CONFIRMATION_DISPLAY_MAX_PAGE)
    : 1;
  const sort = input.sort && Object.hasOwn(SORT_COLUMNS, input.sort) ? input.sort : 'confirmation';
  const direction = input.direction === 'asc' ? 'asc' : 'desc';
  return {
    confirmationNumber, productionOrder, operation, plant,
    recordedFrom, recordedTo, postingFrom, postingTo,
    page, sort, direction,
  };
}

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return await tx.execute(query) as unknown as Array<Record<string, unknown>>;
}

function listWhere(client: string, selection: ConfirmationDisplaySelection): SQL {
  const filters: SQL[] = [sql`c.client = ${client}`];
  if (selection.confirmationNumber) filters.push(sql`c.confirmation_number like ${`${selection.confirmationNumber}%`}`);
  if (selection.productionOrder) filters.push(sql`c.order_number like ${`${selection.productionOrder}%`}`);
  if (selection.operation) {
    filters.push(sql`(
      c.operation_number = ${selection.operation}
      or exists (
        select 1 from production_confirmation_operation e
         where e.client = c.client and e.confirmation_number = c.confirmation_number
           and e.operation_number = ${selection.operation}
      )
    )`);
  }
  if (selection.plant) filters.push(sql`o.plant = ${selection.plant}`);
  if (selection.recordedFrom) filters.push(sql`c.created_at >= ${selection.recordedFrom}::date`);
  if (selection.recordedTo) filters.push(sql`c.created_at < (${selection.recordedTo}::date + interval '1 day')`);
  if (selection.postingFrom) filters.push(sql`c.posting_date >= ${selection.postingFrom}::date`);
  if (selection.postingTo) filters.push(sql`c.posting_date <= ${selection.postingTo}::date`);
  return sql`where ${sql.join(filters, sql` and `)}`;
}

export async function searchProductionConfirmations(
  client: string,
  input: Partial<ConfirmationDisplaySelection>,
): Promise<ConfirmationDisplayPage> {
  const selection = validateConfirmationDisplaySelection(input);
  return withTenant(client, async (tx) => {
    const where = listWhere(client, selection);
    const [count] = await rows(tx, sql`
      select count(*)::int as total
        from production_confirmation c
        join production_order o on o.client = c.client and o.order_number = c.order_number
       ${where}
    `);
    const sortColumn = SORT_COLUMNS[selection.sort];
    const direction = selection.direction === 'asc' ? 'ASC' : 'DESC';
    const found = await rows(tx, sql`
      select c.confirmation_number, c.sequence, c.confirmation_level, c.confirmation_type,
             c.order_number, c.operation_number, c.work_center, c.work_center_plant,
             c.yield_quantity::text as yield_quantity, c.scrap_quantity::text as scrap_quantity,
             c.rework_quantity::text as rework_quantity, c.unit, c.created_at::text as recorded_at,
             c.posting_date::text as posting_date,
             o.material_number, coalesce(m.description, '') as material_description,
             o.plant as plant,
             wc.description as work_center_description,
             (select count(*)::int from production_confirmation_operation e
               where e.client = c.client and e.confirmation_number = c.confirmation_number) as operation_count,
             x.cancellation_number
        from production_confirmation c
        join production_order o on o.client = c.client and o.order_number = c.order_number
        join material m on m.client = o.client and m.material_number = o.material_number
        left join work_center wc
          on wc.client = c.client
         and wc.plant = coalesce(c.work_center_plant, o.plant)
         and wc.work_center = c.work_center
        left join production_confirmation_cancellation x
          on x.client = c.client and x.confirmation_number = c.confirmation_number
       ${where}
       order by ${sql.raw(sortColumn)} ${sql.raw(direction)} nulls last, c.confirmation_number desc
       limit ${CONFIRMATION_DISPLAY_PAGE_SIZE}
      offset ${(selection.page - 1) * CONFIRMATION_DISPLAY_PAGE_SIZE}
    `);
    const total = Number(count?.total ?? 0);
    return {
      rows: found.map((row) => ({
        confirmationNumber: String(row.confirmation_number),
        counter: String(row.sequence).trim(),
        confirmationLevel: String(row.confirmation_level) === 'HEADER' ? 'HEADER' : 'OPERATION',
        confirmationType: String(row.confirmation_type) === 'FINAL' ? 'FINAL' : 'PARTIAL',
        productionOrder: String(row.order_number),
        operationNumber: row.operation_number == null ? null : String(row.operation_number),
        operationCount: Number(row.operation_count ?? 0),
        materialNumber: String(row.material_number),
        materialDescription: String(row.material_description),
        plant: String(row.plant),
        workCenter: row.work_center == null ? null : String(row.work_center),
        workCenterDescription: row.work_center_description == null ? null : String(row.work_center_description),
        yieldQuantity: String(row.yield_quantity),
        scrapQuantity: String(row.scrap_quantity),
        reworkQuantity: String(row.rework_quantity),
        unit: String(row.unit),
        recordedAt: String(row.recorded_at),
        postingDate: String(row.posting_date),
        cancelled: row.cancellation_number != null,
        cancellationNumber: row.cancellation_number == null ? null : String(row.cancellation_number),
      })),
      total,
      page: selection.page,
      pageSize: CONFIRMATION_DISPLAY_PAGE_SIZE,
      pages: Math.max(1, Math.ceil(total / CONFIRMATION_DISPLAY_PAGE_SIZE)),
      sort: selection.sort,
      direction: selection.direction,
      selection,
    };
  });
}

export async function getProductionConfirmationDisplay(
  client: string,
  confirmationNumber: string,
): Promise<ConfirmationDisplayDetail | null> {
  const number = clean(confirmationNumber).toUpperCase();
  if (!number || !/^[A-Z0-9-]{1,12}$/.test(number)) {
    fail('Enter a valid confirmation number (up to 12 letters, digits, or hyphens).');
  }
  return withTenant(client, async (tx) => {
    const found = await rows(tx, sql`
      select c.confirmation_number, c.sequence, c.confirmation_level, c.confirmation_type,
             c.order_number, c.operation_number, c.work_center, c.work_center_plant,
             c.control_key, c.short_text, c.yield_quantity::text as yield_quantity,
             c.scrap_quantity::text as scrap_quantity, c.rework_quantity::text as rework_quantity,
             c.unit, c.posting_date::text as posting_date, c.created_at::text as recorded_at,
             c.execution_start::text as execution_start, c.execution_finish::text as execution_finish,
             c.note, c.created_by, c.request_key, o.material_number,
             coalesce(m.description, '') as material_description, o.plant,
             coalesce(p.name, '') as plant_name, coalesce(p.company_code, '') as company_code,
             wc.description as work_center_description,
             x.cancellation_number, x.created_at::text as cancelled_at,
             x.created_by as cancelled_by, x.reason as cancellation_reason
        from production_confirmation c
        join production_order o on o.client = c.client and o.order_number = c.order_number
        join material m on m.client = o.client and m.material_number = o.material_number
        join plant p on p.client = o.client and p.plant = o.plant
        left join work_center wc
          on wc.client = c.client
         and wc.plant = coalesce(c.work_center_plant, o.plant)
         and wc.work_center = c.work_center
        left join production_confirmation_cancellation x
          on x.client = c.client and x.confirmation_number = c.confirmation_number
       where c.client = ${client} and c.confirmation_number = ${number}
    `);
    const row = found[0];
    if (!row) return null;
    const confirmationLevel = String(row.confirmation_level) === 'HEADER' ? 'HEADER' : 'OPERATION';
    const confirmationNumberValue = String(row.confirmation_number);

    const activitiesFound = await rows(tx, sql`
      select a.parameter, coalesce(v.description, a.parameter) as description,
             a.quantity::text as quantity, a.unit, a.suggested_quantity::text as suggested_quantity
        from production_confirmation_activity a
        left join production_order_operation_value v
          on v.client = a.client and v.order_number = ${String(row.order_number)}
         and v.operation_number = ${row.operation_number} and v.parameter = a.parameter
       where a.client = ${client} and a.confirmation_number = ${confirmationNumberValue}
       order by a.parameter
    `);

    let effects: ConfirmationDisplayEffect[];
    if (confirmationLevel === 'OPERATION') {
      effects = [{
        operationNumber: String(row.operation_number),
        confirmationType: String(row.confirmation_type) === 'FINAL' ? 'FINAL' : 'PARTIAL',
        yieldQuantity: String(row.yield_quantity),
        scrapQuantity: String(row.scrap_quantity),
        reworkQuantity: String(row.rework_quantity),
        unit: String(row.unit),
        workCenter: row.work_center == null ? null : String(row.work_center),
        workCenterDescription: row.work_center_description == null ? null : String(row.work_center_description),
        controlKey: row.control_key == null ? null : String(row.control_key),
        shortText: row.short_text == null ? null : String(row.short_text),
        quantityBasis: 'OPERATION_CONFIRMATION',
      }];
    } else {
      const effectsFound = await rows(tx, sql`
        select e.operation_number, e.confirmation_type,
               e.yield_quantity::text as yield_quantity, e.scrap_quantity::text as scrap_quantity,
               e.rework_quantity::text as rework_quantity, e.unit, e.work_center, e.control_key,
               e.short_text, e.quantity_basis, wc.description as work_center_description,
               e.created_by, e.created_at::text as recorded_at
          from production_confirmation_operation e
          left join production_order_operation op
            on op.client = e.client and op.order_number = e.order_number and op.operation_number = e.operation_number
          left join work_center wc
            on wc.client = e.client and wc.plant = coalesce(op.work_center_plant, ${String(row.plant)})
           and wc.work_center = e.work_center
         where e.client = ${client} and e.confirmation_number = ${confirmationNumberValue}
         order by op.execution_order nulls last, e.operation_number
      `);
      effects = effectsFound.map((effect) => ({
        operationNumber: String(effect.operation_number),
        confirmationType: String(effect.confirmation_type) === 'FINAL' ? 'FINAL' : 'PARTIAL',
        yieldQuantity: String(effect.yield_quantity),
        scrapQuantity: String(effect.scrap_quantity),
        reworkQuantity: String(effect.rework_quantity),
        unit: String(effect.unit),
        workCenter: effect.work_center == null ? null : String(effect.work_center),
        workCenterDescription: effect.work_center_description == null ? null : String(effect.work_center_description),
        controlKey: effect.control_key == null ? null : String(effect.control_key),
        shortText: effect.short_text == null ? null : String(effect.short_text),
        quantityBasis: String(effect.quantity_basis),
      }));
    }

    const movementKeys = [
      movementRequestKey(String(row.request_key), 'ISSUE'),
      movementRequestKey(String(row.request_key), 'RECEIPT'),
    ].filter((key): key is string => key !== null);
    let materialDocuments: ConfirmationDisplayMaterialDocument[] = [];
    if (movementKeys.length > 0) {
      const movementRows = await rows(tx, sql`
        select d.material_document_number, d.document_year, d.document_date, d.posting_date,
               d.status, d.reversal_of, d.reversed_by, reversal.document_year as reversal_year,
               l.line_number, l.movement_type, l.material_number, l.plant, l.storage_location,
               l.entry_quantity::text as entry_quantity, l.entry_unit,
               l.base_quantity::text as base_quantity, l.base_unit, l.production_order_item,
               l.reversal_of_document, l.reversal_of_line
          from material_document d
          join material_document_line l
            on l.client = d.client and l.material_document_number = d.material_document_number
          left join material_document reversal
            on reversal.client = d.client and reversal.material_document_number = d.reversed_by
         where d.client = ${client}
           and d.request_key in (${sql.join(movementKeys.map((key) => sql`${key}`), sql`, `)})
         order by d.posting_date, d.material_document_number, l.line_number
      `);
      materialDocuments = movementRows.map((movement) => ({
        materialDocumentNumber: String(movement.material_document_number),
        documentYear: Number(movement.document_year),
        lineNumber: Number(movement.line_number),
        documentDate: String(movement.document_date),
        postingDate: String(movement.posting_date),
        status: String(movement.status),
        reversalOf: movement.reversal_of == null ? null : String(movement.reversal_of),
        reversedBy: movement.reversed_by == null ? null : String(movement.reversed_by),
        reversalYear: movement.reversal_year == null ? null : Number(movement.reversal_year),
        movementType: String(movement.movement_type),
        materialNumber: String(movement.material_number),
        plant: String(movement.plant),
        storageLocation: movement.storage_location == null ? null : String(movement.storage_location),
        entryQuantity: String(movement.entry_quantity),
        entryUnit: String(movement.entry_unit),
        baseQuantity: String(movement.base_quantity),
        baseUnit: String(movement.base_unit),
        productionOrderItem: movement.production_order_item == null ? null : Number(movement.production_order_item),
        reversalOfDocument: movement.reversal_of_document == null ? null : String(movement.reversal_of_document),
        reversalOfLine: movement.reversal_of_line == null ? null : Number(movement.reversal_of_line),
      }));
    }

    return {
      confirmationNumber: confirmationNumberValue,
      counter: String(row.sequence).trim(),
      confirmationLevel,
      confirmationType: String(row.confirmation_type) === 'FINAL' ? 'FINAL' : 'PARTIAL',
      productionOrder: String(row.order_number),
      materialNumber: String(row.material_number),
      materialDescription: String(row.material_description),
      plant: String(row.plant),
      plantName: String(row.plant_name),
      companyCode: String(row.company_code),
      operationNumber: row.operation_number == null ? null : String(row.operation_number),
      sequence: String(row.sequence).trim(),
      workCenter: row.work_center == null ? null : String(row.work_center),
      workCenterDescription: row.work_center_description == null ? null : String(row.work_center_description),
      controlKey: row.control_key == null ? null : String(row.control_key),
      operationText: row.short_text == null ? null : String(row.short_text),
      yieldQuantity: String(row.yield_quantity),
      scrapQuantity: String(row.scrap_quantity),
      reworkQuantity: String(row.rework_quantity),
      unit: String(row.unit),
      postingDate: String(row.posting_date),
      recordedAt: String(row.recorded_at),
      executionStart: row.execution_start == null ? null : String(row.execution_start),
      executionFinish: row.execution_finish == null ? null : String(row.execution_finish),
      note: row.note == null ? null : String(row.note),
      recordedBy: String(row.created_by),
      cancelled: row.cancellation_number != null,
      cancellationNumber: row.cancellation_number == null ? null : String(row.cancellation_number),
      cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
      cancelledBy: row.cancelled_by == null ? null : String(row.cancelled_by),
      cancellationReason: row.cancellation_reason == null ? null : String(row.cancellation_reason),
      effects,
      activities: activitiesFound.map((activity) => ({
        parameter: String(activity.parameter),
        description: String(activity.description),
        quantity: String(activity.quantity),
        unit: String(activity.unit),
        suggestedQuantity: activity.suggested_quantity == null ? null : String(activity.suggested_quantity),
      })),
      materialDocuments,
    };
  });
}
