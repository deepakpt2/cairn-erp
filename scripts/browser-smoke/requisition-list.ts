import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/requisition-list';

/**
 * SCR-123 browser acceptance: ME5A purchase requisition list display.
 *
 * The journey: a tenant carrying three plants — one mapped to two purchasing
 * organisations, one to a single organisation, one to none — lists its
 * requisitions on screen. The list hides closed items by default, shows them
 * on the toggle with their derived status, filters by plant and by derived
 * organisation, refuses a plant that does not stand by name, and drills a row
 * down to the standing requisition display.
 */
export async function requisitionList(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-123: list purchase requisitions, derive orgs and conversion, drill to the display');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by) values
        (${client}, 'P210', 'Plant 210', 'KW', 'browser.admin'),
        (${client}, 'P220', 'Plant 220', 'KW', 'browser.admin'),
        (${client}, 'P230', 'Plant 230', 'KW', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, created_by) values
        (${client}, 'O210', 'Org 210', 'browser.admin'),
        (${client}, 'O220', 'Org 220', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org_plant (client, purchasing_org, plant, created_by) values
        (${client}, 'O210', 'P210', 'browser.admin'),
        (${client}, 'O220', 'P210', 'browser.admin'),
        (${client}, 'O220', 'P220', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by) values
        (${client}, 'G01', 'Group 01', 'browser.admin'),
        (${client}, 'G02', 'Group 02', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name, created_by)
      values (${client}, 'V90000', 'ME5A supplier', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_requisition_item (
        client, requisition_number, item_number, document_type, item_category,
        account_assignment_category, material_number, short_text, quantity, unit,
        requisition_date, delivery_date, plant, purchasing_group,
        estimated_price, price_unit, currency, marked_for_deletion, creation_source, created_by
      ) values
        (${client}, '9100000001', 10, 'STANDARD', 'STANDARD', null, null, 'Open demand', 10, 'PC',
         '2026-03-10', '2026-04-10', 'P210', 'G01', 12.50, 1, 'USD', false, 'MANUAL', 'browser.admin'),
        (${client}, '9100000002', 10, 'STANDARD', 'STANDARD', null, null, 'Partially converted', 10, 'PC',
         '2026-03-11', '2026-04-11', 'P220', 'G02', 5.00, 1, 'USD', false, 'MANUAL', 'browser.admin'),
        (${client}, '9100000003', 10, 'STANDARD', 'STANDARD', null, null, 'Converted demand', 5, 'PC',
         '2026-03-12', '2026-04-12', 'P210', 'G01', 1.00, 1, 'USD', false, 'MANUAL', 'browser.admin'),
        (${client}, '9100000004', 10, 'STANDARD', 'STANDARD', null, null, 'Deleted demand', 5, 'PC',
         '2026-03-13', '2026-04-13', 'P230', 'G02', 1.00, 1, 'USD', true, 'MANUAL', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order (
        client, order_number, document_type, supplier_number, purchasing_org,
        purchasing_group, company_code, currency, document_date, release_status, created_by
      ) values
        (${client}, 'PO91000001', 'STANDARD', 'V90000', 'O220', 'G02', '1000', 'USD', '2026-03-11', 'RELEASED', 'browser.admin'),
        (${client}, 'PO91000002', 'STANDARD', 'V90000', 'O210', 'G01', '1000', 'USD', '2026-03-12', 'RELEASED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_item (
        client, order_number, item_number, item_category, material_number, short_text,
        quantity, unit, net_price, price_unit, net_value, plant,
        requisition_number, requisition_item, marked_for_deletion, created_by
      ) values
        (${client}, 'PO91000001', 10, 'STANDARD', null, 'Partial order', 4, 'PC', 5, 1, 20, 'P220', '9100000002', 10, false, 'browser.admin'),
        (${client}, 'PO91000002', 10, 'STANDARD', null, 'Full order', 5, 'PC', 1, 1, 5, 'P210', '9100000003', 10, false, 'browser.admin')
      on conflict do nothing
    `);
  });

  // ── The list, with closed items hidden by default ─────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: /Purchase Requisitions: List Display/i }).waitFor();
  await page.getByText('9100000001').waitFor();
  assert.equal(await page.getByText('9100000002').count() > 0, true, 'partial line stands');
  assert.equal(await page.getByText('9100000003').count(), 0, 'converted line hidden by default');
  assert.equal(await page.getByText('9100000004').count(), 0, 'marked line hidden by default');
  console.log('  ✓ the list shows open and partial requisitions and hides the closed ones');

  // ── Derived organisation and status on the toggle ─────────────────────────
  await page.locator('input[name="displayClosed"]').check();
  await page.getByRole('button', { name: 'Execute' }).click();
  await page.getByText('9100000003').waitFor();
  const convertedRow = page.locator('tr', { hasText: '9100000003' }).first();
  assert.equal((await convertedRow.innerText()).includes('CONVERTED'), true, 'converted status derived');
  const markedRow = page.locator('tr', { hasText: '9100000004' }).first();
  assert.equal((await markedRow.innerText()).includes('MFD'), true, 'deletion mark shown');
  const openRow = page.locator('tr', { hasText: '9100000001' }).first();
  const openText = await openRow.innerText();
  assert.equal(openText.includes('O210, O220'), true, 'both plant organisations shown');
  console.log('  ✓ closed items stand on the toggle with derived status, and the plant shows both orgs');

  // ── Plant filter ──────────────────────────────────────────────────────────
  await page.locator('input[name="plantFrom"]').fill('P210');
  await page.locator('input[name="plantTo"]').fill('P210');
  await page.getByRole('button', { name: 'Execute' }).click();
  await page.getByText('9100000001').waitFor();
  assert.equal(await page.getByText('9100000002').count(), 0, 'P220 line filtered out');
  console.log('  ✓ the plant range narrows the list');

  // ── Organisation filter through the plant assignment ──────────────────────
  await page.locator('input[name="plantFrom"]').fill('');
  await page.locator('input[name="plantTo"]').fill('');
  await page.locator('input[name="purchasingOrgFrom"]').fill('O220');
  await page.locator('input[name="purchasingOrgTo"]').fill('O220');
  await page.getByRole('button', { name: 'Execute' }).click();
  await page.getByText('9100000002').waitFor();
  assert.equal(await page.getByText('9100000001').count() > 0, true, 'P210 stands because it maps to O220 too');
  console.log('  ✓ the organisation filter matches through the plant assignment');

  // ── A plant that does not stand refuses by name ───────────────────────────
  await page.goto(`${base}${ROUTE}?plantFrom=P999`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('alert').waitFor();
  const alertText = await page.getByRole('alert').innerText();
  assert.equal(/plant P999/.test(alertText), true, `names the plant: ${alertText}`);
  console.log('  ✓ an unknown plant refuses by name instead of answering an empty list');

  // ── Drill-down to the standing requisition display ────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('tr', { hasText: '9100000001' }).first().getByRole('link').first().click();
  await page.waitForURL(/\/purchasing\/requisitions\?req=9100000001/);
  await page.waitForLoadState('networkidle');
  await page.getByText('9100000001').first().waitFor();
  console.log('  ✓ the row drills down to the requisition display');
}
