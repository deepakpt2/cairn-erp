import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/inventory/transfer-posting';

/**
 * SCR-131 browser acceptance: MB1B transfer posting.
 *
 * The fixture: 100 unrestricted in QH01/SH01 and 10 quality beside it. The run
 * posts a 311 of 25 (two lines, the issuing one signed), reads the balance move,
 * posts a 321 out of quality, refuses a same-location move and an over-draw in
 * their own words, then reverses the 311 by its counter movement type and reads
 * both sides back.
 */
export async function transferPosting(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-131: post a storage-location transfer, a stock-type transfer, refuse two, then reverse');

  let company = '';
  let currency = '';
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code, currency, chart_of_accounts from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string; currency: string; chart_of_accounts: string }>;
    if (!rows[0]) throw new Error('the browser tenant carries no company code');
    company = rows[0].company_code;
    currency = rows[0].currency;

    const accounts = await tx.execute(sql`
      select account_number from gl_account where client = ${client} and account_type in ('ASSET', 'REVENUE')
      order by account_number limit 1
    `) as unknown as Array<{ account_number: string }>;
    const revenue = await tx.execute(sql`
      select account_number from gl_account where client = ${client} and account_type = 'REVENUE'
      order by account_number limit 1
    `) as unknown as Array<{ account_number: string }>;

    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by) values
        (${client}, 'QH01', 'Transfer plant one', ${company}, 'KW', 'browser.admin'),
        (${client}, 'QH02', 'Transfer plant two', ${company}, 'KW', 'browser.admin')
      on conflict (client, plant) do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by) values
        (${client}, 'QH01', 'SH01', 'Store H1', false, true, 'browser.admin'),
        (${client}, 'QH01', 'SH02', 'Store H2', false, true, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MB1B-MAT', 'Transferred material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by) values
        (${client}, 'MB1B-MAT', 'QH01', 'browser.admin'),
        (${client}, 'MB1B-MAT', 'QH02', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      select ${client}, 'MB1B-MAT', p.plant, v.valuation_class, 'MOVING_AVERAGE', 0, 10, 1, ${currency}, 0, 0, 'browser.admin'
      from (values ('QH01'), ('QH02')) p(plant)
      cross join (select valuation_class from valuation_class where client = ${client} limit 1) v
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, e.event, v.valuation_class, '', a.account_number, 'browser.admin'
      from (select chart_of_accounts from company_code where client = ${client} limit 1) c
      cross join (select valuation_class from valuation_class where client = ${client} limit 1) v
      cross join (values ('INVENTORY'), ('PRICE_DIFFERENCE')) e(event)
      cross join (select account_number from gl_account where client = ${client}
                  and account_type = ${'REVENUE'} order by account_number limit 1) a
      on conflict do nothing
    `);
    void accounts;
    void revenue;
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, ${company}, 2026, 10, 2026, 9, true, 'browser.admin')
      on conflict (client, company_code) do update set
        current_fiscal_year = 2026, current_period = 10,
        previous_fiscal_year = 2026, previous_period = 9, allow_backposting = true
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
        (${client}, 'MB1B-MAT', 'QH01', 'SH01', 'UNRESTRICTED', 100, 'browser.admin'),
        (${client}, 'MB1B-MAT', 'QH01', 'SH01', 'QUALITY', 10, 'browser.admin'),
        (${client}, 'MB1B-MAT', 'QH01', 'SH02', 'UNRESTRICTED', 0, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
      do update set quantity = excluded.quantity
    `);
  });

  const fill = async (fields: Record<string, string>) => {
    for (const [name, value] of Object.entries(fields)) {
      const field = page.locator(`form input[name="${name}"], form select[name="${name}"]`).last();
      const tag = await field.evaluate((el) => el.tagName);
      if (tag === 'SELECT') await field.selectOption(value);
      else await field.fill(value);
    }
  };

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Transfer Posting', exact: true }).waitFor();
  console.log('  ✓ the transfer screen stands');

  // ── 311: storage location to storage location ───────────────────────────
  await fill({
    movementTypeCode: '311', materialNumber: 'MB1B-MAT', quantity: '25',
    issuingPlant: 'QH01', issuingStorageLocation: 'SH01',
    receivingPlant: 'QH01', receivingStorageLocation: 'SH02',
    postingDate: '2026-10-15', documentDate: '2026-10-15',
  });
  await page.getByRole('button', { name: 'Post transfer', exact: true }).click();
  const status = page.locator('section[aria-labelledby="transfer-item"] p[role="status"]');
  await status.waitFor();
  const message = await status.innerText();
  const documentNumber = /material document ([A-Za-z0-9-]+)/.exec(message)?.[1];
  assert.ok(documentNumber, `the posting names its document: ${message}`);
  console.log(`  ✓ a 311 posted as material document ${documentNumber}`);

  await page.goto(`${base}${ROUTE}?doc=${documentNumber}`, { waitUntil: 'domcontentloaded' });
  const issueRow = page.locator('tr[data-side="ISSUE"]').first();
  await issueRow.waitFor();
  assert.match(await issueRow.innerText(), /SH01/, 'the issuing line names the issuing store');
  assert.match(await issueRow.innerText(), /−25\.000/, 'the issuing line is signed');
  const receiptRow = page.locator('tr[data-side="RECEIPT"]').first();
  assert.match(await receiptRow.innerText(), /SH02/);
  assert.match(await receiptRow.innerText(), /25\.000/);
  assert.equal(await page.locator('tr[data-side]').count(), 2, 'a transfer is two lines and no more');
  console.log('  ✓ the document carries an issuing line and a receiving line, net zero');

  await page.goto(`${base}${ROUTE}?material=MB1B-MAT&plant=QH01`, { waitUntil: 'domcontentloaded' });
  const stockTable = page.locator('section[aria-labelledby="transfer-stock"] table');
  await stockTable.waitFor();
  assert.match(await stockTable.innerText(), /SH01\s+UNRESTRICTED\s+75\.000/);
  assert.match(await stockTable.innerText(), /SH02\s+UNRESTRICTED\s+25\.000/);
  console.log('  ✓ stock moved 25 from SH01 to SH02');

  // ── 321: quality to unrestricted inside one storage location ────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await fill({
    movementTypeCode: '321', materialNumber: 'MB1B-MAT', quantity: '10',
    issuingPlant: 'QH01', issuingStorageLocation: 'SH01',
    receivingPlant: 'QH01', receivingStorageLocation: 'SH01',
    postingDate: '2026-10-15', documentDate: '2026-10-15',
  });
  await page.getByRole('button', { name: 'Post transfer', exact: true }).click();
  await status.waitFor();
  assert.match(await status.innerText(), /Transfer posted as material document/);
  console.log('  ✓ a 321 released the quality stock to unrestricted use');

  // ── Refusals in their own words ─────────────────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await fill({
    movementTypeCode: '311', materialNumber: 'MB1B-MAT', quantity: '5',
    issuingPlant: 'QH01', issuingStorageLocation: 'SH01',
    receivingPlant: 'QH01', receivingStorageLocation: 'SH01',
    postingDate: '2026-10-15', documentDate: '2026-10-15',
  });
  await page.getByRole('button', { name: 'Post transfer', exact: true }).click();
  await status.waitFor();
  assert.match(await status.innerText(), /both sides name SH01/);
  console.log('  ✓ a 311 naming one storage location twice is refused by name');

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await fill({
    movementTypeCode: '311', materialNumber: 'MB1B-MAT', quantity: '9999',
    issuingPlant: 'QH01', issuingStorageLocation: 'SH01',
    receivingPlant: 'QH01', receivingStorageLocation: 'SH02',
    postingDate: '2026-10-15', documentDate: '2026-10-15',
  });
  await page.getByRole('button', { name: 'Post transfer', exact: true }).click();
  await status.waitFor();
  assert.match(await status.innerText(), /short of the 9999\.000/);
  console.log('  ✓ an over-draw names the stock that stands');

  // ── The counter movement reversal ───────────────────────────────────────
  await page.goto(`${base}${ROUTE}?doc=${documentNumber}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Reverse transfer', exact: true }).click();
  const reverseStatus = page.locator('section[aria-labelledby="transfer-document"] p[role="status"]');
  await reverseStatus.waitFor();
  assert.match(await reverseStatus.innerText(), /Reversal posted as material document/);
  console.log('  ✓ the 311 was reversed by its counter movement type');

  await page.goto(`${base}${ROUTE}?material=MB1B-MAT&plant=QH01`, { waitUntil: 'domcontentloaded' });
  await page.locator('section[aria-labelledby="transfer-stock"] table').waitFor();
  const text = await page.locator('section[aria-labelledby="transfer-stock"] table').innerText();
  // 100 unrestricted + the 10 released by the 321 stand back at SH01 once the 25 returns.
  assert.match(text, /SH01\s+UNRESTRICTED\s+110\.000/);
  assert.match(text, /SH02\s+UNRESTRICTED\s+0\.000/);
  console.log('  ✓ the reversal restored both sides');
}
