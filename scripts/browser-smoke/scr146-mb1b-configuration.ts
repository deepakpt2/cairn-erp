import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/inventory/transfer-posting';
const PLANT_A = 'QK01';
const PLANT_B = 'QK02';
const SLOC_A = 'SK01';
const SLOC_B = 'SK02';
const MATERIAL = 'MB1B-CFG';

/**
 * SCR-146 browser acceptance (T845) — the configuration decides, and the screen says so.
 *
 * The run does what a person would do if a rule had to be changed: it edits the movement's own
 * row and then asks the screen. A Check answers what would post without posting it — and the
 * stock stays put, which the stock panel proves. Changing 311's plant rule from SAME to DIFFERENT
 * in the database changes what the very same number may do; a same-plant 311 is then refused in
 * the configuration's own words. A two-step movement is refused by name rather than quietly posted
 * one-step, and a requirement canon cannot satisfy is refused naming the missing master.
 *
 * Then the two things a posting must survive: a reused request key wearing a different payload is
 * refused (not replayed), and the reversal is the configured counter, not a remembered number.
 */
export async function scr146Mb1bConfiguration(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-146: check without posting, change the movement row and watch the screen obey it, refuse the conditional, then reuse a key and reverse');

  let company = '';
  let currency = '';
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code, currency from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string; currency: string }>;
    if (!rows[0]) throw new Error('the browser tenant carries no company code');
    company = rows[0].company_code;
    currency = rows[0].currency;

    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by) values
        (${client}, ${PLANT_A}, 'Configuration plant one', ${company}, 'KW', 'browser.admin'),
        (${client}, ${PLANT_B}, 'Configuration plant two', ${company}, 'KW', 'browser.admin')
      on conflict (client, plant) do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by) values
        (${client}, ${PLANT_A}, ${SLOC_A}, 'Configuration store one', false, true, 'browser.admin'),
        (${client}, ${PLANT_A}, ${SLOC_B}, 'Configuration store two', false, true, 'browser.admin'),
        (${client}, ${PLANT_B}, ${SLOC_A}, 'Configuration store one (plant two)', false, true, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, ${MATERIAL}, 'Configured transfer material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by) values
        (${client}, ${MATERIAL}, ${PLANT_A}, 'browser.admin'),
        (${client}, ${MATERIAL}, ${PLANT_B}, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      select ${client}, ${MATERIAL}, p.plant, v.valuation_class, 'MOVING_AVERAGE', 0, 10, 1, ${currency}, 0, 0, 'browser.admin'
      from (values (${PLANT_A}), (${PLANT_B})) p(plant)
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
                  and account_type = 'REVENUE' order by account_number limit 1) a
      on conflict do nothing
    `);
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
        (${client}, ${MATERIAL}, ${PLANT_A}, ${SLOC_A}, 'UNRESTRICTED', 100, 'browser.admin'),
        (${client}, ${MATERIAL}, ${PLANT_A}, ${SLOC_A}, 'QUALITY', 10, 'browser.admin'),
        (${client}, ${MATERIAL}, ${PLANT_A}, ${SLOC_B}, 'UNRESTRICTED', 0, 'browser.admin'),
        (${client}, ${MATERIAL}, ${PLANT_B}, ${SLOC_A}, 'UNRESTRICTED', 0, 'browser.admin')
      on conflict (client, material_number, plant, storage_location, stock_type)
      do update set quantity = excluded.quantity
    `);
  });

  const documents = async (): Promise<number> => withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n from material_document where client = ${client}
    `) as unknown as Array<{ n: number }>;
    return Number(rows[0].n);
  });

  const configure = async (movementType: string, patch: Record<string, unknown>) => {
    const assignments = Object.entries(patch).map(([column, value]) => sql`${sql.raw(column)} = ${value}`);
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update movement_type set ${sql.join(assignments, sql`, `)}
        where client = ${client} and movement_type = ${movementType}
      `);
    });
  };

  const fill = async (fields: Record<string, string>) => {
    for (const [name, value] of Object.entries(fields)) {
      const field = page.locator(`form input[name="${name}"], form select[name="${name}"]`).last();
      const tag = await field.evaluate((el) => el.tagName);
      if (tag === 'SELECT') await field.selectOption(value);
      else await field.fill(value);
    }
  };

  const status = page.locator('section[aria-labelledby="transfer-item"] p[role="status"]').first();
  const preview = page.locator('[data-transfer-preview]');

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Transfer Posting', exact: true }).waitFor();
  console.log('  ✓ the transfer screen stands');

  // ── 1. A check answers without posting ───────────────────────────────────
  const beforeCheck = await documents();
  await fill({
    movementTypeCode: '311', materialNumber: MATERIAL, quantity: '25',
    issuingPlant: PLANT_A, issuingStorageLocation: SLOC_A,
    receivingPlant: PLANT_A, receivingStorageLocation: SLOC_B,
    postingDate: '2026-10-15', documentDate: '2026-10-15',
  });
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await preview.waitFor();
  assert.match(await preview.innerText(), /TRANSFER_SLOC/, 'the panel names the configured movement');
  assert.match(await page.locator('[data-preview-base]').innerText(), /25\.000 PC/, 'the base quantity is shown');
  assert.match(await page.locator('[data-preview-from]').innerText(), new RegExp(`${PLANT_A}/${SLOC_A}/UNRESTRICTED`));
  assert.match(await page.locator('[data-preview-to]').innerText(), new RegExp(`${PLANT_A}/${SLOC_B}/UNRESTRICTED`));
  assert.match(await page.locator('[data-preview-stock]').innerText(), /100\.000 → 75\.000/);
  assert.match(await page.locator('[data-preview-value]').innerText(), /no valuation change/);
  assert.match(await page.locator('[data-preview-journal]').innerText(), /none/);
  assert.equal(await documents(), beforeCheck, 'the check posted nothing');
  console.log('  ✓ Check showed 100 → 75 with no valuation change, and no document was posted');

  // ── 2. The row decides: 311 may move between plants once configured so ──
  await configure('TRANSFER_SLOC', { plant_rule: 'DIFFERENT', location_rule: 'ANY' });
  try {
    await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
    await fill({
      movementTypeCode: '311', materialNumber: MATERIAL, quantity: '25',
      issuingPlant: PLANT_A, issuingStorageLocation: SLOC_A,
      receivingPlant: PLANT_B, receivingStorageLocation: SLOC_A,
      postingDate: '2026-10-15', documentDate: '2026-10-15',
      externalReference: 'TO-8801',
    });
    await page.getByRole('button', { name: 'Post transfer', exact: true }).click();
    await status.waitFor();
    const message = await status.innerText();
    const documentNumber = /material document ([A-Za-z0-9-]+)/.exec(message)?.[1];
    assert.ok(documentNumber, `the posting names its document: ${message}`);
    console.log(`  ✓ a 311 configured as DIFFERENT moved 25 from ${PLANT_A} to ${PLANT_B} as ${documentNumber}`);

    await page.goto(`${base}${ROUTE}?doc=${documentNumber}`, { waitUntil: 'domcontentloaded' });
    await page.locator('tr[data-side="ISSUE"]').first().waitFor();
    assert.match(await page.locator('section[aria-labelledby="transfer-document"]').innerText(), /External reference TO-8801/);
    console.log('  ✓ the external reference travelled with the document');

    // The same number inside one plant is now the refused one — the configuration's words.
    await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
    await fill({
      movementTypeCode: '311', materialNumber: MATERIAL, quantity: '5',
      issuingPlant: PLANT_A, issuingStorageLocation: SLOC_A,
      receivingPlant: PLANT_A, receivingStorageLocation: SLOC_B,
      postingDate: '2026-10-15', documentDate: '2026-10-15',
    });
    await page.getByRole('button', { name: 'Post transfer', exact: true }).click();
    await status.waitFor();
    assert.match(
      await status.innerText(),
      /moves between plants, and the configuration says so/,
      'the refusal quotes the configuration that decided it',
    );
    console.log('  ✓ with DIFFERENT configured, a same-plant 311 is refused in the configuration’s own words');
  } finally {
    await configure('TRANSFER_SLOC', { plant_rule: 'SAME', location_rule: 'DIFFERENT' });
  }

  // ── 3. A two-step movement is refused by name, never silently one-step ──
  const beforeTwoStep = await documents();
  for (const code of ['303', '313']) {
    await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
    await fill({
      movementTypeCode: code, materialNumber: MATERIAL, quantity: '5',
      issuingPlant: PLANT_A, issuingStorageLocation: SLOC_A,
      receivingPlant: PLANT_B, receivingStorageLocation: SLOC_A,
      postingDate: '2026-10-15', documentDate: '2026-10-15',
    });
    await page.getByRole('button', { name: 'Post transfer', exact: true }).click();
    await status.waitFor();
    assert.match(await status.innerText(), new RegExp(`${code} is a two-step transfer`));
  }
  assert.equal(await documents(), beforeTwoStep, 'a refused two-step posted nothing');
  console.log('  ✓ 303 and 313 were refused as two-step transfers, posting nothing');

  // ── 4. A requirement canon has no master for is refused naming the master ──
  await configure('TRANSFER_STYPE', { requires_batch: true });
  try {
    await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
    await fill({
      movementTypeCode: '321', materialNumber: MATERIAL, quantity: '4',
      issuingPlant: PLANT_A, issuingStorageLocation: SLOC_A,
      receivingPlant: PLANT_A, receivingStorageLocation: SLOC_A,
      postingDate: '2026-10-15', documentDate: '2026-10-15',
    });
    await page.getByRole('button', { name: 'Post transfer', exact: true }).click();
    await status.waitFor();
    assert.match(await status.innerText(), /requires a batch \(canon carries no batch master\)/);
    console.log('  ✓ a movement requiring a batch was refused, naming the master canon lacks');
  } finally {
    await configure('TRANSFER_STYPE', { requires_batch: false });
  }

  // ── 5. A reused key with a different payload is refused, not replayed ────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  const keyField = page.locator('form input[name="requestKey"]').last();
  await fill({
    movementTypeCode: '321', materialNumber: MATERIAL, quantity: '4',
    issuingPlant: PLANT_A, issuingStorageLocation: SLOC_A,
    receivingPlant: PLANT_A, receivingStorageLocation: SLOC_A,
    postingDate: '2026-10-15', documentDate: '2026-10-15',
  });
  const reusedKey = await keyField.inputValue();
  await page.getByRole('button', { name: 'Post transfer', exact: true }).click();
  await status.waitFor();
  assert.match(await status.innerText(), /Transfer posted as material document/);
  const afterFirst = await documents();

  await fill({
    movementTypeCode: '321', materialNumber: MATERIAL, quantity: '9',
    issuingPlant: PLANT_A, issuingStorageLocation: SLOC_A,
    receivingPlant: PLANT_A, receivingStorageLocation: SLOC_A,
    postingDate: '2026-10-15', documentDate: '2026-10-15',
  });
  // A stale client: it still holds the key of the posting it made a moment ago, and now sends a
  // different quantity under it. The value is set and the form submitted in one turn of the page's
  // own JS, so nothing can quietly refresh the key between the two.
  await page.evaluate((key) => {
    const field = document.querySelector<HTMLInputElement>('form input[name="requestKey"]');
    if (!field?.form) throw new Error('the transfer form is not on the page');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, key);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.form.requestSubmit();
  }, reusedKey);
  // The status box still holds the previous posting's words until the new answer arrives.
  await page.waitForFunction(
    () => document.querySelector('section[aria-labelledby="transfer-item"] p[role="status"]')
      ?.textContent?.includes('different posting') ?? false,
    undefined,
    { timeout: 10_000 },
  ).catch(() => {});
  assert.match(await status.innerText(), /and this is a different posting/);
  assert.equal(await documents(), afterFirst, 'the reused key posted nothing');
  console.log('  ✓ a reused request key wearing a different quantity was refused, not replayed');

  // ── 6. The reversal is the configured counter ───────────────────────────
  await page.goto(`${base}${ROUTE}?material=${MATERIAL}&plant=${PLANT_A}`, { waitUntil: 'domcontentloaded' });
  await page.locator('section[aria-labelledby="transfer-stock"] table').waitFor();
  const stockBeforeReversal = await page.locator('section[aria-labelledby="transfer-stock"] table').innerText();
  assert.match(stockBeforeReversal, new RegExp(`${SLOC_A}\\s+UNRESTRICTED\\s+79\\.000`), '25 left for plant two, 4 came out of quality');
  assert.match(stockBeforeReversal, new RegExp(`${SLOC_A}\\s+QUALITY\\s+6\\.000`));

  const transferDoc = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select material_document_number from material_document
      where client = ${client} and reversal_of is null
        and material_document_number in (
          select material_document_number from material_document_line
          where client = ${client} and movement_type = 'TRANSFER_SLOC'
        )
      order by material_document_number desc limit 1
    `) as unknown as Array<{ material_document_number: string }>;
    return rows[0]?.material_document_number ?? '';
  });
  assert.ok(transferDoc, 'the cross-plant transfer stands');

  await page.goto(`${base}${ROUTE}?doc=${transferDoc}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Reverse transfer', exact: true }).click();
  const reverseStatus = page.locator('section[aria-labelledby="transfer-document"] p[role="status"]').first();
  await reverseStatus.waitFor();
  assert.match(await reverseStatus.innerText(), /Reversal posted as material document/);

  const counter = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select l.movement_type from material_document_line l
      join material_document d on d.client = l.client and d.material_document_number = l.material_document_number
      where l.client = ${client} and d.reversal_of = ${transferDoc}
      order by l.line_number limit 1
    `) as unknown as Array<{ movement_type: string }>;
    return rows[0]?.movement_type ?? '';
  });
  assert.equal(counter, 'TRANSFER_SLOC_REV', 'the reversal posted the configured counter movement');

  await page.goto(`${base}${ROUTE}?material=${MATERIAL}&plant=${PLANT_A}`, { waitUntil: 'domcontentloaded' });
  await page.locator('section[aria-labelledby="transfer-stock"] table').waitFor();
  const stockAfterReversal = await page.locator('section[aria-labelledby="transfer-stock"] table').innerText();
  assert.match(stockAfterReversal, new RegExp(`${SLOC_A}\\s+UNRESTRICTED\\s+104\\.000`), 'the 25 came back');
  console.log('  ✓ the reversal posted TRANSFER_SLOC_REV and the stock came back to 104');

  console.log(
    'SCR-146: a check answered without posting, the movement row decided where 311 could go, '
    + 'a same-plant move was refused in the configuration’s words, two-step and a batch requirement '
    + 'were refused by name, a reused key with a different payload was refused, and the reversal '
    + 'posted the configured counter',
  );
}
