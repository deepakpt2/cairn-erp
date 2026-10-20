import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const LIST_ROUTE = '/inventory/material-document-list';
const DISPLAY_ROUTE = '/inventory/material-documents';

/**
 * SCR-125 browser acceptance: MB51 material document list.
 *
 * The journey: the ledger carries two receipts, one of them reversed and its
 * reversal — so history is never hidden. The list shows every line with the
 * material description, the movement direction and the order cited; the
 * posting-date range is refused when absent; a movement-type filter narrows to
 * the reversal alone; an unknown plant refuses by name; and a row drills into
 * the document display, which shows the header and its lines.
 */
export async function materialDocumentList(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-125: list the material ledger for a posting window, then drill into one document');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by) values
        (${client}, 'Q700', 'Plant 700', 'KW', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MB51-MAT', 'Ledger material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
        (${client}, 'Q700', 'SL70', 'Main store', true, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
        (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', 'browser.admin'),
        (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name, created_by)
      values (${client}, 'V60000', 'Ledger supplier', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, created_by)
      values (${client}, 'O600', 'Ledger org', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by)
      values (${client}, 'G06', 'Ledger group', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order (
        client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
        company_code, currency, document_date, release_status, created_by
      ) values (${client}, '4800000001', 'STANDARD', 'V60000', 'O600', 'G06', '1000', 'USD', '2026-04-01', 'RELEASED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (
        client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by
      ) values
        (${client}, '5900000001', 2026, '2026-04-05', '2026-04-05', 'First receipt', 'POSTED', 'browser.admin'),
        (${client}, '5900000002', 2026, '2026-04-06', '2026-04-06', 'Reversed receipt', 'REVERSED', 'browser.admin'),
        (${client}, '5900000003', 2026, '2026-04-07', '2026-04-07', 'Reversal', 'POSTED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant, storage_location,
        stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, currency, value,
        purchase_order_number, purchase_order_item, item_text, created_by
      ) values
        (${client}, '5900000001', 1, 'GOODS_RECEIPT_PO', 'MB51-MAT', 'Q700', 'SL70', 'UNRESTRICTED',
         10, 'PC', 10, 'PC', 5, 1, 'USD', 50, '4800000001', 10, 'Receipt line', 'browser.admin'),
        (${client}, '5900000002', 1, 'GOODS_RECEIPT_PO', 'MB51-MAT', 'Q700', 'SL70', 'UNRESTRICTED',
         4, 'PC', 4, 'PC', 5, 1, 'USD', 20, null, null, 'Reversed line', 'browser.admin'),
        (${client}, '5900000003', 1, 'RECEIPT_REVERSAL', 'MB51-MAT', 'Q700', 'SL70', 'UNRESTRICTED',
         4, 'PC', 4, 'PC', 5, 1, 'USD', 20, null, null, 'Reversal line', 'browser.admin')
      on conflict do nothing
    `);
  });

  const window = 'postingDateFrom=2026-04-01&postingDateTo=2026-04-30';

  // ── The ledger list ───────────────────────────────────────────────────────
  await page.goto(`${base}${LIST_ROUTE}?${window}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: /Material Documents: List Display/i }).waitFor();
  await page.getByText('5900000001').waitFor();
  const first = await page.locator('tr', { hasText: '5900000001' }).first().innerText();
  assert.equal(first.includes('Ledger material'), true, `description shown: ${first}`);
  assert.equal(first.includes('4800000001'), true, 'the order cited is shown');
  assert.equal(first.includes('RECEIPT'), true, 'the movement direction is shown');
  const reversed = await page.locator('tr', { hasText: '5900000002' }).first().innerText();
  assert.equal(reversed.includes('REVERSED'), true, `reversed history is not hidden: ${reversed}`);
  console.log('  ✓ the ledger window lists every line with description, direction, order and status');

  // ── The posting-date range is required ────────────────────────────────────
  await page.goto(`${base}${LIST_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const refusal = page.locator('div[role="alert"]').filter({ hasText: 'posting date range is required' });
  await refusal.waitFor();
  console.log('  ✓ the list refuses to run without a posting-date window');

  // ── Movement-type filter ──────────────────────────────────────────────────
  await page.goto(`${base}${LIST_ROUTE}?${window}&movementTypeFrom=RECEIPT_REVERSAL&movementTypeTo=RECEIPT_REVERSAL`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByText('5900000003').waitFor();
  assert.equal(await page.getByText('5900000001').count(), 0, 'receipts leave the reversal filter');
  console.log('  ✓ the canon movement type narrows the ledger to the reversal');

  // ── A plant that does not stand refuses by name ───────────────────────────
  await page.goto(`${base}${LIST_ROUTE}?${window}&plantFrom=Q999`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const plantRefusal = page.locator('div[role="alert"]').filter({ hasText: 'plant Q999' });
  await plantRefusal.waitFor();
  console.log('  ✓ an unknown plant refuses by name instead of answering an empty list');

  // ── Drill into the document display ───────────────────────────────────────
  await page.goto(`${base}${LIST_ROUTE}?${window}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('tr', { hasText: '5900000001' }).first().getByRole('link').first().click();
  await page.waitForURL(/\/inventory\/material-documents\?document=5900000001/);
  await page.waitForLoadState('networkidle');
  const heading = await page.getByRole('heading', { level: 1 }).innerText();
  assert.equal(heading.includes('5900000001'), true, `display names the document: ${heading}`);
  const body = await page.locator('body').innerText();
  assert.equal(body.includes('Receipt line'), true, 'the display shows the line text');
  assert.equal(body.includes('Q700'), true, 'the display shows the plant');
  assert.equal(await page.locator(`a[href="${LIST_ROUTE}"]`).count() > 0, true, 'the display links back to the list');
  console.log('  ✓ the drill opens the read-only document display with its lines');
}
