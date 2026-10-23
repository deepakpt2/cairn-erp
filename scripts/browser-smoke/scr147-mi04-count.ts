import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const MI01 = '/inventory/physical-inventory';
const MI04 = '/inventory/physical-inventory-count';
const PLANT = 'QP03';
const SLOC = 'SQ31';

/**
 * SCR-147 browser acceptance (T846) — counting is not adjusting.
 *
 * A document is created through the MI01 screen, then counted through MI04: one material counted,
 * one recorded as an explicit zero, and the third left alone — and the document says
 * PARTIALLY_COUNTED because one item is still owed a count. A correction moves a quantity and the
 * history keeps what it was; a zero beside a quantity is refused; a stale screen is refused with
 * the version that stands; a cleared count returns the item to uncounted without erasing the
 * quantity it cleared.
 *
 * Through all of it the ledger does not move: the run takes a fingerprint of material documents,
 * journals, stock and valuation before the first count and reads it back after the last.
 */
export async function scr147Mi04Count(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-147: count a document from MI04 — positive, explicit zero, correction, stale refusal, clear — and post nothing');

  let company = '';
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code, currency from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string; currency: string }>;
    if (!rows[0]) throw new Error('the browser tenant carries no company code');
    company = rows[0].company_code;

    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, ${PLANT}, 'Count plant', ${company}, 'KW', 'browser.admin')
      on conflict (client, plant) do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
      values (${client}, ${PLANT}, ${SLOC}, 'Count store', false, true, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, m.n, m.d, t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values ('MCNT-A', 'Counted steel'), ('MCNT-B', 'Counted bolts')) m(n, d)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${client}, m.n, ${PLANT}, 'browser.admin'
      from (values ('MCNT-A'), ('MCNT-B')) m(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values
        (${client}, 'MCNT-A', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 100, 'browser.admin'),
        (${client}, 'MCNT-A', ${PLANT}, ${SLOC}, 'QUALITY', 10, 'browser.admin'),
        (${client}, 'MCNT-B', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 40, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number) do update set quantity = excluded.quantity
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
        (select coalesce(sum(quantity), 0)::text from stock_quantity where client = ${client}) as stock,
        (select coalesce(sum(stock_value), 0)::text from material_valuation where client = ${client}) as value
    `) as unknown as Array<{ documents: number; journals: number; stock: string; value: string }>;
    return `${rows[0].documents}/${rows[0].journals}/${rows[0].stock}/${rows[0].value}`;
  });

  // ── The document, created through MI01 ──────────────────────────────────
  await page.goto(`${base}${MI01}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Physical Inventory', exact: true }).waitFor();
  await page.fill('input[name="plant"]', PLANT);
  await page.fill('input[name="storageLocation"]', SLOC);
  await page.fill('input[name="plannedCountDate"]', '2026-10-20');
  await page.check('input[name="postingBlock"]');
  await page.fill('input[name="material-1"]', 'MCNT-A');
  await page.fill('input[name="material-2"]', 'MCNT-B');
  await page.getByRole('button', { name: 'Create the count document', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Created: physical inventory document' }).waitFor();
  const documentNumber = (await page.locator('[data-inventory-document]').first().innerText()).trim();
  assert.match(documentNumber, /^PI-\d{4}-\d{7}$/, 'the document draws a year-bearing number');
  console.log(`  ✓ ${documentNumber} created with a posting block over two materials`);

  const before = await ledgerFingerprint();

  // ── The count workbench ─────────────────────────────────────────────────
  await page.goto(`${base}${MI04}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Enter Physical Inventory Count', exact: true }).waitFor();
  await page.locator('[data-count-line="10"]').waitFor();
  assert.equal(await page.locator('[data-count-line]').count(), 3, 'one item per material and stock type');
  assert.match(
    await page.locator('[data-count-line="10"]').innerText(),
    /QUALITY/,
    'the quality stock is its own item, not folded into unrestricted',
  );
  assert.match(await page.locator('[data-count-line="20"]').innerText(), /100\.000/);
  console.log('  ✓ the grid carries three items, QUALITY separated from UNRESTRICTED');

  // Count 95 of the 100 unrestricted, and record an explicit zero against the quality stock.
  await page.fill('input[name="quantity-2"]', '95');
  await page.check('input[name="zero-1"]');
  await page.fill('input[name="counterName"]', 'A. Counter');
  await page.getByRole('button', { name: 'Save counts', exact: true }).click();
  await page.locator('[data-count-message]').waitFor();
  assert.match(await page.locator('[data-count-message]').innerText(), /Count saved for 2 items/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-line="10"]').waitFor();
  assert.equal(await page.locator('[data-count-document-status]').innerText(), 'PARTIALLY_COUNTED', 'one item is still owed a count');
  assert.equal(await page.locator('[data-count-counted]').innerText(), '2');
  assert.equal(await page.locator('[data-count-uncounted]').innerText(), '1');
  assert.match(await page.locator('[data-count-line="20"]').innerText(), /-5\.000/, 'counted 95 against a book of 100');
  assert.match(await page.locator('[data-count-line="10"]').innerText(), /zero verified/, 'the zero is recorded as a fact');
  assert.match(await page.locator('[data-count-remaining]').innerText(), /30/);
  console.log('  ✓ 95 counted and a zero recorded; the document is PARTIALLY_COUNTED with item 30 owed a count');

  // ── A correction, and the history it keeps ──────────────────────────────
  await page.fill('input[name="quantity-2"]', '100');
  await page.fill('input[name="reason"]', 'Miscount: a pallet was double counted');
  await page.getByRole('button', { name: 'Save counts', exact: true }).click();
  await page.locator('[data-count-message]').waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-line="20"]').waitFor();
  assert.match(await page.locator('[data-count-line="20"]').innerText(), /0\.000/, 'the correction lands on the same book quantity');
  const history = await page.locator('[data-count-history]').innerText();
  assert.match(history, /95\.000/, 'the history keeps what the count was');
  assert.match(history, /100\.000/, 'and what it became');
  console.log('  ✓ the count was corrected to 100 and the history keeps 95 → 100');

  // ── A zero beside a quantity is refused ─────────────────────────────────
  // A client that ignores the control it was given: it ticks the zero flag, re-enables the
  // quantity it was told not to fill, types 5, and submits — all in one turn of the page's own
  // JavaScript, so nothing can quietly undo it between the two.
  await page.evaluate(() => {
    const zero = document.querySelector<HTMLInputElement>('input[name="zero-3"]');
    const quantity = document.querySelector<HTMLInputElement>('input[name="quantity-3"]');
    if (!zero || !quantity?.form) throw new Error('the third row is not on the page');
    // No change event is dispatched: React is deliberately left unaware, so it does not re-render
    // and re-disable the field between the two assignments and the submit.
    zero.checked = true;
    quantity.disabled = false;
    quantity.value = '5';
    quantity.form.requestSubmit();
  });
  await page.waitForFunction(
    () => document.querySelector('[data-count-message]')?.textContent?.includes('at once') ?? false,
    undefined,
    { timeout: 10_000 },
  ).catch(() => {});
  await page.locator('[data-count-message]').waitFor();
  assert.match(
    await page.locator('[data-count-message]').innerText(),
    /submitted as a zero count and as 5 at once/,
    'the contradiction is refused in words',
  );
  console.log('  ✓ a zero flag beside a positive quantity was refused');

  // ── A stale screen is refused ───────────────────────────────────────────
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-line="30"]').waitFor();
  await page.fill('input[name="quantity-3"]', '38');
  await page.evaluate(() => {
    const version = document.querySelector<HTMLInputElement>('input[name="version-3"]');
    if (!version) throw new Error('the version field is not on the page');
    version.value = '2'; // the item stands at 1; this screen is claiming a newer one
  });
  await page.getByRole('button', { name: 'Save counts', exact: true }).click();
  await page.locator('[data-count-message]').waitFor();
  assert.match(
    await page.locator('[data-count-message]').innerText(),
    /it now stands at version 1/,
    'the stale submission is refused with the version that stands',
  );
  console.log('  ✓ a stale submission was refused, naming the version that stands');

  // ── Clearing a count ────────────────────────────────────────────────────
  const clearForm = page.locator('form').filter({ has: page.locator('input[name="itemNumber"][value="10"]') });
  await clearForm.locator('input[name="reason"]').fill('Recorded the zero against the wrong item');
  await clearForm.getByRole('button', { name: 'Clear count', exact: true }).click();
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-line="10"]').waitFor();
  assert.equal(await page.locator('[data-count-document-status]').innerText(), 'PARTIALLY_COUNTED');
  assert.equal(await page.locator('[data-count-uncounted]').innerText(), '2', 'the cleared item is uncounted again');
  assert.match(await page.locator('[data-count-line="10"]').innerText(), /UNCOUNTED/);
  await page.locator('[data-count-history]').waitFor();
  assert.match(await page.locator('[data-count-history]').innerText(), /Recorded the zero against the wrong item/);
  console.log('  ✓ the zero was cleared, the item returned to uncounted, and the reason kept');

  // ── Counting the rest ───────────────────────────────────────────────────
  await page.check('input[name="zero-1"]');
  await page.fill('input[name="quantity-3"]', '38');
  await page.getByRole('button', { name: 'Save counts', exact: true }).click();
  await page.locator('[data-count-message]').waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-document-status]').waitFor();
  assert.equal(await page.locator('[data-count-document-status]').innerText(), 'COUNTED', 'every item is counted now');
  assert.equal(await page.locator('[data-count-uncounted]').innerText(), '0');
  console.log('  ✓ the document advanced to COUNTED only once every item was counted');

  // ── Nothing posted ──────────────────────────────────────────────────────
  const after = await ledgerFingerprint();
  assert.equal(after, before, `the ledger is untouched: ${before} then ${after}`);
  const counts = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n from material_document where client = ${client}
    `) as unknown as Array<{ n: number }>;
    return Number(rows[0].n);
  });
  assert.equal(counts, 0, 'no material document stands for a count');
  console.log('  ✓ no material document, no journal, no stock and no valuation moved');

  console.log(
    'SCR-147: a count recorded what the counter found, a zero stood apart from a missing count, '
    + 'a correction kept its history, a contradiction and a stale screen were refused, a cleared '
    + 'count returned the item to uncounted, and the ledger never moved',
  );
}
