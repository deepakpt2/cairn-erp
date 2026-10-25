import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { createProductionOrder, releaseProductionOrder } from '../../src/modules/inventory/production-orders';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const MIGO = '/inventory/migo';

/**
 * SCR-140 browser acceptance: MIGO A01 + R08 — the finished good comes back from the order.
 *
 * The run releases an order, receives part of its output from the matrix cell that used to
 * refuse, reads the value, the stock and the two accounts off the ledger, asks for more than
 * the order still expects and is refused with the number in the sentence, then receives the
 * rest until the order stands complete.
 */
export async function migoProductionReceipt(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-140: receive a production order’s finished good from MIGO A01 + R08');

  const company = await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code, currency from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string; currency: string }>;
    if (!companies[0]) throw new Error('the browser tenant carries no company code');
    const code = companies[0].company_code;
    const currency = companies[0].currency;

    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.n, v.d, t.material_type, 'PC', 'browser.admin'
      from (values ('MGR-FG', 'Order finished good'), ('MGR-RM', 'Order component')) as v(n, d)
      cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, 'QG02', 'Receipt plant', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${client}, v.n, 'QG02', 'browser.admin'
      from (values ('MGR-FG'), ('MGR-RM')) as v(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, 'QG02', 'SG02', 'Finished store', true, false, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true, allow_negative_stock = false
    `);
    // The finished good is standard-priced at 40 per unit, so the receipt is worth what it is,
    // not what it cost to make. Its component is moving-average at 10.
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values (${client}, 'MGR-FG', 'QG02', 'FINISHED_INVENTORY', 'STANDARD', 40, 40, 1, ${currency}, 0, 0, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values (${client}, 'MGR-RM', 'QG02', 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, ${currency}, 100, 1000, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, 'MGR-RM', 'QG02', 'SG02', 'UNRESTRICTED', 100, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number) do update set quantity = 100
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, ${code}, 2026, 10, 2026, 9, true, 'browser.admin')
      on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10
    `);
    await tx.execute(sql`
      insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                              is_balance_sheet, is_open_item_managed, reconciliation_type,
                              requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
      select ${client}, c.chart_of_accounts, v.n, v.d, v.t,
             v.balance, false, null, false, false, 'GENL', v.kind, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values
        ('121960', 'Finished goods inventory', 'ASSET', true, 'BALANCE_SHEET'),
        ('122960', 'Component inventory', 'ASSET', true, 'BALANCE_SHEET'),
        ('590960', 'Production output', 'EXPENSE', false, 'PL_STATEMENT'),
        ('510960', 'Production consumption', 'EXPENSE', false, 'PL_STATEMENT')
      ) as v(n, d, t, balance, kind)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, v.e, v.vc, '', v.a, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values
        ('INVENTORY', 'FINISHED_INVENTORY', '121960'),
        ('PRODUCTION_OUTPUT', 'FINISHED_INVENTORY', '590960'),
        ('INVENTORY', 'RAW_INVENTORY', '122960'),
        ('PRODUCTION_CONSUMPTION', 'RAW_INVENTORY', '510960')
      ) as v(e, vc, a)
      on conflict do nothing
    `);
    return code;
  });

  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: 'browser.admin' });
    await tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${client}, 'PP01', 'Standard production', '10', ${'browser.admin'})
      on conflict (client, order_type) do nothing
    `);
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8, createdBy: 'browser.admin' });
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: company, subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
  });

  const order = await createProductionOrder({
    orderType: 'PP01',
    client, createdBy: 'browser.admin',
    materialNumber: 'MGR-FG', plant: 'QG02', orderQuantity: 10,
    scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
    components: [{ materialNumber: 'MGR-RM', plant: 'QG02', storageLocation: 'SG02', requiredQuantity: 20 }],
  });
  await releaseProductionOrder({ client, orderNumber: order.orderNumber, releasedBy: 'browser.admin' });
  console.log(`  ✓ order ${order.orderNumber} stands released for ten of MGR-FG`);

  const receive = async (quantity: string) => {
    await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'Goods Movement', exact: true }).waitFor();
    await page.selectOption('select[name="migoAction"]', 'A01');
    await page.selectOption('select[name="migoReference"]', 'R08');
    const cell = page.locator('[data-cell]');
    await cell.waitFor();
    assert.equal(await cell.getAttribute('data-cell'), 'POST_HERE', 'A01 + R08 posts here');
    assert.match(await cell.innerText(), /101/, 'and names movement 101');

    await page.fill('input[name="orderNumber"]', order.orderNumber);
    await page.fill('input[name="postingDate"]', '2026-10-16');
    await page.fill('input[name="documentDate"]', '2026-10-16');
    await page.fill('input[name="headerText"]', 'Output of the order');
    await page.fill('input[name="storageLocation"]', 'SG02');
    await page.fill('input[name="quantity"]', quantity);
    await page.getByRole('button', { name: 'Receive the finished good', exact: true }).click();
  };

  // First receipt: four of the ten.
  await receive('4');
  await page.locator('p[role="status"]').filter({ hasText: 'Posted: material document' }).waitFor();
  const documentNumber = /Posted: material document ([^\s.]+)\./
    .exec(await page.locator('p[role="status"]').first().innerText())![1];
  assert.equal(
    await page.locator('[data-received-after]').first().getAttribute('data-received-after'), '4.000',
    'the result says how much of the order has arrived',
  );
  assert.equal(
    await page.locator('[data-order-open]').first().getAttribute('data-order-open'), '6.000',
    'and what it still expects',
  );
  const journalLink = page.locator(`a[href^="/finance/journal/document?document="]`).first();
  await journalLink.waitFor();
  const mb03Link = page.locator('a[href^="/inventory/material-documents?document="]').first();
  await mb03Link.waitFor();

  // The stock, the valuation and the ledger, read independently of the screen.
  const after = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select quantity::text from stock_quantity
          where client = ${client} and material_number = 'MGR-FG' and plant = 'QG02'
            and storage_location = 'SG02' and stock_type = 'UNRESTRICTED') as stock,
        (select stock_value::text from material_valuation
          where client = ${client} and material_number = 'MGR-FG' and valuation_area = 'QG02') as value,
        (select line_direction from material_document_line
          where client = ${client} and material_document_number = ${documentNumber} and line_number = 1) as direction,
        (select production_order_number from material_document_line
          where client = ${client} and material_document_number = ${documentNumber} and line_number = 1) as ondoc,
        (select gl_account from journal_entry_line
          where client = ${client} and document_number = (
            select journal_document_number from material_document
            where client = ${client} and material_document_number = ${documentNumber}
          ) and debit_credit = 'S' limit 1) as debit,
        (select gl_account from journal_entry_line
          where client = ${client} and document_number = (
            select journal_document_number from material_document
            where client = ${client} and material_document_number = ${documentNumber}
          ) and debit_credit = 'H' limit 1) as credit,
        (select count(*)::int from journal_entry_line
          where client = ${client} and document_number = (
            select journal_document_number from material_document
            where client = ${client} and material_document_number = ${documentNumber}
          ) and production_order = ${order.orderNumber}) as named
    `) as unknown as Array<{
      stock: string; value: string; direction: string; ondoc: string;
      debit: string; credit: string; named: number;
    }>;
    return rows[0];
  });
  assert.equal(Number(after.stock), 4, 'the finished good stands in stock');
  assert.equal(Number(after.value), 160, 'at the material’s own price: four times forty');
  assert.equal(after.direction, 'RECEIPT', 'the line receives');
  assert.equal(after.ondoc, order.orderNumber, 'the material-document line names the order');
  assert.equal(after.debit, '121960', 'inventory is debited');
  assert.equal(after.credit, '590960', 'production output is credited, not consumption');
  assert.equal(after.named, 2, 'and the order stands on both journal lines');

  // More than the order still expects is refused with the number in the sentence. A fresh load
  // gives the form a fresh request key: the same key would replay the receipt already posted.
  await receive('7');
  await page.locator('p[role="status"]')
    .filter({ hasText: 'still expects 6.000 PC of MGR-FG' }).waitFor();

  // The rest, until the order stands complete.
  await receive('6');
  await page.locator('p[role="status"]').filter({ hasText: 'Posted: material document' }).waitFor();
  assert.equal(
    await page.locator('[data-received-after]').first().getAttribute('data-received-after'), '10.000',
  );
  assert.equal(
    await page.locator('[data-order-open]').first().getAttribute('data-order-open'), '0.000',
    'the order expects nothing further',
  );

  console.log(`SCR-140: ${documentNumber} received the finished good of ${order.orderNumber}; the ledger credits production output`);
}
