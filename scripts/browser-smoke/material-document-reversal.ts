import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/inventory/reversal';

/**
 * SCR-132 browser acceptance: MBST material document reversal.
 *
 * The fixture posts two documents directly — a single-line receipt of 40 and a
 * two-line transfer of 5 each — because the screen under test reverses them, not
 * creates them. The run reverses the receipt in full and reads the cancellation,
 * reverses one line of the transfer and reads PARTIALLY_REVERSED, reverses the
 * other line and reads REVERSED, refuses a second cancellation in the service's
 * own words, and refuses a fiscal year that disagrees with the document.
 */
export async function materialDocumentReversal(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-132: reverse a receipt in full, a transfer line by line, and refuse the second cancellation');

  await withTenant(client, async (tx) => {
    const company = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string }>;
    if (!company[0]) throw new Error('the browser tenant carries no company code');
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, 'QJ01', 'Reversal plant', ${company[0].company_code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, ${company[0].company_code}, 2026, 10, 2026, 9, true, 'browser.admin')
      on conflict (client, company_code) do update set
        current_fiscal_year = 2026, current_period = 10,
        previous_fiscal_year = 2026, previous_period = 9, allow_backposting = true
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
        (${client}, 'QJ01', 'SJ01', 'Store J1', true, 'browser.admin'),
        (${client}, 'QJ01', 'SJ02', 'Store J2', true, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MBST-MAT', 'Reversible material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, reversal_movement_type, created_by)
      values (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', 'RECEIPT_REVERSAL', 'browser.admin'),
             (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', null, 'browser.admin')
      on conflict (client, movement_type) do update set reversal_movement_type = excluded.reversal_movement_type
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by) values
        (${client}, 'MBST-0001', 2026, '2026-10-10', '2026-10-10', 'Receipt to reverse', 'POSTED', 'browser.admin'),
        (${client}, 'MBST-0002', 2026, '2026-10-11', '2026-10-11', 'Transfer to reverse', 'POSTED', 'browser.admin')
      on conflict (client, material_document_number) do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type, line_direction,
                                          material_number, plant, storage_location, stock_type, entry_quantity, entry_unit,
                                          base_quantity, base_unit, value, created_by) values
        (${client}, 'MBST-0001', 1, 'GOODS_RECEIPT_PO', 'RECEIPT', 'MBST-MAT', 'QJ01', 'SJ01', 'UNRESTRICTED', 40, 'PC', 40, 'PC', 0, 'browser.admin'),
        (${client}, 'MBST-0002', 1, 'GOODS_RECEIPT_PO', 'ISSUE', 'MBST-MAT', 'QJ01', 'SJ01', 'UNRESTRICTED', 5, 'PC', 5, 'PC', 0, 'browser.admin'),
        (${client}, 'MBST-0002', 2, 'GOODS_RECEIPT_PO', 'RECEIPT', 'MBST-MAT', 'QJ01', 'SJ02', 'UNRESTRICTED', 5, 'PC', 5, 'PC', 0, 'browser.admin')
      on conflict (client, material_document_number, line_number) do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
        (${client}, 'MBST-MAT', 'QJ01', 'SJ01', 'UNRESTRICTED', 40, 'browser.admin'),
        (${client}, 'MBST-MAT', 'QJ01', 'SJ02', 'UNRESTRICTED', 5, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type)
      do update set quantity = excluded.quantity
    `);
  });

  const stockOf = async (location: string) => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select quantity from stock_quantity
      where client = ${client} and material_number = 'MBST-MAT' and plant = 'QJ01'
        and storage_location = ${location} and stock_type = 'UNRESTRICTED'
    `) as unknown as Array<{ quantity: string }>;
    return rows[0] ? Number(rows[0].quantity) : 0;
  });

  await page.goto(`${base}${ROUTE}?doc=MBST-0001`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Reverse Material Document', exact: true }).waitFor();
  const line = page.locator('tr[data-line="1"]').first();
  await line.waitFor();
  assert.equal(await line.getAttribute('data-side'), 'RECEIPT');
  assert.equal(await line.getAttribute('data-remaining'), '40.000');
  console.log('  ✓ the lookup shows the line and what still stands open');

  await page.getByRole('button', { name: 'Reverse', exact: true }).click();
  const status = page.locator('section[aria-labelledby="reversal-document"] p[role="status"]');
  await status.waitFor();
  const message = await status.innerText();
  const reversalNumber = /material document ([A-Za-z0-9-]+)/.exec(message)?.[1];
  assert.ok(reversalNumber, `the reversal names its document: ${message}`);
  assert.equal(await stockOf('SJ01'), 0, 'the receipt of 40 left the store');
  console.log(`  ✓ the receipt reversed as ${reversalNumber} and the stock went back`);

  await page.goto(`${base}${ROUTE}?doc=MBST-0001`, { waitUntil: 'domcontentloaded' });
  const cancelled = page.locator('span[data-status]').first();
  await cancelled.waitFor();
  assert.equal((await cancelled.getAttribute('data-status')), 'REVERSED');
  await page.getByText('Every line of this document is already reversed.').waitFor();
  console.log('  ✓ the document stands cancelled and offers nothing more to reverse');

  // ── Line by line ────────────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?doc=MBST-0002`, { waitUntil: 'domcontentloaded' });
  await page.locator('tr[data-line="2"]').first().waitFor();
  const boxes = page.locator('tbody input[name="lines"]');
  assert.equal(await boxes.count(), 2, 'both lines are selectable');
  await boxes.nth(1).uncheck();
  await page.getByRole('button', { name: 'Reverse', exact: true }).click();
  await status.waitFor();
  assert.match(await status.innerText(), /Reversal posted as material document/);
  console.log('  ✓ one line of the transfer was reversed on its own');

  await page.goto(`${base}${ROUTE}?doc=MBST-0002`, { waitUntil: 'domcontentloaded' });
  const partial = page.locator('span[data-status]').first();
  await partial.waitFor();
  assert.equal(await partial.getAttribute('data-status'), 'PARTIALLY_REVERSED');
  const first = page.locator('tr[data-line="1"]').first();
  const second = page.locator('tr[data-line="2"]').first();
  assert.equal(await first.getAttribute('data-remaining'), '0.000');
  assert.equal(await second.getAttribute('data-remaining'), '5.000');
  assert.equal(await stockOf('SJ02'), 5);
  console.log('  ✓ the document stands partly reversed, one line still open');

  await page.getByRole('button', { name: 'Reverse', exact: true }).click();
  await status.waitFor();
  assert.match(await status.innerText(), /Reversal posted as material document/);
  await page.goto(`${base}${ROUTE}?doc=MBST-0002`, { waitUntil: 'domcontentloaded' });
  const done = page.locator('span[data-status]').first();
  await done.waitFor();
  assert.equal(await done.getAttribute('data-status'), 'REVERSED');
  console.log('  ✓ the second line completed the document to REVERSED');

  // ── The refusals ────────────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?doc=MBST-0001`, { waitUntil: 'domcontentloaded' });
  await page.locator('span[data-status]').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reverse', exact: true }).count(), 0,
    'a cancelled document offers no reversal control at all');
  console.log('  ✓ a cancelled document cannot be cancelled a second time from the screen');

  await page.goto(`${base}${ROUTE}?doc=${reversalNumber}`, { waitUntil: 'domcontentloaded' });
  await page.locator('section[aria-labelledby="reversal-document"]').waitFor();
  await page.getByText('This document is itself a reversal; reverse the original instead.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reverse', exact: true }).count(), 0,
    'a reversal offers no control to reverse itself');
  console.log('  ✓ a reversal cannot itself be reversed');
}
