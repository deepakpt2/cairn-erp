import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/requisitions';

/**
 * SCR-055 / ME51N browser acceptance: purchase requisitions.
 *
 * The journey: the empty document overview, a text requisition created
 * through the item grid, and the database remembering the document
 * with its change document.
 */
export async function purchaseRequisitionsMe51n(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-055 ME51N: verify the empty overview, requisition creation, and database evidence');

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Create Purchase Requisition', exact: true }).waitFor();
  const overview = page.locator('section[aria-labelledby="pr-overview"]');
  await overview.getByText('No requisitions stand yet. Create the first below.').waitFor();
  console.log('  ✓ the document overview stands empty');

  const create = page.locator('section[aria-labelledby="pr-create"]');
  const row = create.locator('tbody tr').first();
  const inputs = row.locator('input');
  // Grid order: material, short text, quantity, unit, delivery date, …
  await inputs.nth(1).fill('Industrial steel plate');
  await inputs.nth(2).fill('10');
  await inputs.nth(3).fill('PC');
  await inputs.nth(4).fill('2026-11-15');
  const selects = row.locator('select');
  await selects.nth(0).evaluate((el) => {
    const select = el as unknown as { options: ArrayLike<{ value: string }>; value: string; dispatchEvent: (e: unknown) => void };
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await selects.nth(2).evaluate((el) => {
    const select = el as unknown as { options: ArrayLike<{ value: string }>; value: string; dispatchEvent: (e: unknown) => void };
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await create.getByRole('button', { name: 'Save requisition', exact: true }).click();
  const confirmation = create.getByText(/Requisition PR-\d+ created\./);
  await confirmation.waitFor();
  const number = (await confirmation.textContent())?.match(/PR-\d+/)?.[0] ?? '';
  assert.ok(number, 'the created requisition number is shown');
  console.log(`  ✓ requisition ${number} created through the item grid`);

  await overview.getByRole('cell', { name: number, exact: true }).waitFor();
  console.log('  ✓ the document stands in the overview');

  const evidence = await withTenant(client, async (tx) => {
    const items = await tx.execute(sql`
      select item_number, short_text, quantity from purchase_requisition_item
      where client = ${client} and requisition_number = ${number}
    `);
    const history = await changeHistory(tx, client, 'purchase_requisition', number);
    return { items: items as unknown as Record<string, unknown>[], history };
  });
  assert.equal(evidence.items.length, 1);
  assert.equal(Number(evidence.items[0].item_number), 10);
  assert.equal(evidence.items[0].short_text, 'Industrial steel plate');
  assert.equal(Number(evidence.items[0].quantity), 10);
  assert.ok(evidence.history.length >= 1, 'The creation is documented.');
  console.log('  ✓ the database remembers the requisition and its change document');
}
