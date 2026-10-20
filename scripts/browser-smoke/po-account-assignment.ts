import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/orders-by-account-assignment';

/**
 * SCR-129 browser acceptance: ME2K purchase orders by account assignment.
 *
 * Order 1 item 10 (value 100) splits 60/40 across two cost centres and is fully
 * delivered and invoiced; order 2 item 20 (value 50) sits wholly on CC2000 and
 * is not. The report must split the values, group them back to 60 and 90, scope
 * to the open order, refuse the categories this canon cannot carry by name, and
 * drill to the order.
 */
export async function poAccountAssignment(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-129: split order commitments across cost centres, group them, then drill to the order');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, country, currency, chart_of_accounts, created_by)
      select ${client}, '1000', 'Browser company', 'KW', 'KWD', c.chart_of_accounts, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by) values (${client}, 'QE01', 'Plant E', 'KW', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, created_by) values (${client}, 'O920', 'Browser org', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, 'G92', 'Browser group', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name, created_by) values (${client}, 'V92000', 'Browser supplier', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      select ${client}, ca.controlling_area, v.code, '2026-01-01', '2026-12-31', v.name, 'ADMINISTRATION', '1000', 'browser.admin'
      from (select controlling_area from controlling_area where client = ${client} limit 1) ca
      cross join (values ('CC1000', 'Cost centre 1000'), ('CC2000', 'Cost centre 2000')) as v(code, name)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'ME2K-MAT', 'Assigned material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order (client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
                                  company_code, currency, document_date, release_status, created_by) values
        (${client}, '4710000001', 'STANDARD', 'V92000', 'O920', 'G92', '1000', 'KWD', '2026-02-10', 'RELEASED', 'browser.admin'),
        (${client}, '4710000002', 'STANDARD', 'V92000', 'O920', 'G92', '1000', 'KWD', '2026-03-15', 'RELEASED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_item (client, order_number, item_number, item_category, account_assignment_category,
                                       short_text, quantity, unit, net_price, price_unit, net_value, plant, created_by) values
        (${client}, '4710000001', 10, 'STANDARD', 'COST_CENTER', 'Split item', 10, 'PC', 10, 1, 100, 'QE01', 'browser.admin'),
        (${client}, '4710000002', 20, 'STANDARD', 'COST_CENTER', 'Whole item', 5, 'PC', 10, 1, 50, 'QE01', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_assignment (client, order_number, item_number, line_number, gl_account, cost_center, distribution_percentage, created_by) values
        (${client}, '4710000001', 10, 1, '500000', 'CC1000', 60, 'browser.admin'),
        (${client}, '4710000001', 10, 2, '500000', 'CC2000', 40, 'browser.admin'),
        (${client}, '4710000002', 20, 1, '500000', 'CC2000', 100, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_schedule_line (client, order_number, item_number, line_number, delivery_date, quantity, created_by) values
        (${client}, '4710000001', 10, 1, '2026-03-01', 10, 'browser.admin'),
        (${client}, '4710000002', 20, 1, '2026-04-01', 5, 'browser.admin')
      on conflict do nothing
    `);
  });

  // ── The split and the grouping ────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?scopeOfList=ALV&scope=ALL`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Purchase Orders by Account Assignment', exact: true }).waitFor();
  const splitLine = page.locator('tr[data-order="4710000001"][data-cost-center="CC1000"]').first();
  await splitLine.waitFor();
  const cells = (await splitLine.locator('td').allInnerTexts()).map((text) => text.trim());
  // item, line, cost centre, G/L, material, description, plant, qty, unit, net value, %, assigned value
  assert.equal(cells[9], '100.00', 'the item net value');
  assert.equal(cells[10], '60.00', 'the distribution percentage');
  assert.equal(cells[11], '60.00', `60% of 100 assigned to CC1000: ${cells.join(' | ')}`);
  const forty = page.locator('tr[data-order="4710000001"][data-cost-center="CC2000"]').first();
  assert.equal((await forty.locator('td').allInnerTexts())[11].trim(), '40.00', '40% of 100 assigned to CC2000');
  console.log('  ✓ the split item distributes 60/40 across two cost centres and adds back to 100');

  const group1000 = page.locator('tr[data-group="CC1000"]').first();
  await group1000.waitFor();
  assert.match(await group1000.innerText(), /60\.00/, 'CC1000 commits 60');
  const group2000 = page.locator('tr[data-group="CC2000"]').first();
  assert.match(await group2000.innerText(), /90\.00/, 'CC2000 commits 90 across two lines');
  assert.match(await page.locator('body').innerText(), /Total:\s*150\.00/, 'the commitment total is 150');
  console.log('  ✓ the groups add up: CC1000 60 and CC2000 90 over two lines, 150 in all');

  // ── The scope of selection ───────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?scopeOfList=ALV&scope=STILL_TO_BE_DELIVERED`, { waitUntil: 'domcontentloaded' });
  await page.locator('tr[data-order="4710000002"]').first().waitFor();
  assert.equal(await page.locator('tr[data-order="4710000001"]').count(), 0, 'the delivered order leaves the open scope');
  console.log('  ✓ the still-to-be-delivered scope carries only the order that is short');

  await page.goto(`${base}${ROUTE}?scopeOfList=ALV&scope=COMPLETED`, { waitUntil: 'domcontentloaded' });
  await page.locator('tr[data-order="4710000001"]').first().waitFor();
  assert.equal(await page.locator('tr[data-order="4710000002"]').count(), 0, 'the open order leaves the completed scope');
  console.log('  ✓ the completed scope carries only the order that is closed out');

  // ── Refusals by name ─────────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?scopeOfList=ALV&scope=ALL&accountAssignmentCategory=P`, { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: 'category P (WBS element) is not carried' }).waitFor();
  console.log('  ✓ a WBS assignment category is refused by name, not silently ignored');

  await page.goto(`${base}${ROUTE}?scopeOfList=HIERARCHY&scope=ALL`, { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: 'scope of list HIERARCHY' }).waitFor();
  console.log('  ✓ an unknown scope of list refuses by name');

  // ── Drill into the order ─────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?scopeOfList=ALV&scope=ALL`, { waitUntil: 'domcontentloaded' });
  await page.locator('tr[data-order="4710000001"]').first().getByRole('link', { name: 'Order', exact: true }).click();
  await page.waitForURL(/\/purchasing\/orders\?order=4710000001/);
  assert.equal((await page.locator('body').innerText()).includes('4710000001'), true, 'the order display names the order');
  console.log('  ✓ the assignment line drills into the order display');
}
