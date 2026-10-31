import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';

import { reverseGoodsReceipt, postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { postTransfer, reverseTransfer } from '../src/modules/inventory/transfer-posting';
import { stockOverview } from '../src/modules/inventory/stock-overview';
import { listWarehouseStocks } from '../src/modules/inventory/warehouse-stocks';
import { stockOnPostingDate } from '../src/modules/inventory/stock-posting-date';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { saveBatchStatus } from '../src/modules/inventory/batch-status';
import { createBatch } from '../src/modules/inventory/batch-master';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'BATCH_POST_TEST';
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
      on conflict (client, material_number) do update set batch_managed = true
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
    client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Batch posting',
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  return client;
}

describe('batch on goods receipt', () => {
  it('posts stock on the standing batch and not on the blank balance', async () => {
    const client = await standing('batch-post-receipt');
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Receipt batch',
    });
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 4, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 4 }], assignments: [],
      }],
    });
    await expect(postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'no-batch',
      lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow(/batch is required/i);
    const posted = await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'with-batch',
      lines: [{ itemNumber: 10, quantity: 2, batch: '00012' }],
    });
    expect(posted.lines[0]?.batch).toBe('00012');
    const stock = await withTenant(client, (tx) => tx.execute(sql`
      select batch_number, quantity::text as quantity from stock_quantity
      where client = ${client} and material_number = 'MAT-BATCH'
      order by batch_number
    `)) as unknown as Array<{ batch_number: string; quantity: string }>;
    expect(stock).toEqual([{ batch_number: '00012', quantity: '2.000' }]);
    const reversed = await reverseGoodsReceipt({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      documentDate: POSTING.documentDate, postingDate: POSTING.postingDate, requestKey: 'reverse-batch',
    });
    expect(reversed.lines[0]?.batch).toBe('00012');
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select batch_number, quantity::text as quantity from stock_quantity
      where client = ${client} and material_number = 'MAT-BATCH' and quantity <> 0
    `)) as unknown as Array<{ batch_number: string; quantity: string }>;
    expect(after).toEqual([]);
  });

  it('refuses an expired batch and accepts one that expires on the posting date', async () => {
    const client = await standing('batch-post-expiry');
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: 'OLD1',
      shelfLifeExpirationDate: '2026-10-17', reason: 'Expired batch',
    });
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: 'DAY1',
      shelfLifeExpirationDate: '2026-10-18', reason: 'Expires on the posting date',
    });
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 4, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 4 }], assignments: [],
      }],
    });
    await expect(postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'expired',
      lines: [{ itemNumber: 10, quantity: 1, batch: 'OLD1' }],
    })).rejects.toThrow(/expired on 2026-10-17/);
    const posted = await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'same-day',
      lines: [{ itemNumber: 10, quantity: 1, batch: 'DAY1' }],
    });
    expect(posted.lines[0]?.batch).toBe('DAY1');
    const stock = await withTenant(client, (tx) => tx.execute(sql`
      select batch_number, quantity::text as quantity from stock_quantity
      where client = ${client} and material_number = 'MAT-BATCH' and quantity <> 0
    `)) as unknown as Array<{ batch_number: string; quantity: string }>;
    expect(stock).toEqual([{ batch_number: 'DAY1', quantity: '1.000' }]);
  });

  it('refuses a missing batch, a restricted batch, and a batch on a material that is not batch-managed', async () => {
    const client = await standing('batch-post-refuse');
    await saveBatchStatus({ client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate status' });
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: 'S1', restrictedUse: 'X', reason: 'Restricted',
    });
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 2, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 2 }], assignments: [],
      }],
    });
    await expect(postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'missing',
      lines: [{ itemNumber: 10, quantity: 1, batch: 'NONE' }],
    })).rejects.toThrow(/does not stand/);
    await expect(postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'restricted',
      lines: [{ itemNumber: 10, quantity: 1, batch: 'S1' }],
    })).rejects.toThrow(/restricted/);
    await withTenant(client, (tx) => tx.execute(sql`
      update material set batch_managed = false where client = ${client} and material_number = 'MAT-BATCH'
    `));
    await expect(postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'plain',
      lines: [{ itemNumber: 10, quantity: 1, batch: 'S1' }],
    })).rejects.toThrow(/not batch-managed/);
  });
});

describe('batch on goods issue', () => {
  it('issues only the standing batch and leaves the blank balance alone', async () => {
    const tenant = await createTenant('batch-issue');
    clients.push(tenant.client);
    const client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    const area = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select controlling_area from controlling_area where client = ${client} order by controlling_area limit 1
      `) as unknown as Array<{ controlling_area: string }>;
      return rows[0]?.controlling_area ?? 'A000';
    });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '1000', 'Issue plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, '1000', '0001', 'Main store', true, false, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
        values (${client}, 'GI-BATCH', 'Issued batch', 'RAW', 'PC', true, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${client}, 'GI-BATCH', '1000', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${client}, 'GI-BATCH', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'KWD', 8, 80, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by)
        values (${client}, 'GI-BATCH', '1000', '0001', 'UNRESTRICTED', '', 5, ${ACTOR}),
               (${client}, 'GI-BATCH', '1000', '0001', 'UNRESTRICTED', '00012', 3, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into controlling_area_company (client, controlling_area, company_code, created_by)
        values (${client}, ${area}, '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
        values (${client}, ${area}, 'CC1100', '2026-01-01', '2026-12-31', 'Line centre', 'PRODUCTION', '1000', false, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
        select ${client}, c.chart_of_accounts, v.n, v.d, v.t, v.bs, false, null, v.cost, false, 'GENL', v.kind, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values
          ('510100', 'Consumption expense', 'EXPENSE', false, true, 'PL_STATEMENT'),
          ('120000', 'Raw materials inventory', 'ASSET', true, false, 'BALANCE_SHEET')
        ) as v(n, d, t, bs, cost, kind)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', '', v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values ('CONSUMPTION', '510100'), ('INVENTORY', '120000')) as v(e, a)
        on conflict do nothing
      `);
    });
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'GI-BATCH', batchNumber: '00012', reason: 'Issue batch' });
    await expect(postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', ...POSTING, requestKey: 'issue-blank',
      lines: [{ materialNumber: 'GI-BATCH', plant: '1000', storageLocation: '0001', quantity: 1, costCenter: 'CC1100' }],
    })).rejects.toThrow(/batch is required/i);
    await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '201', ...POSTING, requestKey: 'issue-batch',
      lines: [{ materialNumber: 'GI-BATCH', plant: '1000', storageLocation: '0001', quantity: 2, costCenter: 'CC1100', batch: '00012' }],
    });
    const stock = await withTenant(client, (tx) => tx.execute(sql`
      select batch_number, quantity::text as quantity from stock_quantity
      where client = ${client} and material_number = 'GI-BATCH'
      order by batch_number
    `)) as unknown as Array<{ batch_number: string; quantity: string }>;
    expect(stock).toEqual([
      { batch_number: '', quantity: '5.000' },
      { batch_number: '00012', quantity: '1.000' },
    ]);
  });
});

describe('batch on transfer and stock overview', () => {
  it('moves only the standing batch and shows that batch on MMBE', async () => {
    const tenant = await createTenant('batch-transfer');
    clients.push(tenant.client);
    const client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '1000', 'Transfer plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, '1000', '0001', 'Main store', true, false, ${ACTOR}),
               (${client}, '1000', '0002', 'Second store', true, false, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
        values (${client}, 'TR-BATCH', 'Transfer batch', 'RAW', 'PC', true, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${client}, 'TR-BATCH', '1000', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency, created_by)
        values (${client}, 'TR-BATCH', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'KWD', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by)
        values (${client}, 'TR-BATCH', '1000', '0001', 'UNRESTRICTED', '', 4, ${ACTOR}),
               (${client}, 'TR-BATCH', '1000', '0001', 'UNRESTRICTED', '00012', 6, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR}) on conflict do nothing
      `);
    });
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'TR-BATCH', batchNumber: '00012', reason: 'Transfer batch' });
    await expect(postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311', materialNumber: 'TR-BATCH', quantity: 1,
      issuingPlant: '1000', issuingStorageLocation: '0001', receivingPlant: '1000', receivingStorageLocation: '0002',
      ...POSTING, requestKey: 'transfer-blank',
    })).rejects.toThrow(/batch is required/i);
    const posted = await postTransfer({
      client, changedBy: ACTOR, movementTypeCode: '311', materialNumber: 'TR-BATCH', quantity: 2, batch: '00012',
      issuingPlant: '1000', issuingStorageLocation: '0001', receivingPlant: '1000', receivingStorageLocation: '0002',
      ...POSTING, requestKey: 'transfer-batch',
    });
    expect(posted.lines.map((line) => line.batch)).toEqual(['00012', '00012']);
    const moved = await withTenant(client, (tx) => tx.execute(sql`
      select storage_location, batch_number, quantity::text as quantity from stock_quantity
      where client = ${client} and material_number = 'TR-BATCH'
      order by storage_location, batch_number
    `)) as unknown as Array<{ storage_location: string; batch_number: string; quantity: string }>;
    expect(moved).toEqual([
      { storage_location: '0001', batch_number: '', quantity: '4.000' },
      { storage_location: '0001', batch_number: '00012', quantity: '4.000' },
      { storage_location: '0002', batch_number: '00012', quantity: '2.000' },
    ]);
    const overview = await stockOverview({ client, selection: { material: 'TR-BATCH', batch: '00012' } });
    expect(overview.totalQuantity).toBe(6);
    const batches = overview.plants.flatMap((plant) => plant.storageLocations.flatMap((location) => location.stockTypes.flatMap((type) => type.batches)));
    expect(batches).toEqual([
      { batch: '00012', quantity: 4 },
      { batch: '00012', quantity: 2 },
    ]);
    await reverseTransfer({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      ...POSTING, requestKey: 'transfer-reverse',
    });
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select storage_location, batch_number, quantity::text as quantity from stock_quantity
      where client = ${client} and material_number = 'TR-BATCH' and quantity <> 0
      order by storage_location, batch_number
    `)) as unknown as Array<{ storage_location: string; batch_number: string; quantity: string }>;
    expect(after).toEqual([
      { storage_location: '0001', batch_number: '', quantity: '4.000' },
      { storage_location: '0001', batch_number: '00012', quantity: '6.000' },
    ]);
  });
});

describe('batch on warehouse stock and posting date', () => {
  it('splits the snapshot and the rollforward by the standing batch', async () => {
    const client = await standing('batch-reports');
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Report batch' });
    await withTenant(client, (tx) => tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by)
      values (${client}, 'MAT-BATCH', '1000', '', 'UNRESTRICTED', '', 5, ${ACTOR})
    `));
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 3, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 3 }], assignments: [],
      }],
    });
    await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING, requestKey: 'report-batch',
      lines: [{ itemNumber: 10, quantity: 3, batch: '00012' }],
    });
    const warehouse = await listWarehouseStocks({
      client, localCurrency: 'USD',
      selection: { materialFrom: 'MAT-BATCH', materialTo: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000' },
    });
    expect(warehouse.rows.map((row) => [row.batch, row.totalQuantity])).toEqual([
      ['', 5],
      ['00012', 3],
    ]);
    const oneBatch = await listWarehouseStocks({
      client, localCurrency: 'USD',
      selection: { materialFrom: 'MAT-BATCH', materialTo: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000', batch: '00012' },
    });
    expect(oneBatch.rows.map((row) => row.batch)).toEqual(['00012']);
    const rollforward = await stockOnPostingDate({
      client,
      selection: {
        materialFrom: 'MAT-BATCH', materialTo: 'MAT-BATCH', plantFrom: '1000', plantTo: '1000',
        dateFrom: '2026-10-01', dateTo: '2026-10-31', batch: '00012',
      },
    });
    expect(rollforward.rows).toHaveLength(1);
    expect(rollforward.rows[0]).toMatchObject({ batch: '00012', receiptQuantity: 3, closingQuantity: 3 });
    expect(rollforward.warnings.join(' ')).not.toMatch(/differs from the stock master/);
  });
});
