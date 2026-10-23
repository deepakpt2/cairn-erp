/**
 * Pick-up list for batch where-used — INV.BATCH.PICKUP (MB5C), program RM07MCHS.
 *
 * Read-only. A row is a batch that already stands and already appears on a
 * material document. Naming that batch lists those document lines. The list
 * does not create a batch, does not post, and does not invent a where-used
 * file. A sales order, a delivery, a billing document, and a scheduling
 * agreement are refused by name: those documents are not on the material
 * document.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';

export const BATCH_PICKUP_CAPABILITY = 'INV.BATCH.PICKUP';
export const BATCH_PICKUP_ALIAS = 'MB5C';
export const BATCH_PICKUP_ROUTE = '/inventory/batch-pickup';

const ROW_CAP = 500;
const USE_CAP = 200;

export class BatchPickupError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'BatchPickupError';
    this.remedy = remedy;
  }
}

export interface BatchPickupSelection {
  material?: string;
  plant?: string;
  batch?: string;
  salesOrder?: string;
  delivery?: string;
  billingDocument?: string;
  schedulingAgreement?: string;
}

export interface BatchPickupRow {
  materialNumber: string;
  materialDescription: string;
  batch: string;
  plant: string;
  documentCount: number;
  lastPostingDate: string;
  shelfLifeExpirationDate: string | null;
  restrictedUse: string;
}

export interface BatchPickupUse {
  materialDocumentNumber: string;
  lineNumber: number;
  postingDate: string;
  movementType: string;
  materialNumber: string;
  batch: string;
  plant: string;
  storageLocation: string;
  direction: string;
  quantity: string;
  unit: string;
  purchaseOrderNumber: string | null;
  productionOrderNumber: string | null;
}

export interface BatchPickupResult {
  rows: BatchPickupRow[];
  uses: BatchPickupUse[];
  truncated: boolean;
  usesTruncated: boolean;
  readOnly: true;
}

function fail(message: string, remedy: string): never {
  throw new BatchPickupError(message, remedy);
}

function clean(value: string | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

export async function listBatchPickup(
  client: string,
  selection: BatchPickupSelection,
): Promise<BatchPickupResult> {
  if (clean(selection.salesOrder)) {
    fail('A sales order is not on the material document. No list was read.', 'Select a material or a batch. This list does not read a sales order.');
  }
  if (clean(selection.delivery)) {
    fail('A delivery is not on the material document. No list was read.', 'Select a material or a batch. This list does not read a delivery.');
  }
  if (clean(selection.billingDocument)) {
    fail('A billing document is not on the material document. No list was read.', 'Select a material or a batch. This list does not read a billing document.');
  }
  if (clean(selection.schedulingAgreement)) {
    fail('A scheduling agreement is not on the material document. No list was read.', 'Select a material or a batch. This list does not read a scheduling agreement.');
  }

  const material = clean(selection.material);
  const plant = clean(selection.plant);
  const batch = clean(selection.batch);
  if (!material && !batch) {
    fail('Name a material or a batch. No list was read.', 'This list does not scan every batch.');
  }

  return withTenant(client, async (tx) => {
    if (material) {
      const rows = await tx.execute(sql`
        select 1 as hit from material where client = ${client} and material_number = ${material} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The material ${material} does not stand.`, 'Maintain the material before selecting it.');
    }
    if (plant) {
      const rows = await tx.execute(sql`
        select 1 as hit from plant where client = ${client} and plant = ${plant} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The plant ${plant} does not stand.`, 'Maintain the plant before selecting it.');
    }
    if (batch) {
      const standing = await tx.execute(sql`
        select 1 as hit from batch
         where client = ${client}
           and batch_number = ${batch}
           and (${material} = '' or material_number = ${material})
         limit 1
      `) as unknown as Array<{ hit: number }>;
      if (standing.length === 0) {
        fail(
          `Batch ${batch} does not stand${material ? ` for material ${material}` : ''}. No list was read.`,
          'Create the batch in MSC1N first. This list does not create a batch.',
        );
      }
    }

    const filters = [
      material ? sql`and l.material_number = ${material}` : sql``,
      plant ? sql`and l.plant = ${plant}` : sql``,
      batch ? sql`and l.batch_number = ${batch}` : sql``,
    ];
    const where = sql.join(filters, sql` `);
    const listed = await tx.execute(sql`
      select l.material_number,
             coalesce(m.description, '') as material_description,
             l.batch_number,
             l.plant,
             count(distinct l.material_document_number)::int as document_count,
             max(h.posting_date) as last_posting_date,
             max(b.shelf_life_expiration_date)::text as shelf_life_expiration_date,
             max(b.restricted_use) as restricted_use
        from material_document_line l
        join material_document h
          on h.client = l.client and h.material_document_number = l.material_document_number
        join batch b
          on b.client = l.client
         and b.material_number = l.material_number
         and b.batch_number = l.batch_number
         and (b.plant is null or b.plant = l.plant)
        left join material m
          on m.client = l.client and m.material_number = l.material_number
       where l.client = ${client}
         and l.batch_number <> ''
         ${where}
       group by l.material_number, m.description, l.batch_number, l.plant
       order by l.material_number, l.batch_number, l.plant
       limit ${ROW_CAP + 1}
    `) as unknown as Array<{
      material_number: string;
      material_description: string;
      batch_number: string;
      plant: string;
      document_count: number;
      last_posting_date: string;
      shelf_life_expiration_date: string | null;
      restricted_use: string | null;
    }>;
    const truncated = listed.length > ROW_CAP;
    const rows: BatchPickupRow[] = listed.slice(0, ROW_CAP).map((row) => ({
      materialNumber: row.material_number,
      materialDescription: row.material_description,
      batch: row.batch_number,
      plant: row.plant,
      documentCount: Number(row.document_count),
      lastPostingDate: row.last_posting_date,
      shelfLifeExpirationDate: row.shelf_life_expiration_date,
      restrictedUse: row.restricted_use === 'X' ? 'X' : '',
    }));

    let uses: BatchPickupUse[] = [];
    let usesTruncated = false;
    if (batch) {
      const used = await tx.execute(sql`
        select h.material_document_number, l.line_number, h.posting_date, l.movement_type,
               l.material_number, l.batch_number, l.plant, coalesce(l.storage_location, '') as storage_location,
               l.line_direction, l.base_quantity::text as quantity, l.base_unit,
               l.purchase_order_number, l.production_order_number
          from material_document_line l
          join material_document h
            on h.client = l.client and h.material_document_number = l.material_document_number
          join batch b
            on b.client = l.client
           and b.material_number = l.material_number
           and b.batch_number = l.batch_number
           and (b.plant is null or b.plant = l.plant)
         where l.client = ${client}
           and l.batch_number = ${batch}
           and l.batch_number <> ''
           ${material ? sql`and l.material_number = ${material}` : sql``}
           ${plant ? sql`and l.plant = ${plant}` : sql``}
         order by h.posting_date, h.material_document_number, l.line_number
         limit ${USE_CAP + 1}
      `) as unknown as Array<{
        material_document_number: string;
        line_number: number;
        posting_date: string;
        movement_type: string;
        material_number: string;
        batch_number: string;
        plant: string;
        storage_location: string;
        line_direction: string;
        quantity: string;
        base_unit: string;
        purchase_order_number: string | null;
        production_order_number: string | null;
      }>;
      usesTruncated = used.length > USE_CAP;
      uses = used.slice(0, USE_CAP).map((row) => ({
        materialDocumentNumber: row.material_document_number,
        lineNumber: Number(row.line_number),
        postingDate: row.posting_date,
        movementType: row.movement_type,
        materialNumber: row.material_number,
        batch: row.batch_number,
        plant: row.plant,
        storageLocation: row.storage_location,
        direction: row.line_direction,
        quantity: row.quantity,
        unit: row.base_unit,
        purchaseOrderNumber: row.purchase_order_number,
        productionOrderNumber: row.production_order_number,
      }));
    }

    return { rows, uses, truncated, usesTruncated, readOnly: true };
  });
}
