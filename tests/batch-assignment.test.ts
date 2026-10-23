import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder, getOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { createBatch } from '../src/modules/inventory/batch-master';
import { createProductionOrder } from '../src/modules/inventory/production-orders';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'BATCH_ASSIGN_TEST';
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
    await defineRange(tx, { client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
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
      values (${client}, 'MAT-BATCH', 'Batch material', 'RAW', 'PC', true, ${ACTOR}),
             (${client}, 'MAT-PLAIN', 'Plain material', 'RAW', 'PC', false, ${ACTOR})
      on conflict (client, material_number) do update set batch_managed = excluded.batch_managed
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MAT-BATCH', '1000', ${ACTOR}),
             (${client}, 'MAT-PLAIN', '1000', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency, created_by
      ) values (${client}, 'MAT-BATCH', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR}),
               (${client}, 'MAT-PLAIN', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
             (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR})
      on conflict do nothing
    `);
  });
  await initializeMaterialPeriodControl({
    client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Batch assignment',
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  return client;
}

describe('batch assigned on the order', () => {
  it('stores a standing batch on the purchase item and receives it when the line leaves the batch blank', async () => {
    const client = await standing('batch-assign-po');
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Order batch',
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
    const saved = await getOrder(client, order.orderNumber);
    expect(saved?.items[0]?.batch).toBe('00012');
    const posted = await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'order-batch',
      lines: [{ itemNumber: 10, quantity: 2 }],
    });
    expect(posted.lines[0]?.batch).toBe('00012');
  });

  it('refuses a purchase batch that does not stand and a batch on a material that is not batch-managed', async () => {
    const client = await standing('batch-assign-refuse');
    await expect(createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 1, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '', batch: 'MISSING',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 1 }], assignments: [],
      }],
    })).rejects.toThrow(/does not stand/i);
    await expect(createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-PLAIN', shortText: 'Plain material', quantity: 1, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '', batch: '00012',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 1 }], assignments: [],
      }],
    })).rejects.toThrow(/not batch-managed/i);
  });

  it('stores a standing finished-good batch on the production order and refuses one that does not stand', async () => {
    const client = await standing('batch-assign-prod');
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Output batch',
    });
    const order = await createProductionOrder({
      client, createdBy: ACTOR, materialNumber: 'MAT-BATCH', plant: '1000', orderQuantity: 4,
      scheduledStart: '2026-10-18', scheduledFinish: '2026-10-20', batch: '00012',
      components: [{ materialNumber: 'MAT-PLAIN', plant: '1000', requiredQuantity: 1 }],
    });
    expect(order.batch).toBe('00012');
    await expect(createProductionOrder({
      client, createdBy: ACTOR, materialNumber: 'MAT-BATCH', plant: '1000', orderQuantity: 1,
      scheduledStart: '2026-10-18', scheduledFinish: '2026-10-20', batch: 'MISSING',
      components: [{ materialNumber: 'MAT-PLAIN', plant: '1000', requiredQuantity: 1 }],
    })).rejects.toThrow(/does not stand/i);
    await expect(createProductionOrder({
      client, createdBy: ACTOR, materialNumber: 'MAT-PLAIN', plant: '1000', orderQuantity: 1,
      scheduledStart: '2026-10-18', scheduledFinish: '2026-10-20', batch: '00012',
      components: [{ materialNumber: 'MAT-PLAIN', plant: '1000', requiredQuantity: 1 }],
    })).rejects.toThrow(/not batch-managed/i);
  });
});
