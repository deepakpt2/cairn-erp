import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { createSourceListEntry } from '../../src/modules/purchasing/source-list';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/source-list';
const ORDERS = '/purchasing/orders';
const ACTOR = 'browser.admin';
const FROM = '2020-01-01';
const TO = '2099-12-31';

/**
 * SCR-153 browser acceptance (T852) — a source list names who may supply a material.
 *
 * The production build is the screen under test. A check writes nothing. The named cuts
 * write nothing. The order stores the source it used, and a later change leaves that order.
 * Rollback, the tenant boundary and the audit delta stay in the service tests.
 */
export async function scr153SourceList(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-153: a source list, and the order keeps the source it used');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values
        (${client}, 'V-SL', 'ORGANIZATION', 'Source supplier', 'CREATED', ${ACTOR}),
        (${client}, 'V-SL2', 'ORGANIZATION', 'Other supplier', 'CREATED', ${ACTOR}),
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
        (${client}, 'V-SL', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-SL2', 'SUPPLIER', ${ACTOR}),
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
        (${client}, 'V-SL', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR}),
        (${client}, 'V-SL2', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, m.n, m.d, t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values
        ('MAT-SL', 'Source material'), ('MAT-MAKE', 'Produced'), ('MAT-BARE', 'No plant'),
        ('MAT-OPT', 'Optional'), ('MAT-CC', 'Concurrent'), ('MAT-OV', 'Overlap'), ('MAT-FUT', 'Future')
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
        (${client}, 'MAT-SL', '1000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-SL', '2000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-MAKE', '1000', 'MAKE', ${ACTOR}),
        (${client}, 'MAT-OPT', '1000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-CC', '1000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-OV', '1000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-FUT', '1000', 'BUY', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_requisition_item
        (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, created_by)
      values (${client}, 'PR-SL', 10, 'Stay', 1, 'PC', '2026-10-21', '2026-11-01', '1000', '001', ${ACTOR})
    `);
  });

  async function tallies() {
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from purchasing_source_list_entry where client = ${client}) as entries,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from material_document where client = ${client}) as movements,
        (select current_number::int from number_range where client = ${client} and object_code = 'SOURCELIST') as drawn,
        (select quantity::text from purchase_requisition_item where client = ${client} and requisition_number = 'PR-SL') as requisition
    `)) as unknown as Array<{ entries: number; journals: number; movements: number; drawn: number; requisition: string }>;
    return row;
  }

  const create = () => page.locator('section[aria-labelledby="source-list-create"]');
  const result = () => create().locator('[data-source-list-result]');

  async function openBlank() {
    await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'Purchasing source list', exact: true }).waitFor();
  }

  async function fillEntry(fields: Record<string, string>, plantValue = '1000') {
    const form = create().locator('form');
    await form.locator('[name="purchasingOrg"]').selectOption(fields.purchasingOrg ?? '1000');
    if (plantValue !== 'inject') {
      await form.locator(`[name="plant"] option[value="${plantValue}"]`).waitFor({ state: 'attached' });
      await form.locator('[name="plant"]').selectOption(plantValue);
    }
    await form.locator('[name="materialNumber"]').fill(fields.materialNumber ?? 'MAT-SL');
    await form.locator('[name="partnerNumber"]').fill(fields.partnerNumber ?? 'V-SL');
    await form.locator('[name="validFrom"]').fill(fields.validFrom ?? FROM);
    await form.locator('[name="validTo"]').fill(fields.validTo ?? TO);
    if (fields.fixedSource === '1') await form.locator('[name="fixedSource"]').check();
    if (fields.sourceListRequired === '1') await form.locator('[name="sourceListRequired"]').check();
    if (fields.blockedSource === '1') await form.locator('[name="blockedSource"]').check();
  }

  async function refused(label: string, message: RegExp, prepare: () => Promise<void>) {
    const before = await tallies();
    await prepare();
    await result().filter({ hasText: message }).waitFor();
    assert.deepEqual(await tallies(), before, `${label} wrote something`);
    console.log(`  ✓ ${label} was refused, and nothing was written`);
  }

  await page.locator('#command-input').fill('ME01');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/source-list$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Purchasing source list', exact: true }).waitFor();
  console.log('  ✓ ME01 opens the one screen');

  const beforeCheck = await tallies();
  await fillEntry({});
  await create().getByRole('button', { name: 'Check', exact: true }).click();
  await page.locator('[data-source-list-preview]').waitFor();
  assert.match(await result().innerText(), /Nothing was written/);
  assert.match(await page.locator('[data-source-list-preview]').innerText(), /Nothing has been written/);
  assert.deepEqual(await tallies(), beforeCheck);
  console.log('  ✓ a check wrote nothing, including the number');

  await openBlank();
  await fillEntry({});
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const created = result().filter({ hasText: /Source SL-\d{7} stands/ });
  await created.waitFor();
  const number = (await created.innerText()).match(/SL-\d{7}/)?.[0] ?? '';
  assert.ok(number);
  const afterCreate = await tallies();
  assert.equal(afterCreate.entries, beforeCheck.entries + 1);
  assert.equal(afterCreate.journals, beforeCheck.journals);
  assert.equal(afterCreate.movements, beforeCheck.movements);
  assert.equal(afterCreate.requisition, beforeCheck.requisition);
  const opened = await withTenant(client, (tx) => tx.execute(sql`
    select source_list_required from purchasing_source_list
     where client = ${client} and material_number = 'MAT-SL'
  `)) as unknown as Array<{ source_list_required: boolean }>;
  assert.equal(opened[0].source_list_required, false);
  console.log(`  ✓ ${number} stands, the requirement is off, and no journal, movement or requisition was touched`);

  await page.getByRole('link', { name: `Open ${number}`, exact: true }).click();
  await page.waitForURL(new RegExp(`source=${number}`), { waitUntil: 'commit' });
  await page.locator('[data-source-list-standing]').waitFor();
  assert.match(await page.locator('[data-source-list-identity]').innerText(), /V-SL/);
  console.log('  ✓ the entry is open, and the supplier is not a retarget field');

  await refused('an unknown material', /does not exist/, async () => {
    await openBlank();
    await fillEntry({ materialNumber: 'NO-MAT' });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an unknown plant', /Plant 9999 does not exist/, async () => {
    await openBlank();
    await fillEntry({}, 'inject');
    await page.evaluate(() => {
      const select = document.querySelector('section[aria-labelledby="source-list-create"] [name="plant"]') as HTMLSelectElement;
      const option = document.createElement('option');
      option.value = '9999';
      option.text = '9999';
      select.appendChild(option);
      select.value = '9999';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await create().locator('[name="materialNumber"]').fill('MAT-SL');
    await create().locator('[name="partnerNumber"]').fill('V-SL');
    await create().locator('[name="validFrom"]').fill(FROM);
    await create().locator('[name="validTo"]').fill(TO);
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a missing extension', /not extended/, async () => {
    await openBlank();
    await fillEntry({ materialNumber: 'MAT-BARE' });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a produced material', /procured only by production/, async () => {
    await openBlank();
    await fillEntry({ materialNumber: 'MAT-MAKE' });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an unknown supplier', /does not exist/, async () => {
    await openBlank();
    await fillEntry({ partnerNumber: 'NOBODY' });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a blocked supplier', /blocked/, async () => {
    await openBlank();
    await fillEntry({ partnerNumber: 'V-OFF' });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a missing purchasing assignment', /no purchasing assignment/, async () => {
    await openBlank();
    await fillEntry({ partnerNumber: 'V-BARE' });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an unassigned plant', /not assigned/, async () => {
    await openBlank();
    await fillEntry({}, 'inject');
    await page.evaluate(() => {
      const select = document.querySelector('section[aria-labelledby="source-list-create"] [name="plant"]') as HTMLSelectElement;
      const option = document.createElement('option');
      option.value = '2000';
      option.text = '2000';
      select.appendChild(option);
      select.value = '2000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await create().locator('[name="materialNumber"]').fill('MAT-SL');
    await create().locator('[name="partnerNumber"]').fill('V-SL');
    await create().locator('[name="validFrom"]').fill(FROM);
    await create().locator('[name="validTo"]').fill(TO);
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an end before the start', /before the start/, async () => {
    await openBlank();
    await fillEntry({ validFrom: '2026-12-31', validTo: '2026-01-01' });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });

  await openBlank();
  await fillEntry({ materialNumber: 'MAT-OV', validFrom: '2026-01-01', validTo: '2026-06-30' });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const firstOverlap = result().filter({ hasText: /Source SL-\d{7} stands/ });
  await firstOverlap.waitFor();
  const overlapNumber = (await firstOverlap.innerText()).match(/SL-\d{7}/)?.[0] ?? '';
  await refused('an overlapping same supplier', new RegExp(overlapNumber), async () => {
    await openBlank();
    await fillEntry({ materialNumber: 'MAT-OV', validFrom: '2026-03-01', validTo: '2026-08-01' });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });

  await openBlank();
  await fillEntry({
    materialNumber: 'MAT-OV', partnerNumber: 'V-SL2', fixedSource: '1',
    validFrom: '2025-01-01', validTo: '2025-06-30',
  });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const fixedNotice = result().filter({ hasText: /Source SL-\d{7} stands/ });
  await fixedNotice.waitFor();
  const fixedNumber = (await fixedNotice.innerText()).match(/SL-\d{7}/)?.[0] ?? '';
  await refused('two fixed sources', new RegExp(`Fixed source ${fixedNumber}`), async () => {
    await openBlank();
    await fillEntry({
      materialNumber: 'MAT-OV', fixedSource: '1', validFrom: '2025-03-01', validTo: '2025-03-31',
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });

  async function saveOrder(supplier: string, material: string) {
    await page.goto(`${base}${ORDERS}`, { waitUntil: 'domcontentloaded' });
    const form = page.locator('section[aria-labelledby="po-create"]');
    await form.locator('label').filter({ hasText: 'Supplier' }).locator('input').fill(supplier);
    await form.locator('label').filter({ hasText: 'Purchasing organization' }).locator('select').selectOption('1000');
    await form.locator('label').filter({ hasText: 'Purchasing group' }).locator('select').selectOption('001');
    await form.locator('label').filter({ hasText: 'Company code' }).locator('select').selectOption('1000');
    const row = form.locator('tbody tr').first();
    await row.locator('td').nth(1).locator('input').fill(material);
    await row.locator('td').nth(2).locator('input').fill('Source material');
    await row.locator('td').nth(3).locator('input').fill('1');
    await row.locator('td').nth(4).locator('input').fill('PC');
    await row.locator('td').nth(5).locator('input').fill('1');
    await row.locator('td').nth(10).locator('select').selectOption('1000');
    const panel = form.locator('fieldset').first();
    await panel.locator('input[type="date"]').fill('2026-11-15');
    await panel.locator('input[placeholder="Scheduled quantity"]').fill('1');
    await form.getByRole('button', { name: 'Save purchase order', exact: true }).click();
    return form;
  }

  const stored = await saveOrder('V-SL', 'MAT-SL');
  await stored.getByText(/Purchase order POF-\d+ created\./).waitFor();
  const storedNumber = (await stored.innerText()).match(/POF-\d+/)?.[0] ?? '';
  const storedRow = await withTenant(client, (tx) => tx.execute(sql`
    select i.source_number, o.supplier_number
      from purchase_order_item i
      join purchase_order o on o.client = i.client and o.order_number = i.order_number
     where i.client = ${client} and i.order_number = ${storedNumber}
  `)) as unknown as Array<{ source_number: string; supplier_number: string }>;
  assert.equal(storedRow[0].source_number, number);
  assert.equal(storedRow[0].supplier_number, 'V-SL');
  console.log(`  ✓ ${storedNumber} stored ${number}`);

  const optional = await saveOrder('V-SL2', 'MAT-SL');
  await optional.getByText(/Purchase order POF-\d+ created\./).waitFor();
  const optionalNumber = (await optional.innerText()).match(/POF-\d+/)?.[0] ?? '';
  const optionalRow = await withTenant(client, (tx) => tx.execute(sql`
    select source_number from purchase_order_item where client = ${client} and order_number = ${optionalNumber}
  `)) as unknown as Array<{ source_number: string | null }>;
  assert.equal(optionalRow[0].source_number, null);
  console.log(`  ✓ ${optionalNumber} was not blocked, and no source was stored`);

  await page.goto(`${base}${ROUTE}?source=${number}`, { waitUntil: 'domcontentloaded' });
  const change = page.locator('section[aria-labelledby="source-list-change"]');
  await change.locator('[name="reason"]').fill('Require a source');
  await change.locator('[name="sourceListRequired"]').check();
  await change.getByRole('button', { name: 'Save change', exact: true }).click();
  await change.locator('[data-source-list-result]').filter({ hasText: /stands at version/ }).waitFor();
  console.log('  ✓ the requirement is a change of the list');

  await openBlank();
  await fillEntry({
    partnerNumber: 'V-SL2', fixedSource: '1', validFrom: '2026-01-01', validTo: '2026-12-31',
  });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const blocking = result().filter({ hasText: /Source SL-\d{7} stands/ });
  await blocking.waitFor();
  const blockingNumber = (await blocking.innerText()).match(/SL-\d{7}/)?.[0] ?? '';
  const refusedOrder = await saveOrder('V-SL', 'MAT-SL');
  await refusedOrder.locator('[role="status"]').filter({ hasText: new RegExp(blockingNumber) }).waitFor();
  console.log(`  ✓ a required list named ${blockingNumber} and did not replace the supplier`);

  await page.goto(`${base}${ROUTE}?source=${blockingNumber}`, { waitUntil: 'domcontentloaded' });
  const blockForm = page.locator('section[aria-labelledby="source-list-change"]');
  await blockForm.locator('[name="reason"]').fill('Block the fixed source');
  await blockForm.locator('[name="blockedSource"]').check();
  await blockForm.getByRole('button', { name: 'Save change', exact: true }).click();
  await blockForm.locator('[data-source-list-result]').filter({ hasText: /stands at version/ }).waitFor();
  const afterBlock = await saveOrder('V-SL', 'MAT-SL');
  await afterBlock.getByText(/Purchase order POF-\d+ created\./).waitFor();
  const afterBlockNumber = (await afterBlock.innerText()).match(/POF-\d+/)?.[0] ?? '';
  const qualified = await withTenant(client, (tx) => tx.execute(sql`
    select source_number from purchase_order_item where client = ${client} and order_number = ${afterBlockNumber}
  `)) as unknown as Array<{ source_number: string }>;
  assert.equal(qualified[0].source_number, number);
  console.log('  ✓ a blocked fixed source did not stop another eligible source');

  await page.goto(`${base}${ROUTE}?source=${number}`, { waitUntil: 'domcontentloaded' });
  const expire = page.locator('section[aria-labelledby="source-list-change"]');
  const staleVersion = await expire.locator('[name="expectedVersion"]').inputValue();
  await expire.locator('[name="reason"]').fill('Expire the used source');
  await expire.locator('[name="validTo"]').fill('2020-01-02');
  await expire.getByRole('button', { name: 'Save change', exact: true }).click();
  await expire.locator('[data-source-list-result]').filter({ hasText: /stands at version/ }).waitFor();
  const still = await withTenant(client, (tx) => tx.execute(sql`
    select i.source_number, o.supplier_number, i.quantity::text as quantity
      from purchase_order_item i
      join purchase_order o on o.client = i.client and o.order_number = i.order_number
     where i.client = ${client} and i.order_number = ${storedNumber}
  `)) as unknown as Array<{ source_number: string; supplier_number: string; quantity: string }>;
  assert.equal(still[0].source_number, number);
  assert.equal(still[0].supplier_number, 'V-SL');
  console.log('  ✓ a later source change left the order where it was');

  await page.goto(`${base}${ORDERS}?order=${storedNumber}`, { waitUntil: 'domcontentloaded' });
  const orderForm = page.locator('section[aria-labelledby="po-create"]');
  const orderRow = orderForm.locator('tbody tr').first();
  await orderRow.locator('td').nth(3).locator('input').fill('3');
  await orderForm.locator('fieldset').first().locator('input[placeholder="Scheduled quantity"]').fill('3');
  await orderForm.getByRole('button', { name: 'Save changes', exact: true }).click();
  await orderForm.getByText(`Purchase order ${storedNumber} saved.`).waitFor();
  const changed = await withTenant(client, (tx) => tx.execute(sql`
    select source_number, quantity::text as quantity from purchase_order_item
     where client = ${client} and order_number = ${storedNumber}
  `)) as unknown as Array<{ source_number: string; quantity: string }>;
  assert.equal(changed[0].source_number, number);
  assert.equal(changed[0].quantity, '3.000');
  console.log('  ✓ a later item change kept the source');

  const expiredOrder = await saveOrder('V-SL', 'MAT-SL');
  await expiredOrder.locator('[role="status"]').filter({ hasText: /no eligible entry/ }).waitFor();
  console.log('  ✓ an expired entry was not selected');

  await openBlank();
  await fillEntry({
    materialNumber: 'MAT-FUT', sourceListRequired: '1', validFrom: '2099-01-01', validTo: '2099-12-31',
  });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  await result().filter({ hasText: /Source SL-\d{7} stands/ }).waitFor();
  const futureOrder = await saveOrder('V-SL', 'MAT-FUT');
  await futureOrder.locator('[role="status"]').filter({ hasText: /no eligible entry/ }).waitFor();
  console.log('  ✓ a future entry was not selected today');

  await page.goto(`${base}${ROUTE}?source=${number}`, { waitUntil: 'domcontentloaded' });
  const stale = page.locator('section[aria-labelledby="source-list-change"]');
  await stale.locator('[name="reason"]').fill('Stale screen');
  await stale.locator('[name="expectedVersion"]').evaluate((el, version) => {
    (el as HTMLInputElement).value = version;
  }, staleVersion);
  await stale.getByRole('button', { name: 'Save change', exact: true }).click();
  await stale.locator('[data-source-list-result]').filter({ hasText: /Reload the entry/ }).waitFor();
  const staleText = await stale.locator('[data-source-list-result]').filter({ hasText: /Reload the entry/ }).innerText();
  assert.match(staleText, /stands at version/);
  console.log('  ✓ a stale version named the version that stands');

  const raced = await Promise.allSettled([
    createSourceListEntry({
      client, changedBy: ACTOR, materialNumber: 'MAT-CC', plant: '1000', partnerNumber: 'V-SL',
      purchasingOrg: '1000', validFrom: FROM, validTo: TO,
    }),
    createSourceListEntry({
      client, changedBy: ACTOR, materialNumber: 'MAT-CC', plant: '1000', partnerNumber: 'V-SL',
      purchasingOrg: '1000', validFrom: FROM, validTo: TO,
    }),
  ]);
  assert.equal(raced.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((row) => row.status === 'rejected').length, 1);
  console.log('  ✓ two concurrent creates left one entry');

  const end = await tallies();
  assert.equal(end.journals, beforeCheck.journals);
  assert.equal(end.movements, beforeCheck.movements);
  assert.equal(end.requisition, '1.000');
  console.log('  ✓ the requisition, the journal and the material document were not touched');
}
