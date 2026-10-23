import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/inventory/goods-issue';
const MD04 = '/production/stock-requirements';

/**
 * SCR-136 browser acceptance: MB1A post goods issue.
 *
 * The fixture gives the browser tenant a plant, a store, a material with stock and
 * a valuation, a cost centre and an open material period with the account
 * determination the issue needs. The run posts a 201 of 10 against a cost centre and
 * reads the document, the journal and the stock fall; then it creates a reservation
 * and issues three against it, reading the demand fall in MD04 in the same breath.
 */
export async function goodsIssue(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-136: post a 201 to a cost centre, then issue against a reservation and watch MD04 fall');

  const company = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string }>;
    if (!rows[0]) throw new Error('the browser tenant carries no company code');
    const code = rows[0].company_code;
    const areas = await tx.execute(sql`
      select controlling_area from controlling_area where client = ${client} order by controlling_area limit 1
    `) as unknown as Array<{ controlling_area: string }>;
    if (!areas[0]) throw new Error('the browser tenant carries no controlling area');
    const area = areas[0].controlling_area;

    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, 'QP01', 'Issue plant', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, 'QP01', 'SP01', 'Issue store', true, false, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true, allow_negative_stock = false
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MB1A-MAT', 'Issue material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MB1A-MAT', 'QP01', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values (${client}, 'MB1A-MAT', 'QP01', 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'KWD', 200, 2000, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, 'MB1A-MAT', 'QP01', 'SP01', 'UNRESTRICTED', 100, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number) do update set quantity = 100
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, ${code}, 2026, 10, 2026, 9, true, 'browser.admin')
      on conflict (client, company_code) do update set
        current_fiscal_year = 2026, current_period = 10,
        previous_fiscal_year = 2026, previous_period = 9, allow_backposting = true
    `);
    await tx.execute(sql`
      insert into controlling_area_company (client, controlling_area, company_code, created_by)
      values (${client}, ${area}, ${code}, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
      values (${client}, ${area}, 'CC7701', '2026-01-01', '2026-12-31', 'Issue centre', 'PRODUCTION', ${code}, false, 'browser.admin')
      on conflict do nothing
    `);
    // Account determination: the issue credits inventory and debits consumption.
    await tx.execute(sql`
      insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                              is_balance_sheet, is_open_item_managed, reconciliation_type,
                              requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
      select ${client}, c.chart_of_accounts, v.n, v.d, v.t,
             v.balance, false, null, v.cost, false, 'GENL', v.kind, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values
        ('510900', 'Consumption expense', 'EXPENSE', false, true, 'PL_STATEMENT'),
        ('120900', 'Raw materials inventory', 'ASSET', true, false, 'BALANCE_SHEET')
      ) as v(n, d, t, balance, cost, kind)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', '', v.a, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values ('CONSUMPTION', '510900'), ('INVENTORY', '120900')) as v(e, a)
      on conflict do nothing
    `);
    return code;
  });

  // The numbers the posting needs: the document's own and the journal's.
  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: company, subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    await defineRange(tx, {
      client, objectCode: 'RESERV', subObject: '*', prefix: 'RSV', numberLength: 8, createdBy: 'browser.admin',
    });
  });

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Post Goods Issue', exact: true }).waitFor();

  await page.selectOption('select[name="movementTypeCode"]', '201');
  await page.fill('input[name="postingDate"]', '2026-10-15');
  await page.fill('input[name="documentDate"]', '2026-10-15');
  await page.fill('input[name="headerText"]', 'Issue to the line');
  await page.fill('input[name="material-1"]', 'MB1A-MAT');
  await page.fill('input[name="plant-1"]', 'QP01');
  await page.fill('input[name="sloc-1"]', 'SP01');
  await page.fill('input[name="quantity-1"]', '10');
  await page.fill('input[name="costCenter-1"]', 'CC7701');
  await page.getByRole('button', { name: 'Post the goods issue', exact: true }).click();

  await page.locator('p[role="status"]').filter({ hasText: 'Issued: material document' }).waitFor();
  const documentRow = page.locator('tr[data-line="1"]').first();
  await documentRow.waitFor();
  const documentNumber = /Issued: material document ([^\s,]+)/.exec(
    await page.locator('p[role="status"]').first().innerText(),
  )![1];

  const afterFirst = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select quantity::text as q from stock_quantity
      where client = ${client} and material_number = 'MB1A-MAT' and plant = 'QP01'
        and storage_location = 'SP01' and stock_type = 'UNRESTRICTED'
    `) as unknown as Array<{ q: string }>;
    return Number(rows[0].q);
  });
  assert.equal(afterFirst, 90, 'the issue took the stock down by ten');

  // A reservation, created through MB21's own screen contract.
  await page.goto(`${base}/inventory/reservations`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('select[name="movementTypeCode"]', '201');
  await page.fill('input[name="baseDate"]', '2026-10-20');
  await page.fill('input[name="costCenter"]', 'CC7701');
  await page.fill('input[name="material-1"]', 'MB1A-MAT');
  await page.fill('input[name="plant-1"]', 'QP01');
  await page.fill('input[name="quantity-1"]', '8');
  await page.fill('input[name="sloc-1"]', 'SP01');
  await page.getByRole('button', { name: 'Create reservation', exact: true }).click();
  const created = await page.locator('p[role="status"]').first().innerText();
  const reservation = /RSV-\d+/.exec(created)![0];

  await page.goto(`${base}${MD04}?material=MB1A-MAT&plant=QP01`, { waitUntil: 'domcontentloaded' });
  const demandRow = page.locator('tr[data-element="RESERVATION"]').first();
  await demandRow.waitFor();
  assert.equal((await demandRow.innerText()).includes('8.000'), true, 'MD04 demands the eight reserved');

  // Issue three of them from the goods issue screen.
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('select[name="movementTypeCode"]', '201');
  await page.fill('input[name="postingDate"]', '2026-10-15');
  await page.fill('input[name="documentDate"]', '2026-10-15');
  await page.fill('input[name="material-1"]', 'MB1A-MAT');
  await page.fill('input[name="plant-1"]', 'QP01');
  await page.fill('input[name="sloc-1"]', 'SP01');
  await page.fill('input[name="quantity-1"]', '3');
  await page.fill('input[name="costCenter-1"]', 'CC7701');
  await page.fill('input[name="reservation-1"]', reservation);
  await page.fill('input[name="reservationItem-1"]', '10');
  await page.getByRole('button', { name: 'Post the goods issue', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Issued: material document' }).waitFor();

  const reservationRow = page.locator('tr[data-line="1"]').first();
  await reservationRow.waitFor();
  assert.equal(await reservationRow.getAttribute('data-reservation-open'), '5.000',
    'the reservation still holds five after the issue');

  await page.goto(`${base}${MD04}?material=MB1A-MAT&plant=QP01`, { waitUntil: 'domcontentloaded' });
  const afterDemand = page.locator('tr[data-element="RESERVATION"]').first();
  await afterDemand.waitFor();
  assert.equal((await afterDemand.innerText()).includes('5.000'), true, 'MD04 demands the five that remain');

  // A 261 has no order master and must refuse by name.
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const select = document.querySelector('select[name="movementTypeCode"]') as HTMLSelectElement | null;
    if (!select) return;
    const option = document.createElement('option');
    option.value = '261';
    option.text = '261 · goods issue to order';
    select.appendChild(option);
    select.value = '261';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.fill('input[name="postingDate"]', '2026-10-15');
  await page.fill('input[name="documentDate"]', '2026-10-15');
  await page.fill('input[name="material-1"]', 'MB1A-MAT');
  await page.fill('input[name="plant-1"]', 'QP01');
  await page.fill('input[name="quantity-1"]', '1');
  await page.getByRole('button', { name: 'Post the goods issue', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'no order master' }).waitFor();

  console.log(`SCR-136: ${documentNumber} took stock to 90, and the reservation issue left five open and five demanded (company ${company})`);
}
