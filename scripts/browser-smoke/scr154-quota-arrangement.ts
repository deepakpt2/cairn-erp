import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { createQuotaArrangement, previewQuotaSelection } from '../../src/modules/purchasing/quota-arrangement';
import { createSourceListEntry } from '../../src/modules/purchasing/source-list';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/quota-arrangement';
const ACTOR = 'browser.admin';
const FROM = '2020-01-01';
const TO = '2099-12-31';
const TODAY = '2026-10-22';

/**
 * SCR-154 browser acceptance (T853) — a quota arrangement weights who may supply a material.
 *
 * The production build is the screen under test. A check writes nothing. The screen
 * allocates nothing. The package example is rated by the same function, and that
 * preview writes nothing. The order and the requisition are not rewritten.
 * Rollback, the tenant boundary and the audit delta stay in the service tests.
 */
export async function scr154QuotaArrangement(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-154: a quota arrangement, and the order is not rewritten');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values
        (${client}, 'V-QA', 'ORGANIZATION', 'Quota supplier', 'CREATED', ${ACTOR}),
        (${client}, 'V-QA2', 'ORGANIZATION', 'Other quota supplier', 'CREATED', ${ACTOR}),
        (${client}, 'V-OFF', 'ORGANIZATION', 'Blocked supplier', 'CREATED', ${ACTOR}),
        (${client}, 'V-BARE', 'ORGANIZATION', 'Unassigned supplier', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      update business_partner set is_blocked = true
       where client = ${client} and partner_number = 'V-OFF'
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values
        (${client}, 'V-QA', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-QA2', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-OFF', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-BARE', 'SUPPLIER', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by)
      values (${client}, '001', 'Buyer', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org
        (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
      values
        (${client}, 'V-QA', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR}),
        (${client}, 'V-QA2', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, m.n, m.d, t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values
        ('MAT-QA', 'Quota material'), ('MAT-MAKE', 'Produced'), ('MAT-BARE', 'No plant'),
        ('MAT-OV', 'Overlap'), ('MAT-FUT', 'Future'), ('MAT-REQ', 'Required'), ('MAT-CC', 'Concurrent')
      ) m(n, d)
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, '2000', 'Unassigned plant', '1000', 'KW', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, procurement_type, created_by)
      values
        (${client}, 'MAT-QA', '1000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-QA', '2000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-MAKE', '1000', 'MAKE', ${ACTOR}),
        (${client}, 'MAT-OV', '1000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-FUT', '1000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-REQ', '1000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-CC', '1000', 'BUY', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_requisition_item
        (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, created_by)
      values (${client}, 'PR-QA', 10, 'Stay', 1, 'PC', '2026-10-21', '2026-11-01', '1000', '001', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_order
        (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
      values (${client}, 'PO-QA', 'V-QA', '1000', '001', '1000', 'KWD', '2026-10-21', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_order_item
        (client, order_number, item_number, material_number, short_text, quantity, unit, net_price, net_value, plant, created_by)
      values (${client}, 'PO-QA', 10, 'MAT-QA', 'Stay', 1, 'PC', 1, 1, '1000', ${ACTOR})
    `);
  });

  const fixed = await createSourceListEntry({
    client,
    changedBy: ACTOR,
    materialNumber: 'MAT-REQ',
    plant: '1000',
    partnerNumber: 'V-QA',
    purchasingOrg: '1000',
    validFrom: FROM,
    validTo: TO,
    fixedSource: true,
    sourceListRequired: true,
  });

  async function tallies() {
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from purchasing_quota_arrangement where client = ${client}) as arrangements,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from material_document where client = ${client}) as movements,
        (select current_number::int from number_range where client = ${client} and object_code = 'QUOTAARR') as drawn,
        (select quantity::text from purchase_requisition_item where client = ${client} and requisition_number = 'PR-QA') as requisition,
        (select supplier_number from purchase_order where client = ${client} and order_number = 'PO-QA') as supplier,
        (select quantity::text from purchase_order_item where client = ${client} and order_number = 'PO-QA') as ordered,
        (select source_number from purchase_order_item where client = ${client} and order_number = 'PO-QA') as source
    `)) as unknown as Array<{
      arrangements: number;
      journals: number;
      movements: number;
      drawn: number;
      requisition: string;
      supplier: string;
      ordered: string;
      source: string | null;
    }>;
    return row;
  }

  const create = () => page.locator('section[aria-labelledby="quota-create"]');
  const result = () => create().locator('[data-quota-result]');

  async function openBlank() {
    await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'Purchasing quota arrangement', exact: true }).waitFor();
  }

  async function fillCreate(fields: {
    material?: string;
    from?: string;
    to?: string;
    plant?: string;
    items: Array<{ partner: string; quota: string; org?: string }>;
  }) {
    const form = create().locator('form');
    const plantValue = fields.plant ?? '1000';
    if (plantValue !== 'inject') {
      await form.locator(`[name="plant"] option[value="${plantValue}"]`).waitFor({ state: 'attached' });
      await form.locator('[name="plant"]').selectOption(plantValue);
    }
    await form.locator('[name="materialNumber"]').fill(fields.material ?? 'MAT-QA');
    await form.locator('[name="validFrom"]').fill(fields.from ?? FROM);
    await form.locator('[name="validTo"]').fill(fields.to ?? TO);
    for (const [index, item] of fields.items.entries()) {
      if (index > 0) await create().getByRole('button', { name: 'Add item', exact: true }).click();
      const org = item.org ?? '1000';
      await form.locator(`[name="item${index}Org"] option[value="${org}"]`).waitFor({ state: 'attached' });
      await form.locator(`[name="item${index}Org"]`).selectOption(org);
      await form.locator(`[name="item${index}Partner"]`).fill(item.partner);
      await form.locator(`[name="item${index}Quota"]`).fill(item.quota);
    }
  }

  async function refused(label: string, message: RegExp, prepare: () => Promise<void>) {
    const before = await tallies();
    await prepare();
    await result().filter({ hasText: message }).waitFor();
    assert.deepEqual(await tallies(), before, `${label} wrote something`);
    console.log(`  ✓ ${label} was refused, and nothing was written`);
  }

  await page.locator('#command-input').fill('MEQ1');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/quota-arrangement$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Purchasing quota arrangement', exact: true }).waitFor();
  assert.equal(await page.locator('[name="allocatedQuantity"]').count(), 0);
  assert.equal(await page.locator('[name="supplyingPlant"]').count(), 0);
  console.log('  ✓ MEQ1 opens the one screen, and allocated quantity is not a field');

  const beforeCheck = await tallies();
  await fillCreate({
    items: [
      { partner: 'V-QA', quota: '60' },
      { partner: 'V-QA2', quota: '40' },
    ],
  });
  await create().getByRole('button', { name: 'Check', exact: true }).click();
  await page.locator('[data-quota-preview]').waitFor();
  await page.locator('[data-quota-nothing-allocated]').waitFor();
  assert.match(await result().innerText(), /Nothing was written/);
  assert.match(await page.locator('[data-quota-preview]').innerText(), /The number was not drawn/);
  assert.deepEqual(await tallies(), beforeCheck);
  console.log('  ✓ a check wrote nothing, including the number, and allocated nothing');

  await openBlank();
  await fillCreate({
    items: [
      { partner: 'V-QA', quota: '60' },
      { partner: 'V-QA2', quota: '40' },
    ],
  });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const created = result().filter({ hasText: /Quota QA-\d{7} stands/ });
  await created.waitFor();
  const number = (await created.innerText()).match(/QA-\d{7}/)?.[0] ?? '';
  assert.ok(number);
  const afterCreate = await tallies();
  assert.equal(afterCreate.arrangements, beforeCheck.arrangements + 1);
  assert.equal(afterCreate.journals, beforeCheck.journals);
  assert.equal(afterCreate.movements, beforeCheck.movements);
  assert.equal(afterCreate.requisition, beforeCheck.requisition);
  assert.equal(afterCreate.supplier, 'V-QA');
  assert.equal(afterCreate.ordered, '1.000');
  console.log(`  ✓ ${number} stands, and the order, requisition, journal and movement were not touched`);

  await page.getByRole('link', { name: `Open ${number}`, exact: true }).click();
  await page.waitForURL(new RegExp(`quota=${number}`), { waitUntil: 'commit' });
  await page.locator('[data-quota-standing]').waitFor();
  const identity = page.locator('[data-quota-identity]');
  assert.match(await identity.innerText(), /MAT-QA/);
  assert.equal(await page.locator('section[aria-labelledby="quota-change"] [name="materialNumber"]').count(), 0);
  assert.equal(await page.locator('section[aria-labelledby="quota-change"] [name="plant"]').count(), 0);
  console.log('  ✓ the arrangement is open, and material and plant are not retarget fields');

  const rate = page.locator('section[aria-labelledby="quota-rate"]');
  await rate.locator('[name="documentDate"]').fill(TODAY);
  await rate.getByRole('button', { name: 'Rate', exact: true }).click();
  await rate.locator('[data-quota-result]').filter({ hasText: /Item 001 is preferred/ }).waitFor();
  const rated = await rate.locator('[data-quota-result]').innerText();
  assert.match(rated, /0\.000000/);
  assert.match(rated, /Nothing has been allocated/);
  assert.deepEqual(await tallies(), afterCreate);
  console.log('  ✓ an equal rating at zero allocated names item 001, and nothing was written');

  const beforeExample = await tallies();
  const example = await previewQuotaSelection({
    client,
    materialNumber: 'MAT-QA',
    plant: '1000',
    documentDate: TODAY,
    allocatedByItem: { '001': '120', '002': '40' },
  });
  assert.equal(example.ratings.find((row) => row.itemNumber === '001')?.rating, '2.000000');
  assert.equal(example.ratings.find((row) => row.itemNumber === '002')?.rating, '1.000000');
  assert.equal(example.preferredItemNumber, '002');
  assert.equal(example.nothingAllocated, false);
  const equal = await previewQuotaSelection({
    client,
    materialNumber: 'MAT-QA',
    plant: '1000',
    documentDate: TODAY,
    allocatedByItem: { '001': '60', '002': '40' },
  });
  assert.equal(equal.ratings.find((row) => row.itemNumber === '001')?.rating, '1.000000');
  assert.equal(equal.ratings.find((row) => row.itemNumber === '002')?.rating, '1.000000');
  assert.equal(equal.preferredItemNumber, '001');
  assert.deepEqual(await tallies(), beforeExample);
  console.log('  ✓ the package example rated 2.000000 and 1.000000, preferred 002, and wrote nothing');

  await refused('an unknown material', /does not exist/, async () => {
    await openBlank();
    await fillCreate({ material: 'NO-MAT', items: [{ partner: 'V-QA', quota: '10' }] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an unknown plant', /Plant 9999 does not exist/, async () => {
    await openBlank();
    await fillCreate({ plant: 'inject', items: [{ partner: 'V-QA', quota: '10' }] });
    await page.evaluate(() => {
      const select = document.querySelector('section[aria-labelledby="quota-create"] [name="plant"]') as HTMLSelectElement;
      const option = document.createElement('option');
      option.value = '9999';
      option.text = '9999';
      select.appendChild(option);
      select.value = '9999';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await create().locator('[name="materialNumber"]').fill('MAT-QA');
    await create().locator('[name="validFrom"]').fill(FROM);
    await create().locator('[name="validTo"]').fill(TO);
    await create().locator('[name="item0Org"] option[value="1000"]').waitFor({ state: 'attached' });
    await create().locator('[name="item0Org"]').selectOption('1000');
    await create().locator('[name="item0Partner"]').fill('V-QA');
    await create().locator('[name="item0Quota"]').fill('10');
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a missing extension', /not extended/, async () => {
    await openBlank();
    await fillCreate({ material: 'MAT-BARE', items: [{ partner: 'V-QA', quota: '10' }] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a produced material', /procured only by production/, async () => {
    await openBlank();
    await fillCreate({ material: 'MAT-MAKE', items: [{ partner: 'V-QA', quota: '10' }] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an unknown supplier', /does not exist/, async () => {
    await openBlank();
    await fillCreate({ items: [{ partner: 'NOBODY', quota: '10' }] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a blocked supplier', /blocked/, async () => {
    await openBlank();
    await fillCreate({ items: [{ partner: 'V-OFF', quota: '10' }] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a missing purchasing assignment', /no purchasing assignment/, async () => {
    await openBlank();
    await fillCreate({ items: [{ partner: 'V-BARE', quota: '10' }] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an unassigned plant', /not assigned/, async () => {
    await openBlank();
    await fillCreate({ plant: 'inject', items: [{ partner: 'V-QA', quota: '10' }] });
    await page.evaluate(() => {
      const select = document.querySelector('section[aria-labelledby="quota-create"] [name="plant"]') as HTMLSelectElement;
      const option = document.createElement('option');
      option.value = '2000';
      option.text = '2000';
      select.appendChild(option);
      select.value = '2000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await create().locator('[name="materialNumber"]').fill('MAT-QA');
    await create().locator('[name="validFrom"]').fill(FROM);
    await create().locator('[name="validTo"]').fill(TO);
    await create().locator('[name="item0Org"] option[value="1000"]').waitFor({ state: 'attached' });
    await create().locator('[name="item0Org"]').selectOption('1000');
    await create().locator('[name="item0Partner"]').fill('V-QA');
    await create().locator('[name="item0Quota"]').fill('10');
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an end before the start', /before the start/, async () => {
    await openBlank();
    await fillCreate({
      material: 'MAT-OV',
      from: '2026-12-31',
      to: '2026-01-01',
      items: [{ partner: 'V-QA', quota: '10' }],
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a zero quota', /positive integer/, async () => {
    await openBlank();
    await fillCreate({ material: 'MAT-OV', items: [{ partner: 'V-QA', quota: '10' }] });
    await create().locator('[name="item0Quota"]').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.removeAttribute('min');
      input.value = '0';
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a negative quota', /positive integer/, async () => {
    await openBlank();
    await fillCreate({ material: 'MAT-OV', items: [{ partner: 'V-QA', quota: '10' }] });
    await create().locator('[name="item0Quota"]').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.removeAttribute('min');
      input.value = '-1';
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('the same supplier twice', /already stands as item 001/, async () => {
    await openBlank();
    await fillCreate({
      material: 'MAT-OV',
      items: [
        { partner: 'V-QA', quota: '60' },
        { partner: 'V-QA', quota: '40' },
      ],
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an internal supplying plant', /not a quota source/, async () => {
    await openBlank();
    await fillCreate({ material: 'MAT-OV', items: [{ partner: 'V-QA', quota: '10' }] });
    await create().locator('form').evaluate((form) => {
      const input = document.createElement('input');
      input.name = 'supplyingPlant';
      input.value = '3000';
      form.appendChild(input);
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });

  await openBlank();
  await fillCreate({
    material: 'MAT-OV',
    from: '2026-01-01',
    to: '2026-06-30',
    items: [{ partner: 'V-QA', quota: '10' }],
  });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const overlapNotice = result().filter({ hasText: /Quota QA-\d{7} stands/ });
  await overlapNotice.waitFor();
  const overlapNumber = (await overlapNotice.innerText()).match(/QA-\d{7}/)?.[0] ?? '';
  await refused('an overlapping arrangement', new RegExp(overlapNumber), async () => {
    await openBlank();
    await fillCreate({
      material: 'MAT-OV',
      from: '2026-03-01',
      to: '2026-08-01',
      items: [{ partner: 'V-QA2', quota: '10' }],
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });

  await page.goto(`${base}${ROUTE}?quota=${number}`, { waitUntil: 'domcontentloaded' });
  const change = page.locator('section[aria-labelledby="quota-change"]');
  const staleVersion = await change.locator('[name="expectedVersion"]').inputValue();
  await change.locator('[name="reason"]').fill('Deactivate the first item');
  await change.locator('[name="item0Deactivate"]').check();
  await change.getByRole('button', { name: 'Save change', exact: true }).click();
  await change.locator('[data-quota-result]').filter({ hasText: /stands at version/ }).waitFor();
  await rate.locator('[name="documentDate"]').fill(TODAY);
  await rate.getByRole('button', { name: 'Rate', exact: true }).click();
  const afterDeactivate = rate.locator('[data-quota-result]').filter({ hasText: /Item 002 is preferred/ });
  await afterDeactivate.waitFor();
  assert.doesNotMatch(await afterDeactivate.innerText(), /Item 001 is preferred/);
  console.log('  ✓ a deactivated item is not preferred');

  await change.locator('[name="reason"]').fill('Expire the arrangement');
  await change.locator('[name="validTo"]').fill('2020-01-02');
  await change.getByRole('button', { name: 'Save change', exact: true }).click();
  await change.locator('[data-quota-result]').filter({ hasText: /stands at version/ }).waitFor();
  await rate.locator('[name="documentDate"]').fill(TODAY);
  await rate.getByRole('button', { name: 'Rate', exact: true }).click();
  await rate.locator('[data-quota-result]').filter({ hasText: /No quota arrangement applies/ }).waitFor();
  console.log('  ✓ an expired arrangement was not selected');

  await openBlank();
  await fillCreate({
    material: 'MAT-FUT',
    from: '2099-01-01',
    to: '2099-12-31',
    items: [{ partner: 'V-QA', quota: '10' }],
  });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const futureNotice = result().filter({ hasText: /Quota QA-\d{7} stands/ });
  await futureNotice.waitFor();
  const futureNumber = (await futureNotice.innerText()).match(/QA-\d{7}/)?.[0] ?? '';
  await page.goto(`${base}${ROUTE}?quota=${futureNumber}`, { waitUntil: 'domcontentloaded' });
  const futureRate = page.locator('section[aria-labelledby="quota-rate"]');
  await futureRate.locator('[name="documentDate"]').fill(TODAY);
  await futureRate.getByRole('button', { name: 'Rate', exact: true }).click();
  await futureRate.locator('[data-quota-result]').filter({ hasText: /No quota arrangement applies/ }).waitFor();
  console.log('  ✓ a future arrangement was not selected today');

  await openBlank();
  await fillCreate({
    material: 'MAT-REQ',
    items: [{ partner: 'V-QA2', quota: '10' }],
  });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const requiredNotice = result().filter({ hasText: /Quota QA-\d{7} stands/ });
  await requiredNotice.waitFor();
  const requiredNumber = (await requiredNotice.innerText()).match(/QA-\d{7}/)?.[0] ?? '';
  await page.goto(`${base}${ROUTE}?quota=${requiredNumber}`, { waitUntil: 'domcontentloaded' });
  const requiredRate = page.locator('section[aria-labelledby="quota-rate"]');
  await requiredRate.locator('[name="documentDate"]').fill(TODAY);
  await requiredRate.getByRole('button', { name: 'Rate', exact: true }).click();
  const named = requiredRate.locator('[data-quota-result]').filter({ hasText: new RegExp(fixed.sourceNumber) });
  await named.waitFor();
  const namedText = await named.innerText();
  assert.match(namedText, /does not replace the supplier/);
  assert.match(namedText, /Nothing has been allocated/);
  console.log(`  ✓ a required list named ${fixed.sourceNumber} and did not replace the supplier`);

  await page.goto(`${base}${ROUTE}?quota=${number}`, { waitUntil: 'domcontentloaded' });
  const stale = page.locator('section[aria-labelledby="quota-change"]');
  await stale.locator('[name="reason"]').fill('Stale screen');
  await stale.locator('[name="expectedVersion"]').evaluate((el, version) => {
    (el as HTMLInputElement).value = version;
  }, staleVersion);
  await stale.getByRole('button', { name: 'Save change', exact: true }).click();
  await stale.locator('[data-quota-result]').filter({ hasText: /Reload the arrangement/ }).waitFor();
  const staleText = await stale.locator('[data-quota-result]').filter({ hasText: /Reload the arrangement/ }).innerText();
  assert.match(staleText, /stands at version/);
  console.log('  ✓ a stale version named the version that stands');

  const raced = await Promise.allSettled([
    createQuotaArrangement({
      client, changedBy: ACTOR, materialNumber: 'MAT-CC', plant: '1000',
      validFrom: FROM, validTo: TO,
      items: [{ partnerNumber: 'V-QA', purchasingOrg: '1000', quota: 10 }],
    }),
    createQuotaArrangement({
      client, changedBy: ACTOR, materialNumber: 'MAT-CC', plant: '1000',
      validFrom: FROM, validTo: TO,
      items: [{ partnerNumber: 'V-QA2', purchasingOrg: '1000', quota: 20 }],
    }),
  ]);
  assert.equal(raced.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((row) => row.status === 'rejected').length, 1);
  console.log('  ✓ two concurrent creates left one arrangement');

  const end = await tallies();
  assert.equal(end.journals, beforeCheck.journals);
  assert.equal(end.movements, beforeCheck.movements);
  assert.equal(end.requisition, '1.000');
  assert.equal(end.supplier, 'V-QA');
  assert.equal(end.ordered, '1.000');
  assert.equal(end.source, null);
  const [quotaColumns] = await withTenant(client, (tx) => tx.execute(sql`
    select count(*)::int as n
      from information_schema.columns
     where table_schema = 'public'
       and table_name in ('purchase_order', 'purchase_order_item', 'purchase_requisition_item')
       and column_name ilike '%quota%'
  `)) as unknown as Array<{ n: number }>;
  assert.equal(quotaColumns.n, 0);
  console.log('  ✓ the requisition and the order were not rewritten, and no journal or material document was written');
}
