import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createPhysicalInventory } from '../src/modules/inventory/physical-inventory';
import { PhysicalInventoryCountError, submitCounts } from '../src/modules/inventory/physical-inventory-count';
import {
  getDifferencePosting,
  postDifferences,
  reverseDifferencePosting,
} from '../src/modules/inventory/physical-inventory-posting';
import {
  PhysicalInventoryRecountError,
  cancelRecount,
  createRecount,
  getRecountComparison,
  validateRecount,
} from '../src/modules/inventory/physical-inventory-recount';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

/**
 * SCR-150 — a recount is a new document, not a second quantity on the original.
 *
 * The original count stays. The recount freezes the stock that stands now, for the stock type
 * that was selected. A refused selection writes nothing.
 */
describe('SCR-150 physical inventory recount', () => {
  const ACTOR = 'SCR150_RECOUNT';
  const DAY = '2026-10-21';
  const PLANT = 'RC01';
  const SLOC = 'RC01';
  let client = '';
  let key = 0;
  const nextKey = () => `scr150-${++key}`;

  const tallies = async () => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select count(*) from physical_inventory_document where client = ${client})::int as documents,
        (select count(*) from physical_inventory_recount_link where client = ${client})::int as links,
        (select count(*) from material_document where client = ${client})::int as material_documents
    `) as unknown as Array<{ documents: number; links: number; material_documents: number }>;
    return rows[0];
  });

  const sourceItem = async (documentNumber: string, itemNumber: number) => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count_status, counted_quantity::text as counted, difference_quantity::text as difference,
             book_quantity_snapshot::text as book, stock_type
        from physical_inventory_item
       where client = ${client} and inventory_document_number = ${documentNumber}
         and item_number = ${itemNumber}
    `) as unknown as Array<{ count_status: string; counted: string; difference: string; book: string; stock_type: string }>;
    return rows[0];
  });

  const linkOf = async (documentNumber: string, itemNumber: number) => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select recount_document_number, status, reason
        from physical_inventory_recount_link
       where client = ${client} and original_document_number = ${documentNumber}
         and original_item_number = ${itemNumber}
       order by created_at
    `) as unknown as Array<{ recount_document_number: string; status: string; reason: string }>;
    return rows;
  });

  beforeAll(async () => {
    const tenant = await createTenant('scr150-recount');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'PHYINV', subObject: '*', prefix: 'RC', numberLength: 6, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client, objectCode: 'MATDOC', subObject: '*', prefix: 'M', numberLength: 6, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'Recount plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
        values (${client}, ${PLANT}, ${SLOC}, 'Recount store', false, true, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, m.number, m.description, t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        cross join (values
          ('RC-A', 'Selected'), ('RC-B', 'Uncounted'), ('RC-Z', 'Exact'), ('RC-P', 'Posted')
        ) m(number, description)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${client}, m.number, ${PLANT}, ${ACTOR}
        from (values ('RC-A'), ('RC-B'), ('RC-Z'), ('RC-P')) m(number)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        select ${client}, c.company_code, 2026, 10, 2026, 9, true, ${ACTOR}
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict (client, company_code) do update set
          current_fiscal_year = 2026, current_period = 10, previous_fiscal_year = 2026, previous_period = 9,
          allow_backposting = true
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values
          (${client}, 'RC-A', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 50, ${ACTOR}),
          (${client}, 'RC-A', ${PLANT}, ${SLOC}, 'QUALITY', 7, ${ACTOR}),
          (${client}, 'RC-B', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 12, ${ACTOR}),
          (${client}, 'RC-Z', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 9, ${ACTOR}),
          (${client}, 'RC-P', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 20, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type)
        do update set quantity = excluded.quantity
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values
          (${client}, 'RC-A', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 10, 10, 1, 'USD', 57, 570, ${ACTOR}),
          (${client}, 'RC-Z', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 4, 4, 1, 'USD', 9, 36, ${ACTOR}),
          (${client}, 'RC-P', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 5, 5, 1, 'USD', 20, 100, ${ACTOR}),
          (${client}, 'RC-B', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 2, 2, 1, 'USD', 12, 24, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
        select ${client}, c.chart_of_accounts, v.n, v.d, v.t,
               v.b, false, null, false, false, 'GENL', v.k, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values
          ('140000', 'Inventory', 'ASSET', true, 'BALANCE_SHEET'),
          ('520000', 'Inventory difference', 'EXPENSE', false, 'PL_STATEMENT')
        ) v(n, d, t, b, k)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', v.m, v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values ('INVENTORY', '', '140000'), ('OFFSETTING_INVENTORY', 'DIFF', '520000')) v(e, m, a)
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  const open = (materials: string[], requestKey = nextKey()) => createPhysicalInventory({
    client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
    plannedCountDate: DAY, postingBlock: true, materials, requestKey,
  });

  const recount = (documentNumber: string, fiscalYear: number, itemNumbers: number[], extras: Record<string, unknown> = {}) => createRecount({
    client, changedBy: ACTOR, documentNumber, fiscalYear, itemNumbers,
    plannedRecountDate: DAY, reason: 'Second count', requestKey: nextKey(),
    ...extras,
  });

  it('recounts the selected stock type at the stock that stands now, and leaves the original count', async () => {
    const source = await open(['RC-A', 'RC-B']);
    expect(source.items.map((item) => item.stockType).sort()).toEqual(['QUALITY', 'UNRESTRICTED', 'UNRESTRICTED']);
    const unrestricted = source.items.find((item) => item.materialNumber === 'RC-A' && item.stockType === 'UNRESTRICTED')!;
    const quality = source.items.find((item) => item.materialNumber === 'RC-A' && item.stockType === 'QUALITY')!;
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(),
      lines: [
        { itemNumber: unrestricted.itemNumber, quantity: 40 },
        { itemNumber: quality.itemNumber, quantity: 7 },
      ],
    });
    await withTenant(client, (tx) => tx.execute(sql`
      update stock_quantity set quantity = 48
       where client = ${client} and material_number = 'RC-A' and stock_type = 'UNRESTRICTED'
    `));

    const before = await tallies();
    const raised = await recount(source.inventoryDocumentNumber, source.fiscalYear, [unrestricted.itemNumber], {
      requestKey: 'scr150-selected', headerText: 'Aisle 2',
    });
    expect(raised.items).toHaveLength(1);
    expect(raised.items[0]).toMatchObject({
      sourceItemNumber: unrestricted.itemNumber,
      stockType: 'UNRESTRICTED',
      materialNumber: 'RC-A',
    });
    expect(Number(raised.items[0].bookQuantity)).toBe(48);
    expect(Number(raised.items[0].originalCountedQuantity)).toBe(40);
    expect(raised.reason).toBe('Second count');
    expect(raised.headerText).toBe('Aisle 2');
    expect(raised.status).toBe('SCHEDULED');

    const original = await sourceItem(source.inventoryDocumentNumber, unrestricted.itemNumber);
    expect(original.count_status).toBe('RECOUNT_REQUIRED');
    expect(Number(original.counted)).toBe(40);
    expect(Number(original.book)).toBe(50);
    const qualityAfter = await sourceItem(source.inventoryDocumentNumber, quality.itemNumber);
    expect(qualityAfter.count_status).toBe('COUNTED');

    const recountHeader = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select posting_block, status, request_key
          from physical_inventory_document
         where client = ${client} and inventory_document_number = ${raised.recountDocumentNumber}
      `) as unknown as Array<{ posting_block: boolean; status: string; request_key: string }>;
      const items = await tx.execute(sql`
        select stock_type from physical_inventory_item
         where client = ${client} and inventory_document_number = ${raised.recountDocumentNumber}
      `) as unknown as Array<{ stock_type: string }>;
      return { header: rows[0], types: items.map((item) => item.stock_type) };
    });
    expect(recountHeader.header.posting_block, 'the block is not copied').toBe(false);
    expect(recountHeader.header.request_key).toBe('scr150-selected');
    expect(recountHeader.types).toEqual(['UNRESTRICTED']);
    expect((await tallies()).documents).toBe(before.documents + 1);
  });

  it('refuses an uncounted item, a mixed selection, a missing document, and a closed period, and writes nothing', async () => {
    const source = await open(['RC-B']);
    const uncounted = source.items[0].itemNumber;
    let before = await tallies();
    await expect(recount(source.inventoryDocumentNumber, source.fiscalYear, [uncounted])).rejects.toThrow(/has not been counted/);
    await expect(recount('NO-SUCH', 2026, [10])).rejects.toThrow(/does not exist/);
    await expect(createRecount({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      itemNumbers: [uncounted], plannedRecountDate: DAY, reason: 'x'.repeat(41), requestKey: nextKey(),
    })).rejects.toThrow(/longer than 40/);
    expect(await tallies()).toEqual(before);

    const counted = await open(['RC-Z']);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: counted.inventoryDocumentNumber, fiscalYear: counted.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 9 }],
    });
    before = await tallies();
    await expect(recount(counted.inventoryDocumentNumber, counted.fiscalYear, [10, 20])).rejects.toThrow(/does not belong/);
    expect(await tallies()).toEqual(before);

    const mixed = await open(['RC-A', 'RC-B']);
    const mixedUnrestricted = mixed.items.find((item) => item.materialNumber === 'RC-A' && item.stockType === 'UNRESTRICTED')!;
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: mixed.inventoryDocumentNumber, fiscalYear: mixed.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: mixedUnrestricted.itemNumber, quantity: 48 }],
    });
    const mixedUncounted = mixed.items.find((item) => item.materialNumber === 'RC-B')!.itemNumber;
    before = await tallies();
    await expect(recount(
      mixed.inventoryDocumentNumber, mixed.fiscalYear, [mixedUnrestricted.itemNumber, mixedUncounted],
    )).rejects.toThrow(/has not been counted/);
    expect(await tallies()).toEqual(before);

    before = await tallies();
    await withTenant(client, (tx) => tx.execute(sql`
      update material_period_control set current_period = 9, allow_backposting = false
       where client = ${client}
    `));
    try {
      await expect(recount(counted.inventoryDocumentNumber, counted.fiscalYear, [10])).rejects.toThrow(/closed/);
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`
        update material_period_control set current_period = 10, allow_backposting = true
         where client = ${client}
      `));
    }
    expect(await tallies()).toEqual(before);
  });

  it('refuses a threshold, a batch, and special stock before any write', async () => {
    const source = await open(['RC-Z']);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 9 }],
    });
    const before = await tallies();
    await expect(recount(source.inventoryDocumentNumber, source.fiscalYear, [10], { varianceThreshold: 1 })).rejects.toThrow(/threshold/);
    await expect(recount(source.inventoryDocumentNumber, source.fiscalYear, [10], { batch: 'B1' })).rejects.toThrow(/Batch/);
    await expect(recount(source.inventoryDocumentNumber, source.fiscalYear, [10], { specialStock: 'K' })).rejects.toThrow(/special stock/);
    expect(await tallies()).toEqual(before);
  });

  it('previews the current stock and writes nothing', async () => {
    const source = await open(['RC-Z']);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 9 }],
    });
    const before = await tallies();
    const preview = await validateRecount({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      itemNumbers: [10], plannedRecountDate: DAY, reason: 'Look only',
    });
    expect(Number(preview.items[0].bookQuantityNow)).toBe(9);
    expect(Number(preview.items[0].originalCountedQuantity)).toBe(9);
    expect(await tallies()).toEqual(before);
  });

  it('resolves an all-zero recount when the recount is counted, and refuses the original by name', async () => {
    const source = await open(['RC-Z']);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 9 }],
    });
    const raised = await recount(source.inventoryDocumentNumber, source.fiscalYear, [10], { reason: 'Confirm zero' });
    expect(Number(raised.items[0].originalDifference)).toBe(0);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: raised.recountDocumentNumber, fiscalYear: raised.recountFiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: raised.items[0].recountItemNumber, quantity: 9 }],
    });
    const links = await linkOf(source.inventoryDocumentNumber, 10);
    expect(links.at(-1)?.status).toBe('RESOLVED');
    expect((await sourceItem(source.inventoryDocumentNumber, 10)).count_status).toBe('RECOUNT_REQUIRED');

    await expect(postDifferences({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      itemNumbers: [10], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    })).rejects.toThrow(new RegExp(raised.recountDocumentNumber));
    const reading = await getDifferencePosting(client, {
      documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
    });
    expect(reading?.lines[0].reason).toContain(raised.recountDocumentNumber);
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 8 }],
    })).rejects.toBeInstanceOf(PhysicalInventoryCountError);
  });

  it('resolves a posted recount and leaves the original difference where it was', async () => {
    const source = await open(['RC-A']);
    const item = source.items.find((row) => row.stockType === 'UNRESTRICTED')!;
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: item.itemNumber, quantity: 40 }],
    });
    const beforeDifference = Number((await sourceItem(source.inventoryDocumentNumber, item.itemNumber)).difference);
    const raised = await recount(source.inventoryDocumentNumber, source.fiscalYear, [item.itemNumber]);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: raised.recountDocumentNumber, fiscalYear: raised.recountFiscalYear,
      countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: raised.items[0].recountItemNumber, quantity: 40 }],
    });
    const posted = await postDifferences({
      client, changedBy: ACTOR, documentNumber: raised.recountDocumentNumber, fiscalYear: raised.recountFiscalYear,
      itemNumbers: [raised.items[0].recountItemNumber], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    expect(posted.materialDocumentNumber).toBeTruthy();
    expect((await linkOf(source.inventoryDocumentNumber, item.itemNumber)).at(-1)?.status).toBe('RESOLVED');
    const original = await sourceItem(source.inventoryDocumentNumber, item.itemNumber);
    expect(original.count_status).toBe('RECOUNT_REQUIRED');
    expect(Number(original.difference)).toBe(beforeDifference);
    expect(Number(original.counted)).toBe(40);
  });

  it('refuses a still-posted item and accepts it once the posting is fully reversed', async () => {
    const source = await open(['RC-P']);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 18 }],
    });
    const posted = await postDifferences({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      itemNumbers: [10], postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    const before = await tallies();
    await expect(recount(source.inventoryDocumentNumber, source.fiscalYear, [10])).rejects.toThrow(/posted difference/);
    expect(await tallies()).toEqual(before);
    await reverseDifferencePosting({
      client, changedBy: ACTOR, materialDocumentNumber: posted.materialDocumentNumber,
      postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
    });
    const raised = await recount(source.inventoryDocumentNumber, source.fiscalYear, [10]);
    expect(raised.items).toHaveLength(1);
    expect(Number((await sourceItem(source.inventoryDocumentNumber, 10)).counted)).toBe(18);
  });

  it('replays the same key and refuses the same key with a different payload', async () => {
    const source = await open(['RC-Z']);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 9 }],
    });
    const first = await recount(source.inventoryDocumentNumber, source.fiscalYear, [10], {
      requestKey: 'scr150-replay', reason: 'Same reason',
    });
    const again = await recount(source.inventoryDocumentNumber, source.fiscalYear, [10], {
      requestKey: 'scr150-replay', reason: 'Same reason',
    });
    expect(again.recountDocumentNumber).toBe(first.recountDocumentNumber);
    expect((await linkOf(source.inventoryDocumentNumber, 10)).filter((link) => link.status !== 'CANCELLED')).toHaveLength(1);
    await expect(recount(source.inventoryDocumentNumber, source.fiscalYear, [10], {
      requestKey: 'scr150-replay', reason: 'Other reason',
    })).rejects.toBeInstanceOf(PhysicalInventoryRecountError);
    expect((await linkOf(source.inventoryDocumentNumber, 10)).filter((link) => link.status !== 'CANCELLED')).toHaveLength(1);
  });

  it('leaves one recount when two requests arrive together', async () => {
    const source = await open(['RC-B']);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 11 }],
    });
    const results = await Promise.allSettled([
      recount(source.inventoryDocumentNumber, source.fiscalYear, [10], { requestKey: 'scr150-race-a' }),
      recount(source.inventoryDocumentNumber, source.fiscalYear, [10], { requestKey: 'scr150-race-b' }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect((await linkOf(source.inventoryDocumentNumber, 10)).filter((link) => link.status !== 'CANCELLED')).toHaveLength(1);
  });

  it('cancels an uncounted recount document and returns the original to counted', async () => {
    const source = await open(['RC-Z']);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 8 }],
    });
    const raised = await recount(source.inventoryDocumentNumber, source.fiscalYear, [10]);
    const cancelled = await cancelRecount({
      client, changedBy: ACTOR, recountDocumentNumber: raised.recountDocumentNumber,
      recountFiscalYear: raised.recountFiscalYear, reason: 'Raised in error',
    });
    expect(cancelled.status).toBe('CANCELLED');
    const header = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select status from physical_inventory_document
         where client = ${client} and inventory_document_number = ${raised.recountDocumentNumber}
      `) as unknown as Array<{ status: string }>;
      return rows[0].status;
    });
    expect(header).toBe('CANCELLED');
    expect((await sourceItem(source.inventoryDocumentNumber, 10)).count_status).toBe('COUNTED');
    expect(Number((await sourceItem(source.inventoryDocumentNumber, 10)).counted)).toBe(8);
  });

  it('cancels the link of a counted recount and leaves that document standing', async () => {
    const source = await open(['RC-Z']);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 8 }],
    });
    const raised = await recount(source.inventoryDocumentNumber, source.fiscalYear, [10]);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: raised.recountDocumentNumber, fiscalYear: raised.recountFiscalYear,
      countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: raised.items[0].recountItemNumber, quantity: 8 }],
    });
    await cancelRecount({
      client, changedBy: ACTOR, recountDocumentNumber: raised.recountDocumentNumber,
      recountFiscalYear: raised.recountFiscalYear, reason: 'Count was the wrong aisle',
    });
    const header = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select status from physical_inventory_document
         where client = ${client} and inventory_document_number = ${raised.recountDocumentNumber}
      `) as unknown as Array<{ status: string }>;
      const counted = await tx.execute(sql`
        select counted_quantity::text as counted from physical_inventory_item
         where client = ${client} and inventory_document_number = ${raised.recountDocumentNumber}
      `) as unknown as Array<{ counted: string }>;
      return { status: rows[0].status, counted: counted[0].counted };
    });
    expect(header.status).not.toBe('CANCELLED');
    expect(Number(header.counted)).toBe(8);
    expect((await linkOf(source.inventoryDocumentNumber, 10)).at(-1)?.status).toBe('CANCELLED');
    expect((await sourceItem(source.inventoryDocumentNumber, 10)).count_status).toBe('COUNTED');
  });

  it('shows both results and does not add them', async () => {
    const source = await open(['RC-Z']);
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
      countDate: DAY, counterName: 'A. Counter', requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 8 }],
    });
    const raised = await recount(source.inventoryDocumentNumber, source.fiscalYear, [10], { reason: 'Compare' });
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: raised.recountDocumentNumber, fiscalYear: raised.recountFiscalYear,
      countDate: DAY, counterName: 'B. Counter', requestKey: nextKey(),
      lines: [{ itemNumber: raised.items[0].recountItemNumber, quantity: 7 }],
    });
    const comparison = await getRecountComparison(client, {
      documentNumber: source.inventoryDocumentNumber, fiscalYear: source.fiscalYear,
    });
    expect(comparison).toHaveLength(1);
    const item = comparison[0].items[0];
    expect(Number(item.originalBook)).toBe(9);
    expect(Number(item.originalCounted)).toBe(8);
    expect(Number(item.originalDifference)).toBe(-1);
    expect(Number(item.recountBook)).toBe(9);
    expect(Number(item.recountCounted)).toBe(7);
    expect(Number(item.recountDifference)).toBe(-2);
    expect(item.recountCounter).toBe('B. Counter');
    expect(item.materialDocumentNumber).toBe('');
    expect(comparison[0].reason).toBe('Compare');
    expect('combined' in item).toBe(false);
  });
});
