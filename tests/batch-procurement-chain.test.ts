import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { displayPurchaseOrder } from '../src/modules/purchasing/purchase-order-display';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { createBatch } from '../src/modules/inventory/batch-master';
import { postTransfer } from '../src/modules/inventory/transfer-posting';
import { stockOverview } from '../src/modules/inventory/stock-overview';
import { listWarehouseStocks } from '../src/modules/inventory/warehouse-stocks';
import { stockOnPostingDate } from '../src/modules/inventory/stock-posting-date';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'BATCH_CHAIN_TEST';
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
    client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Batch chain',
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Chain batch' });
  await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00013', reason: 'Other batch' });
  return { client, currency: tenant.currency };
}

function item(batch: string, quantity: number) {
  return {
    materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity, unit: 'PC',
    netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001', batch,
    markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity }], assignments: [],
  };
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

async function valuation(client: string): Promise<{ quantity: number; value: number }> {
  const rows = await withTenant(client, async (tx) => tx.execute(sql`
    select total_stock_quantity::text as quantity, stock_value::text as value
      from material_valuation
     where client = ${client} and material_number = 'MAT-BATCH' and valuation_area = '1000'
  `)) as unknown as Array<{ quantity: string; value: string }>;
  return { quantity: Number(rows[0]?.quantity ?? 0), value: Number(rows[0]?.value ?? 0) };
}

describe('one procurement and transfer batch chain', () => {
  it('posts one standing batch and keeps the stock and value balance off the other batch', async () => {
    const { client, currency } = await standing('batch-chain');
    const other = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [item('00013', 2)],
    });
    await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: other.orderNumber,
      documentDate: DAY, postingDate: DAY, requestKey: 'chain-other',
      lines: [{ itemNumber: 10, quantity: 2, storageLocation: '0001' }],
    });

    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [item('00012', 4)],
    });
    const shown = await displayPurchaseOrder(client, order.orderNumber);
    expect(shown.found).toBe(true);
    if (!shown.found) return;
    expect(shown.order.items[0]?.batch).toBe('00012');

    const receipt = await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: DAY, postingDate: DAY, requestKey: 'chain-receipt',
      lines: [{ itemNumber: 10, quantity: 1, storageLocation: '0001' }],
    });
    expect(receipt.lines.map((line) => line.batch)).toEqual(['00012']);
    expect(await stock(client, '0001', '00012')).toBe(1);
    expect(await stock(client, '0001', '00013')).toBe(2);
    expect(await valuation(client)).toEqual({ quantity: 3, value: 30 });

    const journal = await withTenant(client, async (tx) => tx.execute(sql`
      select debit_credit, amount_local::text as amount from journal_entry_line
       where client = ${client} and document_number = ${receipt.journalDocumentNumber}
    `)) as unknown as Array<{ debit_credit: string; amount: string }>;
    const debit = journal.filter((line) => line.debit_credit === 'S').reduce((sum, line) => sum + Number(line.amount), 0);
    const credit = journal.filter((line) => line.debit_credit === 'H').reduce((sum, line) => sum + Number(line.amount), 0);
    expect(debit).toBe(10);
    expect(credit).toBe(10);

    const moved = await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311', materialNumber: 'MAT-BATCH', quantity: 1,
      issuingPlant: '1000', issuingStorageLocation: '0001',
      receivingPlant: '1000', receivingStorageLocation: '0002',
      postingDate: DAY, documentDate: DAY, batch: '00012', requestKey: 'chain-transfer',
    });
    expect(moved.lines.map((line) => line.batch)).toEqual(['00012', '00012']);
    expect(await stock(client, '0001', '00012')).toBe(0);
    expect(await stock(client, '0002', '00012')).toBe(1);
    expect(await stock(client, '0001', '00013')).toBe(2);
    expect(await valuation(client)).toEqual({ quantity: 3, value: 30 });

    const overview = await stockOverview({
      client, selection: { material: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000', batch: '00012' },
    });
    expect(overview.totalQuantity).toBe(1);
    const warehouse = await listWarehouseStocks({
      client, localCurrency: currency,
      selection: { materialFrom: 'MAT-BATCH', materialTo: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000' },
    });
    expect(warehouse.rows.map((row) => [row.storageLocation, row.batch, row.totalQuantity])).toEqual([
      ['0001', '00013', 2],
      ['0002', '00012', 1],
    ]);
    const rollforward = await stockOnPostingDate({
      client,
      selection: {
        materialFrom: 'MAT-BATCH', materialTo: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000',
        dateFrom: '2026-10-01', dateTo: '2026-10-31', displayZero: true,
      },
    });
    expect(rollforward.rows.map((row) => [row.storageLocation, row.batch, row.receiptQuantity, row.issueQuantity, row.closingQuantity])).toEqual([
      ['0001', '00012', 1, 1, 0],
      ['0001', '00013', 2, 0, 2],
      ['0002', '00012', 1, 0, 1],
    ]);
    expect(rollforward.warnings.join(' ')).not.toMatch(/differs from the stock master/);
  });
});
