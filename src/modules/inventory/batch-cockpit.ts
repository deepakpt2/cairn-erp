/**
 * Batch Information Cockpit — BMBC.
 *
 * Read-only. A row is a batch that already stands. Stock is summed from the
 * stock master, never from material-document lines. A document line is a
 * direct movement, not a top-down or bottom-up explosion. Characteristic
 * values and inspection lots are not stored, so those filters are refused.
 * Opening this screen writes nothing. A closed posting period does not block it.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';

export const ACTIVITY = 'INV.BATCH.COCKPIT';
export const ALIAS = 'BMBC';
export const ROUTE = '/inventory/batch-cockpit';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DOCUMENT_CAP = 40;

export const NOT_STORED = [
  {
    field: 'CLASS',
    title: 'Characteristic values',
    reason: 'No value is stored on a batch. A class or characteristic filter is refused.',
  },
  {
    field: 'QA',
    title: 'Inspection lot',
    reason: 'No inspection lot stands. That filter is refused.',
  },
  {
    field: 'CHVW',
    title: 'Genealogy',
    reason: 'Top-down and bottom-up usage is not stored. Direct material-document lines are shown. They are not an explosion.',
  },
] as const;

export class BatchCockpitError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(message: string, code: string, remedy: string) {
    super(message);
    this.name = 'BatchCockpitError';
    this.code = code;
    this.remedy = remedy;
  }
}

export interface CockpitSelection {
  material?: string;
  plant?: string;
  batch?: string;
  vendorBatch?: string;
  expirationFrom?: string;
  expirationTo?: string;
  stockType?: string;
  restrictedUse?: string;
  productionOrder?: string;
  purchaseOrder?: string;
  supplier?: string;
  limit?: number;
  inspectionLot?: string;
  className?: string;
  characteristic?: string;
  salesOrder?: string;
  delivery?: string;
  billingDocument?: string;
  schedulingAgreement?: string;
  genealogy?: boolean;
}

export interface CockpitStock {
  unrestricted: string;
  quality: string;
  blocked: string;
  other: string;
  unit: string;
}

export interface CockpitRow {
  materialNumber: string;
  materialDescription: string;
  batchNumber: string;
  plant: string | null;
  batchLevel: string;
  restrictedUse: 'X' | ' ' | null;
  manufactureDate: string | null;
  shelfLifeExpirationDate: string | null;
  vendorBatch: string | null;
  stock: CockpitStock;
}

export interface CockpitStockLine {
  plant: string;
  storageLocation: string;
  stockType: string;
  quantity: string;
  unit: string;
}

export interface CockpitDocument {
  materialDocumentNumber: string;
  lineNumber: number;
  postingDate: string;
  status: string;
  movementType: string;
  plant: string;
  storageLocation: string;
  stockType: string;
  direction: string;
  quantity: string;
  unit: string;
  purchaseOrderNumber: string | null;
  supplierNumber: string | null;
  productionOrderNumber: string | null;
  reversalOfDocument: string | null;
  returnOfDocument: string | null;
}

export interface CockpitResult {
  rows: CockpitRow[];
  truncated: boolean;
  limit: number;
  readOnly: true;
  genealogyStored: false;
  asOf: string;
}

export interface CockpitDetail {
  row: CockpitRow;
  stockLines: CockpitStockLine[];
  documents: CockpitDocument[];
  documentsTruncated: boolean;
  genealogyStored: false;
  readOnly: true;
}

function clean(value: string | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

function dateOf(value: string | undefined, label: string): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new BatchCockpitError(
      `${label} ${text} is not a date. Nothing was read.`,
      'DATE_INVALID',
      'Use YYYY-MM-DD.',
    );
  }
  return text;
}

function refuseUnsupported(selection: CockpitSelection): void {
  if (clean(selection.inspectionLot)) {
    throw new BatchCockpitError(
      'This cockpit reads no inspection lot, and lots are stored — at /quality/lots. Nothing was read.',
      'INSPECTION_REFUSED', 'Leave the inspection lot empty.',
    );
  }
  if (clean(selection.className) || clean(selection.characteristic)) {
    throw new BatchCockpitError(
      'A class or a characteristic value is not stored on a batch. Nothing was read.',
      'CLASS_REFUSED',
      'Leave classification empty. BMC1 does not assign a value.',
    );
  }
  if (clean(selection.salesOrder) || clean(selection.delivery)
    || clean(selection.billingDocument) || clean(selection.schedulingAgreement)) {
    throw new BatchCockpitError(
      'A sales order, a delivery, a billing document, or a scheduling agreement is not stored here. Nothing was read.',
      'SALES_REFUSED',
      'Select a material or a batch. Those documents are not on the material document.',
    );
  }
  if (selection.genealogy) {
    throw new BatchCockpitError(
      'Top-down and bottom-up genealogy are not stored. Nothing was exploded.',
      'GENEALOGY_NOT_STORED',
      'Read the direct material-document lines. Do not infer a parent batch.',
    );
  }
  const batch = selection.batch ?? '';
  if (/[*?%]/.test(batch)) {
    throw new BatchCockpitError(
      'A wildcard is refused. Nothing was read.',
      'PATTERN_REFUSED',
      'Type the batch number. This cockpit does not expand a star.',
    );
  }
}

function limitOf(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) return DEFAULT_LIMIT;
  const next = Math.trunc(value);
  if (next < 1 || next > MAX_LIMIT) {
    throw new BatchCockpitError(
      `The result limit ${value} is refused. Nothing was read.`,
      'LIMIT_REFUSED',
      `Use 1 to ${MAX_LIMIT}.`,
    );
  }
  return next;
}

function stockOf(type: string): string | null {
  const text = clean(type);
  if (!text) return null;
  if (text === 'UNRESTRICTED' || text === 'QUALITY' || text === 'BLOCKED' || text === 'OTHER') return text;
  throw new BatchCockpitError(
    `Stock type ${text} is refused. Nothing was read.`,
    'STOCK_UNKNOWN',
    'Use UNRESTRICTED, QUALITY, BLOCKED, or OTHER. Restricted use is not a stock type.',
  );
}

function restrictedOf(value: string | undefined): 'X' | ' ' | null {
  const text = clean(value);
  if (!text || text === 'ANY') return null;
  if (text === 'X') return 'X';
  if (text === 'BLANK') return ' ';
  throw new BatchCockpitError(
    `Restricted use ${text} is refused. Nothing was read.`,
    'STATUS_UNKNOWN',
    'Use X, blank, or leave it empty. It is not a stock type.',
  );
}

function qty(value: string | number | null | undefined): string {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(3) : '0.000';
}

export function traceBatchGenealogy(): never {
  throw new BatchCockpitError(
    'Top-down and bottom-up genealogy are not stored. Nothing was exploded.',
    'GENEALOGY_NOT_STORED',
    'Read the direct material-document lines. Do not infer a parent batch.',
  );
}

export async function searchBatches(client: string, selection: CockpitSelection): Promise<CockpitResult> {
  const key = client?.trim() ?? '';
  if (!key) throw new BatchCockpitError('The tenant is missing.', 'CLIENT_REQUIRED', 'Sign in again.');
  refuseUnsupported(selection);
  const material = clean(selection.material);
  const plant = clean(selection.plant);
  const batch = clean(selection.batch);
  const vendorBatch = clean(selection.vendorBatch);
  const expirationFrom = dateOf(selection.expirationFrom, 'Expiration from');
  const expirationTo = dateOf(selection.expirationTo, 'Expiration to');
  const stockType = stockOf(selection.stockType ?? '');
  const restricted = restrictedOf(selection.restrictedUse);
  const productionOrder = clean(selection.productionOrder);
  const purchaseOrder = clean(selection.purchaseOrder);
  const supplier = clean(selection.supplier);
  const limit = limitOf(selection.limit);
  if (!material && !plant && !batch && !vendorBatch && !expirationFrom && !expirationTo
    && !stockType && !restricted && !productionOrder && !purchaseOrder && !supplier) {
    throw new BatchCockpitError(
      'Name a material, a plant, a batch, or another stored criterion. Nothing was read.',
      'SELECTION_REQUIRED',
      'This cockpit does not list every batch on open.',
    );
  }

  return withTenant(key, async (tx) => {
    if (material) {
      const rows = await tx.execute(sql`select 1 as hit from material where client = ${key} and material_number = ${material} limit 1`) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) {
        throw new BatchCockpitError(`Material ${material} does not stand. Nothing was read.`, 'MATERIAL_UNKNOWN', 'Maintain the material first.');
      }
    }
    if (plant) {
      const rows = await tx.execute(sql`select 1 as hit from plant where client = ${key} and plant = ${plant} limit 1`) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) {
        throw new BatchCockpitError(`Plant ${plant} does not stand. Nothing was read.`, 'PLANT_UNKNOWN', 'Maintain the plant first.');
      }
    }
    const listed = await tx.execute(sql`
      select b.material_number, coalesce(m.description, '') as material_description,
             b.batch_number, b.plant, b.batch_level_at_creation, b.restricted_use,
             b.manufacture_date::text as manufacture_date,
             b.shelf_life_expiration_date::text as shelf_life_expiration_date,
             b.vendor_batch, m.base_unit
        from batch b
        join material m on m.client = b.client and m.material_number = b.material_number
       where b.client = ${key}
         ${material ? sql`and b.material_number = ${material}` : sql``}
         ${batch ? sql`and b.batch_number = ${batch}` : sql``}
         ${vendorBatch ? sql`and b.vendor_batch = ${vendorBatch}` : sql``}
         ${expirationFrom ? sql`and b.shelf_life_expiration_date >= ${expirationFrom}` : sql``}
         ${expirationTo ? sql`and b.shelf_life_expiration_date <= ${expirationTo}` : sql``}
         ${restricted === 'X' ? sql`and b.restricted_use = 'X'` : sql``}
         ${restricted === ' ' ? sql`and (b.restricted_use is null or b.restricted_use = ' ')` : sql``}
         ${plant ? sql`and (
           b.plant = ${plant}
           or (b.plant is null and (
             exists (
               select 1 from stock_quantity s
                where s.client = b.client and s.material_number = b.material_number
                  and s.batch_number = b.batch_number and s.plant = ${plant} and s.quantity <> 0
             )
             or exists (
               select 1 from material_document_line l
                where l.client = b.client and l.material_number = b.material_number
                  and l.batch_number = b.batch_number and l.plant = ${plant}
             )
           ))
         )` : sql``}
         ${stockType ? sql`and exists (
           select 1 from stock_quantity s
            where s.client = b.client and s.material_number = b.material_number
              and s.batch_number = b.batch_number and s.quantity <> 0
              and (b.plant is null or s.plant = b.plant)
              and (
                (${stockType} = 'UNRESTRICTED' and s.stock_type = 'UNRESTRICTED')
                or (${stockType} = 'QUALITY' and s.stock_type = 'QUALITY')
                or (${stockType} = 'BLOCKED' and s.stock_type = 'BLOCKED')
                or (${stockType} = 'OTHER' and s.stock_type not in ('UNRESTRICTED', 'QUALITY', 'BLOCKED'))
              )
         )` : sql``}
         ${productionOrder ? sql`and exists (
           select 1 from material_document_line l
            where l.client = b.client and l.material_number = b.material_number
              and l.batch_number = b.batch_number and l.production_order_number = ${productionOrder}
              and (b.plant is null or l.plant = b.plant)
         )` : sql``}
         ${purchaseOrder ? sql`and exists (
           select 1 from material_document_line l
            where l.client = b.client and l.material_number = b.material_number
              and l.batch_number = b.batch_number and l.purchase_order_number = ${purchaseOrder}
              and (b.plant is null or l.plant = b.plant)
         )` : sql``}
         ${supplier ? sql`and exists (
           select 1 from material_document_line l
           join purchase_order po on po.client = l.client and po.order_number = l.purchase_order_number
            where l.client = b.client and l.material_number = b.material_number
              and l.batch_number = b.batch_number and po.supplier_number = ${supplier}
              and (b.plant is null or l.plant = b.plant)
         )` : sql``}
       order by b.material_number, b.batch_number, b.plant nulls first
       limit ${limit + 1}
    `) as unknown as Array<{
      material_number: string;
      material_description: string;
      batch_number: string;
      plant: string | null;
      batch_level_at_creation: string;
      restricted_use: string | null;
      manufacture_date: string | null;
      shelf_life_expiration_date: string | null;
      vendor_batch: string | null;
      base_unit: string;
    }>;
    const truncated = listed.length > limit;
    const page = listed.slice(0, limit);
    const stock = page.length === 0 ? [] : await tx.execute(sql`
      select s.material_number, s.batch_number, s.plant, s.stock_type, sum(s.quantity) as quantity
        from stock_quantity s
       where s.client = ${key}
         and s.batch_number <> ''
         and (${sql.join(page.map((row) => sql`(s.material_number = ${row.material_number} and s.batch_number = ${row.batch_number})`), sql` or `)})
       group by s.material_number, s.batch_number, s.plant, s.stock_type
    `) as unknown as Array<{
      material_number: string;
      batch_number: string;
      plant: string;
      stock_type: string;
      quantity: string;
    }>;
    const rows = page.map((row) => {
      const lines = stock.filter((item) => item.material_number === row.material_number
        && item.batch_number === row.batch_number
        && (row.plant == null || item.plant === row.plant)
        && (plant === '' || row.plant != null || item.plant === plant));
      const sum = (type: string) => lines
        .filter((item) => (type === 'OTHER'
          ? !['UNRESTRICTED', 'QUALITY', 'BLOCKED'].includes(item.stock_type)
          : item.stock_type === type))
        .reduce((total, item) => total + Number(item.quantity), 0);
      const restrictedUse = row.restricted_use === 'X' ? 'X' : row.restricted_use == null ? null : ' ';
      return {
        materialNumber: row.material_number,
        materialDescription: row.material_description,
        batchNumber: row.batch_number,
        plant: row.plant,
        batchLevel: row.batch_level_at_creation,
        restrictedUse,
        manufactureDate: row.manufacture_date,
        shelfLifeExpirationDate: row.shelf_life_expiration_date,
        vendorBatch: row.vendor_batch,
        stock: {
          unrestricted: qty(sum('UNRESTRICTED')),
          quality: qty(sum('QUALITY')),
          blocked: qty(sum('BLOCKED')),
          other: qty(sum('OTHER')),
          unit: row.base_unit,
        },
      } satisfies CockpitRow;
    });
    return {
      rows,
      truncated,
      limit,
      readOnly: true,
      genealogyStored: false,
      asOf: new Date().toISOString(),
    };
  });
}

export async function readBatchCockpit(client: string, input: {
  materialNumber: string;
  batchNumber: string;
  plant?: string;
}): Promise<CockpitDetail> {
  const found = await searchBatches(client, {
    material: input.materialNumber,
    batch: input.batchNumber,
    plant: input.plant,
    limit: 5,
  });
  if (found.rows.length === 0) {
    throw new BatchCockpitError(
      `Batch ${input.batchNumber} does not stand for material ${input.materialNumber}. Nothing was read.`,
      'BATCH_UNKNOWN',
      'Select a batch that already stands.',
    );
  }
  if (found.rows.length > 1 && !clean(input.plant)) {
    throw new BatchCockpitError(
      'More than one batch matches. Name the plant. Nothing else was read.',
      'PLANT_REQUIRED',
      'Plant level keeps a separate batch in each plant.',
    );
  }
  const row = found.rows[0]!;
  return withTenant(client, async (tx) => {
    const stockLines = await tx.execute(sql`
      select s.plant, s.storage_location, s.stock_type, s.quantity::text as quantity, m.base_unit
        from stock_quantity s
        join material m on m.client = s.client and m.material_number = s.material_number
       where s.client = ${client}
         and s.material_number = ${row.materialNumber}
         and s.batch_number = ${row.batchNumber}
         and (${row.plant}::text is null or s.plant = ${row.plant})
       order by s.plant, s.storage_location, s.stock_type
    `) as unknown as Array<{
      plant: string;
      storage_location: string;
      stock_type: string;
      quantity: string;
      base_unit: string;
    }>;
    const documents = await tx.execute(sql`
      select h.material_document_number, l.line_number, h.posting_date::text as posting_date, h.status, l.movement_type,
             l.plant, coalesce(l.storage_location, '') as storage_location, l.stock_type,
             l.line_direction, l.base_quantity::text as quantity, l.base_unit,
             l.purchase_order_number, po.supplier_number, l.production_order_number,
             l.reversal_of_document, l.return_of_document
        from material_document_line l
        join material_document h
          on h.client = l.client and h.material_document_number = l.material_document_number
        left join purchase_order po
          on po.client = l.client and po.order_number = l.purchase_order_number
       where l.client = ${client}
         and l.material_number = ${row.materialNumber}
         and l.batch_number = ${row.batchNumber}
         and (${row.plant}::text is null or l.plant = ${row.plant})
       order by h.posting_date, h.material_document_number, l.line_number
       limit ${DOCUMENT_CAP + 1}
    `) as unknown as Array<{
      material_document_number: string;
      line_number: number;
      posting_date: string;
      status: string;
      movement_type: string;
      plant: string;
      storage_location: string;
      stock_type: string;
      line_direction: string;
      quantity: string;
      base_unit: string;
      purchase_order_number: string | null;
      supplier_number: string | null;
      production_order_number: string | null;
      reversal_of_document: string | null;
      return_of_document: string | null;
    }>;
    return {
      row,
      stockLines: stockLines.map((line) => ({
        plant: line.plant,
        storageLocation: line.storage_location,
        stockType: line.stock_type,
        quantity: qty(line.quantity),
        unit: line.base_unit,
      })),
      documents: documents.slice(0, DOCUMENT_CAP).map((line) => ({
        materialDocumentNumber: line.material_document_number,
        lineNumber: Number(line.line_number),
        postingDate: line.posting_date,
        status: line.status,
        movementType: line.movement_type,
        plant: line.plant,
        storageLocation: line.storage_location,
        stockType: line.stock_type,
        direction: line.line_direction,
        quantity: qty(line.quantity),
        unit: line.base_unit,
        purchaseOrderNumber: line.purchase_order_number,
        supplierNumber: line.supplier_number,
        productionOrderNumber: line.production_order_number,
        reversalOfDocument: line.reversal_of_document,
        returnOfDocument: line.return_of_document,
      })),
      documentsTruncated: documents.length > DOCUMENT_CAP,
      genealogyStored: false,
      readOnly: true,
    };
  });
}
