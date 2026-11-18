import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { createPhysicalInventory } from '../src/modules/inventory/physical-inventory';
import { defineUomConversion } from '../src/modules/inventory/unit-conversion';
import { getStoStatus, postStoIssue, postStoReceipt, reconcileStoItem, reverseStoDocument } from '../src/modules/inventory/stock-transport';
import { buildStoFixture } from './helpers/sto-fixture';
import { makeStoActor } from './helpers/sto-actor';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'ITEM22_BATCH_TEST';
const DAY = '2026-10-15';
let client = '';
let all: Awaited<ReturnType<typeof makeStoActor>>;
let key = 0;
const nextKey = () => `sto-b-${++key}`;

const header = (over: Record<string, unknown> = {}) => ({
  documentType: 'STOCK_TRANSPORT', supplyingPlant: '1000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', ...over,
});
const item = (over: Record<string, unknown> = {}) => ({
  materialNumber: 'MAT-B', quantity: 100, unit: 'PC', plant: '1100', storageLocation: '', batch: '',
  scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 100 }], ...over,
});
async function create(headerOver: Record<string, unknown> = {}, items: Array<Record<string, unknown>> = [item()]) {
  return (await createOrder({ client, changedBy: ACTOR, ...header(headerOver), items } as never)).orderNumber;
}
const issue = (orderNumber: string, items: Array<Record<string, unknown>>) => postStoIssue({
  client, changedBy: ACTOR, orderNumber, postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
  items: items.map((i) => ({ storageLocation: '0001', ...i })) as never,
}, { authorization: all });
const receive = (orderNumber: string, lines: Array<Record<string, unknown>>) => postStoReceipt({
  client, changedBy: ACTOR, orderNumber, postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
  lines: lines.map((l) => ({ storageLocation: '0001', ...l })) as never,
}, { authorization: all });
async function stock(mat: string, plant: string, location: string, type: string, batch = ''): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select quantity from stock_quantity where client = ${client} and material_number = ${mat} and plant = ${plant}
        and storage_location = ${location} and stock_type = ${type} and batch_number = ${batch}`) as unknown as Array<{ quantity: string }>;
    return rows[0] ? Number(rows[0].quantity) : 0;
  });
}
async function valuation(mat: string, plant: string) {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select total_stock_quantity, stock_value from material_valuation
      where client = ${client} and material_number = ${mat} and valuation_area = ${plant}`) as unknown as Array<{ total_stock_quantity: string; stock_value: string }>;
    return { quantity: Number(rows[0].total_stock_quantity), value: Number(rows[0].stock_value) };
  });
}

beforeAll(async () => {
  const tenant = await createTenant('item22-batches');
  client = tenant.client;
  await buildStoFixture(client, ACTOR);
  all = await makeStoActor(client, 'all', { plants: ['1000', '1100', '2000', '3000'] });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`insert into batch_level_configuration (client, batch_level, created_by, changed_by) values (${client}, '1', ${ACTOR}, ${ACTOR})
      on conflict (client) do update set batch_level = '1'`);
    for (const m of ['MAT-B', 'MAT-U']) {
      await tx.execute(sql`insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
        values (${client}, ${m}, ${`Material ${m}`}, 'RAW', 'PC', ${m === 'MAT-B'}, ${ACTOR}) on conflict do nothing`);
      for (const p of ['1000', '1100']) {
        await tx.execute(sql`insert into material_plant (client, material_number, plant, created_by) values (${client}, ${m}, ${p}, ${ACTOR}) on conflict do nothing`);
        await tx.execute(sql`insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control, standard_price,
            moving_average_price, price_unit, currency, total_stock_quantity, stock_value, created_by)
          values (${client}, ${m}, ${p}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 10, 1, 'USD', ${p === '1000' ? 1000 : 0}, ${p === '1000' ? 10000 : 0}, ${ACTOR}) on conflict do nothing`);
      }
      await tx.execute(sql`insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by)
        values (${client}, ${m}, '1000', '0001', 'UNRESTRICTED', '', ${m === 'MAT-U' ? 1000 : 0}, ${ACTOR}) on conflict do nothing`);
    }
    for (const b of ['B1', 'B2', 'B3']) {
      await tx.execute(sql`insert into batch (id, client, batch_number, material_number, plant, batch_level_at_creation, created_by, changed_by)
        values (${`${client}-${b}`}, ${client}, ${b}, 'MAT-B', null, '1', ${ACTOR}, ${ACTOR}) on conflict do nothing`);
    }
    await tx.execute(sql`insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by) values
      (${client}, 'MAT-B', '1000', '0001', 'UNRESTRICTED', 'B1', 100, ${ACTOR}), (${client}, 'MAT-B', '1000', '0001', 'UNRESTRICTED', 'B2', 100, ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`update material_valuation set total_stock_quantity = 200, stock_value = 2000
      where client = ${client} and material_number = 'MAT-B' and valuation_area = '1000'`);
  });
}, 240_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  await closeDb();
}, 240_000);

describe('ITEM-22 batches: transit and receipts keep the batch, and each issue keeps its own value', () => {
  let order = '';
  it('requires a batch for a batch-managed material, and refuses a batch that does not stand', async () => {
    order = await create();
    await expect(issue(order, [{ itemNumber: 10, quantity: 10 }])).rejects.toThrow(/batch-managed. A batch is required/);
    await expect(issue(order, [{ itemNumber: 10, quantity: 10, batch: 'NOPE' }])).rejects.toThrow(/Batch NOPE does not stand/);
  });

  it('issues two batches at two different prices and carries the batch into transit', async () => {
    const first = await issue(order, [{ itemNumber: 10, quantity: 10, batch: 'B1' }]);
    expect(first.lines[1]).toMatchObject({ stockType: 'IN_TRANSIT', batch: 'B1', value: '100.0000' });
    // The price moves after the first issue; the second issue carries the new price, the first keeps its own.
    await withTenant(client, (tx) => tx.execute(sql`update material_valuation set moving_average_price = 12, stock_value = total_stock_quantity * 12
      where client = ${client} and material_number = 'MAT-B' and valuation_area = '1000'`));
    await issue(order, [{ itemNumber: 10, quantity: 10, batch: 'B1' }]);
    await issue(order, [{ itemNumber: 10, quantity: 20, batch: 'B2' }]);
    expect(await stock('MAT-B', '1100', '', 'IN_TRANSIT', 'B1')).toBe(20);
    expect(await stock('MAT-B', '1100', '', 'IN_TRANSIT', 'B2')).toBe(20);
    expect(await stock('MAT-B', '1100', '0001', 'UNRESTRICTED', 'B1')).toBe(0);
    const status = await getStoStatus(client, order);
    expect(status?.items[0].allocations.map((a) => [a.batch, a.issued, a.issueValue])).toEqual([
      ['B1', '10.000', '100.0000'], ['B1', '10.000', '120.0000'], ['B2', '20.000', '240.0000'],
    ]);
  });

  it('will not receive without naming the batch when several stand in transit, nor a batch that is not in transit', async () => {
    await expect(receive(order, [{ itemNumber: 10, quantity: 5 }])).rejects.toThrow(/stands in transit in several batches \(B1, B2\)/);
    await expect(receive(order, [{ itemNumber: 10, quantity: 5, batch: 'B3' }])).rejects.toThrow(/Item 10 batch B3: 0.000 PC stands in transit/);
    await expect(receive(order, [{ itemNumber: 10, quantity: 21, batch: 'B1' }])).rejects.toThrow(/20.000 PC stands in transit, 21.000 was asked/);
  });

  it('receives FIFO inside the batch and carries each issue\'s original value onto the lines', async () => {
    const doc = await receive(order, [{ itemNumber: 10, quantity: 15, batch: 'B1' }]);
    const receipts = doc.lines.filter((l) => l.lineDirection === 'RECEIPT');
    expect(receipts.map((l) => [l.batch, l.quantity, l.value])).toEqual([['B1', '10.000', '100.0000'], ['B1', '5.000', '60.0000']]);
    expect(await stock('MAT-B', '1100', '0001', 'UNRESTRICTED', 'B1')).toBe(15);
    expect(await stock('MAT-B', '1100', '', 'IN_TRANSIT', 'B1')).toBe(5);
    expect(await stock('MAT-B', '1100', '', 'IN_TRANSIT', 'B2')).toBe(20);
    // Receiving valuation: 40 units in total, 100 + 120 + 240 = 460, unchanged by the receipt itself.
    expect(await valuation('MAT-B', '1100')).toEqual({ quantity: 40, value: 460 });
    expect((await reconcileStoItem(client, order, 10)).reconciled).toBe(true);
  });

  it('a 102 gives the allocations back exactly (quantities and values), a 352 follows', async () => {
    const status = await getStoStatus(client, order);
    const receiptDoc = status!.history.find((h) => h.code === '101')!.materialDocumentNumber;
    await reverseStoDocument({ client, changedBy: ACTOR, materialDocumentNumber: receiptDoc, postingDate: DAY, documentDate: DAY, requestKey: nextKey() }, { authorization: all });
    expect(await stock('MAT-B', '1100', '', 'IN_TRANSIT', 'B1')).toBe(20);
    const after = await getStoStatus(client, order);
    expect(after?.items[0].allocations.map((a) => [a.received, a.inTransit])).toEqual([['0.000', '10.000'], ['0.000', '10.000'], ['0.000', '20.000']]);
    for (const h of after!.history.filter((x) => x.code === '351').reverse()) {
      await reverseStoDocument({ client, changedBy: ACTOR, materialDocumentNumber: h.materialDocumentNumber, postingDate: DAY, documentDate: DAY, requestKey: nextKey() }, { authorization: all });
    }
    // Historical values return exactly: 100 + 120 + 240 = 460 from the receiving valuation back to the source.
    expect(await valuation('MAT-B', '1100')).toEqual({ quantity: 0, value: 0 });
    expect(await stock('MAT-B', '1000', '0001', 'UNRESTRICTED', 'B1')).toBe(100);
  });
});

describe('ITEM-22 units of measure and several items', () => {
  it('stores the entered quantity and unit, counts the base quantity, and converts exactly', async () => {
    await defineUomConversion({ client, changedBy: ACTOR, materialNumber: 'MAT-U', alternativeUnit: 'BOX', numerator: 12, denominator: 1 });
    const order = await create({}, [item({ materialNumber: 'MAT-U', quantity: 5, unit: 'BOX', batch: '', scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }] })]);
    const issued = await issue(order, [{ itemNumber: 10, quantity: 2 }]);
    expect(issued.lines[0]).toMatchObject({ quantity: '24.000', unit: 'PC', value: '240.0000' });
    const lineRows = await withTenant(client, (tx) => tx.execute(sql`
      select entry_quantity::text as q, entry_unit, base_quantity::text as b, base_unit from material_document_line
       where client = ${client} and material_document_number = ${issued.materialDocumentNumber} and line_number = 1`)) as unknown as Array<Record<string, string>>;
    expect(lineRows[0]).toEqual({ q: '2.000', entry_unit: 'BOX', b: '24.000', base_unit: 'PC' });
    const status = await getStoStatus(client, order);
    expect(status?.items[0]).toMatchObject({ orderedQuantity: '5.000', orderUnit: 'BOX', orderedBase: '60.000', netIssued: '24.000', issueable: '36.000' });
    await expect(issue(order, [{ itemNumber: 10, quantity: 4 }])).rejects.toThrow(/ordered 60.000 PC, already issued 24.000, issueable 36.000; 48.000 was asked/);
    await receive(order, [{ itemNumber: 10, quantity: 1 }]);
    expect(await stock('MAT-U', '1100', '0001', 'UNRESTRICTED')).toBe(12);
    expect(await stock('MAT-U', '1100', '', 'IN_TRANSIT')).toBe(12);
  });

  it('issues two items in one document, with one line pair per item', async () => {
    const order = await create({}, [
      item({ materialNumber: 'MAT-U', quantity: 10, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 10 }] }),
      item({ materialNumber: 'MAT-A', quantity: 10, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 10 }] }),
    ]);
    const doc = await issue(order, [{ itemNumber: 10, quantity: 4 }, { itemNumber: 20, quantity: 6 }]);
    expect(doc.lines.map((l) => [l.lineNumber, l.lineDirection, l.materialNumber, l.itemNumber, l.quantity])).toEqual([
      [1, 'ISSUE', 'MAT-U', 10, '4.000'], [2, 'RECEIPT', 'MAT-U', 10, '4.000'],
      [3, 'ISSUE', 'MAT-A', 20, '6.000'], [4, 'RECEIPT', 'MAT-A', 20, '6.000'],
    ]);
  });
});

describe('ITEM-22 inventory locks and stock sufficiency', () => {
  it('refuses an issue short of stock, naming what stands, and writes nothing', async () => {
    const order = await create({}, [item({ materialNumber: 'MAT-U', quantity: 5000, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5000 }] })]);
    const before = await stock('MAT-U', '1000', '0001', 'UNRESTRICTED');
    await expect(issue(order, [{ itemNumber: 10, quantity: before + 1 }])).rejects.toThrow(/short of the .* to issue/);
    expect(await stock('MAT-U', '1000', '0001', 'UNRESTRICTED')).toBe(before);
    expect((await getStoStatus(client, order))?.items[0].netIssued).toBe('0.000');
  });

  it('a counting block on the supplying side stops the issue, and releasing it lets the issue post', async () => {
    const order = await create({}, [item({ materialNumber: 'MAT-A', quantity: 10, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 10 }] })]);
    const count = await createPhysicalInventory({
      client, createdBy: ACTOR, plant: '1000', storageLocation: '0001', plannedCountDate: '2026-10-20', postingBlock: true,
      materials: ['MAT-A'], requestKey: nextKey(),
    } as never);
    await expect(issue(order, [{ itemNumber: 10, quantity: 1 }])).rejects.toThrow(new RegExp(count.inventoryDocumentNumber));
    expect((await getStoStatus(client, order))?.items[0].netIssued).toBe('0.000');
    const { cancelPhysicalInventory } = await import('../src/modules/inventory/physical-inventory');
    await cancelPhysicalInventory({ client, changedBy: ACTOR, inventoryDocumentNumber: count.inventoryDocumentNumber, fiscalYear: count.fiscalYear });
    expect((await issue(order, [{ itemNumber: 10, quantity: 1 }])).status).toBe('POSTED');
  });
});
