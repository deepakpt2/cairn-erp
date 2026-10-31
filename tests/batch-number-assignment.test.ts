import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import {
  assignedGoodsReceiptDecision, getInternalBatchAssignment, listAssignedReceiptSettings, productionBatchAssignment, saveAssignedReceipt, saveInternalBatchAssignment, } from '../src/modules/inventory/batch-number-assignment';
import { createBatch } from '../src/modules/inventory/batch-master';
import { getReceiptOrder } from '../src/modules/inventory/goods-receipt';
import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { createOrder } from '../src/modules/purchasing/orders';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'OMCZ_TEST';
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

async function material(client: string, materialNumber: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
    values (${client}, ${materialNumber}, ${materialNumber}, 'RAW', 'PC', true, ${ACTOR})
    on conflict (client, material_number) do update set batch_managed = true
  `));
}

async function interval(client: string, to = 9999999999) {
  await withTenant(client, (tx) => defineRange(tx, {
    client,
    objectCode: 'BATCH_CLT',
    companyCode: '*',
    subObject: '01',
    fiscalYear: 0,
    prefix: '',
    fromNumber: 1,
    toNumber: to,
    numberLength: 10,
    displayStyle: 'CLASSIC',
    isExternal: false,
    createdBy: ACTOR,
  }));
}

async function currentNumber(client: string): Promise<number | null> {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select current_number::text as current_number
    from number_range
    where client = ${client} and object_code = 'BATCH_CLT' and sub_object = '01'
  `)) as unknown as Array<{ current_number: string }>;
  return rows[0] ? Number(rows[0].current_number) : null;
}

describe('OMCZ internal batch number assignment', () => {
  it('is not active until saved, and does not create a number range or a batch', async () => {
    const client = await tenant('omcz-pack-alpha-1');
    const opened = await getInternalBatchAssignment(client);
    expect(opened.code).toBeNull();
    expect(opened.version).toBe(0);
    expect(opened.range.defined).toBe(false);

    await withTenant(client, (tx) => tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, 'CFG.INV.BATCHNUMBER.DEFINE', 'NOT_STARTED', ${ACTOR})
      on conflict do nothing
    `));
    const saved = await saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: 'X', version: 0, reason: 'Activate numbering', requestKey: 'omcz-1',
    });
    expect(saved.code).toBe('X');
    expect(saved.version).toBe(1);
    expect(saved.range.defined).toBe(false);
    const stored = await withTenant(client, (tx) => tx.execute(sql`
      select internal_assignment, pg_typeof(internal_assignment) as stored_type
      from batch_number_assignment where client = ${client}
    `)) as unknown as Array<{ internal_assignment: string; stored_type: string }>;
    expect(stored[0]?.internal_assignment).toBe('X');
    expect(stored[0]?.stored_type).toBe('character');
    const batches = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from batch where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(Number(batches[0]?.n)).toBe(0);
    const history = await withTenant(client, (tx) => changeHistory(tx, client, 'batch_number_assignment', client));
    expect(history.map((row) => row.changeType)).toContain('CREATE');

    await expect(saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: '1', version: 1, reason: 'Wrong code',
    })).rejects.toMatchObject({ code: 'CODE_UNKNOWN' });
    await expect(saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: ' ', version: 1, reason: 'Transport', transportRequest: 'DEVK900001',
    })).rejects.toMatchObject({ code: 'TRANSPORT_REFUSED' });
    await expect(saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: 'X', version: 1, reason: 'Range', batchNumberRange: '01',
    })).rejects.toMatchObject({ code: 'RANGE_REFUSED' });
    await expect(saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: 'X', version: 9, reason: 'Stale',
    })).rejects.toMatchObject({ code: 'VERSION_STALE' });
    const still = await getInternalBatchAssignment(client);
    expect(still.code).toBe('X');
    expect(still.version).toBe(1);
  });

  it('stores the plant flag apart from the client flag and rejects another client plant', async () => {
    const client = await tenant('omcz-pack-bravo-1');
    const other = await tenant('omcz-pack-charlie-1');
    await withTenant(other, (tx) => tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      values (${other}, '2000', 'Other plant', 'KW', ${ACTOR})
    `));
    const listed = await listAssignedReceiptSettings(client);
    expect(listed.some((row) => row.plant === '1000')).toBe(true);
    expect(listed.every((row) => row.code === null)).toBe(true);
    expect(listed.some((row) => row.plant === '2000')).toBe(false);

    const saved = await saveAssignedReceipt({
      client, changedBy: ACTOR, plant: '1000', assignedReceipt: 'X', version: 0, reason: 'Permit assigned receipt',
    });
    expect(saved.code).toBe('X');
    expect(saved.name.length).toBeGreaterThan(0);
    expect((await getInternalBatchAssignment(client)).code).toBeNull();

    await expect(saveAssignedReceipt({
      client, changedBy: ACTOR, plant: '2000', assignedReceipt: 'X', version: 0, reason: 'Cross tenant',
    })).rejects.toMatchObject({ code: 'PLANT_UNKNOWN' });
    await expect(saveAssignedReceipt({
      client, changedBy: ACTOR, plant: '1000', assignedReceipt: ' ', version: 4, reason: 'Stale plant',
    })).rejects.toMatchObject({ code: 'VERSION_STALE' });
    expect((await listAssignedReceiptSettings(client)).find((row) => row.plant === '1000')?.code).toBe('X');
  });

  it('draws an internal number only when active, and keeps a typed number', async () => {
    const client = await tenant('omcz-pack-delta-4');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await material(client, 'MAT-A');
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', reason: 'No number',
    })).rejects.toThrow(/OMCZ/);
    expect(await currentNumber(client)).toBeNull();

    await saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: 'X', version: 0, reason: 'Activate numbering',
    });
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', reason: 'No range',
    })).rejects.toMatchObject({ code: 'RANGE_UNAVAILABLE' });
    expect(await currentNumber(client)).toBeNull();

    await interval(client);
    const typed = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', reason: 'Typed number',
    });
    expect(typed.batchNumber).toBe('B1');
    expect(await currentNumber(client)).toBe(0);

    const first = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', reason: 'Internal one',
    });
    const second = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', reason: 'Internal two',
    });
    expect(first.batchNumber).toBe('0000000001');
    expect(second.batchNumber).toBe('0000000002');
    expect(await currentNumber(client)).toBe(2);

    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', countryOfOrigin: 'ZZ', reason: 'Bad country',
    })).rejects.toMatchObject({ code: 'COUNTRY_UNKNOWN' });
    expect(await currentNumber(client)).toBe(2);
  });

  it('does not consume a number when the batch cannot be stored, and stops when the interval is exhausted', async () => {
    const client = await tenant('omcz-pack-echo-1');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await material(client, 'MAT-A');
    await saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: 'X', version: 0, reason: 'Activate numbering',
    });
    await interval(client, 1);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into batch (
        id, client, batch_number, material_number, batch_level_at_creation, version, created_by, changed_by
      ) values (
        gen_random_uuid()::text, ${client}, '0000000001', 'MAT-A', '1', 1, ${ACTOR}, ${ACTOR}
      )
    `));
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', reason: 'Collides and rolls back',
    })).rejects.toMatchObject({ code: 'BATCH_DUPLICATE' });
    expect(await currentNumber(client)).toBe(0);

    await withTenant(client, (tx) => tx.execute(sql`
      delete from batch where client = ${client} and batch_number = '0000000001'
    `));
    const only = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', reason: 'Last number',
    });
    expect(only.batchNumber).toBe('0000000001');
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', reason: 'Exhausted',
    })).rejects.toMatchObject({ code: 'RANGE_UNAVAILABLE' });
    const count = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from batch where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(Number(count[0]?.n)).toBe(1);
  });

  it('allocates two different numbers under concurrent creates', async () => {
    const client = await tenant('omcz-pack-foxtrot-1');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await material(client, 'MAT-A');
    await saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: 'X', version: 0, reason: 'Activate numbering',
    });
    await interval(client);
    const [left, right] = await Promise.all([
      createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', reason: 'Left', requestKey: 'left' }),
      createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', reason: 'Right', requestKey: 'right' }),
    ]);
    expect(new Set([left.batchNumber, right.batchNumber]).size).toBe(2);
    expect(await currentNumber(client)).toBe(2);
  });

  it('does not create a batch on a stock receipt, and does not post an account-assigned receipt', async () => {
    expect(assignedGoodsReceiptDecision({ internalActive: true, plantPermitted: true, accountAssigned: false }).assign).toBe(false);
    expect(assignedGoodsReceiptDecision({ internalActive: false, plantPermitted: true, accountAssigned: true }).assign).toBe(false);
    expect(assignedGoodsReceiptDecision({ internalActive: true, plantPermitted: false, accountAssigned: true }).assign).toBe(false);
    expect(assignedGoodsReceiptDecision({ internalActive: true, plantPermitted: true, accountAssigned: true }).assign).toBe(true);

    const client = await tenant('omcz-pack-golf-1');
    await defineTestRanges({ client, companyCode: '1000' }, { fiscalYear: 2026 });
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
        values (${client}, 'MAT-BATCH', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, created_by
        ) values (${client}, 'MAT-BATCH', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
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
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'OMCZ receipt',
    });
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: 'X', version: 0, reason: 'Activate numbering',
    });
    await saveAssignedReceipt({
      client, changedBy: ACTOR, plant: '1000', assignedReceipt: 'X', version: 0, reason: 'Permit assigned receipt',
    });
    await interval(client);
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Standing batch' });
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 1, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001', batch: '00012',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 1 }], assignments: [],
      }],
    });
    const posted = await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-10-18', postingDate: '2026-10-18', requestKey: 'omcz-gr',
      lines: [{ itemNumber: 10, quantity: 1, storageLocation: '0001' }],
    });
    expect(posted.lines[0]?.batch).toBe('00012');
    expect(await currentNumber(client)).toBe(0);

    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchase_order (
        client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by
      ) values (
        ${client}, 'PO-ASSIGNED', 'V10000', '1000', '001', '1000', 'USD', '2026-10-18', ${ACTOR}
      )
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into purchase_order_item (
        client, order_number, item_number, short_text, quantity, unit, net_price, net_value, plant,
        material_number, account_assignment_category, created_by
      ) values (
        ${client}, 'PO-ASSIGNED', 10, 'Assigned', 1, 'PC', 10, 10, '1000', 'MAT-BATCH', 'COST_CENTER', ${ACTOR}
      )
    `));
    const view = await getReceiptOrder(client, 'PO-ASSIGNED');
    expect(view?.items[0]?.refusal).toMatch(/later round/);
    expect(view?.items[0]?.eligible).toBe(false);
    const before = await currentNumber(client);
    await expect(postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: 'PO-ASSIGNED',
      documentDate: '2026-10-18', postingDate: '2026-10-18', requestKey: 'omcz-assigned',
      lines: [{ itemNumber: 10, quantity: 1, storageLocation: '0001' }],
    })).rejects.toThrow(/later round/);
    expect(await currentNumber(client)).toBe(before);
  });

  it('does not create a batch for a production order when internal assignment is active', async () => {
    const client = await tenant('omcz-pack-hotel-1');
    await saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: 'X', version: 0, reason: 'Activate numbering',
    });
    const timing = await withTenant(client, (tx) => productionBatchAssignment(tx, client));
    expect(timing.timing).toBe('NONE');
    expect(timing.internalActive).toBe(true);
    expect(timing.reason).toMatch(/OPKP/);
    const source = readFileSync('src/modules/inventory/production-orders.ts', 'utf8');
    expect(source).toContain('readMaterialSchedulingProfile');
    expect(source).not.toContain('allocateInternalBatchNumber');
  });

  it('refuses an unauthorized configuration change at the action', () => {
    const action = readFileSync('src/app/config/batch-number-assignment/actions.ts', 'utf8');
    expect(action).toContain('requireCapability(ACTIVITY)');
    expect(action.match(/requireCapability\(ACTIVITY\)/g)).toHaveLength(2);
    expect(readFileSync('src/modules/inventory/goods-receipt.ts', 'utf8')).toContain('readAssignedGoodsReceiptDecision');
    expect(readFileSync('src/modules/inventory/goods-receipt.ts', 'utf8')).not.toContain('allocateInternalBatchNumber');
  });
});

