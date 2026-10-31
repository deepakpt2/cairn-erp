import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { createBatch } from '../src/modules/inventory/batch-master';
import { reverseMaterialDocument } from '../src/modules/inventory/material-document-reversal';
import { stockOverview } from '../src/modules/inventory/stock-overview';
import { listWarehouseStocks } from '../src/modules/inventory/warehouse-stocks';
import { stockOnPostingDate } from '../src/modules/inventory/stock-posting-date';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'STOCK_READBACK_TEST';
const DAY = '2026-10-18';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function standing(seed: string): Promise<{ client: string; currency: string }> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
      values (${client}, 'V10000', 'SUPPLIER', '1000', ${tenant.currency}, ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
      values (${client}, '1000', '0001', 'Main store', false, true, ${ACTOR})
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
      values (${client}, 'MAT-BATCH', 'Batch material', 'RAW', 'PC', true, ${ACTOR})
      on conflict (client, material_number) do update set batch_managed = true
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MAT-BATCH', '1000', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency,
        total_stock_quantity, stock_value, created_by
      ) values (${client}, 'MAT-BATCH', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, ${tenant.currency}, 0, 0, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
             (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
             (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '300000', ${ACTOR})
      on conflict do nothing
    `);
  });
  await initializeMaterialPeriodControl({
    client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Stock readback',
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Receipt batch' });
  await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00013', reason: 'Other batch' });
  return { client, currency: tenant.currency };
}

function batchesOf(overview: Awaited<ReturnType<typeof stockOverview>>) {
  return overview.plants.flatMap((plant) => plant.storageLocations.flatMap((location) => (
    location.stockTypes.flatMap((type) => type.batches.map((batch) => ({
      batch: batch.batch,
      quantity: batch.quantity,
      movements: location.movementsDrillDown,
    })))
  )));
}

describe('stock readback of one posted batch', () => {
  it('reads that batch on MMBE, MB52 and MB5B and leaves the other batch', async () => {
    const { client, currency } = await standing('stock-batch-readback');
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [
        {
          materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 3, unit: 'PC',
          netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001', batch: '00012',
          markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 3 }], assignments: [],
        },
        {
          materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 2, unit: 'PC',
          netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001', batch: '00013',
          markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 2 }], assignments: [],
        },
      ],
    });
    const receipt = await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: DAY, postingDate: DAY, requestKey: 'readback-gr',
      lines: [
        { itemNumber: 10, quantity: 3, storageLocation: '0001', batch: '00012' },
        { itemNumber: 20, quantity: 2, storageLocation: '0001', batch: '00013' },
      ],
    });

    const overview = await stockOverview({
      client, selection: { material: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000' },
    });
    expect(batchesOf(overview).map((row) => [row.batch, row.quantity])).toEqual([['00012', 3], ['00013', 2]]);
    const one = await stockOverview({
      client, selection: { material: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000', batch: '00012' },
    });
    expect(one.totalQuantity).toBe(3);
    expect(batchesOf(one).map((row) => row.batch)).toEqual(['00012']);
    expect(one.plants[0]?.storageLocations[0]?.movementsDrillDown).toContain('batch=00012');
    expect(one.plants[0]?.storageLocations[0]?.movementsDrillDown).not.toContain('00013');

    const warehouse = await listWarehouseStocks({
      client, localCurrency: currency,
      selection: { materialFrom: 'MAT-BATCH', materialTo: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000' },
    });
    expect(warehouse.rows.map((row) => [row.batch, row.totalQuantity])).toEqual([['00012', 3], ['00013', 2]]);
    expect(warehouse.rows[0]?.movementsDrillDown).toContain('batch=00012');
    expect(warehouse.rows[1]?.movementsDrillDown).toContain('batch=00013');

    const rollforward = await stockOnPostingDate({
      client,
      selection: {
        materialFrom: 'MAT-BATCH', materialTo: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000',
        dateFrom: '2026-10-01', dateTo: '2026-10-31',
      },
    });
    expect(rollforward.rows.map((row) => [row.batch, row.receiptQuantity, row.closingQuantity])).toEqual([
      ['00012', 3, 3],
      ['00013', 2, 2],
    ]);
    expect(rollforward.rows[0]?.drillDown).toContain('batch=00012');
    expect(rollforward.rows[1]?.drillDown).toContain('batch=00013');

    const moved = receipt.lines.find((line) => line.batch === '00012');
    expect(moved?.lineNumber).toBeTruthy();
    await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: receipt.materialDocumentNumber,
      lines: [moved!.lineNumber], postingDate: DAY, documentDate: DAY, requestKey: 'readback-rev',
    });
    const after = await stockOverview({
      client, selection: { material: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000' },
    });
    expect(batchesOf(after).map((row) => [row.batch, row.quantity])).toEqual([['00013', 2]]);
    const afterWarehouse = await listWarehouseStocks({
      client, localCurrency: currency,
      selection: { materialFrom: 'MAT-BATCH', materialTo: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000' },
    });
    expect(afterWarehouse.rows.map((row) => [row.batch, row.totalQuantity])).toEqual([['00013', 2]]);
    const afterRoll = await stockOnPostingDate({
      client,
      selection: {
        materialFrom: 'MAT-BATCH', materialTo: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000',
        dateFrom: '2026-10-01', dateTo: '2026-10-31', displayZero: true,
      },
    });
    expect(afterRoll.rows.find((row) => row.batch === '00012')).toBeUndefined();
    expect(afterRoll.rows.find((row) => row.batch === '00013')).toMatchObject({ receiptQuantity: 2, closingQuantity: 2 });
    expect(afterRoll.warnings.join(' ')).not.toMatch(/00012/);
  });
});
