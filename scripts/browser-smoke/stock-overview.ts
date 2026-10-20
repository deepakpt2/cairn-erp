import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/inventory/stock-overview';

/**
 * SCR-128 browser acceptance: MMBE stock overview.
 *
 * Two plants, three stocked locations and a project stock type. The tree must
 * roll up exactly — 30 unrestricted + 5 quality = 35 in SL10, 4 blocked + 3
 * project = 7 in SL20, 42 in plant QB01; 7 in QB02; 49 overall — open to the
 * level the dropdown asks for, hide the zero location until asked, refuse a
 * missing material and the special stock indicator by name, and drill into the
 * material document list.
 */
export async function stockOverview(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-128: fold the stock of one material into a plant/location/type tree, then drill into its movements');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by) values
        (${client}, 'QB01', 'Plant B1', 'KW', 'browser.admin'),
        (${client}, 'QB02', 'Plant B2', 'KW', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MMBE-MAT', 'Overview material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
        (${client}, 'QB01', 'SL10', 'Store 10', true, 'browser.admin'),
        (${client}, 'QB01', 'SL20', 'Store 20', true, 'browser.admin'),
        (${client}, 'QB02', 'SL30', 'Store 30', true, 'browser.admin'),
        (${client}, 'QB02', 'SL40', 'Empty store', true, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
        (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by) values
        (${client}, '5970000001', 2026, '2026-06-03', '2026-06-03', 'Overview receipt', 'POSTED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant, storage_location,
        stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, currency, value, created_by
      ) values
        (${client}, '5970000001', 1, 'GOODS_RECEIPT_PO', 'MMBE-MAT', 'QB01', 'SL10', 'UNRESTRICTED',
         30, 'PC', 30, 'PC', 1, 1, 'KWD', 30, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
        (${client}, 'MMBE-MAT', 'QB01', 'SL10', 'UNRESTRICTED', 30, 'browser.admin'),
        (${client}, 'MMBE-MAT', 'QB01', 'SL10', 'QUALITY', 5, 'browser.admin'),
        (${client}, 'MMBE-MAT', 'QB01', 'SL20', 'BLOCKED', 4, 'browser.admin'),
        (${client}, 'MMBE-MAT', 'QB01', 'SL20', 'PROJECT', 3, 'browser.admin'),
        (${client}, 'MMBE-MAT', 'QB02', 'SL30', 'UNRESTRICTED', 7, 'browser.admin'),
        (${client}, 'MMBE-MAT', 'QB02', 'SL40', 'UNRESTRICTED', 0, 'browser.admin')
      on conflict do nothing
    `);
  });

  // ── The tree and its roll-ups ─────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?material=MMBE-MAT&expansionLevel=STORAGE_LOCATION`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /Stock Overview/i }).waitFor();
  const plantA = page.locator('[data-plant="QB01"]').first();
  await plantA.waitFor();
  assert.match(await plantA.locator('summary').first().innerText(), /42\.000/, 'plant QB01 rolls up to 42');
  const sl10 = page.locator('[data-location="QB01|SL10"]').first();
  assert.match(await sl10.locator('summary').first().innerText(), /35\.000/, 'location SL10 rolls up to 35');
  await sl10.locator('summary').first().click();
  const sl10Text = await sl10.innerText();
  assert.equal(sl10Text.includes('30.000'), true, 'unrestricted 30 at SL10');
  assert.equal(sl10Text.includes('5.000'), true, 'quality 5 at SL10');
  console.log('  ✓ the tree folds 30 unrestricted + 5 quality into 35, and the plant into 42');

  const sl20 = page.locator('[data-location="QB01|SL20"]').first();
  await sl20.locator('summary').first().click();
  const sl20Text = await sl20.innerText();
  assert.equal(sl20Text.includes('PROJECT'), true, 'the special stock type names itself at the third level');
  assert.match(await sl20.locator('summary').first().innerText(), /7\.000/, 'SL20 rolls up to 7');
  const body = await page.locator('body').innerText();
  assert.equal(/Total:\s*49\.000/.test(body), true, `the material total is 49: ${body.slice(0, 200)}`);
  console.log('  ✓ project stock is named at the third level and the material totals 49');

  // ── Expansion level ──────────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?material=MMBE-MAT&expansionLevel=PLANT`, { waitUntil: 'domcontentloaded' });
  const collapsed = page.locator('[data-plant="QB01"]').first();
  await collapsed.waitFor();
  assert.equal(await collapsed.getAttribute('open'), null, 'plants stay closed at the PLANT level');
  await page.goto(`${base}${ROUTE}?material=MMBE-MAT&expansionLevel=STORAGE_LOCATION`, { waitUntil: 'domcontentloaded' });
  const opened = page.locator('[data-plant="QB01"]').first();
  await opened.waitFor();
  assert.notEqual(await opened.getAttribute('open'), null, 'plants open at the STORAGE_LOCATION level');
  console.log('  ✓ the expansion dropdown decides whether the tree opens on arrival');

  // ── Zero nodes ───────────────────────────────────────────────────────────
  assert.equal(await page.locator('[data-location="QB02|SL40"]').count(), 0, 'the empty location is suppressed');
  await page.goto(`${base}${ROUTE}?material=MMBE-MAT&displayZero=on`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-location="QB02|SL40"]').first().waitFor();
  console.log('  ✓ a zero location stays hidden until the display flag asks for it');

  // ── Refusals by name ─────────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: 'material is required' }).waitFor();
  console.log('  ✓ the overview refuses to run without a material');

  await page.goto(`${base}${ROUTE}?material=MMBE-MAT&specialStockIndicator=E`, { waitUntil: 'domcontentloaded' });
  await page.locator('div[role="alert"]').filter({ hasText: 'special stock indicator E' }).waitFor();
  console.log('  ✓ the one-character special stock indicator is refused in favour of a named type');

  // ── Drill into the movements ─────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?material=MMBE-MAT`, { waitUntil: 'domcontentloaded' });
  const drillPlant = page.locator('[data-plant="QB01"]').first();
  await drillPlant.waitFor();
  await drillPlant.locator('summary').first().getByRole('link', { name: 'Movements' }).first().click();
  await page.waitForURL(/\/inventory\/material-document-list\?.*materialFrom=MMBE-MAT/);
  await page.getByRole('heading', { name: /Material Documents: List Display/i }).waitFor();
  assert.equal((await page.locator('body').innerText()).includes('5970000001'), true, 'the movement is listed');
  console.log('  ✓ the plant node drills into the material document list for the same material');
}
