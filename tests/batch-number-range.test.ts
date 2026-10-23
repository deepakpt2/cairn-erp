import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import { allocateNumber, defineRange } from '../src/platform/numbering';
import { adjustNumberRangeCurrent } from '../src/modules/foundation/number-ranges';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { saveInternalBatchAssignment } from '../src/modules/inventory/batch-number-assignment';
import {
  ACTIVITY,
  adjustBatchNumberStatus,
  deleteBatchNumberInterval,
  getBatchNumberRanges,
  saveBatchNumberInterval,
} from '../src/modules/inventory/batch-number-range';
import { createBatch } from '../src/modules/inventory/batch-master';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { createOrder } from '../src/modules/purchasing/orders';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'OMAD_TEST';
const AUTH = [ACTIVITY];
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

async function ranges(client: string) {
  return withTenant(client, (tx) => tx.execute(sql`
    select sub_object, from_number::text as from_number, to_number::text as to_number,
           current_number::text as current_number, is_external, is_buffered, status
    from number_range
    where client = ${client} and object_code = 'BATCH_CLT'
    order by sub_object
  `)) as Promise<Array<{
    sub_object: string;
    from_number: string;
    to_number: string;
    current_number: string;
    is_external: boolean;
    is_buffered: boolean;
    status: string;
  }>>;
}

async function batches(client: string): Promise<string[]> {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select batch_number from batch where client = ${client} order by batch_number
  `)) as unknown as Array<{ batch_number: string }>;
  return rows.map((row) => row.batch_number);
}

async function ready(client: string, materialNumber = 'MAT-OMAD') {
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  await saveInternalBatchAssignment({
    client, changedBy: ACTOR, internalAssignment: 'X', version: 0, reason: 'Assign internally',
  });
  await withTenant(client, (tx) => tx.execute(sql`
    insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
    values (${client}, ${materialNumber}, ${materialNumber}, 'RAW', 'PC', true, ${ACTOR})
    on conflict (client, material_number) do update set batch_managed = true
  `));
}

describe('OMAD batch number ranges', () => {
  it('does not create an interval by being opened, and keeps leading zeros on display', async () => {
    const client = await tenant('omad-open-1');
    const opened = await getBatchNumberRanges(client);
    expect(opened.objectCode).toBe('BATCH_CLT');
    expect(opened.intervals).toEqual([]);
    expect(await ranges(client)).toEqual([]);

    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: [], interval: '01', fromNumber: '1', toNumber: '10',
      external: false, mode: 'CREATE', reason: 'No authority',
    })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    expect(await ranges(client)).toEqual([]);

    const saved = await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01',
      fromNumber: '0000000001', toNumber: '0000000010', external: false, mode: 'CREATE', reason: 'Internal interval',
    });
    expect(saved.interval).toBe('01');
    expect(saved.fromNumber).toBe('0000000001');
    expect(saved.toNumber).toBe('0000000010');
    expect(saved.currentDisplay).toBeNull();
    expect(saved.nextDisplay).toBe('0000000001');
    expect(saved.external).toBe(false);
    const stored = await ranges(client);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.from_number).toBe('1');
    expect(stored[0]?.current_number).toBe('0');
    expect(stored[0]?.is_buffered).toBe(false);
    expect(await batches(client)).toEqual([]);

    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '10',
      external: true, mode: 'CREATE', reason: 'External 01',
    })).rejects.toMatchObject({ code: 'ASSIGNMENT_REFUSED' });
    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '02', fromNumber: '20', toNumber: '30',
      external: false, mode: 'CREATE', reason: 'Internal 02',
    })).rejects.toMatchObject({ code: 'ASSIGNMENT_REFUSED' });
    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '03', fromNumber: '10', toNumber: '1',
      external: false, mode: 'CREATE', reason: 'Reversed',
    })).rejects.toMatchObject({ code: 'BOUNDS_INVALID' });
    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '03', fromNumber: '5', toNumber: '15',
      external: false, mode: 'CREATE', reason: 'Overlap',
    })).rejects.toThrow(/overlap/i);
    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '03', fromNumber: '1', toNumber: '5',
      external: false, mode: 'CREATE', reason: 'Buffer', buffered: true,
    })).rejects.toMatchObject({ code: 'BUFFER_REFUSED' });
    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '03', fromNumber: '11', toNumber: '20',
      external: false, mode: 'CREATE', reason: 'Other object', objectCode: 'MATDOC',
    })).rejects.toMatchObject({ code: 'OBJECT_REFUSED' });
    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '03', fromNumber: '11', toNumber: '20',
      external: false, mode: 'CREATE', reason: 'Company', companyCode: '1000',
    })).rejects.toMatchObject({ code: 'COMPANY_REFUSED' });
    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '03', fromNumber: '11', toNumber: '20',
      external: false, mode: 'CREATE', reason: 'Year', fiscalYear: '2026',
    })).rejects.toMatchObject({ code: 'YEAR_REFUSED' });
    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '03', fromNumber: '11', toNumber: '20',
      external: false, mode: 'CREATE', reason: 'Transport', transportRequest: 'DEVK900001',
    })).rejects.toMatchObject({ code: 'TRANSPORT_REFUSED' });
    expect(await ranges(client)).toHaveLength(1);

    const other = await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '03', fromNumber: '11', toNumber: '20',
      external: false, mode: 'CREATE', reason: 'Unused interval',
    });
    expect(other.nextDisplay).toBe('0000000011');
    await deleteBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '03', reason: 'Nothing issued',
    });
    expect((await ranges(client)).map((row) => row.sub_object)).toEqual(['01']);
    const history = await withTenant(client, (tx) => changeHistory(tx, client, 'number_range', 'BATCH_CLT/*/03/0'));
    expect(history.map((row) => row.changeType)).toContain('DELETE');
  });

  it('draws 01 only for a blank number, does not wrap, and will not move the counter backwards', async () => {
    const client = await tenant('omad-issue-1');
    await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '20',
      external: false, mode: 'CREATE', reason: 'Internal interval',
    });
    await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '03', fromNumber: '500', toNumber: '600',
      external: false, mode: 'CREATE', reason: 'Unused internal',
    });
    await ready(client);
    const first = await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-OMAD', reason: 'First internal' });
    expect(first.batchNumber).toBe('0000000001');
    const typed = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-OMAD', batchNumber: '0000000008', reason: 'Typed number',
    });
    expect(typed.batchNumber).toBe('0000000008');
    expect((await ranges(client)).find((row) => row.sub_object === '01')?.current_number).toBe('1');

    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '30',
      external: false, mode: 'CHANGE', expectedTo: '20', expectedCurrent: '0', status: 'ACTIVE', reason: 'Stale',
    })).rejects.toMatchObject({ code: 'VERSION_STALE' });
    expect((await ranges(client)).find((row) => row.sub_object === '01')?.to_number).toBe('20');

    const extended = await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '30',
      external: false, mode: 'CHANGE', expectedTo: '20', expectedCurrent: '1', status: 'ACTIVE', reason: 'Extend',
    });
    expect(extended.toNumber).toBe('0000000030');

    await expect(adjustBatchNumberStatus({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', currentNumber: '0', expectedCurrent: '1', reason: 'Backwards',
    })).rejects.toMatchObject({ code: 'STATUS_BACKWARDS' });
    expect((await ranges(client)).find((row) => row.sub_object === '01')?.current_number).toBe('1');

    await adjustBatchNumberStatus({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', currentNumber: '5', expectedCurrent: '1', reason: 'Skip a gap',
    });
    await expect(saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '4',
      external: false, mode: 'CHANGE', expectedTo: '30', expectedCurrent: '5', status: 'ACTIVE', reason: 'Narrow below issued',
    })).rejects.toThrow(/last issued/i);
    expect((await ranges(client)).find((row) => row.sub_object === '01')?.to_number).toBe('30');
    const next = await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-OMAD', reason: 'After the gap' });
    expect(next.batchNumber).toBe('0000000006');
    expect((await batches(client)).filter((number) => number === '0000000002')).toEqual([]);

    await adjustBatchNumberStatus({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', currentNumber: '30', expectedCurrent: '6', reason: 'Exhaust',
    });
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-OMAD', reason: 'Past the end',
    })).rejects.toThrow(/exhausted/i);
    expect((await ranges(client)).find((row) => row.sub_object === '01')?.current_number).toBe('30');
    const view = await getBatchNumberRanges(client);
    expect(view.intervals.find((row) => row.interval === '01')?.nextDisplay).toBeNull();
    await expect(deleteBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', reason: 'Issued numbers',
    })).rejects.toMatchObject({ code: 'UNSAFE_DELETE' });
  });

  it('refuses allocation from a blocked interval and does not create a batch', async () => {
    const client = await tenant('omad-block-9');
    await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '10',
      external: false, status: 'BLOCKED', mode: 'CREATE', reason: 'Blocked',
    });
    await ready(client);
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-OMAD', reason: 'Blocked range',
    })).rejects.toThrow(/BLOCKED/i);
    expect(await batches(client)).toEqual([]);
    expect((await ranges(client))[0]?.current_number).toBe('0');
  });

  it('judges a typed number against interval 02 only when that interval stands', async () => {
    const client = await tenant('omad-external-1');
    await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '10',
      external: false, mode: 'CREATE', reason: 'Internal',
    });
    const external = await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '02', fromNumber: '100', toNumber: '200',
      external: true, mode: 'CREATE', reason: 'External check',
    });
    expect(external.external).toBe(true);
    expect(external.nextDisplay).toBeNull();
    expect(external.currentDisplay).toBeNull();
    await ready(client);
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-OMAD', batchNumber: 'B1', reason: 'Letter',
    })).rejects.toMatchObject({ code: 'EXTERNAL_REFUSED' });
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-OMAD', batchNumber: '0000000005', reason: 'Outside 02',
    })).rejects.toMatchObject({ code: 'EXTERNAL_REFUSED' });
    const kept = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-OMAD', batchNumber: '0000000150', reason: 'Inside 02',
    });
    expect(kept.batchNumber).toBe('0000000150');
    const stored = await ranges(client);
    expect(stored.find((row) => row.sub_object === '01')?.current_number).toBe('0');
    expect(stored.find((row) => row.sub_object === '02')?.current_number).toBe('99');
    expect(await batches(client)).toEqual(['0000000150']);
    await expect(deleteBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '02', reason: 'Batch stands',
    })).rejects.toMatchObject({ code: 'UNSAFE_DELETE' });

    const open = await tenant('omad-other-9');
    await saveBatchNumberInterval({
      client: open, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '10',
      external: false, mode: 'CREATE', reason: 'Internal only',
    });
    await ready(open, 'MAT-OPEN');
    const letter = await createBatch({
      client: open, changedBy: ACTOR, materialNumber: 'MAT-OPEN', batchNumber: 'B1', reason: 'No external interval',
    });
    expect(letter.batchNumber).toBe('B1');
    expect((await ranges(open)).find((row) => row.sub_object === '01')?.current_number).toBe('0');
    await deleteBatchNumberInterval({
      client: open, changedBy: ACTOR, capabilities: AUTH, interval: '01', reason: 'Letter is not a number',
    });
    expect(await ranges(open)).toEqual([]);
  });

  it('does not show another tenant an interval', async () => {
    const left = await tenant('omad-cross-a');
    const right = await tenant('omad-cross-c');
    await saveBatchNumberInterval({
      client: left, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '10',
      external: false, mode: 'CREATE', reason: 'Left only',
    });
    expect((await getBatchNumberRanges(right)).intervals).toEqual([]);
    await expect(deleteBatchNumberInterval({
      client: right, changedBy: ACTOR, capabilities: AUTH, interval: '01', reason: 'Other tenant',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await ranges(left)).toHaveLength(1);
  });

  it('lets one overlapping create win and refuses the other', async () => {
    const client = await tenant('omad-race-1');
    const attempts = await Promise.allSettled([
      saveBatchNumberInterval({
        client, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '10',
        external: false, mode: 'CREATE', reason: 'First racer',
      }),
      saveBatchNumberInterval({
        client, changedBy: ACTOR, capabilities: AUTH, interval: '04', fromNumber: '5', toNumber: '15',
        external: false, mode: 'CREATE', reason: 'Second racer',
      }),
    ]);
    const saved = attempts.filter((row) => row.status === 'fulfilled');
    const refused = attempts.filter((row) => row.status === 'rejected');
    expect(saved).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(await ranges(client)).toHaveLength(1);
  });

  it('does not allocate a batch number when a goods receipt uses a standing batch', async () => {
    const tenantRow = await createTenant('omad-receipt-9');
    const client = tenantRow.client;
    clients.push(client);
    await defineTestRanges(tenantRow, { fiscalYear: 2026 });
    await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: AUTH, interval: '01', fromNumber: '1', toNumber: '10',
      external: false, mode: 'CREATE', reason: 'Must not be consumed',
    });
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
          standard_price, moving_average_price, price_unit, currency, total_stock_quantity, stock_value, created_by
        ) values (${client}, 'MAT-BATCH', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', 0, 0, ${ACTOR})
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
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Receipt period',
    });
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-BATCH', batchNumber: '00012', reason: 'Standing batch' });
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 2, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001', batch: '00012',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 2 }], assignments: [],
      }],
    });
    const posted = await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-10-18', postingDate: '2026-10-18', requestKey: 'omad-gr-standing',
      lines: [{ itemNumber: 10, quantity: 1, storageLocation: '0001' }],
    });
    expect(posted.lines[0]?.batch).toBe('00012');
    expect((await ranges(client))[0]?.current_number).toBe('0');
    expect(await batches(client)).toEqual(['00012']);

    const blank = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-BATCH', shortText: 'Batch material', quantity: 1, unit: 'PC',
        netPrice: 10, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001',
        markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 1 }], assignments: [],
      }],
    });
    await expect(postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: blank.orderNumber,
      documentDate: '2026-10-18', postingDate: '2026-10-18', requestKey: 'omad-gr-blank',
      lines: [{ itemNumber: 10, quantity: 1, storageLocation: '0001' }],
    })).rejects.toThrow();
    expect((await ranges(client))[0]?.current_number).toBe('0');
    expect(await batches(client)).toEqual(['00012']);
  });

  it('does not take a batch number from a process-local buffer, and leaves the general backwards act alone', async () => {
    const client = await tenant('omad-beta-9');
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'BATCH_CLT', companyCode: '*', subObject: '01', fiscalYear: 0,
        fromNumber: 1, toNumber: 100, numberLength: 10, displayStyle: 'CLASSIC', createdBy: ACTOR,
      });
      await tx.execute(sql`
        update number_range set is_buffered = true, buffer_size = 10
        where client = ${client} and object_code = 'BATCH_CLT' and sub_object = '01'
      `);
    });
    const drawn = await withTenant(client, (tx) => allocateNumber(tx, {
      client, objectCode: 'BATCH_CLT', companyCode: '*', subObject: '01', fiscalYear: 0, allocatedBy: ACTOR,
    }));
    expect(drawn.display).toBe('0000000001');
    expect((await ranges(client))[0]?.current_number).toBe('1');

    const general = await tenant('omad-snro-1');
    await withTenant(general, (tx) => defineRange(tx, {
      client: general, objectCode: 'BATCH_CLT', companyCode: '*', subObject: '01', fiscalYear: 0,
      fromNumber: 1, toNumber: 20, numberLength: 10, displayStyle: 'CLASSIC', createdBy: ACTOR,
    }));
    await withTenant(general, (tx) => tx.execute(sql`
      update number_range set current_number = 4
      where client = ${general} and object_code = 'BATCH_CLT' and sub_object = '01'
    `));
    const moved = await adjustNumberRangeCurrent({
      client: general, changedBy: ACTOR, objectCode: 'BATCH_CLT', companyCode: '*', subObject: '01', fiscalYear: 0,
      currentNumber: 1, reason: 'The general screen still warns and saves',
    });
    expect(moved.changed).toBe(true);
    expect(moved.wouldRepeat).toBe(false);
    expect((await ranges(general))[0]?.current_number).toBe('1');
  });

  it('names OMAD in the manual and does not seed an interval', () => {
    const manual = readFileSync('onboarding-manual.md', 'utf8');
    expect(manual).toMatch(/CFG\.INV\.BATCHRANGE\.DEFINE/);
    expect(manual).toMatch(/\/config\/batch-number-ranges/);
    expect(manual).toMatch(/Opening the screen does not create `01`/);
    const migration = readFileSync('drizzle/9125_omad_batch_number_ranges.sql', 'utf8');
    expect(migration).not.toMatch(/insert into number_range/i);
    const receipt = readFileSync('src/modules/inventory/goods-receipt.ts', 'utf8');
    const production = readFileSync('src/modules/inventory/production-orders.ts', 'utf8');
    expect(receipt).not.toMatch(/createBatch|BATCH_CLT/);
    expect(production).not.toMatch(/createBatch|BATCH_CLT/);
  });
});
