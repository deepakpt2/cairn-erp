import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { createBatch } from '../src/modules/inventory/batch-master';
import { postTransfer } from '../src/modules/inventory/transfer-posting';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'TRANSFER_BATCH_TEST';
const DAY = '2026-10-18';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function standing(seed: string): Promise<string> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, '2000', 'Plant Two', '1000', 'KW', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
      values (${client}, '1000', '0001', 'Main store', false, true, ${ACTOR}),
             (${client}, '1000', '0002', 'Second store', false, true, ${ACTOR}),
             (${client}, '2000', '0001', 'Plant two store', false, true, ${ACTOR})
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
      values (${client}, 'MAT-BATCH', 'Batch material', 'RAW', 'PC', true, ${ACTOR})
      on conflict (client, material_number) do update set batch_managed = true
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MAT-BATCH', '1000', ${ACTOR}),
             (${client}, 'MAT-BATCH', '2000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency,
        total_stock_quantity, stock_value, created_by
      ) values (${client}, 'MAT-BATCH', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 10, 1, ${tenant.currency}, 9, 90, ${ACTOR}),
               (${client}, 'MAT-BATCH', '2000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 10, 1, ${tenant.currency}, 0, 0, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by)
      values (${client}, 'MAT-BATCH', '1000', '0001', 'UNRESTRICTED', '00012', 4, ${ACTOR}),
             (${client}, 'MAT-BATCH', '1000', '0001', 'UNRESTRICTED', '00013', 2, ${ACTOR}),
             (${client}, 'MAT-BATCH', '1000', '0002', 'UNRESTRICTED', '00013', 1, ${ACTOR}),
             (${client}, 'MAT-BATCH', '1000', '0001', 'QUALITY', '00012', 3, ${ACTOR})
      on conflict do nothing
    `);
  });
  await initializeMaterialPeriodControl({
    client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Transfer batch',
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Moved batch' });
  await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00013', reason: 'Other batch' });
  return client;
}

async function stock(client: string, plant: string, location: string, type: string, batch: string): Promise<number> {
  const rows = await withTenant(client, async (tx) => tx.execute(sql`
    select quantity::text as quantity from stock_quantity
     where client = ${client} and material_number = 'MAT-BATCH'
       and plant = ${plant} and storage_location = ${location}
       and stock_type = ${type} and batch_number = ${batch}
  `)) as unknown as Array<{ quantity: string }>;
  return Number(rows[0]?.quantity ?? 0);
}

describe('transfer of one standing batch', () => {
  it('moves that batch and leaves the other batch where it stands', async () => {
    const client = await standing('transfer-batch');
    const moved = await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311', materialNumber: 'MAT-BATCH', quantity: 1,
      issuingPlant: '1000', issuingStorageLocation: '0001',
      receivingPlant: '1000', receivingStorageLocation: '0002',
      postingDate: DAY, documentDate: DAY, batch: '00012', requestKey: 'transfer-batch-311',
    });
    expect(moved.lines.map((line) => line.batch)).toEqual(['00012', '00012']);
    expect(await stock(client, '1000', '0001', 'UNRESTRICTED', '00012')).toBe(3);
    expect(await stock(client, '1000', '0002', 'UNRESTRICTED', '00012')).toBe(1);
    expect(await stock(client, '1000', '0001', 'UNRESTRICTED', '00013')).toBe(2);
    expect(await stock(client, '1000', '0002', 'UNRESTRICTED', '00013')).toBe(1);

    const typed = await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '321', materialNumber: 'MAT-BATCH', quantity: 1,
      issuingPlant: '1000', issuingStorageLocation: '0001',
      receivingPlant: '1000', receivingStorageLocation: '0001',
      postingDate: DAY, documentDate: DAY, batch: '00012', requestKey: 'transfer-batch-321',
    });
    expect(typed.lines.map((line) => line.batch)).toEqual(['00012', '00012']);
    expect(typed.lines.map((line) => line.stockType)).toEqual(['QUALITY', 'UNRESTRICTED']);
    expect(await stock(client, '1000', '0001', 'QUALITY', '00012')).toBe(2);
    expect(await stock(client, '1000', '0001', 'UNRESTRICTED', '00012')).toBe(4);
    expect(await stock(client, '1000', '0001', 'UNRESTRICTED', '00013')).toBe(2);

    const plant = await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '301', materialNumber: 'MAT-BATCH', quantity: 1,
      issuingPlant: '1000', issuingStorageLocation: '0002',
      receivingPlant: '2000', receivingStorageLocation: '0001',
      postingDate: DAY, documentDate: DAY, batch: '00012', requestKey: 'transfer-batch-301',
    });
    expect(plant.lines.map((line) => line.batch)).toEqual(['00012', '00012']);
    expect(await stock(client, '1000', '0002', 'UNRESTRICTED', '00012')).toBe(0);
    expect(await stock(client, '2000', '0001', 'UNRESTRICTED', '00012')).toBe(1);
    expect(await stock(client, '1000', '0002', 'UNRESTRICTED', '00013')).toBe(1);
  });
});
