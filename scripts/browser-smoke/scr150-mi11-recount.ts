import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { createPhysicalInventory } from '../../src/modules/inventory/physical-inventory';
import { submitCounts } from '../../src/modules/inventory/physical-inventory-count';
import { postDifferences } from '../../src/modules/inventory/physical-inventory-posting';
import { createRecount } from '../../src/modules/inventory/physical-inventory-recount';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const MI01 = '/inventory/physical-inventory';
const MI04 = '/inventory/physical-inventory-count';
const MI20 = '/inventory/physical-inventory-differences';
const POST = '/inventory/physical-inventory-posting';
const RECOUNT = '/inventory/physical-inventory-recount';
const PLANT = 'RC49';
const SLOC = 'RC49';
const DAY = '2026-10-21';
const ACTOR = 'browser.admin';

/**
 * SCR-150 browser acceptance (T849) — a recount is a new document.
 *
 * The original count stays. The recount freezes the stock standing now. The list shows both
 * and does not add them. A refusal leaves no document behind, and this screen does not reverse.
 */
export async function scr150Mi11Recount(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-150: recount the selected items, and leave the original count where it was');

  const company = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string }>;
    if (!rows[0]) throw new Error('the browser tenant carries no company code');
    const code = rows[0].company_code;
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, ${PLANT}, 'Recount plant', ${code}, 'KW', ${ACTOR})
      on conflict (client, plant) do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
      values (${client}, ${PLANT}, ${SLOC}, 'Recount store', false, true, ${ACTOR})
      on conflict (client, plant, storage_location) do update set is_active = true, allow_negative_stock = false
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, m.n, m.d, t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values
        ('RC49-A', 'Selected'), ('RC49-B', 'Uncounted'), ('RC49-Z', 'Exact'),
        ('RC49-C', 'One item'), ('RC49-P', 'Posted'), ('RC49-D', 'Closed period'), ('RC49-E', 'Concurrent')
      ) m(n, d)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${client}, m.n, ${PLANT}, ${ACTOR}
      from (values ('RC49-A'), ('RC49-B'), ('RC49-Z'), ('RC49-C'), ('RC49-P'), ('RC49-D'), ('RC49-E')) m(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values
        (${client}, 'RC49-A', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 50, ${ACTOR}),
        (${client}, 'RC49-A', ${PLANT}, ${SLOC}, 'QUALITY', 7, ${ACTOR}),
        (${client}, 'RC49-B', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 12, ${ACTOR}),
        (${client}, 'RC49-Z', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 9, ${ACTOR}),
        (${client}, 'RC49-C', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 15, ${ACTOR}),
        (${client}, 'RC49-P', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 20, ${ACTOR}),
        (${client}, 'RC49-D', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 6, ${ACTOR}),
        (${client}, 'RC49-E', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 4, ${ACTOR})
      on conflict (client, material_number, plant, storage_location, stock_type) do update set quantity = excluded.quantity
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values
        (${client}, 'RC49-A', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 10, 10, 1, 'KWD', 57, 570, ${ACTOR}),
        (${client}, 'RC49-Z', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 4, 4, 1, 'KWD', 9, 36, ${ACTOR}),
        (${client}, 'RC49-P', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 5, 5, 1, 'KWD', 20, 100, ${ACTOR}),
        (${client}, 'RC49-C', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 3, 3, 1, 'KWD', 15, 45, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      update gl_account set requires_cost_object = false
       where client = ${client} and account_number in ('120000', '440000')
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', v.m, v.a, ${ACTOR}
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values ('INVENTORY', '', '120000'), ('OFFSETTING_INVENTORY', 'DIFF', '440000')) v(e, m, a)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type
        (client, movement_type, description, direction, reference_category, movement_kind,
         valuation_relevant, inventory_event, offset_event, offset_modifier, reversal_movement_type, created_by)
      values
        (${client}, 'SURPLUS-R', 'Configured surplus', 'RECEIPT', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
         true, 'INVENTORY', 'OFFSETTING_INVENTORY', 'DIFF', 'SHORT-R', ${ACTOR}),
        (${client}, 'SHORT-R', 'Configured shortage', 'ISSUE', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
         true, 'INVENTORY', 'OFFSETTING_INVENTORY', 'DIFF', 'SURPLUS-R', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, ${code}, 2026, 10, 2026, 9, true, ${ACTOR})
      on conflict (client, company_code) do update set
        current_fiscal_year = 2026, current_period = 10, allow_backposting = true
    `);
    await defineRange(tx, { client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'M', numberLength: 6, createdBy: ACTOR });
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: code, subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
    });
    return code;
  });

  const tallies = async () => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select count(*) from physical_inventory_document where client = ${client})::int as documents,
        (select count(*) from physical_inventory_recount_link where client = ${client})::int as links,
        (select count(*) from material_document where client = ${client})::int as material_documents,
        (select count(*) from journal_entry where client = ${client})::int as journals,
        (select quantity::text from stock_quantity
          where client = ${client} and material_number = 'RC49-A' and stock_type = 'UNRESTRICTED') as stock
    `) as unknown as Array<{ documents: number; links: number; material_documents: number; journals: number; stock: string }>;
    return rows[0];
  });

  const itemsOf = async (documentNumber: string) => withTenant(client, async (tx) => tx.execute(sql`
    select item_number, material_number, stock_type, count_status,
           counted_quantity::text as counted, book_quantity_snapshot::text as book,
           difference_quantity::text as difference
      from physical_inventory_item
     where client = ${client} and inventory_document_number = ${documentNumber}
     order by item_number
  `)) as unknown as Array<{
    item_number: number; material_number: string; stock_type: string; count_status: string;
    counted: string | null; book: string | null; difference: string | null;
  }>;

  const form = () => page.locator('form').filter({ has: page.locator('[data-recount-check]') });

  await page.goto(`${base}${MI01}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Physical Inventory', exact: true }).waitFor();
  await page.fill('input[name="plant"]', PLANT);
  await page.fill('input[name="storageLocation"]', SLOC);
  await page.fill('input[name="plannedCountDate"]', DAY);
  for (const [index, material] of ['RC49-A', 'RC49-B', 'RC49-Z'].entries()) {
    await page.fill(`input[name="material-${index + 1}"]`, material);
  }
  await page.getByRole('button', { name: 'Create the count document', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Created: physical inventory document' }).waitFor();
  const documentNumber = (await page.locator('[data-inventory-document]').first().innerText()).trim();
  assert.match(documentNumber, /^PI-\d{4}-\d{7}$/);
  const sourceItems = await itemsOf(documentNumber);
  const unrestricted = sourceItems.find((item) => item.material_number === 'RC49-A' && item.stock_type === 'UNRESTRICTED')!;
  const quality = sourceItems.find((item) => item.material_number === 'RC49-A' && item.stock_type === 'QUALITY')!;
  const uncounted = sourceItems.find((item) => item.material_number === 'RC49-B')!;
  const exact = sourceItems.find((item) => item.material_number === 'RC49-Z')!;
  assert.ok(unrestricted && quality && uncounted && exact, 'the document carries both stock types and the uncounted material');
  console.log(`  ✓ ${documentNumber} carries unrestricted and quality, and the uncounted material`);

  await page.goto(`${base}${MI04}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-line]').first().waitFor();
  await page.fill('input[name="countDate"]', DAY);
  const lines = page.locator('[data-count-line]');
  const lineCount = await lines.count();
  const quantities: Record<number, string> = {
    [unrestricted.item_number]: '40',
    [quality.item_number]: '7',
    [exact.item_number]: '9',
  };
  for (let index = 0; index < lineCount; index += 1) {
    const itemNumber = Number(await lines.nth(index).getAttribute('data-count-line'));
    if (quantities[itemNumber] !== undefined) await page.fill(`input[name="quantity-${index + 1}"]`, quantities[itemNumber]);
  }
  await page.getByRole('button', { name: 'Save counts', exact: true }).click();
  await page.locator('[data-count-message]').waitFor();
  assert.match(await page.locator('[data-count-message]').innerText(), /Count saved for 3 items/);
  console.log('  ✓ three items counted; the uncounted material was left uncounted');

  await withTenant(client, (tx) => tx.execute(sql`
    update stock_quantity set quantity = 48
     where client = ${client} and material_number = 'RC49-A' and stock_type = 'UNRESTRICTED'
  `));

  await page.goto(`${base}${RECOUNT}?doc=NO-SUCH&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Recount physical inventory', exact: true }).waitFor();
  assert.match(await page.locator('p[role="status"]').innerText(), /does not stand/);
  await page.goto(`${base}${RECOUNT}?doc=${documentNumber}`, { waitUntil: 'domcontentloaded' });
  assert.match(await page.locator('p[role="status"]').innerText(), /does not stand/);
  assert.equal(await page.locator('input[name="postingDate"]').count(), 0, 'a planned date is not a posting date');
  assert.equal(await page.locator('input[name="quantity"]').count(), 0, 'the recount quantity is not entered here');
  console.log('  ✓ a missing document and a missing year are refused, and there is no posting date or quantity');

  await page.goto(`${base}${RECOUNT}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-recount-document]').waitFor();
  const uncountedReason = page.locator(`[data-recount-line="${uncounted.item_number}"] [data-recount-reason]`);
  assert.match(await uncountedReason.innerText(), /has not been counted/);
  assert.equal(await page.locator(`[data-recount-line="${uncounted.item_number}"] input[name="item"]`).isDisabled(), true);
  assert.match(await page.locator(`[data-recount-line="${unrestricted.item_number}"] [data-recount-book-now]`).innerText(), /48\.000/);
  assert.match(await page.locator(`[data-recount-line="${unrestricted.item_number}"] [data-recount-counted]`).innerText(), /40\.000/);
  console.log('  ✓ the uncounted item is named, and the book standing now is not the original snapshot');

  const beforeCheck = await tallies();
  await page.getByRole('button', { name: 'Select eligible', exact: true }).click();
  await form().locator('input[name="plannedRecountDate"]').fill(DAY);
  await form().locator('input[name="reason"]').fill('Second count');
  await page.locator('[data-recount-check]').click();
  await page.locator('[data-recount-preview]').waitFor();
  const preview = await page.locator('[data-recount-preview]').innerText();
  assert.match(preview, /Nothing was written/);
  assert.match(preview, /48\.000/);
  assert.deepEqual(await tallies(), beforeCheck, 'a check writes nothing');
  console.log('  ✓ the check showed the stock standing now and wrote nothing');

  await page.getByRole('button', { name: 'Select eligible', exact: true }).click();
  await form().locator('input[name="plannedRecountDate"]').fill(DAY);
  await form().locator('input[name="reason"]').fill('Second count');
  const requestKey = await form().locator('input[name="requestKey"]').inputValue();
  const selected = [unrestricted.item_number, quality.item_number, exact.item_number].map(String);
  await page.getByRole('button', { name: 'Create recount', exact: true }).click();
  await page.locator('[data-recount-result]').waitFor();
  const createdText = await page.locator('[data-recount-result]').innerText();
  assert.match(createdText, /Recount document PI-/);
  assert.match(createdText, /original count was not changed/);
  const recountDocument = createdText.match(/Recount document (PI-\d{4}-\d{7})/)?.[1] ?? '';
  assert.ok(recountDocument);
  const afterCreate = await tallies();
  assert.equal(afterCreate.documents, beforeCheck.documents + 1);
  assert.equal(afterCreate.material_documents, beforeCheck.material_documents, 'a recount writes no material document');
  assert.equal(afterCreate.journals, beforeCheck.journals, 'a recount writes no journal');
  assert.equal(Number(afterCreate.stock), 48);
  const originalAfter = (await itemsOf(documentNumber)).find((item) => item.item_number === unrestricted.item_number)!;
  assert.equal(originalAfter.count_status, 'RECOUNT_REQUIRED');
  assert.equal(Number(originalAfter.counted), 40);
  assert.equal(Number(originalAfter.book), 50);
  const recountItems = await itemsOf(recountDocument);
  assert.equal(recountItems.length, 3, 'several selected items, and not the uncounted one');
  assert.equal(recountItems.some((item) => item.stock_type === 'QUALITY'), true);
  assert.equal(Number(recountItems.find((item) => item.stock_type === 'UNRESTRICTED' && item.material_number === 'RC49-A')?.book), 48);
  console.log(`  ✓ ${recountDocument} froze 48, left the original count at 40, and wrote no stock and no journal`);

  const replay = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('physical-inventory-recount'),
  );
  const replayed = await page.evaluate(({ key, items }) => {
    const posting = [...document.querySelectorAll('form')].find((form) => form.querySelector('[data-recount-check]'));
    if (!posting) return 'no form';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(posting.querySelector('input[name="requestKey"]'), key);
    setter?.call(posting.querySelector('input[name="reason"]'), 'Second count');
    setter?.call(posting.querySelector('input[name="plannedRecountDate"]'), '2026-10-21');
    for (const existing of posting.querySelectorAll('input[name="item"]')) existing.remove();
    for (const item of items) {
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'item';
      hidden.value = item;
      posting.appendChild(hidden);
    }
    const submit = posting.querySelector('button[type="submit"]');
    submit?.removeAttribute('disabled');
    posting.requestSubmit(submit as HTMLButtonElement);
    return 'submitted';
  }, { key: requestKey, items: selected });
  await replay;
  assert.equal(replayed, 'submitted');
  await page.locator('[data-recount-result]').filter({ hasText: recountDocument }).waitFor();
  assert.equal((await tallies()).documents, afterCreate.documents, 'the same key returned the same document');
  console.log('  ✓ a retry returned the same recount document');

  const changed = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('physical-inventory-recount'),
  );
  await page.evaluate(({ key, items }) => {
    const posting = [...document.querySelectorAll('form')].find((form) => form.querySelector('[data-recount-check]'));
    if (!posting) throw new Error('the recount form is not on the page');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(posting.querySelector('input[name="requestKey"]'), key);
    setter?.call(posting.querySelector('input[name="reason"]'), 'Other reason');
    for (const existing of posting.querySelectorAll('input[name="item"]')) existing.remove();
    for (const item of items) {
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'item';
      hidden.value = item;
      posting.appendChild(hidden);
    }
    const submit = posting.querySelector('button[type="submit"]');
    submit?.removeAttribute('disabled');
    posting.requestSubmit(submit as HTMLButtonElement);
  }, { key: requestKey, items: selected });
  await changed;
  await page.locator('[data-recount-result]').filter({ hasText: 'different recount' }).waitFor();
  assert.equal((await tallies()).documents, afterCreate.documents);
  console.log('  ✓ the same key with a different reason was refused');

  await page.goto(`${base}${RECOUNT}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-recount-document]').waitFor();
  assert.match(await page.locator(`[data-recount-line="${unrestricted.item_number}"]`).innerText(), new RegExp(recountDocument));
  const beforeSecond = await tallies();
  const refused = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('physical-inventory-recount'),
  );
  await page.evaluate(({ items }) => {
    const posting = [...document.querySelectorAll('form')].find((form) => form.querySelector('[data-recount-check]'));
    if (!posting) throw new Error('the recount form is not on the page');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(posting.querySelector('input[name="requestKey"]'), 'scr150-second');
    setter?.call(posting.querySelector('input[name="reason"]'), 'Again');
    setter?.call(posting.querySelector('input[name="plannedRecountDate"]'), '2026-10-21');
    for (const existing of posting.querySelectorAll('input[name="item"]')) existing.remove();
    for (const item of items) {
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'item';
      hidden.value = item;
      posting.appendChild(hidden);
    }
    posting.querySelector('button[type="submit"]')?.removeAttribute('disabled');
    posting.requestSubmit(posting.querySelector('button[type="submit"]') as HTMLButtonElement);
  }, { items: [String(unrestricted.item_number), String(uncounted.item_number), '999'] });
  await refused;
  await page.locator('[data-recount-result]').filter({ hasText: 'does not belong' }).waitFor();
  const refusal = await page.locator('[data-recount-result]').innerText();
  assert.match(refusal, new RegExp(recountDocument));
  assert.match(refusal, /has not been counted/);
  assert.match(refusal, /does not belong/);
  assert.deepEqual(await tallies(), beforeSecond, 'an ineligible selection writes nothing');
  console.log('  ✓ a second recount, an uncounted item and an item that does not belong were refused by name');

  const crafted = async (extra: Record<string, string>, expected: RegExp) => {
    const before = await tallies();
    const response = page.waitForResponse(
      (candidate) => candidate.request().method() === 'POST' && candidate.url().includes('physical-inventory-recount'),
    );
    await page.evaluate((fields) => {
      const posting = [...document.querySelectorAll('form')].find((form) => form.querySelector('[data-recount-check]'));
      if (!posting) throw new Error('the recount form is not on the page');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(posting.querySelector('input[name="requestKey"]'), 'scr150-' + Math.random().toString(36).slice(2));
      setter?.call(posting.querySelector('input[name="reason"]'), 'Crafted');
      setter?.call(posting.querySelector('input[name="plannedRecountDate"]'), '2026-10-21');
      for (const [name, value] of Object.entries(fields)) {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = name;
        hidden.value = value;
        posting.appendChild(hidden);
      }
      posting.querySelector('button[type="submit"]')?.removeAttribute('disabled');
      posting.requestSubmit(posting.querySelector('button[type="submit"]') as HTMLButtonElement);
    }, extra);
    await response;
    await page.locator('[data-recount-result]').filter({ hasText: expected }).waitFor();
    assert.deepEqual(await tallies(), before);
  };
  await crafted({ postingDate: DAY }, /not a posting date/);
  await crafted({ varianceThreshold: '1' }, /threshold/);
  console.log('  ✓ a posting date and a threshold were refused, and nothing was written');

  await page.goto(`${base}${MI04}?doc=${recountDocument}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-line]').first().waitFor();
  const recountLines = await itemsOf(recountDocument);
  const recountUnrestricted = recountLines.find((item) => item.material_number === 'RC49-A' && item.stock_type === 'UNRESTRICTED')!;
  const recountCounts: Record<number, string> = {};
  for (const item of recountLines) {
    recountCounts[item.item_number] = item.material_number === 'RC49-A' && item.stock_type === 'UNRESTRICTED' ? '40' : String(Number(item.book));
  }
  const recountRows = page.locator('[data-count-line]');
  const recountRowCount = await recountRows.count();
  for (let index = 0; index < recountRowCount; index += 1) {
    const itemNumber = Number(await recountRows.nth(index).getAttribute('data-count-line'));
    await page.fill(`input[name="quantity-${index + 1}"]`, recountCounts[itemNumber]);
  }
  await page.getByRole('button', { name: 'Save counts', exact: true }).click();
  await page.locator('[data-count-message]').waitFor();
  assert.match(await page.locator('[data-count-message]').innerText(), /Count saved/);
  const originalStill = (await itemsOf(documentNumber)).find((item) => item.item_number === unrestricted.item_number)!;
  assert.equal(Number(originalStill.counted), 40, 'the recount quantity was not written onto the original');
  assert.equal(Number((await itemsOf(recountDocument)).find((item) => item.item_number === recountUnrestricted.item_number)?.counted), 40);
  console.log('  ✓ the recount quantity is on the new document only');

  await page.goto(
    `${base}${MI20}?executed=1&plantFrom=${PLANT}&fiscalYear=2026&documentFrom=${documentNumber}&documentTo=${documentNumber}&differenceExists=0&includeUncounted=1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('[data-difference-row]').first().waitFor();
  await page.locator('[data-difference-row] a').first().click();
  await page.locator('[data-recount-comparison]').waitFor();
  const comparison = page.locator(`[data-recount-comparison-line="${unrestricted.item_number}"]`);
  assert.match(await comparison.locator('[data-recount-original]').innerText(), /50\.000/);
  assert.match(await comparison.locator('[data-recount-original]').innerText(), /40\.000/);
  assert.match(await comparison.locator('[data-recount-original]').innerText(), /-10\.000/);
  assert.match(await comparison.locator('[data-recount-side]').innerText(), /48\.000/);
  assert.match(await comparison.locator('[data-recount-side]').innerText(), /-8\.000/);
  assert.doesNotMatch(await page.locator('[data-recount-comparison]').innerText(), /-18\.000/);
  assert.equal(await page.getByRole('button', { name: 'Create recount' }).count(), 0, 'the list does not recount');
  await page.locator('[data-difference-recount-link][href*="doc="]').click();
  await page.getByRole('heading', { level: 1, name: 'Recount physical inventory', exact: true }).waitFor();
  await page.goto(`${base}${MI20}?workflow=RECOUNT&doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-difference-workflow]').waitFor();
  assert.match(await page.locator('[data-difference-workflow]').innerText(), /does not create a recount/);
  console.log('  ✓ the list showed both results, did not add them, and still refuses to recount');

  await page.goto(`${base}${POST}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-posting-document]').waitFor();
  assert.match(await page.locator('[data-posting-document]').innerText(), new RegExp(recountDocument));
  await assert.rejects(
    () => postDifferences({
      client, changedBy: ACTOR, documentNumber, fiscalYear: 2026,
      itemNumbers: [unrestricted.item_number], postingDate: DAY, documentDate: DAY, requestKey: 'scr150-direct',
    }),
    new RegExp(recountDocument),
  );
  console.log('  ✓ difference posting refuses the original, including a direct call');

  const beforePost = await tallies();
  await page.goto(`${base}${POST}?doc=${recountDocument}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-posting-document]').waitFor();
  await page.getByRole('button', { name: 'Select eligible', exact: true }).click();
  const postingForm = page.locator('form').filter({ has: page.locator('[data-posting-check]') });
  await postingForm.locator('input[name="postingDate"]').fill(DAY);
  await postingForm.locator('input[name="documentDate"]').fill(DAY);
  await page.getByRole('button', { name: 'Post selected differences', exact: true }).click();
  await page.locator('[data-posting-result]').waitFor();
  assert.match(await page.locator('[data-posting-result]').innerText(), /Posted material document /);
  const posted = await tallies();
  assert.equal(posted.material_documents, beforePost.material_documents + 1);
  assert.equal(Number(posted.stock), 40, 'only the recount difference moved stock');
  const link = await withTenant(client, async (tx) => tx.execute(sql`
    select status from physical_inventory_recount_link
     where client = ${client} and recount_document_number = ${recountDocument}
     limit 1
  `)) as unknown as Array<{ status: string }>;
  assert.equal(link[0].status, 'RESOLVED');
  assert.equal((await itemsOf(documentNumber)).find((item) => item.item_number === unrestricted.item_number)?.count_status, 'RECOUNT_REQUIRED');
  await assert.rejects(
    () => postDifferences({
      client, changedBy: ACTOR, documentNumber, fiscalYear: 2026,
      itemNumbers: [unrestricted.item_number], postingDate: DAY, documentDate: DAY, requestKey: 'scr150-after',
    }),
    new RegExp(recountDocument),
  );
  console.log('  ✓ the recount posted once, the link resolved, and the original stays ineligible');

  const one = await createPhysicalInventory({
    client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
    plannedCountDate: DAY, materials: ['RC49-C'], requestKey: 'scr150-one-doc',
  });
  await submitCounts({
    client, changedBy: ACTOR, documentNumber: one.inventoryDocumentNumber, fiscalYear: one.fiscalYear,
    countDate: DAY, requestKey: 'scr150-one-count', lines: [{ itemNumber: 10, quantity: 14 }],
  });
  await page.goto(`${base}${RECOUNT}?doc=${one.inventoryDocumentNumber}&year=${one.fiscalYear}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-recount-document]').waitFor();
  await page.getByRole('button', { name: 'Select eligible', exact: true }).click();
  await form().locator('input[name="reason"]').fill('One item');
  await form().locator('input[name="plannedRecountDate"]').fill(DAY);
  await page.getByRole('button', { name: 'Create recount', exact: true }).click();
  await page.locator('[data-recount-result]').filter({ hasText: 'Recount document' }).waitFor();
  const oneRecount = (await page.locator('[data-recount-result]').innerText()).match(/Recount document (PI-\d{4}-\d{7})/)?.[1] ?? '';
  assert.equal((await itemsOf(oneRecount)).length, 1);
  const cancel = page.locator('[data-recount-cancel]');
  await cancel.locator('input[name="recountDocumentNumber"]').fill(oneRecount);
  await cancel.locator('input[name="recountFiscalYear"]').fill(String(one.fiscalYear));
  await cancel.locator('input[name="reason"]').fill('Raised in error');
  await cancel.getByRole('button', { name: 'Cancel recount', exact: true }).click();
  await cancel.locator('p[role="status"]').filter({ hasText: 'cancelled' }).waitFor();
  const cancelledLink = await withTenant(client, async (tx) => tx.execute(sql`
    select status from physical_inventory_recount_link
     where client = ${client} and recount_document_number = ${oneRecount}
  `)) as unknown as Array<{ status: string }>;
  assert.equal(cancelledLink[0].status, 'CANCELLED');
  assert.equal((await itemsOf(one.inventoryDocumentNumber))[0].count_status, 'COUNTED');
  assert.equal(Number((await itemsOf(one.inventoryDocumentNumber))[0].counted), 14);
  console.log('  ✓ one item was recounted, and cancellation released the original and kept the link');

  const postedSource = await createPhysicalInventory({
    client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
    plannedCountDate: DAY, materials: ['RC49-P'], requestKey: 'scr150-posted-doc',
  });
  await submitCounts({
    client, changedBy: ACTOR, documentNumber: postedSource.inventoryDocumentNumber, fiscalYear: postedSource.fiscalYear,
    countDate: DAY, requestKey: 'scr150-posted-count', lines: [{ itemNumber: 10, quantity: 18 }],
  });
  await postDifferences({
    client, changedBy: ACTOR, documentNumber: postedSource.inventoryDocumentNumber, fiscalYear: postedSource.fiscalYear,
    itemNumbers: [10], postingDate: DAY, documentDate: DAY, requestKey: 'scr150-posted-post',
  });
  const beforePostedRefusal = await tallies();
  await page.goto(`${base}${RECOUNT}?doc=${postedSource.inventoryDocumentNumber}&year=${postedSource.fiscalYear}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-recount-document]').waitFor();
  assert.match(await page.locator('[data-recount-reason]').innerText(), /posted difference/);
  const postedRefusal = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('physical-inventory-recount'),
  );
  await page.evaluate(() => {
    const posting = [...document.querySelectorAll('form')].find((form) => form.querySelector('[data-recount-check]'));
    if (!posting) throw new Error('the recount form is not on the page');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(posting.querySelector('input[name="requestKey"]'), 'scr150-posted-try');
    setter?.call(posting.querySelector('input[name="reason"]'), 'Too late');
    setter?.call(posting.querySelector('input[name="plannedRecountDate"]'), '2026-10-21');
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = 'item';
    hidden.value = '10';
    posting.appendChild(hidden);
    posting.querySelector('button[type="submit"]')?.removeAttribute('disabled');
    posting.requestSubmit(posting.querySelector('button[type="submit"]') as HTMLButtonElement);
  });
  await postedRefusal;
  await page.locator('[data-recount-result]').filter({ hasText: 'posted difference' }).waitFor();
  const afterPostedRefusal = await tallies();
  assert.equal(afterPostedRefusal.documents, beforePostedRefusal.documents);
  assert.equal(afterPostedRefusal.material_documents, beforePostedRefusal.material_documents, 'the refusal did not reverse');
  console.log('  ✓ a still-posted item was refused, with no reversal and no document left behind');

  const closedSource = await createPhysicalInventory({
    client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
    plannedCountDate: DAY, materials: ['RC49-D'], requestKey: 'scr150-closed-doc',
  });
  await submitCounts({
    client, changedBy: ACTOR, documentNumber: closedSource.inventoryDocumentNumber, fiscalYear: closedSource.fiscalYear,
    countDate: DAY, requestKey: 'scr150-closed-count', lines: [{ itemNumber: 10, quantity: 5 }],
  });
  await withTenant(client, (tx) => tx.execute(sql`
    update material_period_control set current_period = 9, allow_backposting = false
     where client = ${client} and company_code = ${company}
  `));
  try {
    await page.goto(`${base}${RECOUNT}?doc=${closedSource.inventoryDocumentNumber}&year=${closedSource.fiscalYear}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-recount-document]').waitFor();
    await page.getByRole('button', { name: 'Select eligible', exact: true }).click();
    await form().locator('input[name="reason"]').fill('Closed');
    await form().locator('input[name="plannedRecountDate"]').fill(DAY);
    const beforeClosed = await tallies();
    await page.getByRole('button', { name: 'Create recount', exact: true }).click();
    await page.locator('[data-recount-result]').filter({ hasText: /closed/i }).waitFor();
    assert.deepEqual(await tallies(), beforeClosed);
    assert.equal((await itemsOf(closedSource.inventoryDocumentNumber))[0].count_status, 'COUNTED');
    console.log('  ✓ a closed material period was refused, and the item was not marked for recount');
  } finally {
    await withTenant(client, (tx) => tx.execute(sql`
      update material_period_control set current_period = 10, allow_backposting = true
       where client = ${client} and company_code = ${company}
    `));
  }

  const raceSource = await createPhysicalInventory({
    client, createdBy: ACTOR, plant: PLANT, storageLocation: SLOC,
    plannedCountDate: DAY, materials: ['RC49-E'], requestKey: 'scr150-race-doc',
  });
  await submitCounts({
    client, changedBy: ACTOR, documentNumber: raceSource.inventoryDocumentNumber, fiscalYear: raceSource.fiscalYear,
    countDate: DAY, requestKey: 'scr150-race-count', lines: [{ itemNumber: 10, quantity: 3 }],
  });
  const raced = await Promise.allSettled([
    createRecount({
      client, changedBy: ACTOR, documentNumber: raceSource.inventoryDocumentNumber, fiscalYear: raceSource.fiscalYear,
      itemNumbers: [10], plannedRecountDate: DAY, reason: 'Race', requestKey: 'scr150-race-a',
    }),
    createRecount({
      client, changedBy: ACTOR, documentNumber: raceSource.inventoryDocumentNumber, fiscalYear: raceSource.fiscalYear,
      itemNumbers: [10], plannedRecountDate: DAY, reason: 'Race', requestKey: 'scr150-race-b',
    }),
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  const raceLinks = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from physical_inventory_recount_link
     where client = ${client} and original_document_number = ${raceSource.inventoryDocumentNumber}
       and status <> 'CANCELLED'
  `)) as unknown as Array<{ n: number }>;
  assert.equal(raceLinks[0].n, 1);
  console.log(`  ✓ two concurrent requests left one recount; company ${company}`);
}
