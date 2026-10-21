import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const MI01 = '/inventory/physical-inventory';
const MI04 = '/inventory/physical-inventory-count';
const MI20 = '/inventory/physical-inventory-differences';
const PLANT = 'QP04';
const SLOC = 'SQ41';

/**
 * SCR-148 browser acceptance (T847) — a difference list reads, and decides nothing.
 *
 * A document is counted through MI04, then read through the difference list: a shortage is
 * named as a shortage, a zero is hidden until asked for and is not called a shortage, an
 * uncounted item is not a zero, the monetary figure carries its currency, the document opens
 * read-only, and a request to post is refused. The ledger fingerprint does not move.
 */
export async function scr148Mi20Differences(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-148: read a counted document as differences — shortage, zero, uncounted, money, refusal — and post nothing');

  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string }>;
    if (!rows[0]) throw new Error('the browser tenant carries no company code');
    const company = rows[0].company_code;

    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, ${PLANT}, 'Difference plant', ${company}, 'KW', 'browser.admin')
      on conflict (client, plant) do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
      values (${client}, ${PLANT}, ${SLOC}, 'Difference store', false, true, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, m.n, m.d, t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values ('MDIF-A', 'Counted steel'), ('MDIF-B', 'Exact bolts'), ('MDIF-C', 'Still to count')) m(n, d)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${client}, m.n, ${PLANT}, 'browser.admin' from (values ('MDIF-A'), ('MDIF-B'), ('MDIF-C')) m(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values
        (${client}, 'MDIF-A', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 100, 'browser.admin'),
        (${client}, 'MDIF-B', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 40, 'browser.admin'),
        (${client}, 'MDIF-C', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 8, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type) do update set quantity = excluded.quantity
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values (${client}, 'MDIF-A', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 10, 10, 1, 'KWD', 100, 1000, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, ${company}, 2026, 10, 2026, 9, true, 'browser.admin')
      on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10
    `);
    await defineRange(tx, {
      client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 7, createdBy: 'browser.admin',
    });
  });

  const ledgerFingerprint = async (): Promise<string> => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select count(*) from material_document where client = ${client})::int as documents,
        (select count(*) from journal_entry where client = ${client})::int as journals,
        (select coalesce(sum(quantity), 0)::text from stock_quantity where client = ${client}) as stock
    `) as unknown as Array<{ documents: number; journals: number; stock: string }>;
    return `${rows[0].documents}/${rows[0].journals}/${rows[0].stock}`;
  });

  await page.goto(`${base}${MI01}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Physical Inventory', exact: true }).waitFor();
  await page.fill('input[name="plant"]', PLANT);
  await page.fill('input[name="storageLocation"]', SLOC);
  await page.fill('input[name="plannedCountDate"]', '2026-10-20');
  await page.fill('input[name="material-1"]', 'MDIF-A');
  await page.fill('input[name="material-2"]', 'MDIF-B');
  await page.fill('input[name="material-3"]', 'MDIF-C');
  await page.getByRole('button', { name: 'Create the count document', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Created: physical inventory document' }).waitFor();
  const documentNumber = (await page.locator('[data-inventory-document]').first().innerText()).trim();
  assert.match(documentNumber, /^PI-\d{4}-\d{7}$/);
  console.log(`  ✓ ${documentNumber} created`);

  const before = await ledgerFingerprint();

  await page.goto(`${base}${MI04}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-line="10"]').waitFor();
  await page.fill('input[name="quantity-1"]', '95');
  await page.fill('input[name="quantity-2"]', '40');
  await page.getByRole('button', { name: 'Save counts', exact: true }).click();
  await page.locator('[data-count-message]').waitFor();
  assert.match(await page.locator('[data-count-message]').innerText(), /Count saved for 2 items/);
  console.log('  ✓ 95 and 40 counted; the third item left uncounted');

  await page.locator('[data-count-differences-link]').click();
  await page.getByRole('heading', { level: 1, name: 'Physical inventory differences', exact: true }).waitFor();
  await page.locator('[data-difference-row]').first().waitFor();
  const grid = await page.locator('table').innerText();
  assert.match(grid, /Shortage/, 'a counted shortfall is named as a shortage');
  assert.match(grid, /-5\.000/);
  assert.match(grid, /-50\.000 KWD/, 'the monetary difference carries the currency');
  assert.match(grid, /Current plant price/);
  assert.doesNotMatch(grid, /MDIF-B/, 'a zero difference is hidden by the default selection');
  assert.doesNotMatch(grid, /MDIF-C/, 'an uncounted item is not listed as zero');
  assert.equal(await page.getByRole('button', { name: /Post/ }).count(), 0, 'the list has no posting control');
  assert.equal(await page.getByRole('link', { name: /Recount/ }).count(), 0, 'the list has no recount control');
  console.log('  ✓ the shortage is named, priced in KWD, and the zero and the uncounted item are absent');

  const widened = `${base}${MI20}?executed=1&plantFrom=${PLANT}&fiscalYear=2026&documentFrom=${documentNumber}&documentTo=${documentNumber}&differenceExists=0&includeUncounted=1`;
  await page.goto(widened, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-difference-row]').first().waitFor();
  const all = await page.locator('table').innerText();
  assert.match(all, /No difference/, 'a zero count is not called a shortage');
  assert.match(all, /Not counted/);
  assert.match(all, /Unavailable/, 'a material with no valuation is named, not zeroed');
  console.log('  ✓ a zero is no difference, an uncounted item is not counted, and the unvalued row says unavailable');

  await page.locator('[data-difference-row] a').first().click();
  await page.locator('[data-difference-document]').waitFor();
  assert.match(await page.locator('[data-difference-document]').innerText(), /Read only/);
  assert.match(await page.locator('[data-difference-document-status]').innerText(), /PARTIALLY_COUNTED/);
  console.log('  ✓ the document opened read-only, still partially counted');

  await page.goto(
    `${base}${MI20}?workflow=POST&doc=${documentNumber}&year=2026`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('[data-difference-workflow]').waitFor();
  assert.match(await page.locator('[data-difference-workflow]').innerText(), /does not post/);
  console.log('  ✓ a request to post was refused');

  const after = await ledgerFingerprint();
  assert.equal(after, before, `the ledger is untouched: ${before} then ${after}`);
  console.log('  ✓ no material document, no journal, no stock moved');

  console.log(
    'SCR-148: a shortage was named and priced, a zero was not a shortage, an uncounted item was not zero, '
    + 'an unvalued row stayed unvalued, the document opened read-only, a posting was refused, and the ledger never moved',
  );
}
