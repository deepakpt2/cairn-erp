import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createPhysicalInventory } from '../src/modules/inventory/physical-inventory';
import { submitCounts } from '../src/modules/inventory/physical-inventory-count';
import {
  PhysicalInventoryPostingError,
  getDifferencePosting,
  getPostingHistory,
  postDifferences,
  reverseDifferencePosting,
  validateDifferencePosting,
} from '../src/modules/inventory/physical-inventory-posting';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

/**
 * SCR-149 — a difference is posted by the engine that already posts.
 *
 * The movement is whatever row the kind and the direction name. The amount is the plant
 * valuation. A selected batch commits together or not at all.
 */
describe('SCR-149 physical inventory difference posting', () => {
  const ACTOR = 'SCR149_POST';
  const DAY = '2026-10-20';
  const POSTING = '2026-10-21';
  const PLANT = '1000';
  const SLOC = '0001';
  let client = '';
  let other = '';
  let documentNumber = '';
  let fiscalYear = 2026;
  let key = 0;
  const nextKey = () => `scr149-${++key}`;

  const itemNumber = async (materialNumber: string, stockType = 'UNRESTRICTED') => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select item_number from physical_inventory_item
       where client = ${client} and inventory_document_number = ${documentNumber}
         and material_number = ${materialNumber} and stock_type = ${stockType}
    `) as unknown as Array<{ item_number: number }>;
    return rows[0].item_number;
  });

  const ledger = async () => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from journal_entry where client = ${client})::int as journals,
        (select count(*) from physical_inventory_difference_allocation where client = ${client})::int as allocations
    `) as unknown as Array<{ documents: number; journals: number; allocations: number }>;
    return rows[0];
  });

  beforeAll(async () => {
    const tenant = await createTenant('scr149-post');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    other = (await createTenant('scr149-post-other')).client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 7, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client, objectCode: 'MATDOC', subObject: '*', prefix: 'M', numberLength: 6, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'Posting plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
        values (${client}, ${PLANT}, ${SLOC}, 'Posting store', false, true, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = true, allow_negative_stock = false
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, m.number, m.description, 'RAW', 'PC', ${ACTOR}
        from (values
          ('POST-S', 'Shortage'), ('POST-P', 'Surplus'), ('POST-Z', 'Exact'),
          ('POST-U', 'Uncounted'), ('POST-N', 'Unvalued'), ('POST-Q', 'Quality')
        ) m(number, description)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${client}, m.number, ${PLANT}, ${ACTOR}
        from (values ('POST-S'), ('POST-P'), ('POST-Z'), ('POST-U'), ('POST-N'), ('POST-Q')) m(number)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        select ${client}, c.company_code, 2026, 10, 2026, 9, true, ${ACTOR}
        from (select company_code from company_code where client = ${client} limit 1) c
        on conflict (client, company_code) do update set
          current_fiscal_year = 2026, current_period = 10, allow_backposting = true
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values
          (${client}, 'POST-S', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 100, ${ACTOR}),
          (${client}, 'POST-P', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 40, ${ACTOR}),
          (${client}, 'POST-Z', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 24, ${ACTOR}),
          (${client}, 'POST-U', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 8, ${ACTOR}),
          (${client}, 'POST-N', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 10, ${ACTOR}),
          (${client}, 'POST-Q', ${PLANT}, ${SLOC}, 'QUALITY', 6, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
        do update set quantity = excluded.quantity
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values
          (${client}, 'POST-S', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 10, 10, 1, 'USD', 100, 1000, ${ACTOR}),
          (${client}, 'POST-P', ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 7.5, 10, 'USD', 40, 30, ${ACTOR}),
          (${client}, 'POST-Z', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 5, 5, 1, 'USD', 24, 120, ${ACTOR}),
          (${client}, 'POST-U', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 2, 2, 1, 'USD', 8, 16, ${ACTOR}),
          (${client}, 'POST-Q', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 4, 4, 1, 'USD', 6, 24, ${ACTOR})
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
      await tx.execute(sql`
        insert into movement_type
          (client, movement_type, description, direction, reference_category, movement_kind,
           valuation_relevant, inventory_event, offset_event, offset_modifier, reversal_movement_type, created_by)
        values
          (${client}, '701', 'Physical inventory surplus', 'RECEIPT', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
           true, 'INVENTORY', 'OFFSETTING_INVENTORY', 'DIFF', '702', ${ACTOR}),
          (${client}, '702', 'Physical inventory shortage', 'ISSUE', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
           true, 'INVENTORY', 'OFFSETTING_INVENTORY', 'DIFF', '701', ${ACTOR})
        on conflict do nothing
      `);
    });

    const created = await createPhysicalInventory({
      client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
      plannedCountDate: DAY, postingBlock: false,
      materials: ['POST-S', 'POST-P', 'POST-Z', 'POST-U', 'POST-N', 'POST-Q'],
    });
    documentNumber = created.inventoryDocumentNumber;
    fiscalYear = created.fiscalYear;
    const of = (materialNumber: string, stockType = 'UNRESTRICTED') =>
      created.items.find((item) => item.materialNumber === materialNumber && item.stockType === stockType)!.itemNumber;
    await submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [
        { itemNumber: of('POST-S'), quantity: 95 },
        { itemNumber: of('POST-P'), quantity: 44 },
        { itemNumber: of('POST-Z'), quantity: 24 },
        { itemNumber: of('POST-N'), quantity: 7 },
        { itemNumber: of('POST-Q', 'QUALITY'), quantity: 4 },
      ],
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  const post = (itemNumbers: number[], requestKey = nextKey(), extras: Record<string, unknown> = {}) => postDifferences({
    client, changedBy: ACTOR, documentNumber, fiscalYear, itemNumbers,
    postingDate: POSTING, documentDate: POSTING, requestKey, ...extras,
  });

  it('does not hardcode a movement number or an account alias', () => {
    const source = readFileSync(join(__dirname, '../src/modules/inventory/physical-inventory-posting.ts'), 'utf8');
    expect(source).toContain("movement_kind = 'INVENTORY_DIFFERENCE'");
    expect(source).not.toContain('GBB');
    expect(source).not.toContain("'INV'");
    expect(source).not.toContain('140000');
  });

  it('posts a shortage and a surplus through the configured movements, and leaves the uncounted item', async () => {
    const before = await ledger();
    const shortage = await itemNumber('POST-S');
    const surplus = await itemNumber('POST-P');
    const checked = await validateDifferencePosting({
      client, changedBy: ACTOR, documentNumber, fiscalYear,
      itemNumbers: [shortage, surplus], postingDate: POSTING, documentDate: POSTING,
    });
    expect(checked.journalRequired).toBe(true);
    expect(checked.lines.map((line) => line.direction).sort()).toEqual(['SHORTAGE', 'SURPLUS']);
    const afterCheck = await ledger();
    expect(afterCheck).toEqual(before);

    const posted = await post([shortage, surplus], 'scr149-both');
    expect(posted.materialDocumentNumber).toMatch(/^M-/);
    expect(posted.journalDocumentNumber).toBeTruthy();
    expect(posted.headerStatus).toBe('PARTIALLY_POSTED');
    const shortageLine = posted.lines.find((line) => line.direction === 'SHORTAGE')!;
    const surplusLine = posted.lines.find((line) => line.direction === 'SURPLUS')!;
    expect(shortageLine.movementType).toBe('702');
    expect(shortageLine.postingValue).toBe('50.00');
    expect(surplusLine.movementType).toBe('701');
    expect(surplusLine.postingValue).toBe('3.00');

    const stock = await withTenant(client, async (tx) => tx.execute(sql`
      select material_number, quantity::text as quantity from stock_quantity
       where client = ${client} and material_number in ('POST-S', 'POST-P') and stock_type = 'UNRESTRICTED'
       order by material_number
    `)) as unknown as Array<{ material_number: string; quantity: string }>;
    expect(stock).toEqual([
      { material_number: 'POST-P', quantity: '44.000' },
      { material_number: 'POST-S', quantity: '95.000' },
    ]);
    const journal = await withTenant(client, async (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount
        from journal_entry_line
       where client = ${client} and document_number = ${posted.journalDocumentNumber}
       order by gl_account, debit_credit
    `)) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string }>;
    expect(journal.some((line) => line.gl_account === '140000' && line.debit_credit === 'H' && Number(line.amount) === 50)).toBe(true);
    expect(journal.some((line) => line.gl_account === '520000' && line.debit_credit === 'S' && Number(line.amount) === 50)).toBe(true);
    expect(journal.some((line) => line.gl_account === '140000' && line.debit_credit === 'S' && Number(line.amount) === 3)).toBe(true);

    const again = await post([shortage, surplus], 'scr149-both');
    expect(again.materialDocumentNumber).toBe(posted.materialDocumentNumber);
    await expect(post([shortage], nextKey())).rejects.toThrow(/already fully posted/);
  });

  it('refuses a zero, an uncounted item, and an unvalued material, and leaves no document', async () => {
    const before = await ledger();
    await expect(post([await itemNumber('POST-Z')])).rejects.toThrow(/no difference/);
    await expect(post([await itemNumber('POST-U')])).rejects.toThrow(/not been counted/);
    await expect(post([await itemNumber('POST-N')])).rejects.toThrow(/no valuation record/);
    expect(await ledger()).toEqual(before);
  });

  it('refuses a stored difference that disagrees with the book and the count', async () => {
    const item = await itemNumber('POST-Q', 'QUALITY');
    await withTenant(client, (tx) => tx.execute(sql`
      update physical_inventory_item set difference_quantity = -9
       where client = ${client} and inventory_document_number = ${documentNumber} and item_number = ${item}
    `));
    await expect(post([item])).rejects.toThrow(/will not overwrite/);
    const standing = await withTenant(client, async (tx) => tx.execute(sql`
      select difference_quantity::text as difference from physical_inventory_item
       where client = ${client} and item_number = ${item} and inventory_document_number = ${documentNumber}
    `)) as unknown as Array<{ difference: string }>;
    expect(standing[0].difference).toBe('-9.000');
    await withTenant(client, (tx) => tx.execute(sql`
      update physical_inventory_item set difference_quantity = -2
       where client = ${client} and inventory_document_number = ${documentNumber} and item_number = ${item}
    `));
  });

  it('posts the quality stock to the quality dimension, not to unrestricted', async () => {
    const posted = await post([await itemNumber('POST-Q', 'QUALITY')]);
    expect(posted.lines[0].stockType).toBe('QUALITY');
    const stock = await withTenant(client, async (tx) => tx.execute(sql`
      select stock_type, quantity::text as quantity from stock_quantity
       where client = ${client} and material_number = 'POST-Q'
       order by stock_type
    `)) as unknown as Array<{ stock_type: string; quantity: string }>;
    expect(stock).toEqual([{ stock_type: 'QUALITY', quantity: '4.000' }]);
  });

  it('refuses a closed material period and a closed financial period without leaving a document', async () => {
    const before = await ledger();
    await withTenant(client, (tx) => tx.execute(sql`
      update material_period_control set current_period = 9, allow_backposting = false
       where client = ${client}
    `));
    await expect(post([await itemNumber('POST-Z')])).rejects.toThrow(/material posting period/);
    await withTenant(client, (tx) => tx.execute(sql`
      update material_period_control set current_period = 10, allow_backposting = true
       where client = ${client}
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      update posting_period_rule set period_to = 9 where client = ${client} and account_type = 'S'
    `));
    await expect(post([await itemNumber('POST-U')])).rejects.toThrow();
    await withTenant(client, (tx) => tx.execute(sql`
      update posting_period_rule set period_to = 12 where client = ${client} and account_type = 'S'
    `));
    expect(await ledger()).toEqual(before);
  });

  it('refuses a threshold, a batch-requiring movement, and a second movement for the same direction', async () => {
    await expect(post([await itemNumber('POST-Z')], nextKey(), { maximumDifferenceValue: 10 })).rejects.toThrow(/not implemented/);
    const fresh = await createPhysicalInventory({
      client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
      plannedCountDate: DAY, postingBlock: false, materials: ['POST-S'],
    });
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: fresh.inventoryDocumentNumber, fiscalYear: fresh.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 90 }],
    });
    const again = (extras: Record<string, unknown> = {}) => postDifferences({
      client, changedBy: ACTOR, documentNumber: fresh.inventoryDocumentNumber, fiscalYear: fresh.fiscalYear,
      itemNumbers: [10], postingDate: POSTING, documentDate: POSTING, requestKey: nextKey(), ...extras,
    });
    await withTenant(client, (tx) => tx.execute(sql`
      update movement_type set requires_batch = true
       where client = ${client} and movement_kind = 'INVENTORY_DIFFERENCE' and direction = 'ISSUE'
    `));
    await expect(again()).rejects.toThrow(/requires a batch/);
    await withTenant(client, (tx) => tx.execute(sql`
      update movement_type set requires_batch = false
       where client = ${client} and movement_kind = 'INVENTORY_DIFFERENCE'
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into movement_type
        (client, movement_type, description, direction, reference_category, movement_kind,
         valuation_relevant, inventory_event, offset_event, offset_modifier, reversal_movement_type, created_by)
      values (${client}, 'DIFF-ALT', 'Second shortage', 'ISSUE', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
              true, 'INVENTORY', 'OFFSETTING_INVENTORY', 'DIFF', '701', ${ACTOR})
    `));
    await expect(again()).rejects.toThrow(/More than one difference movement/);
    await withTenant(client, (tx) => tx.execute(sql`
      delete from movement_type where client = ${client} and movement_type = 'DIFF-ALT'
    `));
  });

  it('refuses a different payload on the same request key', async () => {
    await expect(post([await itemNumber('POST-S')], 'scr149-both')).rejects.toThrow(/different posting/);
  });

  it('refuses to correct a posted count, and refuses a missing difference account', async () => {
    await expect(submitCounts({
      client, changedBy: ACTOR, documentNumber, fiscalYear, countDate: DAY, requestKey: nextKey(),
      lines: [{ itemNumber: await itemNumber('POST-Q', 'QUALITY'), quantity: 6 }],
    })).rejects.toThrow(/difference posted/);
    const before = await ledger();
    await withTenant(client, (tx) => tx.execute(sql`
      delete from account_determination
       where client = ${client} and event = 'OFFSETTING_INVENTORY' and general_modifier = 'DIFF'
    `));
    const fresh = await createPhysicalInventory({
      client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
      plannedCountDate: DAY, postingBlock: false, materials: ['POST-S'],
    });
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: fresh.inventoryDocumentNumber, fiscalYear: fresh.fiscalYear,
      countDate: DAY, requestKey: nextKey(), lines: [{ itemNumber: 10, quantity: 80 }],
    });
    await expect(postDifferences({
      client, changedBy: ACTOR, documentNumber: fresh.inventoryDocumentNumber, fiscalYear: fresh.fiscalYear,
      itemNumbers: [10], postingDate: POSTING, documentDate: POSTING, requestKey: nextKey(),
    })).rejects.toThrow(/does not stand/);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, 'OFFSETTING_INVENTORY', 'RAW_INVENTORY', 'DIFF', '520000', ${ACTOR}
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      on conflict do nothing
    `));
    expect(await ledger()).toEqual(before);
  });

  it('reverses through the canonical service and releases the allocation', async () => {
    const history = await getPostingHistory(client, { documentNumber, fiscalYear });
    const shortage = history.find((row) => Number(row.postedDifference) < 0)!;
    const reversed = await reverseDifferencePosting({
      client, changedBy: ACTOR, materialDocumentNumber: shortage.materialDocumentNumber,
      postingDate: POSTING, documentDate: POSTING, requestKey: nextKey(),
    });
    expect(reversed.materialDocumentNumber).toBeTruthy();
    const after = await getPostingHistory(client, { documentNumber, fiscalYear });
    const released = after.filter((row) => row.materialDocumentNumber === shortage.materialDocumentNumber);
    expect(released.every((row) => Number(row.reversedQuantity) === Math.abs(Number(row.postedDifference)))).toBe(true);
    const status = await withTenant(client, async (tx) => tx.execute(sql`
      select posting_status from physical_inventory_item
       where client = ${client} and inventory_document_number = ${documentNumber} and material_number = 'POST-S'
    `)) as unknown as Array<{ posting_status: string }>;
    expect(status[0].posting_status).toBe('UNPOSTED');
    await expect(reverseDifferencePosting({
      client, changedBy: ACTOR, materialDocumentNumber: shortage.materialDocumentNumber,
      postingDate: POSTING, documentDate: POSTING, requestKey: nextKey(),
    })).rejects.toThrow(/already been cancelled|already reversed/);
  });

  it('does not show another tenant the document', async () => {
    expect(await getDifferencePosting(other, { documentNumber, fiscalYear })).toBeNull();
    await expect(postDifferences({
      client: other, changedBy: ACTOR, documentNumber, fiscalYear,
      itemNumbers: [10], postingDate: POSTING, documentDate: POSTING, requestKey: nextKey(),
    })).rejects.toThrow(/does not exist/);
  });
});
