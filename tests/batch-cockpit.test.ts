import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  BatchCockpitError,
  readBatchCockpit,
  searchBatches,
  traceBatchGenealogy,
} from '../src/modules/inventory/batch-cockpit';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'BMBC_TEST';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function tenant(seed: string): Promise<string> {
  const created = await createTenant(seed);
  clients.push(created.client);
  return created.client;
}

async function counts(client: string): Promise<{ batches: number; stock: number; documents: number }> {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select
      (select count(*)::int from batch where client = ${client}) as batches,
      (select count(*)::int from stock_quantity where client = ${client}) as stock,
      (select count(*)::int from material_document where client = ${client}) as documents
  `)) as unknown as Array<{ batches: number; stock: number; documents: number }>;
  return rows[0]!;
}

describe('batch information cockpit', () => {
  it('selects stored criteria, keeps stock unmultiplied, and refuses what is not stored', async () => {
    const client = await tenant('bmbc-select');
    const other = await tenant('bmbc-other');
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values
          (${client}, 'RM-BMBC', 'Cockpit material', 'RAW', 'PC', ${ACTOR}),
          (${client}, 'RM-OTHER', 'Other material', 'RAW', 'PC', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by)
        values (${client}, '2000', 'Other plant', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into batch (
          id, client, batch_number, material_number, plant, batch_level_at_creation,
          restricted_use, manufacture_date, shelf_life_expiration_date, vendor_batch, created_by, changed_by
        ) values
          ('bmbc-a', ${client}, 'B-A', 'RM-BMBC', null, '1', 'X', '2026-10-01', '2026-12-31', 'VEND-A', ${ACTOR}, ${ACTOR}),
          ('bmbc-b', ${client}, 'B-B', 'RM-BMBC', null, '1', ' ', '2026-09-01', '2026-11-30', 'VEND-B', ${ACTOR}, ${ACTOR}),
          ('bmbc-c', ${client}, 'B-C', 'RM-BMBC', null, '1', ' ', '2026-08-01', '2027-01-15', 'VEND-C', ${ACTOR}, ${ACTOR}),
          ('bmbc-p', ${client}, 'B-P', 'RM-OTHER', '1000', '0', ' ', null, null, null, ${ACTOR}, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by)
        values
          (${client}, 'RM-BMBC', '1000', '0001', 'UNRESTRICTED', 'B-A', 5, ${ACTOR}),
          (${client}, 'RM-BMBC', '1000', '0002', 'UNRESTRICTED', 'B-A', 3, ${ACTOR}),
          (${client}, 'RM-BMBC', '1000', '0001', 'QUALITY', 'B-A', 2, ${ACTOR}),
          (${client}, 'RM-BMBC', '1000', '0001', 'TRANSIT', 'B-A', 1, ${ACTOR}),
          (${client}, 'RM-BMBC', '2000', '0001', 'UNRESTRICTED', 'B-B', 9, ${ACTOR}),
          (${client}, 'RM-OTHER', '1000', '0001', 'BLOCKED', 'B-P', 4, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${client}, 'RECEIPT_OTHER', 'Goods receipt without reference', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, 'SUP-1', 'ORGANIZATION', 'Cockpit supplier', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, 'SUP-1', 'SUPPLIER', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_order (
          client, order_number, supplier_number, purchasing_org, purchasing_group,
          company_code, currency, document_date, created_by
        ) values (${client}, '4500000091', 'SUP-1', '1000', '001', '1000', 'INR', '2026-10-18', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into production_order (
          client, order_number, material_number, plant, order_quantity, unit_of_measure,
          scheduled_start, scheduled_finish, status, created_by
        ) values (${client}, '1000001', 'RM-BMBC', '1000', 1, 'PC', '2026-10-01', '2026-10-31', 'RELEASED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
        values
          (${client}, '4900000911', 2026, '2026-10-18', '2026-10-18', 'POSTED', ${ACTOR}),
          (${client}, '4900000912', 2026, '2026-10-19', '2026-10-19', 'POSTED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant,
          storage_location, stock_type, batch_number, line_direction,
          entry_quantity, entry_unit, base_quantity, base_unit,
          purchase_order_number, purchase_order_item, production_order_number, reversal_of_document, reversal_of_line, created_by
        ) values
          (${client}, '4900000911', 1, 'RECEIPT_OTHER', 'RM-BMBC', '1000', '0001', 'UNRESTRICTED', 'B-A', 'RECEIPT', 100, 'PC', 100, 'PC', '4500000091', 10, null, null, null, ${ACTOR}),
          (${client}, '4900000912', 1, 'RECEIPT_OTHER', 'RM-BMBC', '1000', '0001', 'UNRESTRICTED', 'B-A', 'RECEIPT', 100, 'PC', 100, 'PC', null, null, '1000001', '4900000911', 1, ${ACTOR}),
          (${client}, '4900000912', 2, 'RECEIPT_OTHER', 'RM-BMBC', '2000', '0001', 'UNRESTRICTED', 'B-B', 'RECEIPT', 9, 'PC', 9, 'PC', null, null, null, null, null, ${ACTOR})
      `);
    });
    await withTenant(other, (tx) => tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${other}, 'RM-BMBC', 'Foreign', 'RAW', 'PC', ${ACTOR})
    `));
    await withTenant(other, (tx) => tx.execute(sql`
      insert into batch (id, client, batch_number, material_number, plant, batch_level_at_creation, vendor_batch, created_by, changed_by)
      values ('bmbc-foreign', ${other}, 'B-A', 'RM-BMBC', null, '1', 'FOREIGN', ${ACTOR}, ${ACTOR})
    `));

    const before = await counts(client);
    const listed = await searchBatches(client, { material: 'rm-bmbc' });
    expect(listed.rows.map((row) => row.batchNumber)).toEqual(['B-A', 'B-B', 'B-C']);
    expect(listed.truncated).toBe(false);
    expect(listed.readOnly).toBe(true);
    expect(listed.genealogyStored).toBe(false);
    const first = listed.rows[0]!;
    expect(first.stock).toEqual({
      unrestricted: '8.000',
      quality: '2.000',
      blocked: '0.000',
      other: '1.000',
      unit: 'PC',
    });
    expect(first.restrictedUse).toBe('X');
    expect(first.stock.unrestricted).not.toBe('200.000');
    expect(listed.rows[1]?.stock.unrestricted).toBe('9.000');
    expect(listed.rows[2]?.stock.unrestricted).toBe('0.000');

    const byVendor = await searchBatches(client, { vendorBatch: 'vend-a' });
    expect(byVendor.rows.map((row) => row.batchNumber)).toEqual(['B-A']);
    const byDate = await searchBatches(client, { material: 'RM-BMBC', expirationFrom: '2026-12-01', expirationTo: '2026-12-31' });
    expect(byDate.rows.map((row) => row.batchNumber)).toEqual(['B-A']);
    const byPlant = await searchBatches(client, { material: 'RM-BMBC', plant: '2000' });
    expect(byPlant.rows.map((row) => row.batchNumber)).toEqual(['B-B']);
    const byStatus = await searchBatches(client, { material: 'RM-BMBC', restrictedUse: 'X' });
    expect(byStatus.rows.map((row) => row.batchNumber)).toEqual(['B-A']);
    const byQuality = await searchBatches(client, { material: 'RM-BMBC', stockType: 'QUALITY' });
    expect(byQuality.rows.map((row) => row.batchNumber)).toEqual(['B-A']);
    const byOrder = await searchBatches(client, { productionOrder: '1000001' });
    expect(byOrder.rows.map((row) => row.batchNumber)).toEqual(['B-A']);
    const bySupplier = await searchBatches(client, { supplier: 'SUP-1' });
    expect(bySupplier.rows.map((row) => row.batchNumber)).toEqual(['B-A']);
    const capped = await searchBatches(client, { material: 'RM-BMBC', limit: 2 });
    expect(capped.rows.map((row) => row.batchNumber)).toEqual(['B-A', 'B-B']);
    expect(capped.truncated).toBe(true);
    const plantBatch = await searchBatches(client, { plant: '1000', batch: 'B-P' });
    expect(plantBatch.rows).toHaveLength(1);
    expect(plantBatch.rows[0]?.stock.blocked).toBe('4.000');
    expect(await searchBatches(client, { plant: '2000', batch: 'B-P' })).toMatchObject({ rows: [] });

    const detail = await readBatchCockpit(client, { materialNumber: 'RM-BMBC', batchNumber: 'B-A' });
    expect(detail.documents).toHaveLength(2);
    expect(detail.documents[0]?.purchaseOrderNumber).toBe('4500000091');
    expect(detail.documents[0]?.supplierNumber).toBe('SUP-1');
    expect(detail.documents[1]?.supplierNumber).toBeNull();
    expect(detail.documents[1]?.productionOrderNumber).toBe('1000001');
    expect(detail.documents[1]?.reversalOfDocument).toBe('4900000911');
    expect(detail.documents.reduce((sum, line) => sum + Number(line.quantity), 0)).toBe(200);
    expect(detail.row.stock.unrestricted).toBe('8.000');
    expect(detail.genealogyStored).toBe(false);
    expect(detail.stockLines).toHaveLength(4);

    const foreign = await searchBatches(other, { material: 'RM-BMBC' });
    expect(foreign.rows.map((row) => row.vendorBatch)).toEqual(['FOREIGN']);
    expect(foreign.rows[0]?.stock.unrestricted).toBe('0.000');
    await expect(searchBatches(other, { supplier: 'SUP-1' })).resolves.toMatchObject({ rows: [] });

    await expect(searchBatches(client, {})).rejects.toMatchObject({ code: 'SELECTION_REQUIRED' });
    await expect(searchBatches(client, { inspectionLot: '100' })).rejects.toMatchObject({ code: 'INSPECTION_REFUSED' });
    await expect(searchBatches(client, { className: 'CLASS1' })).rejects.toMatchObject({ code: 'CLASS_REFUSED' });
    await expect(searchBatches(client, { characteristic: 'LOBM_HSDAT' })).rejects.toMatchObject({ code: 'CLASS_REFUSED' });
    await expect(searchBatches(client, { salesOrder: 'SO-1' })).rejects.toMatchObject({ code: 'SALES_REFUSED' });
    await expect(searchBatches(client, { delivery: 'DL-1' })).rejects.toMatchObject({ code: 'SALES_REFUSED' });
    await expect(searchBatches(client, { billingDocument: 'BL-1' })).rejects.toMatchObject({ code: 'SALES_REFUSED' });
    await expect(searchBatches(client, { schedulingAgreement: 'SA-1' })).rejects.toMatchObject({ code: 'SALES_REFUSED' });
    await expect(searchBatches(client, { batch: 'B*' })).rejects.toMatchObject({ code: 'PATTERN_REFUSED' });
    await expect(searchBatches(client, { genealogy: true })).rejects.toMatchObject({ code: 'GENEALOGY_NOT_STORED' });
    await expect(searchBatches(client, { stockType: 'RESTRICTED' })).rejects.toMatchObject({ code: 'STOCK_UNKNOWN' });
    expect(() => traceBatchGenealogy()).toThrow(BatchCockpitError);
    expect(await counts(client)).toEqual(before);
  });

  it('does not write, convert, or invent a genealogy table', () => {
    const service = readFileSync('src/modules/inventory/batch-cockpit.ts', 'utf8');
    const page = readFileSync('src/app/inventory/batch-cockpit/page.tsx', 'utf8');
    const goods = readFileSync('src/modules/inventory/goods-issue.ts', 'utf8');
    expect(service).not.toMatch(/insert into|update |delete from|create table/i);
    expect(service).not.toMatch(/convertQuantity|postingPeriod|OB52/);
    expect(service).toContain('GENEALOGY_NOT_STORED');
    expect(page).toContain('Genealogy is not stored');
    expect(page).toContain('Not stored');
    expect(goods).not.toContain('batch-cockpit');
    expect(readFileSync('onboarding-manual.md', 'utf8')).toContain('INV.BATCH.COCKPIT');
  });
});
