import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { createBatch } from '../src/modules/inventory/batch-master';
import { postTransfer } from '../src/modules/inventory/transfer-posting';
import {
  MaterialReversalError,
  getReversalDocument,
  reverseMaterialDocument,
} from '../src/modules/inventory/material-document-reversal';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'REVERSAL_BATCH_TEST';
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
      values (${client}, '1000', '0001', 'Main store', false, true, ${ACTOR}),
             (${client}, '1000', '0002', 'Second store', false, true, ${ACTOR})
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
      values (${client}, 'MAT-BATCH', 'Batch material', 'RAW', 'PC', true, ${ACTOR})
      on conflict (client, material_number) do update set batch_managed = true
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MAT-BATCH', '1000', ${ACTOR})
      on conflict do nothing
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
    client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Reversal batch',
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Receipt batch' });
  await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00013', reason: 'Other batch' });
  return client;
}

function item(batch: string, quantity: number) {
  return {
    materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity, unit: 'PC',
    netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001', batch,
    markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity }], assignments: [],
  };
}

async function bothBatches(client: string, requestKey: string) {
  const order = await createOrder({
    client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
    companyCode: '1000', currency: '',
    items: [item('00012', 3), item('00013', 2)],
  });
  return postGoodsReceipt({
    client, changedBy: ACTOR, orderNumber: order.orderNumber,
    documentDate: DAY, postingDate: DAY, requestKey,
    lines: [
      { itemNumber: 10, quantity: 3, storageLocation: '0001', batch: '00012' },
      { itemNumber: 20, quantity: 2, storageLocation: '0001', batch: '00013' },
    ],
  });
}

async function stock(client: string, location: string, batch: string): Promise<number> {
  const rows = await withTenant(client, async (tx) => tx.execute(sql`
    select quantity::text as quantity from stock_quantity
     where client = ${client} and material_number = 'MAT-BATCH'
       and plant = '1000' and storage_location = ${location}
       and stock_type = 'UNRESTRICTED' and batch_number = ${batch}
  `)) as unknown as Array<{ quantity: string }>;
  return Number(rows[0]?.quantity ?? 0);
}

async function documents(client: string): Promise<number> {
  const rows = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from material_document where client = ${client}
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

describe('reversal of one batch', () => {
  it('takes that batch back and leaves the other batch where it stands', async () => {
    const client = await standing('reversal-batch');
    const receipt = await bothBatches(client, 'reversal-batch-gr');
    expect(receipt.lines.map((line) => line.batch)).toEqual(['00012', '00013']);
    const open = await getReversalDocument(client, receipt.materialDocumentNumber);
    expect(open?.lines.map((line) => line.batch)).toEqual(['00012', '00013']);

    const reversal = await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: receipt.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: 'reversal-batch-rev',
    });
    expect(reversal.lines.map((line) => line.batch)).toEqual(['00012', '00013']);
    expect(await stock(client, '0001', '00012')).toBe(0);
    expect(await stock(client, '0001', '00013')).toBe(0);
  });

  it('refuses the short batch by name and does not take the other batch', async () => {
    const client = await standing('reversal-batch-short');
    const receipt = await bothBatches(client, 'reversal-batch-short-gr');
    await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311', materialNumber: 'MAT-BATCH', quantity: 3,
      issuingPlant: '1000', issuingStorageLocation: '0001',
      receivingPlant: '1000', receivingStorageLocation: '0002',
      postingDate: DAY, documentDate: DAY, batch: '00012', requestKey: 'reversal-batch-short-move',
    });
    const before = await documents(client);
    let words = '';
    try {
      await reverseMaterialDocument({
        client, changedBy: ACTOR, materialDocumentNumber: receipt.materialDocumentNumber,
        postingDate: DAY, documentDate: DAY, requestKey: 'reversal-batch-short-rev',
      });
    } catch (caught) {
      words = caught instanceof MaterialReversalError ? caught.message : String(caught);
    }
    expect(words).toMatch(/batch 00012/);
    expect(words).toMatch(/short of the 3\.000/);
    expect(words).not.toMatch(/00013/);
    expect(await documents(client)).toBe(before);
    expect(await stock(client, '0001', '00013')).toBe(2);
    expect(await stock(client, '0002', '00012')).toBe(3);
  });
});
