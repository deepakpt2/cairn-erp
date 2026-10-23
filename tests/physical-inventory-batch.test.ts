import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { createBatch } from '../src/modules/inventory/batch-master';
import { postGoodsIssue, GoodsIssueError } from '../src/modules/inventory/goods-issue';
import { submitCounts } from '../src/modules/inventory/physical-inventory-count';
import { postDifferences } from '../src/modules/inventory/physical-inventory-posting';
import { createPhysicalInventory } from '../src/modules/inventory/physical-inventory';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'PI_BATCH_TEST';
const PLANT = 'QB01';
const DAY = '2026-10-20';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function standing(seed: string): Promise<string> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const client = tenant.client;
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
      values (${client}, 'PI-BATCH', 'Counted batch', 'RAW', 'PC', true, ${ACTOR}),
             (${client}, 'PI-PLAIN', 'Counted plain', 'RAW', 'PC', false, ${ACTOR})
      on conflict (client, material_number) do update set batch_managed = excluded.batch_managed
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      select ${client}, ${PLANT}, 'Count plant', c.company_code, 'KW', ${ACTOR}
      from (select company_code from company_code where client = ${client} order by company_code limit 1) c
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'PI-BATCH', ${PLANT}, ${ACTOR}),
             (${client}, 'PI-PLAIN', ${PLANT}, ${ACTOR})
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, ${PLANT}, 'SB01', 'Count store', true, false, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      select ${client}, v.n, ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 10, 10, 1, c.currency, 8, 80, ${ACTOR}
      from (values ('PI-BATCH'), ('PI-PLAIN')) as v(n)
      cross join (select currency from company_code where client = ${client} limit 1) c
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by)
      values (${client}, 'PI-BATCH', ${PLANT}, 'SB01', 'UNRESTRICTED', '00012', 8, ${ACTOR}),
             (${client}, 'PI-BATCH', ${PLANT}, 'SB01', 'UNRESTRICTED', '00013', 3, ${ACTOR}),
             (${client}, 'PI-BATCH', ${PLANT}, 'SB01', 'UNRESTRICTED', '', 100, ${ACTOR})
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
      do update set quantity = excluded.quantity
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
        ('520000', 'Inventory difference', 'EXPENSE', false, 'PL_STATEMENT'),
        ('595960', 'Scrap', 'EXPENSE', false, 'PL_STATEMENT')
      ) v(n, d, t, b, k)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', v.m, v.a, ${ACTOR}
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values ('INVENTORY', '', '140000'), ('OFFSETTING_INVENTORY', 'DIFF', '520000'), ('SCRAP', '', '595960')) v(e, m, a)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      select ${client}, c.company_code, 2026, 10, 2026, 9, true, ${ACTOR}
      from (select company_code from company_code where client = ${client} limit 1) c
      on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10, allow_backposting = true
    `);
  });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PHYINV', subObject: '*', fiscalYear: 2026, prefix: 'PI', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8, createdBy: ACTOR });
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
    });
  });
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
  await createBatch({ client, changedBy: ACTOR, materialNumber: 'PI-BATCH', batchNumber: '00012', reason: 'Count batch' });
  await createBatch({ client, changedBy: ACTOR, materialNumber: 'PI-BATCH', batchNumber: '00013', reason: 'Other batch' });
  return client;
}

describe('physical inventory of a standing batch', () => {
  it('counts and posts the named batch, and does not take the blank balance', async () => {
    const client = await standing('pi-batch-count');
    const document = await createPhysicalInventory({
      client, createdBy: ACTOR, plant: PLANT, storageLocation: 'SB01',
      plannedCountDate: DAY, postingBlock: true,
      materials: ['PI-BATCH'], batches: ['00012'],
      requestKey: 'pi-batch-create',
    });
    expect(document.items.map((item) => item.batch)).toEqual(['00012']);
    expect(document.items[0]?.stockQuantity).toBe('8.000');
    await submitCounts({
      client, changedBy: ACTOR, documentNumber: document.inventoryDocumentNumber, fiscalYear: document.fiscalYear,
      countDate: DAY, requestKey: 'pi-batch-enter',
      lines: [{ itemNumber: document.items[0]!.itemNumber, quantity: 6 }],
    });
    const posted = await postDifferences({
      client, changedBy: ACTOR, documentNumber: document.inventoryDocumentNumber, fiscalYear: document.fiscalYear,
      itemNumbers: [document.items[0]!.itemNumber], postingDate: DAY, documentDate: DAY, requestKey: 'pi-batch-post',
    });
    expect(posted.lines[0]?.batch).toBe('00012');
    const stock = await withTenant(client, (tx) => tx.execute(sql`
      select batch_number, quantity::text as quantity from stock_quantity
       where client = ${client} and material_number = 'PI-BATCH' and storage_location = 'SB01'
       order by batch_number
    `)) as unknown as Array<{ batch_number: string; quantity: string }>;
    expect(stock).toEqual([
      { batch_number: '', quantity: '100.000' },
      { batch_number: '00012', quantity: '6.000' },
      { batch_number: '00013', quantity: '3.000' },
    ]);
  });

  it('refuses a missing batch, a batch that does not stand, and a batch on a material that is not batch-managed', async () => {
    const client = await standing('pi-batch-refuse');
    const base = {
      client, createdBy: ACTOR, plant: PLANT, storageLocation: 'SB01',
      plannedCountDate: DAY, postingBlock: false,
    };
    await expect(createPhysicalInventory({
      ...base, materials: ['PI-BATCH'], requestKey: 'pi-missing',
    })).rejects.toThrow(/batch is required/i);
    await expect(createPhysicalInventory({
      ...base, materials: ['PI-BATCH'], batches: ['MISSING'], requestKey: 'pi-unknown',
    })).rejects.toThrow(/does not stand/i);
    await expect(createPhysicalInventory({
      ...base, materials: ['PI-PLAIN'], batches: ['00012'], requestKey: 'pi-plain',
    })).rejects.toThrow(/not batch-managed/i);
    const both = await createPhysicalInventory({
      ...base, materials: ['PI-BATCH', 'PI-BATCH'], batches: ['00012', '00013'], requestKey: 'pi-both',
    });
    expect(both.items.map((item) => item.batch).sort()).toEqual(['00012', '00013']);
  });

  it('blocks a movement of the counted batch and lets another batch of the same material move', async () => {
    const client = await standing('pi-batch-block');
    await createPhysicalInventory({
      client, createdBy: ACTOR, plant: PLANT, storageLocation: 'SB01',
      plannedCountDate: DAY, postingBlock: true,
      materials: ['PI-BATCH'], batches: ['00012'],
      requestKey: 'pi-block',
    });
    const blocked = await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '551',
      postingDate: DAY, documentDate: DAY,
      lines: [{ materialNumber: 'PI-BATCH', plant: PLANT, storageLocation: 'SB01', quantity: 1, batch: '00012' }],
      requestKey: 'pi-block-issue',
    }).catch((error: unknown) => error as GoodsIssueError);
    expect(blocked).toBeInstanceOf(GoodsIssueError);
    expect((blocked as GoodsIssueError).message).toMatch(/blocks postings/);
    await postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '551',
      postingDate: DAY, documentDate: DAY,
      lines: [{ materialNumber: 'PI-BATCH', plant: PLANT, storageLocation: 'SB01', quantity: 1, batch: '00013' }],
      requestKey: 'pi-other-issue',
    });
    const stock = await withTenant(client, (tx) => tx.execute(sql`
      select batch_number, quantity::text as quantity from stock_quantity
       where client = ${client} and material_number = 'PI-BATCH' and storage_location = 'SB01'
         and batch_number in ('00012', '00013')
       order by batch_number
    `)) as unknown as Array<{ batch_number: string; quantity: string }>;
    expect(stock).toEqual([
      { batch_number: '00012', quantity: '8.000' },
      { batch_number: '00013', quantity: '2.000' },
    ]);
  });
});
