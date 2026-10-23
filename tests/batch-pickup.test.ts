import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { createBatch } from '../src/modules/inventory/batch-master';
import { BatchPickupError, listBatchPickup } from '../src/modules/inventory/batch-pickup';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'BATCH_PICKUP_TEST';
const POSTING = { documentDate: '2026-10-18', postingDate: '2026-10-18' };
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
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
      values (${client}, 'MAT-BATCH', 'Batch material', 'RAW', 'PC', true, ${ACTOR})
      on conflict (client, material_number) do update set batch_managed = excluded.batch_managed
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MAT-BATCH', '1000', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency, created_by
      ) values (${client}, 'MAT-BATCH', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
             (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR})
      on conflict do nothing
    `);
  });
  await initializeMaterialPeriodControl({
    client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Batch pick-up',
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  return client;
}

async function documentCount(client: string): Promise<number> {
  const rows = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from material_document where client = ${client}
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

describe('batch pick-up list', () => {
  it('lists a standing batch that already appears on a material document and does not list one that does not', async () => {
    const client = await standing('batch-pickup');
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Posted batch',
    });
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00013', reason: 'Unposted batch',
    });
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 4, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '', batch: '00012',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 4 }], assignments: [],
      }],
    });
    await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'pickup-one',
      lines: [{ itemNumber: 10, quantity: 1 }],
    });
    await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'pickup-two',
      lines: [{ itemNumber: 10, quantity: 1 }],
    });
    const before = await documentCount(client);
    const listed = await listBatchPickup(client, { material: 'MAT-BATCH' });
    expect(listed.readOnly).toBe(true);
    expect(listed.rows.map((row) => row.batch)).toEqual(['00012']);
    expect(listed.rows[0]?.documentCount).toBe(2);
    expect(listed.rows[0]?.plant).toBe('1000');
    expect(listed.uses).toEqual([]);
    const picked = await listBatchPickup(client, { material: 'MAT-BATCH', batch: '00012' });
    expect(picked.uses).toHaveLength(2);
    expect(picked.uses.every((use) => use.batch === '00012' && use.purchaseOrderNumber === order.orderNumber)).toBe(true);
    expect(await documentCount(client)).toBe(before);
  });

  it('refuses a batch that does not stand and a sales document, and writes nothing', async () => {
    const client = await standing('batch-pickup-refuse');
    const before = await documentCount(client);
    await expect(listBatchPickup(client, { batch: 'MISSING' })).rejects.toBeInstanceOf(BatchPickupError);
    await expect(listBatchPickup(client, { material: 'MAT-BATCH', salesOrder: 'SO-1' })).rejects.toThrow(/sales order/i);
    await expect(listBatchPickup(client, {})).rejects.toThrow(/Name a material or a batch/);
    expect(await documentCount(client)).toBe(before);
  });
});
