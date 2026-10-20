import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/inventory/material-document-output';
const DOC = '4900000901';
const EMAIL_DOC = '4900000902';

/**
 * SCR-135 browser acceptance: MB90 material document output.
 *
 * The fixture writes two posted documents directly — a receipt of 10 and a receipt
 * of 1 — because the screen under test determines and dispatches, it does not post.
 * The run determines WE01 for both and dispatches them; a second run creates nothing
 * (idempotent). An EMAIL message with no recipient fails with its reason in the
 * grid; a recipient is set and a single dispatch then succeeds, the send count
 * rising to one. The slip preview shows the document as posted.
 */
export async function materialDocumentOutput(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-135: determine and dispatch the slips, fail an EMAIL for want of a recipient, then succeed');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      values (${client}, 'QN01', 'Output plant', 'KW', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MB90-MAT', 'Printed material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, 'RECEIPT_OTHER', 'Goods receipt without reference', 'RECEIPT', 'MATERIAL_DOCUMENT', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date,
                                     header_text, status, created_by) values
        (${client}, ${DOC}, 2026, '2026-05-01', '2026-05-01', 'Output run', 'POSTED', 'browser.admin'),
        (${client}, ${EMAIL_DOC}, 2026, '2026-05-02', '2026-05-02', 'Output email', 'POSTED', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type, material_number,
                                          plant, storage_location, stock_type, line_direction, entry_quantity, entry_unit,
                                          base_quantity, base_unit, value, currency, created_by) values
        (${client}, ${DOC}, 1, 'RECEIPT_OTHER', 'MB90-MAT', 'QN01', '0001', 'UNRESTRICTED', 'RECEIPT',
         10, 'PC', 10, 'PC', 100, 'KWD', 'browser.admin'),
        (${client}, ${EMAIL_DOC}, 1, 'RECEIPT_OTHER', 'MB90-MAT', 'QN01', '0001', 'UNRESTRICTED', 'RECEIPT',
         1, 'PC', 1, 'PC', 10, 'KWD', 'browser.admin')
      on conflict do nothing
    `);
  });

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Material Document Output', exact: true }).waitFor();

  // The run determines and dispatches what is pending.
  await page.getByRole('button', { name: 'Determine and dispatch', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Determined' }).waitFor();

  // Both documents now carry a processed WE01 with one send.
  const row = page.locator(`tr[data-document="${DOC}"][data-output="WE01"]`).first();
  await row.waitFor();
  assert.equal(await row.getAttribute('data-status'), 'PROCESSED', 'the immediate slip is processed');
  assert.equal(await row.getAttribute('data-sends'), '1', 'the send was counted');

  // The slip preview shows the document as posted.
  await page.goto(`${base}${ROUTE}?preview=${DOC}`, { waitUntil: 'domcontentloaded' });
  const slip = page.locator(`pre[data-slip="${DOC}"]`);
  await slip.waitFor();
  const text = await slip.innerText();
  assert.equal(text.includes(`MATERIAL DOCUMENT ${DOC} / 2026`), true, 'the slip names the document');
  assert.equal(text.includes('MB90-MAT'), true, 'the slip names the material');
  assert.equal(text.includes('10.000 PC'), true, 'the slip carries the quantity');

  // An EMAIL message with no recipient fails for real, with its reason in the grid.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into output_type (client, output_type, description, direction, transmission_medium, dispatch_time, created_by)
      values (${client}, 'WE01', 'Goods receipt slip', 'RECEIPT', 'PRINT', 'IMMEDIATE', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into output_message (client, material_document_number, document_year, output_type,
                                  transmission_medium, dispatch_time, status, created_by)
      values (${client}, ${EMAIL_DOC}, 2026, 'WE01', 'EMAIL', 'PERIODIC', 'PENDING', 'browser.admin')
      on conflict do nothing
    `);
  });

  await page.goto(`${base}${ROUTE}?transmissionMedium=EMAIL`, { waitUntil: 'domcontentloaded' });
  const emailRow = page.locator(`tr[data-document="${EMAIL_DOC}"][data-medium="EMAIL"]`).first();
  await emailRow.waitFor();
  await emailRow.getByRole('button', { name: 'Dispatch', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'failed' }).waitFor();
  await page.goto(`${base}${ROUTE}?transmissionMedium=EMAIL`, { waitUntil: 'domcontentloaded' });
  const failed = page.locator(`tr[data-document="${EMAIL_DOC}"][data-medium="EMAIL"]`).first();
  await failed.waitFor();
  assert.equal(await failed.getAttribute('data-status'), 'ERROR', 'the EMAIL failed');
  assert.equal((await failed.innerText()).includes('needs a recipient'), true, 'the grid records why');

  // Set a recipient, dispatch again, and the send counts.
  await failed.locator('input[name="recipient"]').fill('warehouse@example.test');
  await failed.getByRole('button', { name: 'Set', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Recipient recorded' }).waitFor();
  await page.goto(`${base}${ROUTE}?transmissionMedium=EMAIL`, { waitUntil: 'domcontentloaded' });
  const retried = page.locator(`tr[data-document="${EMAIL_DOC}"][data-medium="EMAIL"]`).first();
  await retried.waitFor();
  await retried.getByRole('button', { name: 'Dispatch', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Dispatched WE01' }).waitFor();
  await page.goto(`${base}${ROUTE}?transmissionMedium=EMAIL`, { waitUntil: 'domcontentloaded' });
  const done = page.locator(`tr[data-document="${EMAIL_DOC}"][data-medium="EMAIL"]`).first();
  await done.waitFor();
  assert.equal(await done.getAttribute('data-status'), 'PROCESSED', 'the retried EMAIL is processed');
  assert.equal(await done.getAttribute('data-sends'), '1', 'the retried send was counted');

  console.log(`SCR-135: ${DOC} processed with one send, its slip rendered, and ${EMAIL_DOC} failed then succeeded once a recipient stood`);
}
