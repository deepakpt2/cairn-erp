import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/orders';

/**
 * SCR-056 / ME21N browser acceptance: purchase orders.
 *
 * The journey: a supplier fixture with purchasing data, the empty
 * overview, an order created through the header and item grid with
 * its schedule line, and the database remembering.
 */
export async function purchaseOrdersMe21n(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-056 ME21N: verify the empty overview, order creation, and database evidence');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Browser purchasing organization', '1000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Browser Supplier', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Create Purchase Order', exact: true }).waitFor();
  const overview = page.locator('section[aria-labelledby="po-overview"]');
  await overview.getByText('No purchase orders stand yet. Create the first below.').waitFor();
  console.log('  ✓ the document overview stands empty');

  const create = page.locator('section[aria-labelledby="po-create"]');
  await create.locator('label').filter({ hasText: 'Supplier' }).locator('input').fill('V10000');
  const headerSelects = create.locator('form > div select');
  await headerSelects.nth(0).selectOption('1000');
  await headerSelects.nth(1).evaluate((el) => {
    const select = el as unknown as { options: ArrayLike<{ value: string }>; value: string; dispatchEvent: (e: unknown) => void };
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await headerSelects.nth(2).selectOption('1000');

  const row = create.locator('tbody tr').first();
  const inputs = row.locator('input');
  // Grid order: material, short text, quantity, unit, net price, …
  await inputs.nth(1).fill('Industrial steel plate');
  await inputs.nth(2).fill('10');
  await inputs.nth(3).fill('PC');
  await inputs.nth(4).fill('150');
  await row.locator('select').nth(0).selectOption('1000');

  const panel = create.locator('fieldset').first();
  await panel.locator('input[type="date"]').fill('2026-11-15');
  await panel.locator('input[placeholder="Scheduled quantity"]').fill('10');

  await create.getByRole('button', { name: 'Save purchase order', exact: true }).click();
  const confirmation = create.getByText(/Purchase order POF-\d+ created\./);
  await confirmation.waitFor();
  const number = (await confirmation.textContent())?.match(/POF-\d+/)?.[0] ?? '';
  assert.ok(number, 'the created order number is shown');
  console.log(`  ✓ purchase order ${number} created through the header and item grid`);

  await overview.getByRole('cell', { name: number, exact: true }).waitFor();
  console.log('  ✓ the order stands in the overview');

  const evidence = await withTenant(client, async (tx) => {
    const items = await tx.execute(sql`
      select i.item_number, i.short_text, i.net_value, s.delivery_date
      from purchase_order_item i
      join purchase_order_schedule_line s
        on s.client = i.client and s.order_number = i.order_number and s.item_number = i.item_number
      where i.client = ${client} and i.order_number = ${number}
    `);
    const history = await changeHistory(tx, client, 'purchase_order', number);
    return { items: items as unknown as Record<string, unknown>[], history };
  });
  assert.equal(evidence.items.length, 1);
  assert.equal(Number(evidence.items[0].item_number), 10);
  assert.equal(Number(evidence.items[0].net_value), 1500);
  assert.ok(evidence.history.length >= 1, 'The creation is documented.');
  console.log('  ✓ the database remembers the order, its schedule line and its change document');
}
