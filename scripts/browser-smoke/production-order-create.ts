import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/production/orders';

/**
 * SCR-138 browser acceptance: CO01 create production order.
 *
 * The fixture gives the tenant a finished good, two components, a plant with a company
 * code and a store, all extended. The run creates an order through the screen, reads back
 * the derived company code, the status and the component grid, releases it under the
 * second capability, and confirms the ledger and the stock were never touched.
 */
export async function productionOrderCreate(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-138: create an order with components, read its derived company, release it, prove nothing posted');

  const fixture = await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string }>;
    if (!companies[0]) throw new Error('the browser tenant carries no company code');
    const code = companies[0].company_code;
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.n, v.d, t.material_type, 'PC', 'browser.admin'
      from (values ('CO01-FG', 'Order finished good'), ('CO01-RM1', 'Order raw one'), ('CO01-RM2', 'Order raw two'))
        as v(n, d)
      cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, 'QC01', 'Order plant', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${client}, v.n, 'QC01', 'browser.admin'
      from (values ('CO01-FG'), ('CO01-RM1'), ('CO01-RM2')) as v(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, 'QC01', 'SC01', 'Order store', true, false, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    return code;
  });
  console.log('  ✓ a plant, a store and three materials stand extended');

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Create Production Order', exact: true }).waitFor();

  await page.fill('input[name="materialNumber"]', 'CO01-FG');
  await page.fill('input[name="plant"]', 'QC01');
  await page.fill('input[name="orderQuantity"]', '100');
  await page.fill('input[name="scheduledStart"]', '2026-11-02');
  await page.fill('input[name="scheduledFinish"]', '2026-11-06');
  await page.fill('input[name="componentMaterial-1"]', 'CO01-RM1');
  await page.fill('input[name="componentPlant-1"]', 'QC01');
  await page.fill('input[name="componentSloc-1"]', 'SC01');
  await page.fill('input[name="componentQuantity-1"]', '50');
  await page.fill('input[name="componentMaterial-2"]', 'CO01-RM2');
  await page.fill('input[name="componentPlant-2"]', 'QC01');
  await page.fill('input[name="componentQuantity-2"]', '20');
  await page.getByRole('button', { name: 'Create the order', exact: true }).click();

  const status = page.locator('p[role="status"]').first();
  await status.waitFor();
  const message = await status.innerText();
  assert.match(message, /Order PRD-?\d+ created\./, `the order is created: ${message}`);
  const orderNumber = /Order (PRD-?\d+) created\./.exec(message)![1];

  // The order card: derived company, status, both components.
  const card = page.locator('section[aria-labelledby="order-summary"]');
  await card.waitFor();
  assert.equal(await card.locator('[data-order-number]').getAttribute('data-order-number'), orderNumber,
    'the order shows its number');
  assert.equal(await card.locator('[data-company-code]').getAttribute('data-company-code'), fixture,
    'the company code is derived from the plant, not typed');
  assert.equal(await card.locator('[data-status]').getAttribute('data-status'), 'CREATED',
    'a created order is not released yet');
  assert.equal(await card.locator('tr[data-item]').count(), 2, 'both components stand on the order');
  assert.equal((await card.innerText()).includes('Order raw one'), true, 'the component description resolves');

  // Release it.
  await page.getByRole('button', { name: 'Release the order', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'released' }).waitFor();
  const releasedCard = page.locator('section[aria-labelledby="order-summary"]');
  await page.waitForFunction(
    (selector) => document.querySelector(`${selector} [data-status]`)?.getAttribute('data-status') === 'RELEASED',
    'section[aria-labelledby="order-summary"]',
  );
  assert.equal(await releasedCard.locator('[data-status]').getAttribute('data-status'), 'RELEASED',
    'the release is recorded on the order');

  // Read independently of the screen: stock untouched, no document, no journal.
  const after = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select count(*)::int from production_order where client = ${client} and order_number = ${orderNumber}) as orders,
        (select count(*)::int from production_order_component where client = ${client} and order_number = ${orderNumber}) as components,
        (select status from production_order where client = ${client} and order_number = ${orderNumber}) as status,
        (select count(*)::int from material_document where client = ${client}) as documents,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select coalesce(sum(quantity), 0)::text from stock_quantity where client = ${client}) as stock
    `) as unknown as Array<{
      orders: number; components: number; status: string; documents: number; journals: number; stock: string;
    }>;
    return rows[0];
  });
  assert.equal(after.orders, 1, 'one order stands');
  assert.equal(after.components, 2, 'with both components');
  assert.equal(after.status, 'RELEASED', 'and it is released');
  assert.equal(after.documents, 0, 'no material document was written');
  assert.equal(after.journals, 0, 'no journal was written');
  assert.equal(Number(after.stock), 0, 'no stock moved');

  // A refusal keeps its SAP shape: an unknown plant refuses by name.
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="materialNumber"]', 'CO01-FG');
  await page.fill('input[name="plant"]', 'QC99');
  await page.fill('input[name="orderQuantity"]', '5');
  await page.fill('input[name="scheduledStart"]', '2026-11-02');
  await page.fill('input[name="scheduledFinish"]', '2026-11-06');
  await page.fill('input[name="componentMaterial-1"]', 'CO01-RM1');
  await page.fill('input[name="componentQuantity-1"]', '5');
  await page.getByRole('button', { name: 'Create the order', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Plant QC99 does not exist.' }).waitFor();

  console.log(`SCR-138: order ${orderNumber} was created in company ${fixture}, released, and nothing posted`);
}
