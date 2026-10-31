import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { createBatch } from '../src/modules/inventory/batch-master';
import { getReturnableDocument, postReturnDelivery } from '../src/modules/inventory/return-delivery';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'RETURN_BATCH_TEST';
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
             (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
             (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '300000', ${ACTOR})
      on conflict do nothing
    `);
  });
  await initializeMaterialPeriodControl({
    client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Return batch',
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  return client;
}

async function stock(client: string, batch: string): Promise<string | undefined> {
  const rows = await withTenant(client, async (tx) => tx.execute(sql`
    select quantity::text as quantity from stock_quantity
     where client = ${client} and material_number = 'MAT-BATCH' and batch_number = ${batch}
  `)) as unknown as Array<{ quantity: string }>;
  return rows[0]?.quantity;
}

async function documentCount(client: string): Promise<number> {
  const rows = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from material_document where client = ${client}
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

describe('return of a receipt batch', () => {
  it('returns the receipt batch and refuses a different one', async () => {
    const client = await standing('return-batch');
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Receipt batch' });
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00013', reason: 'Other batch' });
    const kept = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 2, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001', batch: '00013',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 2 }], assignments: [],
      }],
    });
    await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: kept.orderNumber, ...POSTING, requestKey: 'return-batch-keep',
      lines: [{ itemNumber: 10, quantity: 2, storageLocation: '0001' }],
    });
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 4, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001', batch: '00012',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 4 }], assignments: [],
      }],
    });
    const receipt = await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'return-batch-receipt',
      lines: [{ itemNumber: 10, quantity: 4, storageLocation: '0001' }],
    });
    const opened = await getReturnableDocument(client, { documentNumber: receipt.materialDocumentNumber });
    expect(opened?.items[0]?.batch).toBe('00012');

    const returned = await postReturnDelivery({
      client, changedBy: ACTOR, documentNumber: receipt.materialDocumentNumber,
      ...POSTING, requestKey: 'return-batch-post', lines: [{ originalLine: 1, quantity: 1 }],
    });
    const postedBatch = await withTenant(client, async (tx) => tx.execute(sql`
      select batch_number from material_document_line
       where client = ${client} and material_document_number = ${returned.materialDocumentNumber}
    `)) as unknown as Array<{ batch_number: string }>;
    expect(postedBatch[0]?.batch_number).toBe('00012');
    expect(Number(await stock(client, '00012'))).toBe(3);
    expect(Number(await stock(client, '00013'))).toBe(2);

    const confirmed = await postReturnDelivery({
      client, changedBy: ACTOR, documentNumber: receipt.materialDocumentNumber,
      ...POSTING, requestKey: 'return-batch-same', batch: '00012', lines: [{ originalLine: 1, quantity: 1 }],
    });
    expect(confirmed.materialDocumentNumber).not.toBe(returned.materialDocumentNumber);
    expect(Number(await stock(client, '00012'))).toBe(2);

    const before = await documentCount(client);
    await expect(postReturnDelivery({
      client, changedBy: ACTOR, documentNumber: receipt.materialDocumentNumber,
      ...POSTING, requestKey: 'return-batch-other', batch: '00013', lines: [{ originalLine: 1, quantity: 1 }],
    })).rejects.toThrow(/does not change it/);
    expect(await documentCount(client)).toBe(before);
    expect(Number(await stock(client, '00012'))).toBe(2);
    expect(Number(await stock(client, '00013'))).toBe(2);
  });
});
