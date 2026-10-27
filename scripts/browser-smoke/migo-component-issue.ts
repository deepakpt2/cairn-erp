import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { createProductionOrder, releaseProductionOrder } from '../../src/modules/inventory/production-orders';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const MIGO = '/inventory/migo';

/**
 * SCR-139 browser acceptance: MIGO 261 goods issue to a production order.
 *
 * One screen, an action and a reference. The run posts A07 + R08 for ten components
 * against a released order, reads the order's remaining requirement off the result,
 * confirms the ledger carries the order, and walks three other cells of the matrix:
 * a delivered one that links away, and a refused one that names its capability.
 */
export async function migoComponentIssue(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-139: post 261 against a released order from MIGO, then walk the matrix');

  const company = await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code, currency from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string; currency: string }>;
    if (!companies[0]) throw new Error('the browser tenant carries no company code');
    const code = companies[0].company_code;

    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.n, v.d, v.t, 'PC', 'browser.admin'
      from (values ('MIGO-FG', 'Order output', 'FIN'), ('MIGO-RM', 'Order component', 'RAW')) as v(n, d, t)
      on conflict do nothing
    `);
    // The type is named per material because the ledger refuses a valuation class the material
    // type does not permit: RAW_INVENTORY belongs to a RAW material, not to whatever type the
    // tenant happens to have first.
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, 'QG01', 'MIGO plant', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${client}, v.n, 'QG01', 'browser.admin'
      from (values ('MIGO-FG'), ('MIGO-RM')) as v(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, 'QG01', 'SG01', 'MIGO store', true, false, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true, allow_negative_stock = false
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values (${client}, 'MIGO-RM', 'QG01', 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, ${companies[0].currency}, 100, 1000, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, 'MIGO-RM', 'QG01', 'SG01', 'UNRESTRICTED', 100, 'browser.admin')
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
        ('510960', 'Production consumption', 'EXPENSE', false, 'PL_STATEMENT'),
        ('120960', 'Component inventory', 'ASSET', true, 'BALANCE_SHEET')
      ) as v(n, d, t, balance, kind)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', '', v.a, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values ('PRODUCTION_CONSUMPTION', '510960'), ('INVENTORY', '120960')) as v(e, a)
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
    materialNumber: 'MIGO-FG', plant: 'QG01', orderQuantity: 10,
    scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
    components: [{ materialNumber: 'MIGO-RM', plant: 'QG01', storageLocation: 'SG01', requiredQuantity: 25 }],
  });
  await releaseProductionOrder({ client, orderNumber: order.orderNumber, releasedBy: 'browser.admin' });
  console.log(`  ✓ order ${order.orderNumber} stands released with 25 of MIGO-RM required`);

  await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Goods Movement', exact: true }).waitFor();

  // The default cell is this round's: A07 + R08.
  await page.selectOption('select[name="migoAction"]', 'A07');
  await page.selectOption('select[name="migoReference"]', 'R08');
  const cell = page.locator('[data-cell]');
  await cell.waitFor();
  assert.equal(await cell.getAttribute('data-cell'), 'POST_HERE', 'A07 + R08 posts here');

  await page.fill('input[name="orderNumber"]', order.orderNumber);
  await page.fill('input[name="postingDate"]', '2026-10-15');
  await page.fill('input[name="documentDate"]', '2026-10-15');
  await page.fill('input[name="headerText"]', 'Issue to the order');
  await page.fill('input[name="material-1"]', 'MIGO-RM');
  await chooseClosed(page, 'plant-1', 'QG01');
  await chooseClosed(page, 'sloc-1', 'SG01');
  await page.fill('input[name="quantity-1"]', '10');
  await page.fill('input[name="orderItem-1"]', '10');
  await page.getByRole('button', { name: 'Post the movement', exact: true }).click();

  await page.locator('p[role="status"]').filter({ hasText: 'Posted: material document' }).waitFor();
  const message = await page.locator('p[role="status"]').first().innerText();
  const documentNumber = /Posted: material document ([^\s.]+)\./.exec(message)![1];
  const stillRequired = await page.locator('[data-order-open]').first().getAttribute('data-order-open');
  assert.equal(stillRequired, '15.000', 'the result says what the order still requires');

  // The ledger and the stock, read independently of the screen.
  const after = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select quantity::text from stock_quantity
          where client = ${client} and material_number = 'MIGO-RM' and plant = 'QG01'
            and storage_location = 'SG01' and stock_type = 'UNRESTRICTED') as stock,
        (select production_order_number from material_document_line
          where client = ${client} and material_document_number = ${documentNumber} and line_number = 1) as ondoc,
        (select production_order from journal_entry_line
          where client = ${client} and document_number = (
            select journal_document_number from material_document
            where client = ${client} and material_document_number = ${documentNumber}
          ) and debit_credit = 'S' limit 1) as onjournal,
        (select gl_account from journal_entry_line
          where client = ${client} and document_number = (
            select journal_document_number from material_document
            where client = ${client} and material_document_number = ${documentNumber}
          ) and debit_credit = 'S' limit 1) as debit
    `) as unknown as Array<{ stock: string; ondoc: string; onjournal: string; debit: string }>;
    return rows[0];
  });
  assert.equal(Number(after.stock), 90, 'the issue took the component stock down by ten');
  assert.equal(after.ondoc, order.orderNumber, 'the material-document line names the order');
  assert.equal(after.onjournal, order.orderNumber, 'the journal line names the order');
  assert.equal(after.debit, '510960', 'production consumption is debited, not inventory');

  // A delivered cell links away rather than posting here.
  await page.selectOption('select[name="migoAction"]', 'A01');
  await page.selectOption('select[name="migoReference"]', 'R01');
  const elsewhere = page.locator('[data-cell="ELSEWHERE"]');
  await elsewhere.waitFor();
  assert.match(await elsewhere.innerText(), /INV\.GR\.POST/, 'the receipt cell names the capability that posts it');
  assert.equal(
    (await elsewhere.locator('a').getAttribute('href')), '/inventory/goods-receipt',
    'and links to it',
  );

  // The order's finished good coming back posts here since SCR-140, as its own movement.
  await page.selectOption('select[name="migoAction"]', 'A01');
  await page.selectOption('select[name="migoReference"]', 'R08');
  const receipt = page.locator('[data-cell="POST_HERE"]');
  await receipt.waitFor();
  assert.match(await receipt.innerText(), /101/, 'A01 + R08 posts movement 101 from this screen');

  // A refused cell still names what would deliver it.
  await page.selectOption('select[name="migoAction"]', 'A02');
  const refused = page.locator('[data-cell="REFUSED"]');
  await refused.waitFor();
  assert.match(await refused.innerText(), /return/i, 'the return delivery refuses by name');

  // An over-issue is refused with the number in the sentence. A fresh load gives the form a
  // fresh request key: the same key would replay the document already posted, which is the
  // duplicate-submit protection doing its job.
  await page.goto(`${base}${MIGO}`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('select[name="migoAction"]', 'A07');
  await page.selectOption('select[name="migoReference"]', 'R08');
  await page.fill('input[name="orderNumber"]', order.orderNumber);
  await page.fill('input[name="postingDate"]', '2026-10-15');
  await page.fill('input[name="documentDate"]', '2026-10-15');
  await page.fill('input[name="material-1"]', 'MIGO-RM');
  await chooseClosed(page, 'plant-1', 'QG01');
  await chooseClosed(page, 'sloc-1', 'SG01');
  await page.fill('input[name="quantity-1"]', '16');
  await page.fill('input[name="orderItem-1"]', '10');
  await page.getByRole('button', { name: 'Post the movement', exact: true }).click();
  await page.locator('p[role="status"]')
    .filter({ hasText: 'still requires 15.000 PC of MIGO-RM' }).waitFor();

  console.log(`SCR-139: ${documentNumber} issued ten components to ${order.orderNumber}; the ledger names the order`);
}
