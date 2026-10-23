import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { lockStockScope } from '../src/modules/inventory/physical-inventory';
import { postGoodsReceipt, reverseGoodsReceipt } from '../src/modules/inventory/goods-receipt';
import { postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'ATOMIC_POSTING';
const POSTING = { documentDate: '2026-10-18', postingDate: '2026-10-18' };
const MATERIAL = 'ATOMIC-MAT';

describe('atomic inventory posting', () => {
  let client = '';
  let currency = 'USD';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standing(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('atomic-inventory-posting');
    client = tenant.client;
    currency = tenant.currency;
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
        values (${client}, 'V10000', 'SUPPLIER', '1000', ${currency}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, ${MATERIAL}, 'Atomic posting material', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
        values (${client}, ${MATERIAL}, '1000', 0, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, created_by
        ) values (
          ${client}, ${MATERIAL}, '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, ${currency}, ${ACTOR}
        ) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
               (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
               (${client}, 'CA01', 'SCRAP', 'RAW_INVENTORY', '', '500000', ${ACTOR})
        on conflict do nothing
      `);
    });
    await initializeMaterialPeriodControl({
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Atomic posting',
    });
    return client;
  }

  const header = () => ({
    supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
  });
  const item = (quantity: number, netPrice: number, storageLocation = '0001') => ({
    materialNumber: MATERIAL, shortText: 'Atomic posting material', quantity, unit: 'PC',
    netPrice, priceUnit: 1, taxCode: '', plant: '1000', storageLocation,
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
    assignments: [] as never[],
  });

  async function balances(c: string) {
    return withTenant(c, async (tx) => {
      const stock = await tx.execute(sql`
        select storage_location, quantity from stock_quantity
        where client = ${c} and material_number = ${MATERIAL} and plant = '1000'
        order by storage_location
      `) as unknown as Array<{ storage_location: string; quantity: string }>;
      const valuation = await tx.execute(sql`
        select total_stock_quantity, stock_value from material_valuation
        where client = ${c} and material_number = ${MATERIAL} and valuation_area = '1000'
      `) as unknown as Array<{ total_stock_quantity: string; stock_value: string }>;
      const documents = await tx.execute(sql`
        select count(*)::int as n from material_document where client = ${c}
      `) as unknown as Array<{ n: number }>;
      const journals = await tx.execute(sql`
        select count(*)::int as n from journal_entry where client = ${c}
      `) as unknown as Array<{ n: number }>;
      return { stock, valuation: valuation[0], documents: documents[0].n, journals: journals[0].n };
    });
  }

  it('applies every line of one receipt to valuation, not the last snapshot', async () => {
    const c = await standing();
    const order = await createOrder({
      client: c, changedBy: ACTOR, ...header(),
      items: [item(4, 10), item(3, 20)],
    });
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'atomic-two-lines',
      lines: [{ itemNumber: 10, quantity: 4 }, { itemNumber: 20, quantity: 3 }],
    });
    expect(doc.lines).toHaveLength(2);
    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select debit_credit, amount_local from journal_entry_line
      where client = ${c} and document_number = ${doc.journalDocumentNumber}
    `)) as unknown as Array<{ debit_credit: string; amount_local: string }>;
    const debit = journal.filter((line) => line.debit_credit === 'S').reduce((sum, line) => sum + Number(line.amount_local), 0);
    const credit = journal.filter((line) => line.debit_credit === 'H').reduce((sum, line) => sum + Number(line.amount_local), 0);
    expect(debit).toBe(100);
    expect(credit).toBe(100);
    const changes = await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from change_document
      where client = ${c} and object_class = 'material_document' and object_key = ${doc.materialDocumentNumber}
    `)) as unknown as Array<{ n: number }>;
    expect(changes[0].n).toBeGreaterThan(0);
    const after = await balances(c);
    expect(Number(after.valuation.total_stock_quantity)).toBe(7);
    expect(Number(after.valuation.stock_value)).toBe(100);
    expect(after.stock.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(7);
  });

  it('refuses a reused request key whose quantity differs, and posts nothing more', async () => {
    const c = await standing();
    const before = await balances(c);
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: 'unused', ...POSTING,
      requestKey: 'atomic-two-lines',
      lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow(/different posting/);
    const after = await balances(c);
    expect(after.documents).toBe(before.documents);
    expect(Number(after.valuation.total_stock_quantity)).toBe(Number(before.valuation.total_stock_quantity));
  });

  it('returns the original document when the same request is retried concurrently', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header(), items: [item(2, 15)] });
    const input = {
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'atomic-concurrent-retry', lines: [{ itemNumber: 10, quantity: 2 }],
    };
    const [first, second] = await Promise.all([postGoodsReceipt(input), postGoodsReceipt(input)]);
    expect(second.materialDocumentNumber).toBe(first.materialDocumentNumber);
    const after = await balances(c);
    expect(after.stock.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(9);
    expect(Number(after.valuation.total_stock_quantity)).toBe(9);
    expect(Number(after.valuation.stock_value)).toBe(130);
  }, 30000);

  it('keeps valuation equal to both receipts when two orders post together', async () => {
    const c = await standing();
    const left = await createOrder({ client: c, changedBy: ACTOR, ...header(), items: [item(5, 40)] });
    const right = await createOrder({ client: c, changedBy: ACTOR, ...header(), items: [item(5, 60)] });
    await Promise.all([
      postGoodsReceipt({
        client: c, changedBy: ACTOR, orderNumber: left.orderNumber, ...POSTING,
        requestKey: 'atomic-gr-left', lines: [{ itemNumber: 10, quantity: 5 }],
      }),
      postGoodsReceipt({
        client: c, changedBy: ACTOR, orderNumber: right.orderNumber, ...POSTING,
        requestKey: 'atomic-gr-right', lines: [{ itemNumber: 10, quantity: 5 }],
      }),
    ]);
    const after = await balances(c);
    expect(Number(after.valuation.total_stock_quantity)).toBe(19);
    expect(Number(after.valuation.stock_value)).toBe(630);
    expect(after.stock.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(19);
  }, 30000);

  it('does not let a goods issue and a receipt reversal consume the same location stock', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header(), items: [item(10, 25)] });
    const receipt = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'atomic-race-receipt', lines: [{ itemNumber: 10, quantity: 10, storageLocation: '0001' }],
    });
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${c}, ${MATERIAL}, '1000', '0002', 'UNRESTRICTED', 10, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
        do update set quantity = 10
      `);
      await tx.execute(sql`
        update stock_quantity set quantity = 10
         where client = ${c} and material_number = ${MATERIAL} and plant = '1000' and storage_location = '0001'
      `);
      await tx.execute(sql`
        update material_valuation
           set total_stock_quantity = 40, stock_value = 1000
         where client = ${c} and material_number = ${MATERIAL} and valuation_area = '1000'
      `);
    });
    const results = await Promise.allSettled([
      postGoodsIssue({
        client: c, changedBy: ACTOR, movementTypeCode: '551', ...POSTING,
        requestKey: 'atomic-race-issue',
        lines: [{ materialNumber: MATERIAL, plant: '1000', storageLocation: '0001', quantity: 10 }],
      }),
      reverseGoodsReceipt({
        client: c, changedBy: ACTOR, materialDocumentNumber: receipt.materialDocumentNumber, ...POSTING,
        requestKey: 'atomic-race-reverse',
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected.map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))).toEqual([
      expect.stringMatching(/short of|no longer covers|already been reversed|carries/),
    ]);
    expect(fulfilled).toHaveLength(1);
    const stock = await withTenant(c, async (tx) => tx.execute(sql`
      select quantity from stock_quantity
      where client = ${c} and material_number = ${MATERIAL} and plant = '1000' and storage_location = '0001'
    `)) as unknown as Array<{ quantity: string }>;
    expect(Number(stock[0].quantity)).toBe(0);
  }, 30000);

  it('waits on the material balance lock before a second movement reads stock', async () => {
    const c = await standing();
    const key = `${c}/stock-scope/${MATERIAL}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let holding!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const holder = withTenant(c, async (tx) => {
      await lockStockScope(tx, c, [MATERIAL], 'EXCLUSIVE');
      holding();
      await gate;
    });
    await held;
    let settled = false;
    const posting = postGoodsIssue({
      client: c, changedBy: ACTOR, movementTypeCode: '551', ...POSTING,
      requestKey: 'atomic-lock-wait',
      lines: [{ materialNumber: MATERIAL, plant: '1000', storageLocation: '0002', quantity: 1 }],
    }).finally(() => { settled = true; });
    const waiting = await withTenant(c, async (tx) => {
      const started = Date.now();
      while (Date.now() - started < 8000) {
        const rows = await tx.execute(sql`
          select count(*)::int as n
          from pg_locks
          where locktype = 'advisory' and not granted
            and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)
        `) as unknown as Array<{ n: number }>;
        if (rows[0].n > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return false;
    });
    expect(settled).toBe(false);
    expect(waiting).toBe(true);
    release();
    await holder;
    const posted = await posting;
    expect(posted.materialDocumentNumber).toMatch(/\d/);
  }, 30000);

  it('rolls back the material document, journal and stock when valuation cannot accept the delta', async () => {
    const c = await standing();
    const before = await balances(c);
    const rangeBefore = await withTenant(c, async (tx) => tx.execute(sql`
      select current_number from number_range
      where client = ${c} and object_code = 'MATDOC'
      order by current_number desc limit 1
    `)) as unknown as Array<{ current_number: string }>;
    const changesBefore = await withTenant(c, async (tx) => tx.execute(sql`
      select count(*)::int as n from change_document where client = ${c}
    `)) as unknown as Array<{ n: number }>;
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        update material_valuation
           set total_stock_quantity = 1, stock_value = 1
         where client = ${c} and material_number = ${MATERIAL} and valuation_area = '1000'
      `);
    });
    await expect(postGoodsIssue({
      client: c, changedBy: ACTOR, movementTypeCode: '551', ...POSTING,
      requestKey: 'atomic-rollback',
      lines: [{ materialNumber: MATERIAL, plant: '1000', storageLocation: '0001', quantity: 5 }],
    })).rejects.toThrow();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        update material_valuation
           set total_stock_quantity = ${before.valuation.total_stock_quantity},
               stock_value = ${before.valuation.stock_value}
         where client = ${c} and material_number = ${MATERIAL} and valuation_area = '1000'
      `);
    });
    const after = await balances(c);
    expect(after.documents).toBe(before.documents);
    expect(after.journals).toBe(before.journals);
    const location = after.stock.find((row) => row.storage_location === '0001');
    const beforeLocation = before.stock.find((row) => row.storage_location === '0001');
    expect(Number(location?.quantity ?? 0)).toBe(Number(beforeLocation?.quantity ?? 0));
    const rangeAfter = await withTenant(c, async (tx) => tx.execute(sql`
      select current_number from number_range
      where client = ${c} and object_code = 'MATDOC'
      order by current_number desc limit 1
    `)) as unknown as Array<{ current_number: string }>;
    const changesAfter = await withTenant(c, async (tx) => tx.execute(sql`
      select count(*)::int as n from change_document where client = ${c}
    `)) as unknown as Array<{ n: number }>;
    expect(rangeAfter[0].current_number).toBe(rangeBefore[0].current_number);
    expect(changesAfter[0].n).toBe(changesBefore[0].n);
  });

  it('refuses two issue lines that together exceed the locked stock', async () => {
    const c = await standing();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        update stock_quantity set quantity = 4
         where client = ${c} and material_number = ${MATERIAL} and plant = '1000' and storage_location = '0001'
      `);
    });
    await expect(postGoodsIssue({
      client: c, changedBy: ACTOR, movementTypeCode: '551', ...POSTING,
      requestKey: 'atomic-two-issue-lines',
      lines: [
        { materialNumber: MATERIAL, plant: '1000', storageLocation: '0001', quantity: 4 },
        { materialNumber: MATERIAL, plant: '1000', storageLocation: '0001', quantity: 1 },
      ],
    })).rejects.toThrow(/carries 4\.000/);
    const after = await balances(c);
    expect(Number(after.stock.find((row) => row.storage_location === '0001')?.quantity)).toBe(4);
  });

  it('lets only one receipt of the same order consume the open quantity', async () => {
    const c = await standing();
    const before = await balances(c);
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header(), items: [item(5, 8)] });
    const results = await Promise.allSettled([
      postGoodsReceipt({
        client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
        requestKey: 'atomic-same-order-a', lines: [{ itemNumber: 10, quantity: 4 }],
      }),
      postGoodsReceipt({
        client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
        requestKey: 'atomic-same-order-b', lines: [{ itemNumber: 10, quantity: 4 }],
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const after = await balances(c);
    expect(after.stock.reduce((sum, row) => sum + Number(row.quantity), 0) - before.stock.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(4);
    expect(Number(after.valuation.total_stock_quantity) - Number(before.valuation.total_stock_quantity)).toBe(4);
  }, 30000);

  it('reverses a receipt once when two reversals race', async () => {
    const c = await standing();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header(), items: [item(3, 12, '0002')] });
    const receipt = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'atomic-reverse-once-receipt', lines: [{ itemNumber: 10, quantity: 3, storageLocation: '0002' }],
    });
    const results = await Promise.allSettled([
      reverseGoodsReceipt({
        client: c, changedBy: ACTOR, materialDocumentNumber: receipt.materialDocumentNumber, ...POSTING,
        requestKey: 'atomic-reverse-once-a',
      }),
      reverseGoodsReceipt({
        client: c, changedBy: ACTOR, materialDocumentNumber: receipt.materialDocumentNumber, ...POSTING,
        requestKey: 'atomic-reverse-once-b',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rows = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select status from material_document where client = ${c} and material_document_number = ${receipt.materialDocumentNumber}) as status,
        (select count(*)::int from material_document where client = ${c} and reversal_of = ${receipt.materialDocumentNumber}) as reversals
    `)) as unknown as Array<{ status: string; reversals: number }>;
    expect(rows[0].status).toBe('REVERSED');
    expect(rows[0].reversals).toBe(1);
  }, 30000);

  it('lets two goods issues consume only what stands', async () => {
    const c = await standing();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        update stock_quantity set quantity = 10
         where client = ${c} and material_number = ${MATERIAL} and plant = '1000' and storage_location = '0002'
      `);
    });
    const results = await Promise.allSettled([
      postGoodsIssue({
        client: c, changedBy: ACTOR, movementTypeCode: '551', ...POSTING,
        requestKey: 'atomic-gi-a',
        lines: [{ materialNumber: MATERIAL, plant: '1000', storageLocation: '0002', quantity: 8 }],
      }),
      postGoodsIssue({
        client: c, changedBy: ACTOR, movementTypeCode: '551', ...POSTING,
        requestKey: 'atomic-gi-b',
        lines: [{ materialNumber: MATERIAL, plant: '1000', storageLocation: '0002', quantity: 8 }],
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stock = await withTenant(c, async (tx) => tx.execute(sql`
      select quantity from stock_quantity
      where client = ${c} and material_number = ${MATERIAL} and plant = '1000' and storage_location = '0002'
    `)) as unknown as Array<{ quantity: string }>;
    expect(Number(stock[0].quantity)).toBe(2);
  }, 30000);
});
