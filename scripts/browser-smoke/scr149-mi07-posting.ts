import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postDifferences, reverseDifferencePosting } from '../../src/modules/inventory/physical-inventory-posting';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const MI01 = '/inventory/physical-inventory';
const MI04 = '/inventory/physical-inventory-count';
const MI20 = '/inventory/physical-inventory-differences';
const POST = '/inventory/physical-inventory-posting';
const PLANT = 'QP48';
const SLOC = 'SQ48';
const DAY = '2026-10-21';

/**
 * SCR-149 browser acceptance (T848) — a counted difference posts through the screen.
 *
 * The movement on the screen is the row the kind and the direction name. The amount is the
 * plant valuation at the moment of posting, not the figure the difference list showed. A
 * selected batch posts together. Reversal is the canonical one, and it needs its own capability.
 */
export async function scr149Mi07Posting(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-149: post a shortage and a surplus from the screen, and refuse what the contract names');

  const company = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string }>;
    if (!rows[0]) throw new Error('the browser tenant carries no company code');
    const code = rows[0].company_code;
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, ${PLANT}, 'Posting plant', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
      values (${client}, ${PLANT}, ${SLOC}, 'Posting store', false, true, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true, allow_negative_stock = false
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, m.n, m.d, t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values
        ('MP48-S', 'Shortage'), ('MP48-P', 'Surplus'), ('MP48-Z', 'Exact'),
        ('MP48-U', 'Uncounted'), ('MP48-N', 'Unvalued')
      ) m(n, d)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${client}, m.n, ${PLANT}, 'browser.admin'
      from (values ('MP48-S'), ('MP48-P'), ('MP48-Z'), ('MP48-U'), ('MP48-N')) m(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values
        (${client}, 'MP48-S', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 100, 'browser.admin'),
        (${client}, 'MP48-P', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 40, 'browser.admin'),
        (${client}, 'MP48-Z', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 24, 'browser.admin'),
        (${client}, 'MP48-U', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 8, 'browser.admin'),
        (${client}, 'MP48-N', ${PLANT}, ${SLOC}, 'UNRESTRICTED', 10, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number) do update set quantity = excluded.quantity
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values
        (${client}, 'MP48-S', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 10, 10, 1, 'KWD', 100, 1000, 'browser.admin'),
        (${client}, 'MP48-P', ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 7.5, 10, 'KWD', 40, 30, 'browser.admin'),
        (${client}, 'MP48-Z', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 5, 5, 1, 'KWD', 24, 120, 'browser.admin'),
        (${client}, 'MP48-U', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 2, 2, 1, 'KWD', 8, 16, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      update gl_account set requires_cost_object = false
       where client = ${client} and account_number in ('120000', '440000')
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', v.m, v.a, 'browser.admin'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values ('INVENTORY', '', '120000'), ('OFFSETTING_INVENTORY', 'DIFF', '440000')) v(e, m, a)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type
        (client, movement_type, description, direction, reference_category, movement_kind,
         valuation_relevant, inventory_event, offset_event, offset_modifier, reversal_movement_type, created_by)
      values
        (${client}, 'SURPLUS-X', 'Configured surplus', 'RECEIPT', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
         true, 'INVENTORY', 'OFFSETTING_INVENTORY', 'DIFF', 'SHORT-X', 'browser.admin'),
        (${client}, 'SHORT-X', 'Configured shortage', 'ISSUE', 'PHYSICAL_INVENTORY', 'INVENTORY_DIFFERENCE',
         true, 'INVENTORY', 'OFFSETTING_INVENTORY', 'DIFF', 'SURPLUS-X', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, ${code}, 2026, 10, 2026, 9, true, 'browser.admin')
      on conflict (client, company_code) do update set
        current_fiscal_year = 2026, current_period = 10, allow_backposting = true
    `);
    await defineRange(tx, { client, objectCode: 'PHYINV', subObject: '*', prefix: 'PI', numberLength: 7, createdBy: 'browser.admin' });
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'M', numberLength: 6, createdBy: 'browser.admin' });
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: code, subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    return code;
  });

  const documents = async () => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n from material_document where client = ${client}
    `) as unknown as Array<{ n: number }>;
    return rows[0].n;
  });

  await page.goto(`${base}${MI01}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Physical Inventory', exact: true }).waitFor();
  await page.fill('input[name="plant"]', PLANT);
  await page.fill('input[name="storageLocation"]', SLOC);
  await page.fill('input[name="plannedCountDate"]', '2026-10-20');
  for (const [index, material] of ['MP48-S', 'MP48-P', 'MP48-Z', 'MP48-U', 'MP48-N'].entries()) {
    await page.fill(`input[name="material-${index + 1}"]`, material);
  }
  await page.getByRole('button', { name: 'Create the count document', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Created: physical inventory document' }).waitFor();
  const documentNumber = (await page.locator('[data-inventory-document]').first().innerText()).trim();
  assert.match(documentNumber, /^PI-\d{4}-\d{7}$/);
  console.log(`  ✓ ${documentNumber} created`);

  await page.goto(`${base}${MI04}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-line="10"]').waitFor();
  await page.fill('input[name="countDate"]', '2026-10-20');
  await page.fill('input[name="quantity-1"]', '95');
  await page.fill('input[name="quantity-2"]', '44');
  await page.fill('input[name="quantity-3"]', '24');
  await page.fill('input[name="quantity-5"]', '7');
  await page.getByRole('button', { name: 'Save counts', exact: true }).click();
  await page.locator('[data-count-message]').waitFor();
  assert.match(await page.locator('[data-count-message]').innerText(), /Count saved for 4 items/);
  console.log('  ✓ shortage, surplus, zero and unvalued counted; one item left uncounted');

  await page.goto(
    `${base}${MI20}?executed=1&plantFrom=${PLANT}&fiscalYear=2026&documentFrom=${documentNumber}&documentTo=${documentNumber}&differenceExists=1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('[data-difference-row]').first().waitFor();
  const list = await page.locator('table').innerText();
  assert.match(list, /-50\.000 KWD/, 'the list estimate is the price standing now');
  assert.equal(await page.getByRole('button', { name: /Post/ }).count(), 0, 'the list still has no posting button');
  await page.locator('[data-difference-row] a').first().click();
  await page.locator('[data-difference-posting-link][href*="doc="]').click();
  await page.getByRole('heading', { level: 1, name: 'Post inventory differences', exact: true }).waitFor();
  await page.locator('[data-posting-document]').waitFor();
  console.log('  ✓ the list linked here, and did not post');

  await page.goto(`${base}${MI20}?workflow=POST&doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-difference-workflow]').waitFor();
  assert.match(await page.locator('[data-difference-workflow]').innerText(), /does not post/);
  console.log('  ✓ naming a posting on the list is still refused');

  await page.goto(`${base}${POST}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-posting-line]').first().waitFor();
  const reasons = await page.locator('[data-posting-document]').innerText();
  assert.match(reasons, /no difference/);
  assert.match(reasons, /not been counted/);
  assert.match(reasons, /no valuation record/);
  assert.equal(await page.locator('input[name="quantity"]').count(), 0, 'there is no quantity to type');
  console.log('  ✓ a zero, an uncounted item and an unvalued material are shown, and not selectable as a quantity');

  const form = page.locator('form').filter({ has: page.locator('[data-posting-check]') });
  await page.getByRole('button', { name: 'Select eligible', exact: true }).click();
  await form.locator('input[name="postingDate"]').fill(DAY);
  await form.locator('input[name="documentDate"]').fill(DAY);
  await form.locator('input[name="headerText"]').fill('Count adj');
  const beforeCheck = await documents();
  await page.locator('[data-posting-check]').click();
  await page.locator('[data-posting-preview]').waitFor();
  const preview = await page.locator('[data-posting-preview]').innerText();
  assert.match(preview, /SHORT-X/);
  assert.match(preview, /SURPLUS-X/);
  assert.match(preview, /50\.000 KWD/);
  assert.match(preview, /3\.000 KWD/);
  assert.match(preview, /A journal will be written/);
  assert.match(preview, /2026\/10/);
  assert.match(preview, /not the difference list estimate/);
  assert.equal(await documents(), beforeCheck, 'a check writes nothing');
  console.log('  ✓ the check named the configured movements and the plant valuation, and wrote nothing');

  await withTenant(client, (tx) => tx.execute(sql`
    update material_valuation set standard_price = 12, stock_value = 1200
     where client = ${client} and material_number = 'MP48-S' and valuation_area = ${PLANT}
  `));
  // A check refreshes the page, and the selection does not survive that refresh.
  await page.getByRole('button', { name: 'Select eligible', exact: true }).click();
  await form.locator('input[name="postingDate"]').fill(DAY);
  await form.locator('input[name="documentDate"]').fill(DAY);
  await form.locator('input[name="headerText"]').fill('Count adj');
  await page.locator('[data-posting-check]').click();
  await page.locator('[data-posting-amount]').filter({ hasText: '60.000' }).waitFor();
  assert.doesNotMatch(await page.locator('[data-posting-preview]').innerText(), /50\.000 KWD/);
  console.log('  ✓ after the price moved, the amount to post is 60.000, not the 50.000 the list showed');

  await page.getByRole('button', { name: 'Select eligible', exact: true }).click();
  await form.locator('input[name="postingDate"]').fill(DAY);
  await form.locator('input[name="documentDate"]').fill(DAY);
  await form.locator('input[name="headerText"]').fill('Count adj');
  const requestKey = await form.locator('input[name="requestKey"]').inputValue();
  const beforePost = await documents();
  await page.getByRole('button', { name: 'Post selected differences', exact: true }).click();
  await page.locator('[data-posting-result]').waitFor();
  const postedText = await page.locator('[data-posting-result]').innerText();
  assert.match(postedText, /Posted material document /);
  const materialDocument = postedText.match(/material document (\S+?)\./)?.[1] ?? '';
  assert.ok(materialDocument);
  await page.locator('[data-posting-status]').waitFor();
  assert.match(await page.locator('[data-posting-status]').innerText(), /PARTIALLY_POSTED/);
  await page.locator('[data-posting-reason]').filter({ hasText: 'already fully posted' }).first().waitFor();
  assert.equal(await documents(), beforePost + 1);

  const ledger = await withTenant(client, async (tx) => tx.execute(sql`
    select
      (select quantity::text from stock_quantity where client = ${client} and material_number = 'MP48-S' and stock_type = 'UNRESTRICTED') as shortage,
      (select quantity::text from stock_quantity where client = ${client} and material_number = 'MP48-P' and stock_type = 'UNRESTRICTED') as surplus,
      (select string_agg(movement_type, ',' order by movement_type) from material_document_line
        where client = ${client} and material_document_number = ${materialDocument}) as movements,
      (select string_agg(gl_account || debit_credit || amount_local::text, ',' order by gl_account, debit_credit)
         from journal_entry_line l
         join material_document d on d.client = l.client and d.journal_document_number = l.document_number
        where d.client = ${client} and d.material_document_number = ${materialDocument}) as journal
  `)) as unknown as Array<{ shortage: string; surplus: string; movements: string; journal: string }>;
  assert.equal(ledger[0].shortage, '95.000');
  assert.equal(ledger[0].surplus, '44.000');
  assert.equal(ledger[0].movements, 'SHORT-X,SURPLUS-X');
  assert.match(ledger[0].journal, /120000H60/);
  assert.match(ledger[0].journal, /440000S60/);
  assert.doesNotMatch(ledger[0].journal, /50/);
  console.log(`  ✓ ${materialDocument} posted both items; stock and the journal agree, and the journal is not the list estimate`);

  const replay = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('physical-inventory-posting'),
    { timeout: 15000 },
  ).catch((error: unknown) => error);
  const submitted = await page.evaluate((key) => {
    const posting = [...document.querySelectorAll('form')].find((form) => form.querySelector('[data-posting-check]'));
    if (!posting) return 'the posting form is not on the page';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return 'no value setter';
    const names = ['requestKey', 'postingDate', 'documentDate', 'headerText'];
    const values = [key, '2026-10-21', '2026-10-21', 'Count adj'];
    for (let i = 0; i < names.length; i += 1) {
      const field = posting.querySelector('input[name="' + names[i] + '"]');
      if (!field) return 'missing ' + names[i];
      setter.call(field, values[i]);
    }
    for (const item of ['10', '20']) {
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'item';
      hidden.value = item;
      posting.appendChild(hidden);
    }
    const submit = posting.querySelector('button[type="submit"]');
    if (!submit) return 'no submit button';
    submit.disabled = false;
    posting.requestSubmit(submit);
    return 'submitted';
  }, requestKey);
  const replayed = await replay;
  if (submitted !== 'submitted' || replayed instanceof Error) {
    throw new Error(`retry did not post: ${submitted}; ${replayed instanceof Error ? replayed.message : 'response received'}`);
  }
  assert.match(await page.locator('[data-posting-result]').innerText(), new RegExp(materialDocument));
  assert.equal(await documents(), beforePost + 1, 'the same key and the same payload posted nothing new');
  console.log('  ✓ a retry returned the same material document');

  const changed = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('physical-inventory-posting'));
  await page.evaluate((key) => {
    const posting = [...document.querySelectorAll('form')].find((form) => form.querySelector('[data-posting-check]'));
    if (!posting) throw new Error('the posting form is not on the page');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const keyField = posting.querySelector<HTMLInputElement>('input[name="requestKey"]');
    const header = posting.querySelector<HTMLInputElement>('input[name="headerText"]');
    setter?.call(keyField, key);
    setter?.call(header, 'Other text');
    const extras = posting.querySelectorAll('input[type="hidden"][name="item"]');
    for (let i = extras.length - 1; i >= 0; i -= 1) extras[i].remove();
    for (const item of ['10', '20']) {
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'item';
      hidden.value = item;
      posting.appendChild(hidden);
    }
    const submit = posting.querySelector('button[type="submit"]');
    submit?.removeAttribute('disabled');
    posting.requestSubmit(submit);
  }, requestKey);
  await changed;
  await page.locator('[data-posting-result]').filter({ hasText: 'different posting' }).waitFor();
  assert.equal(await documents(), beforePost + 1);
  console.log('  ✓ the same key with a different header text was refused');

  await page.goto(`${base}${MI04}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-line="10"]').waitFor();
  await page.fill('input[name="quantity-1"]', '90');
  await page.getByRole('button', { name: 'Save counts', exact: true }).click();
  await page.locator('[data-count-message]').waitFor();
  assert.match(await page.locator('[data-count-message]').innerText(), /difference posted/);
  console.log('  ✓ a posted count cannot be corrected from the count screen');

  await page.goto(`${base}${POST}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator(`[data-posting-history-document="${materialDocument}"]`).waitFor();
  const reverseForm = page.locator(`[data-posting-history-document="${materialDocument}"] form`);
  await reverseForm.locator('input[name="postingDate"]').fill(DAY);
  await reverseForm.locator('input[name="documentDate"]').fill(DAY);
  await reverseForm.locator('input[name="headerText"]').fill('Undo');
  await reverseForm.getByRole('button', { name: 'Reverse', exact: true }).click();
  await page.locator('[data-posting-reversal]').waitFor();
  assert.match(await page.locator('[data-posting-reversal]').innerText(), /Reversal posted as material document/);
  const restored = await withTenant(client, async (tx) => tx.execute(sql`
    select
      (select quantity::text from stock_quantity where client = ${client} and material_number = 'MP48-S') as shortage,
      (select posting_status from physical_inventory_item
        where client = ${client} and inventory_document_number = ${documentNumber} and material_number = 'MP48-S') as status
  `)) as unknown as Array<{ shortage: string; status: string }>;
  assert.equal(restored[0].shortage, '100.000');
  assert.equal(restored[0].status, 'UNPOSTED');
  console.log('  ✓ reversal restored the stock and the item');

  await expectSecondReversal(page, base, materialDocument);
  const afterSecond = await documents();
  try {
    await reverseDifferencePosting({
      client, changedBy: 'browser.admin', materialDocumentNumber: materialDocument,
      postingDate: DAY, documentDate: DAY, requestKey: `t848-second-${Date.now()}`,
    });
    assert.fail('a second reversal should have been refused');
  } catch (caught) {
    assert.match(caught instanceof Error ? caught.message : '', /already been cancelled|already reversed/);
  }
  assert.equal(await documents(), afterSecond, 'the refused second reversal wrote no document');
  console.log('  ✓ a second reversal was refused, and the screen no longer offers it');

  const open = await documents();
  await withTenant(client, (tx) => tx.execute(sql`
    update material_period_control set current_period = 9, allow_backposting = false where client = ${client}
  `));
  await postEligible(page, base, documentNumber);
  assert.match(await page.locator('[data-posting-result]').innerText(), /material posting period/);
  assert.equal(await documents(), open);
  await withTenant(client, (tx) => tx.execute(sql`
    update material_period_control set current_period = 10, allow_backposting = true where client = ${client}
  `));
  console.log('  ✓ a closed material period was refused, and no document was left');

  await withTenant(client, (tx) => tx.execute(sql`
    update posting_period_rule set period_to = 9 where client = ${client} and account_type = 'S'
  `));
  await postEligible(page, base, documentNumber);
  assert.match(await page.locator('[data-posting-result]').innerText(), /period|closed/i);
  assert.equal(await documents(), open);
  await withTenant(client, (tx) => tx.execute(sql`
    update posting_period_rule set period_to = 12 where client = ${client} and account_type = 'S'
  `));
  console.log('  ✓ a closed financial period left no material document');

  await withTenant(client, (tx) => tx.execute(sql`
    delete from account_determination
     where client = ${client} and event = 'OFFSETTING_INVENTORY' and general_modifier = 'DIFF'
  `));
  await postEligible(page, base, documentNumber);
  assert.match(await page.locator('[data-posting-result]').innerText(), /does not stand/);
  assert.equal(await documents(), open);
  await withTenant(client, (tx) => tx.execute(sql`
    insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
    select ${client}, c.chart_of_accounts, 'OFFSETTING_INVENTORY', 'RAW_INVENTORY', 'DIFF', '440000', 'browser.admin'
    from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
    on conflict do nothing
  `));
  console.log('  ✓ a missing difference account was refused, and nothing was left');

  await withTenant(client, (tx) => tx.execute(sql`
    update movement_type set requires_batch = true
     where client = ${client} and movement_type = 'SHORT-X'
  `));
  await postEligible(page, base, documentNumber);
  assert.match(await page.locator('[data-posting-result]').innerText(), /requires a batch/);
  assert.equal(await documents(), open);
  await withTenant(client, (tx) => tx.execute(sql`
    update movement_type set requires_batch = false where client = ${client} and movement_type = 'SHORT-X'
  `));
  console.log('  ✓ a batch-requiring movement was refused by name');

  await page.goto(`${base}${MI01}`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="plant"]', PLANT);
  await page.fill('input[name="plannedCountDate"]', '2026-10-20');
  await page.fill('input[name="material-1"]', 'MP48-Z');
  await page.getByRole('button', { name: 'Create the count document', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Created: physical inventory document' }).waitFor();
  const bare = (await page.locator('[data-inventory-document]').first().innerText()).trim();
  await page.goto(`${base}${POST}?doc=${bare}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-posting-reason]').first().waitFor();
  assert.match(await page.locator('[data-posting-document]').innerText(), /no storage location/);
  console.log('  ✓ a document without a storage location is refused by name');

  await withTenant(client, (tx) => tx.execute(sql`
    update movement_type set valuation_relevant = false where client = ${client} and movement_type = 'SURPLUS-X'
  `));
  const beforeQuantity = await documents();
  await postItems(page, base, documentNumber, ['20']);
  const quantityText = await page.locator('[data-posting-result]').innerText();
  assert.match(quantityText, /Posted material document/);
  assert.doesNotMatch(quantityText, /Journal/);
  const quantityDocument = quantityText.match(/material document (\S+?)\./)?.[1] ?? '';
  const quantityOnly = await withTenant(client, async (tx) => tx.execute(sql`
    select d.journal_document_number, q.quantity::text as stock
      from material_document d
      join stock_quantity q on q.client = d.client and q.material_number = 'MP48-P' and q.stock_type = 'UNRESTRICTED'
     where d.client = ${client} and d.material_document_number = ${quantityDocument}
  `)) as unknown as Array<{ journal_document_number: string | null; stock: string }>;
  assert.equal(quantityOnly[0].journal_document_number, null);
  assert.equal(quantityOnly[0].stock, '44.000');
  assert.equal(await documents(), beforeQuantity + 1);
  await withTenant(client, (tx) => tx.execute(sql`
    update movement_type set valuation_relevant = true where client = ${client} and movement_type = 'SURPLUS-X'
  `));
  console.log(`  ✓ ${quantityDocument} moved the surplus quantity and wrote no journal`);

  const browser = page.context().browser();
  if (!browser) throw new Error('the browser is not available for a second request');
  const second = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await second.addCookies(await page.context().cookies());
  const other = await second.newPage();
  await armItem(page, base, documentNumber, '10');
  await armItem(other, base, documentNumber, '10');
  const beforeRace = await documents();
  await Promise.all([
    page.getByRole('button', { name: 'Post selected differences', exact: true }).click(),
    other.getByRole('button', { name: 'Post selected differences', exact: true }).click(),
  ]);
  await page.locator('[data-posting-result]').waitFor();
  await other.locator('[data-posting-result]').waitFor();
  const raced = (await page.locator('[data-posting-result]').innerText()) + '\n' + (await other.locator('[data-posting-result]').innerText());
  assert.equal(await documents(), beforeRace + 1, 'two concurrent requests left one posting');
  assert.match(raced, /already fully posted|another posting of this count is in progress/);
  await second.close();
  console.log('  ✓ two concurrent requests left one posting');

  const beforeAgain = await documents();
  try {
    await postDifferences({
      client, changedBy: 'browser.admin', documentNumber, fiscalYear: 2026, itemNumbers: [10],
      postingDate: DAY, documentDate: DAY, requestKey: `t848-again-${Date.now()}`,
    });
    assert.fail('a new key must not post a difference that is already posted');
  } catch (caught) {
    assert.match(caught instanceof Error ? caught.message : '', /already fully posted/);
  }
  assert.equal(await documents(), beforeAgain);
  await page.goto(`${base}${POST}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  assert.match(await page.locator('[data-posting-status]').innerText(), /PARTIALLY_POSTED/);
  console.log('  ✓ a new key could not post the same difference, and an item still remains');

  await withTenant(client, (tx) => tx.execute(sql`
    insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                    standard_price, moving_average_price, price_unit, currency,
                                    total_stock_quantity, stock_value, created_by)
    values (${client}, 'MP48-N', ${PLANT}, 'RAW_INVENTORY', 'STANDARD', 4, 4, 1, 'KWD', 10, 40, 'browser.admin')
    on conflict do nothing
  `));
  await postItems(page, base, documentNumber, ['50']);
  assert.match(await page.locator('[data-posting-result]').innerText(), /PARTIALLY_POSTED/);
  assert.match(await page.locator('[data-posting-status]').innerText(), /PARTIALLY_POSTED/);
  console.log('  ✓ posting the last valued difference still leaves the header partial while an item is uncounted');

  await page.goto(`${base}${MI04}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-count-line="40"]').waitFor();
  const book = await page.locator('[data-count-line="40"] [data-count-book]').innerText();
  await page.fill('input[name="quantity-4"]', book.match(/[0-9.]+/)?.[0] ?? '');
  await page.getByRole('button', { name: 'Save counts', exact: true }).click();
  await page.locator('[data-count-message]').waitFor();
  await page.goto(`${base}${POST}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  assert.equal((await page.locator('[data-posting-status]').innerText()).trim(), 'POSTED');
  console.log('  ✓ the header is POSTED only once every item is resolved');

  console.log(
    `SCR-149: ${materialDocument} posted a shortage and a surplus through ${company}, the journal took 60.000 rather than the list's 50.000, `
    + 'a retry returned the same document, and the named refusals left nothing behind',
  );
}

async function postEligible(page: Page, base: string, documentNumber: string) {
  await page.goto(`${base}${POST}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Select eligible', exact: true }).click();
  const form = page.locator('form').filter({ has: page.locator('[data-posting-check]') });
  await form.locator('input[name="postingDate"]').fill(DAY);
  await form.locator('input[name="documentDate"]').fill(DAY);
  await page.getByRole('button', { name: 'Post selected differences', exact: true }).click();
  await page.locator('[data-posting-result]').waitFor();
}


async function postItems(page: Page, base: string, documentNumber: string, items: string[]) {
  await armItem(page, base, documentNumber, items[0]);
  for (const item of items.slice(1)) await page.locator(`input[name="item"][value="${item}"]`).click();
  await page.getByRole('button', { name: 'Post selected differences', exact: true }).click();
  await page.locator('[data-posting-result]').waitFor();
}

async function armItem(page: Page, base: string, documentNumber: string, item: string) {
  await page.goto(`${base}${POST}?doc=${documentNumber}&year=2026`, { waitUntil: 'domcontentloaded' });
  await page.locator(`input[name="item"][value="${item}"]`).click();
  const form = page.locator('form').filter({ has: page.locator('[data-posting-check]') });
  await form.locator('input[name="postingDate"]').fill(DAY);
  await form.locator('input[name="documentDate"]').fill(DAY);
  await form.locator('input[name="headerText"]').fill('Race');
}

async function expectSecondReversal(page: Page, base: string, materialDocument: string) {
  await page.goto(`${base}/inventory/reversal?doc=${materialDocument}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Reverse Material Document', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reverse', exact: true }).count(), 0);
}
