import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/inventory/stock-posting-date';

/**
 * SCR-126 browser acceptance: MB5B stocks on posting date.
 *
 * The fixture is a small but complete rollforward. One material is received
 * before the window, received and issued inside it, and also carries a reversed
 * receipt of 99 that must never reach the figures. A second material moves in
 * and straight back out, so it nets to zero and is suppressed unless asked for.
 * A third has drifted from the stock master: its closing position disagrees with
 * the snapshot, which must be reported as a warning without touching the figure.
 *
 * The journey: the April window shows opening 10, receipts 5, issues 2 and
 * closing 13; the zero-stock line appears only when asked for; a window with no
 * material range refuses by name; an unknown plant refuses by name; a window
 * ending on the latest posting date reports the drift as a control; and the
 * Movements link lands on the ledger list filtered to the same material and window.
 */
export async function stockOnPostingDate(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-126: roll the ledger forward across an April window, then drill into its movements');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by) values
        (${client}, 'Q800', 'Plant 800', 'KW', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.number, v.description, t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values ('MB5B-MAT', 'Rolled material'), ('MB5B-NET', 'Netted material'), ('MB5B-DRIFT', 'Drifted material')) as v(number, description)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
        (${client}, 'Q800', 'SL80', 'Rollforward store', true, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
        (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', 'browser.admin'),
        (${client}, 'GOODS_ISSUE', 'Goods issue', 'ISSUE', 'COST_CENTER', 'browser.admin'),
        (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (
        client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by
      ) values
        (${client}, '5950000001', 2026, '2026-03-20', '2026-03-20', 'Opening receipt', 'POSTED', 'browser.admin'),
        (${client}, '5950000002', 2026, '2026-04-05', '2026-04-05', 'April receipt', 'POSTED', 'browser.admin'),
        (${client}, '5950000003', 2026, '2026-04-10', '2026-04-10', 'April issue', 'POSTED', 'browser.admin'),
        (${client}, '5950000004', 2026, '2026-04-06', '2026-04-06', 'Reversed receipt', 'REVERSED', 'browser.admin'),
        (${client}, '5950000005', 2026, '2026-04-07', '2026-04-07', 'Netted in', 'POSTED', 'browser.admin'),
        (${client}, '5950000006', 2026, '2026-04-08', '2026-04-08', 'Netted out', 'POSTED', 'browser.admin'),
        (${client}, '5950000007', 2026, '2026-04-20', '2026-04-20', 'Drift receipt', 'POSTED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant, storage_location,
        stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, currency, value, created_by
      ) values
        (${client}, '5950000001', 1, 'GOODS_RECEIPT_PO', 'MB5B-MAT', 'Q800', 'SL80', 'UNRESTRICTED', 10, 'PC', 10, 'PC', 5, 1, 'USD', 50, 'browser.admin'),
        (${client}, '5950000002', 1, 'GOODS_RECEIPT_PO', 'MB5B-MAT', 'Q800', 'SL80', 'UNRESTRICTED',  5, 'PC',  5, 'PC', 5, 1, 'USD', 25, 'browser.admin'),
        (${client}, '5950000003', 1, 'GOODS_ISSUE',      'MB5B-MAT', 'Q800', 'SL80', 'UNRESTRICTED',  2, 'PC',  2, 'PC', 5, 1, 'USD', 10, 'browser.admin'),
        (${client}, '5950000004', 1, 'GOODS_RECEIPT_PO', 'MB5B-MAT', 'Q800', 'SL80', 'UNRESTRICTED', 99, 'PC', 99, 'PC', 5, 1, 'USD', 495, 'browser.admin'),
        (${client}, '5950000005', 1, 'GOODS_RECEIPT_PO', 'MB5B-NET', 'Q800', 'SL80', 'UNRESTRICTED',  3, 'PC',  3, 'PC', 5, 1, 'USD', 15, 'browser.admin'),
        (${client}, '5950000006', 1, 'GOODS_ISSUE',      'MB5B-NET', 'Q800', 'SL80', 'UNRESTRICTED',  3, 'PC',  3, 'PC', 5, 1, 'USD', 15, 'browser.admin'),
        (${client}, '5950000007', 1, 'GOODS_RECEIPT_PO', 'MB5B-DRIFT', 'Q800', 'SL80', 'UNRESTRICTED', 4, 'PC', 4, 'PC', 5, 1, 'USD', 20, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
        (${client}, 'MB5B-MAT', 'Q800', 'SL80', 'UNRESTRICTED', 13, 'browser.admin'),
        (${client}, 'MB5B-NET', 'Q800', 'SL80', 'UNRESTRICTED', 0, 'browser.admin'),
        (${client}, 'MB5B-DRIFT', 'Q800', 'SL80', 'UNRESTRICTED', 1, 'browser.admin')
      on conflict do nothing
    `);
  });

  const april = 'materialFrom=MB5B-MAT&materialTo=MB5B-NET&plantFrom=Q800&plantTo=Q800&dateFrom=2026-04-01&dateTo=2026-04-30';

  // ── The rollforward ───────────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?${april}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: /Stocks on Posting Date/i }).waitFor();
  const row = page.locator('tr', { hasText: 'MB5B-MAT' }).first();
  await row.waitFor();
  const cells = (await row.locator('td').allInnerTexts()).map((text) => text.trim());
  assert.deepEqual(cells.slice(6, 14), ['10.000', '50.00', '5.000', '25.00', '2.000', '10.00', '13.000', '65.00'],
    `opening, receipts, issues and closing roll forward: ${cells.join(' | ')}`);
  console.log('  ✓ the April window rolls opening 10 forward through receipts 5 and issues 2 to closing 13');

  // ── Reversed documents never count ────────────────────────────────────────
  assert.equal(cells.includes('104.000'), false, 'the reversed receipt of 99 is not folded into the receipts');
  assert.equal(await row.locator('td').nth(4).innerText(), 'UNRESTRICTED');
  console.log('  ✓ a reversed receipt of 99 contributes nothing to the figures');

  // ── Zero-stock lines are suppressed unless asked for ──────────────────────
  assert.equal(await page.getByText('MB5B-NET').count(), 0, 'the netted-to-zero line is suppressed by default');
  await page.goto(`${base}${ROUTE}?${april}&displayZero=on`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const netted = page.locator('tr', { hasText: 'MB5B-NET' }).first();
  await netted.waitFor();
  const nettedCells = (await netted.locator('td').allInnerTexts()).map((text) => text.trim());
  assert.equal(nettedCells[12], '0.000', `the netted line closes at zero: ${nettedCells.join(' | ')}`);
  console.log('  ✓ zero-stock lines stay hidden until the display flag asks for them');

  // ── A required range is enforced ──────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?plantFrom=Q800&plantTo=Q800&dateFrom=2026-04-01&dateTo=2026-04-30`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('div[role="alert"]').filter({ hasText: 'material range is required' }).waitFor();
  console.log('  ✓ the rollforward refuses to run without a material range');

  // ── A plant that does not stand refuses by name ───────────────────────────
  await page.goto(`${base}${ROUTE}?${april}&plantFrom=Q999&plantTo=Q999`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('div[role="alert"]').filter({ hasText: 'plant Q999' }).waitFor();
  console.log('  ✓ an unknown plant refuses by name instead of answering an empty list');

  // ── The stock master is a control, not an adjustment ──────────────────────
  await page.goto(`${base}${ROUTE}?${april}&dateTo=2026-04-20`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const warning = page.locator('section[aria-label="Report warnings"] li').filter({ hasText: 'MB5B-DRIFT' });
  await warning.waitFor();
  const warningText = await warning.innerText();
  assert.match(warningText, /closing 4\.000 against stock on hand 1\.000/, `the drift is named with both figures: ${warningText}`);
  const driftRow = page.locator('tr', { hasText: 'MB5B-DRIFT' }).first();
  assert.equal((await driftRow.locator('td').allInnerTexts())[12].trim(), '4.000', 'the ledger figure stands untouched');
  console.log('  ✓ a closing position that disagrees with the stock master is warned about, never adjusted');

  // ── Drill into the movements behind the row ───────────────────────────────
  await page.goto(`${base}${ROUTE}?${april}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('tr', { hasText: 'MB5B-MAT' }).first().getByRole('link', { name: /Movements/i }).click();
  await page.waitForURL(/\/inventory\/material-document-list\?.*materialFrom=MB5B-MAT/);
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: /Material Documents: List Display/i }).waitFor();
  const body = await page.locator('body').innerText();
  assert.match(page.url(), /postingDateFrom=2026-04-01&postingDateTo=2026-04-30/, 'the drill carries the same window');
  assert.equal(body.includes('5950000002'), true, 'the April receipt is listed');
  assert.equal(body.includes('5950000003'), true, 'the April issue is listed');
  // The June... the March opening receipt lies before the window, so it is not here.
  assert.equal(body.includes('5950000001'), false, 'the opening movement lies outside the drilled window');
  console.log('  ✓ the row drills into the ledger list for the same material and window');
}
