import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { createBatch } from '../src/modules/inventory/batch-master';
import { saveMaterialShelfLife } from '../src/modules/inventory/material-shelf-life';
import { ShelfLifeListError, listShelfLife } from '../src/modules/inventory/shelf-life-list';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'MB5M_TEST';
const KEY = '2026-10-23';
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

async function stock(client: string, batch: string, quantity: string, stockType = 'UNRESTRICTED', location = '0001') {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into stock_quantity (
      client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by
    ) values (${client}, 'MAT-SLED', '1000', ${location}, ${stockType}, ${batch}, ${quantity}, ${ACTOR})
  `));
}

async function fixture(seed: string): Promise<string> {
  const client = await tenant(seed);
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
      values (${client}, 'MAT-SLED', 'Shelf life material', 'RAW', 'PC', true, ${ACTOR})
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MAT-SLED', '1000', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, created_by)
      values (${client}, '1000', '0001', 'Main', ${ACTOR}),
             (${client}, '1000', '0002', 'Second', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, '4900000501', 2026, '2026-10-01', '2026-10-01', 'POSTED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, '101', 'Receipt', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR})
      on conflict do nothing
    `);
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level for MB5M' });
  const batches = [
    { batchNumber: 'B-EXP', shelfLifeExpirationDate: '2026-10-01', manufactureDate: '2026-07-01' },
    { batchNumber: 'B-SOON', shelfLifeExpirationDate: '2026-10-28', manufactureDate: '2026-08-01' },
    { batchNumber: 'B-LATER', shelfLifeExpirationDate: '2026-12-01', manufactureDate: '2026-09-01' },
    { batchNumber: 'B-TODAY', shelfLifeExpirationDate: '2026-10-23', manufactureDate: '2026-09-23' },
    { batchNumber: 'B-MISS' },
    { batchNumber: 'B-ZERO', shelfLifeExpirationDate: '2026-09-01' },
    { batchNumber: 'B-WH', shelfLifeExpirationDate: '2026-11-22', manufactureDate: '2026-10-23' },
  ];
  for (const batch of batches) {
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-SLED', reason: 'Standing batch', ...batch });
  }
  await stock(client, 'B-EXP', '7.000');
  await stock(client, 'B-EXP', '4.000', 'QUALITY');
  await stock(client, 'B-EXP', '9.000', 'BLOCKED');
  await stock(client, 'B-SOON', '3.000');
  await stock(client, 'B-LATER', '2.000', 'UNRESTRICTED', '0002');
  await stock(client, 'B-TODAY', '1.000');
  await stock(client, 'B-MISS', '4.000');
  await stock(client, 'B-ZERO', '0.000');
  await stock(client, 'B-WH', '5.000');
  await withTenant(client, (tx) => tx.execute(sql`
    insert into material_document_line (
      client, material_document_number, line_number, movement_type, material_number, plant,
      storage_location, stock_type, batch_number, line_direction,
      entry_quantity, entry_unit, base_quantity, base_unit, created_by
    ) values
      (${client}, '4900000501', 1, '101', 'MAT-SLED', '1000', '0001', 'UNRESTRICTED', 'B-EXP', 'RECEIPT', 100, 'PC', 100, 'PC', ${ACTOR}),
      (${client}, '4900000501', 2, '101', 'MAT-SLED', '1000', '0001', 'UNRESTRICTED', 'B-EXP', 'RECEIPT', 100, 'PC', 100, 'PC', ${ACTOR})
  `));
  return client;
}

function names(rows: Array<{ batch: string }>): string[] {
  return rows.map((row) => row.batch);
}

describe('MB5M shelf life list', () => {
  it('lists expired unrestricted stock and does not invent a date or sum documents', async () => {
    const client = await fixture('mb5m-expired');
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from batch where client = ${client})::int as batches,
        (select count(*) from change_document where client = ${client} and object_class = 'material_document')::int as changes
    `)) as unknown as Array<{ documents: number; batches: number; changes: number }>;
    const result = await listShelfLife({ client, selection: { keyDate: KEY } });
    expect(names(result.rows)).toEqual(['B-EXP']);
    expect(result.rows[0]).toMatchObject({
      classification: 'EXPIRED',
      remainingDays: -22,
      unrestrictedQuantity: '7.000',
      baseUnit: 'PC',
    });
    expect(result.rows[0]?.unrestrictedQuantity).not.toBe('200.000');
    expect(names(result.undetermined)).toContain('B-MISS');
    expect(result.undetermined.find((row) => row.batch === 'B-MISS')?.reason).toMatch(/not stored/);
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from batch where client = ${client})::int as batches,
        (select quantity::text from stock_quantity
          where client = ${client} and batch_number = 'B-EXP' and stock_type = 'UNRESTRICTED') as stock
    `)) as unknown as Array<{ documents: number; batches: number; stock: string }>;
    expect(after[0]?.documents).toBe(before[0]?.documents);
    expect(after[0]?.batches).toBe(before[0]?.batches);
    expect(after[0]?.stock).toBe('7.000');
  });

  it('includes a batch inside the day threshold and keeps period display from changing the rows', async () => {
    const client = await fixture('mb5m-threshold');
    const days = await listShelfLife({
      client, selection: { keyDate: KEY, remainingShelfLifeDays: 10, display: 'DAYS' },
    });
    expect(names(days.rows)).toEqual(['B-EXP', 'B-SOON', 'B-TODAY']);
    expect(days.rows.find((row) => row.batch === 'B-TODAY')?.classification).toBe('EXPIRES_ON_KEY_DATE');
    expect(days.rows.find((row) => row.batch === 'B-SOON')?.remainingDays).toBe(5);
    const period = await listShelfLife({
      client, selection: { keyDate: KEY, remainingShelfLifeDays: 10, display: 'PERIOD' },
    });
    expect(names(period.rows)).toEqual(names(days.rows));
    expect(period.rows.map((row) => row.unrestrictedQuantity)).toEqual(days.rows.map((row) => row.unrestrictedQuantity));
  });

  it('calculates warehouse remaining life separately and does not fall back to total life', async () => {
    const client = await fixture('mb5m-warehouse');
    await saveMaterialShelfLife({
      client, changedBy: ACTOR, materialNumber: 'MAT-SLED',
      minRemainingShelfLife: 20, totalShelfLife: 30, storagePercentage: 50, periodIndicator: ' ',
      reason: 'Store the warehouse percentage',
    });
    const total = await listShelfLife({
      client, selection: { keyDate: KEY, remainingShelfLifeDays: 30, scope: 'TOTAL', batchFrom: 'B-WH', batchTo: 'B-WH' },
    });
    const warehouse = await listShelfLife({
      client, selection: { keyDate: KEY, remainingShelfLifeDays: 30, scope: 'WAREHOUSE', batchFrom: 'B-WH', batchTo: 'B-WH' },
    });
    expect(total.rows[0]?.remainingDays).toBe(30);
    expect(warehouse.rows[0]?.remainingDays).toBe(20);
    expect(warehouse.rows[0]?.comparedExpiration).toBe('2026-11-12');
    expect(warehouse.rows[0]?.remainingDays).not.toBe(total.rows[0]?.remainingDays);
    await saveMaterialShelfLife({
      client, changedBy: ACTOR, materialNumber: 'MAT-SLED',
      minRemainingShelfLife: 1, totalShelfLife: 2, storagePercentage: 100, periodIndicator: '2',
      reason: 'Store a one-month deduction',
    });
    const months = await listShelfLife({
      client, selection: { keyDate: KEY, remainingShelfLifeDays: 40, scope: 'WAREHOUSE', batchFrom: 'B-WH', batchTo: 'B-WH' },
    });
    expect(months.rows[0]?.comparedExpiration).toBe('2026-10-22');
    const without = await listShelfLife({
      client: await fixture('mb5m-warehouse-blank'),
      selection: { keyDate: KEY, remainingShelfLifeDays: 40, scope: 'WAREHOUSE', batchFrom: 'B-WH', batchTo: 'B-WH' },
    });
    expect(without.rows).toEqual([]);
    expect(without.undetermined[0]?.reason).toMatch(/storage percentage/i);
  });

  it('honours zero stock, ranges, and refuses a layout or a sales document', async () => {
    const client = await fixture('mb5m-filters');
    const hidden = await listShelfLife({ client, selection: { keyDate: KEY, includeZeroStock: false } });
    expect(names(hidden.rows)).not.toContain('B-ZERO');
    const shown = await listShelfLife({ client, selection: { keyDate: KEY, includeZeroStock: true } });
    expect(names(shown.rows)).toContain('B-ZERO');
    const location = await listShelfLife({
      client, selection: { keyDate: KEY, remainingShelfLifeDays: 9999, storageLocationFrom: '0002', storageLocationTo: '0002' },
    });
    expect(names(location.rows)).toEqual(['B-LATER']);
    await expect(listShelfLife({ client, selection: { materialFrom: 'ZZZ', materialTo: 'AAA', keyDate: KEY } })).rejects.toBeInstanceOf(ShelfLifeListError);
    await expect(listShelfLife({ client, selection: { layoutVariant: 'SAVED', keyDate: KEY } })).rejects.toThrow(/not stored/);
    await expect(listShelfLife({ client, selection: { salesOrder: '1', keyDate: KEY } })).rejects.toThrow(/sales order/i);
  });

  it('does not show another tenant', async () => {
    const client = await fixture('mb5m-tenant');
    const other = await fixture('mb5m-other');
    const own = await listShelfLife({ client, selection: { keyDate: KEY, remainingShelfLifeDays: 9999 } });
    const foreign = await listShelfLife({ client: other, selection: { keyDate: KEY, remainingShelfLifeDays: 9999, materialFrom: 'MAT-SLED' } });
    expect(own.rows.length).toBeGreaterThan(0);
    expect(foreign.rows.every((row) => row.materialNumber === 'MAT-SLED')).toBe(true);
    const leaked = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from stock_quantity where client = ${other}
    `)) as unknown as Array<{ n: number }>;
    expect(Number(leaked[0]?.n ?? 0)).toBe(0);
  });
});
