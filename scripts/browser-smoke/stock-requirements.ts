import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/production/stock-requirements';

/**
 * SCR-130 browser acceptance: MD04 stock/requirements list.
 *
 * The fixture: 30 unrestricted + 10 quality stock (blocked 5 excluded), a safety
 * stock of 20, one requisition of 25, one order of 30 of which 12 are delivered
 * and one past-due requisition of 4. The list must project 40 - 20 + 10 + 18 + 25,
 * exclude the blocked stock with a warning, mark the past-due row, carry it when
 * hidden, bucket into weeks, refuse the MRP area by name, and drill into the order.
 */
export async function stockRequirements(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-130: project stock, requisitions and orders into one running balance, then drill into an order');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`insert into plant (client, plant, name, country, created_by) values (${client}, 'QG01', 'Plant G', 'KW', 'browser.admin') on conflict do nothing`);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MD04-MAT', 'Planned material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by)
      values (${client}, 'QG01', 'SLG1', 'Store G', true, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, mrp_type, mrp_controller, safety_stock, reorder_point, created_by)
      values (${client}, 'MD04-MAT', 'QG01', 'REQUIREMENTS', '001', 20, 10, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, 'G94', 'Test group', 'browser.admin') on conflict do nothing`);
    await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, created_by) values (${client}, 'O940', 'Test org', 'browser.admin') on conflict do nothing`);
    await tx.execute(sql`insert into business_partner (client, partner_number, name, created_by) values (${client}, 'V94000', 'Test supplier', 'browser.admin') on conflict do nothing`);
    await tx.execute(sql`
      insert into company_code (client, company_code, name, country, currency, chart_of_accounts, created_by)
      select ${client}, '1000', 'Browser company', 'KW', 'KWD', c.chart_of_accounts, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
        (${client}, 'MD04-MAT', 'QG01', 'SLG1', 'UNRESTRICTED', 30, 'browser.admin'),
        (${client}, 'MD04-MAT', 'QG01', 'SLG1', 'QUALITY', 10, 'browser.admin'),
        (${client}, 'MD04-MAT', 'QG01', 'SLG1', 'BLOCKED', 5, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_requisition_item (client, requisition_number, item_number, short_text, quantity, unit,
                                             requisition_date, delivery_date, plant, purchasing_group, material_number, created_by) values
        (${client}, '200001', 1, 'Open requisition', 25, 'PC', '2026-05-01', '2026-07-01', 'QG01', 'G94', 'MD04-MAT', 'browser.admin'),
        (${client}, '200002', 1, 'Past due requisition', 4, 'PC', '2026-04-01', '2026-05-01', 'QG01', 'G94', 'MD04-MAT', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order (client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
                                  company_code, currency, document_date, release_status, created_by) values
        (${client}, '5600000001', 'STANDARD', 'V94000', 'O940', 'G94', '1000', 'KWD', '2026-05-02', 'RELEASED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_item (client, order_number, item_number, item_category, short_text, material_number,
                                       quantity, unit, net_price, price_unit, net_value, plant, created_by) values
        (${client}, '5600000001', 1, 'STANDARD', 'Big order', 'MD04-MAT', 30, 'PC', 1, 1, 30, 'QG01', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_schedule_line (client, order_number, item_number, line_number, delivery_date, quantity, created_by) values
        (${client}, '5600000001', 1, 1, '2026-06-15', 30, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
        (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by) values
        (${client}, '6410000001', 2026, '2026-05-10', '2026-05-10', 'Part delivery', 'POSTED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant, storage_location,
        stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, currency, value,
        purchase_order_number, purchase_order_item, created_by
      ) values
        (${client}, '6410000001', 1, 'GOODS_RECEIPT_PO', 'MD04-MAT', 'QG01', 'SLG1', 'UNRESTRICTED',
         12, 'PC', 12, 'PC', 1, 1, 'KWD', 12, '5600000001', 1, 'browser.admin')
      on conflict do nothing
    `);
  });

  // ── The projection ────────────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?material=MD04-MAT&plant=QG01`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Stock/Requirements List', exact: true }).waitFor();
  const stockRow = page.locator('tr[data-element="STOCK"]').first();
  await stockRow.waitFor();
  assert.equal(await stockRow.getAttribute('data-balance'), '44.000',
    'the past-due requisition of 4 lifts stock of 40 to 44 before safety stock');
  const safetyRow = page.locator('tr[data-element="SAFETY_STOCK"]').first();
  assert.equal(await safetyRow.getAttribute('data-balance'), '24.000', 'the safety stock of 20 leaves 24');
  const poRow = page.locator('tr[data-element="PURCHASE_ORDER"]').first();
  assert.equal(await poRow.getAttribute('data-balance'), '42.000', '18 open of a 30 order leaves 42');
  const reqRow = page.locator('tr[data-element="PURCHASE_REQUISITION"][data-date="2026-07-01"]').first();
  assert.equal(await reqRow.getAttribute('data-balance'), '67.000', 'the open requisition of 25 closes at 67');
  console.log('  ✓ the list projects 4 + 40 − 20 + 18 + 25 into a closing balance of 67');

  // ── Blocked stock excluded ───────────────────────────────────────────────
  await page.locator('section[aria-label="Report warnings"] li').filter({ hasText: 'BLOCKED 5.000' }).waitFor();
  console.log('  ✓ blocked stock is excluded from MRP availability and named');

  // ── Past due marked, then hidden without losing its effect ───────────────
  const pastDueRow = page.locator('tr[data-date="2026-05-01"]').first();
  await pastDueRow.locator('[data-exception-code="PAST_DUE"]').waitFor();
  await page.goto(`${base}${ROUTE}?material=MD04-MAT&plant=QG01&pastDueOff=1`, { waitUntil: 'domcontentloaded' });
  const firstVisible = page.locator('tr[data-element="STOCK"]').first();
  await firstVisible.waitFor();
  assert.equal(await page.locator('tr[data-date="2026-05-01"]').count(), 0, 'the past-due row is hidden');
  assert.equal(await firstVisible.getAttribute('data-balance'), '44.000', 'its 4 still moved the balance');
  console.log('  ✓ hidden past-due rows leave the list but never leave the balance');

  // ── Weekly split ─────────────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?material=MD04-MAT&plant=QG01&periodSplit=WEEKLY`, { waitUntil: 'domcontentloaded' });
  const week = page.locator('tr[data-date="2026-04-27"]').first();
  await week.waitFor();
  assert.match(await week.innerText(), /2026-05-03/, 'the bucket names its week end');
  console.log('  ✓ the weekly split buckets into Monday-started weeks');

  // ── Refusals by name ─────────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?material=MD04-MAT&plant=QG01&mrpArea=0001`, { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: 'MRP area 0001 does not stand' }).waitFor();
  console.log('  ✓ an MRP area is refused by name — the plant is the planning scope here');

  await page.goto(`${base}${ROUTE}?plant=QG01`, { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: 'material is required' }).waitFor();
  console.log('  ✓ the list refuses to run without a material');

  // ── Drill into the order ─────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?material=MD04-MAT&plant=QG01`, { waitUntil: 'domcontentloaded' });
  await page.locator('tr[data-element="PURCHASE_ORDER"]').first().getByRole('link', { name: 'Display' }).click();
  await page.waitForURL(/\/purchasing\/orders\?order=5600000001/);
  assert.equal((await page.locator('body').innerText()).includes('5600000001'), true, 'the order display names the order');
  console.log('  ✓ the order element drills into the order display');
}
