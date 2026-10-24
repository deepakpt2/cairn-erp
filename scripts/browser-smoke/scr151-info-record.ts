import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { createPurchasingInfoRecord } from '../../src/modules/purchasing/info-record';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/info-record';
const ORDERS = '/purchasing/orders';
const ACTOR = 'browser.admin';
const FROM = '2020-01-01';
const TO = '2099-12-31';

/**
 * SCR-151 browser acceptance (T850) — a purchasing info record is a default.
 *
 * The production build is the screen under test. A check writes nothing. The named cuts write
 * nothing. An order with no typed price takes the record, and a later price leaves that order
 * where it was. Rollback, the tenant boundary, a stale version and the direct resolver stay in
 * the service tests.
 */
export async function scr151InfoRecord(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-151: a standard info record, and the order keeps the price it used');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values
        (${client}, 'V-IR', 'ORGANIZATION', 'Info supplier', 'CREATED', ${ACTOR}),
        (${client}, 'V-OFF', 'ORGANIZATION', 'Blocked supplier', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      update business_partner set is_blocked = true
       where client = ${client} and partner_number = 'V-OFF'
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values
        (${client}, 'V-IR', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-OFF', 'SUPPLIER', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by)
      values (${client}, '001', 'Buyer', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org
        (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
      values (${client}, 'V-IR', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, m.n, m.d, t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values
        ('MAT-IR', 'Info material'), ('MAT-ZERO', 'Zero'), ('MAT-BOX', 'No conversion'),
        ('MAT-MAKE', 'Produced'), ('MAT-MISS', 'No record'), ('MAT-CC', 'Concurrent')
      ) m(n, d)
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, procurement_type, created_by)
      values
        (${client}, 'MAT-IR', '1000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-MAKE', '1000', 'MAKE', ${ACTOR}),
        (${client}, 'MAT-MISS', '1000', 'BUY', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, '2000', 'Unassigned plant', '1000', 'KW', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_requisition_item
        (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, created_by)
      values (${client}, 'PR-IR', 10, 'Stay', 1, 'PC', '2026-10-21', '2026-11-01', '1000', '001', ${ACTOR})
    `);
  });

  async function tallies() {
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from purchasing_info_record where client = ${client}) as records,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from material_document where client = ${client}) as movements,
        (select current_number::int from number_range where client = ${client} and object_code = 'INFOREC') as drawn,
        (select quantity::text from purchase_requisition_item where client = ${client} and requisition_number = 'PR-IR') as requisition
    `)) as unknown as Array<{ records: number; journals: number; movements: number; drawn: number; requisition: string }>;
    return row;
  }

  const create = () => page.locator('section[aria-labelledby="info-record-create"]');
  const result = () => page.locator('[data-info-record-result]');

  async function openBlank() {
    await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'Purchasing info record', exact: true }).waitFor();
  }

  async function fillPrice(amount: string, extra: Record<string, string> = {}) {
    const form = create().locator('form');
    const fields = {
      partnerNumber: 'V-IR',
      materialNumber: 'MAT-IR',
      purchasingOrg: '1000',
      amount,
      currency: 'KWD',
      priceUnit: '1',
      priceUnitOfMeasure: 'PC',
      validFrom: FROM,
      validTo: TO,
      ...extra,
    };
    for (const [name, value] of Object.entries(fields)) {
      const input = form.locator(`[name="${name}"]`);
      if ((await input.evaluate((el) => el.tagName)) === 'SELECT') {
        await input.locator(`option[value="${value}"]`).waitFor({ state: 'attached' });
        await input.selectOption(value);
        continue;
      }
      if (await input.getAttribute('readonly') !== null && (await input.inputValue()) === value) continue;
      await input.fill(value);
    }
  }

  async function refused(label: string, message: RegExp, prepare: () => Promise<void>) {
    const before = await tallies();
    await prepare();
    await result().filter({ hasText: message }).waitFor();
    assert.deepEqual(await tallies(), before, `${label} wrote something`);
    console.log(`  ✓ ${label} was refused, and nothing was written`);
  }

  await page.locator('#command-input').fill('ME11');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/info-record$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Purchasing info record', exact: true }).waitFor();
  assert.equal(await page.locator('[data-info-record-category="STANDARD"]').count() > 0, true);
  assert.equal(await page.locator('[data-info-record-category="STANDARD"]').evaluateAll((nodes) => nodes.some((node) => node.tagName === 'SELECT' || node.querySelector('select'))), false, 'the category is not a list');
  console.log('  ✓ ME11 opens the one screen, and Standard is text');

  const beforeCheck = await tallies();
  await fillPrice('10', { plannedDeliveryDays: '7', minimumOrderQuantity: '2', minimumOrderUnit: 'PC' });
  await create().getByRole('button', { name: 'Check', exact: true }).click();
  await page.locator('[data-info-record-preview]').waitFor();
  assert.match(await result().innerText(), /Nothing was written/);
  assert.deepEqual(await tallies(), beforeCheck);
  console.log('  ✓ a check wrote nothing, including the number');

  // The check action may refresh the page. Wait for that to settle, then fill again.
  // A surviving value is not a saved draft; the tally above already proved nothing was written.
  await page.waitForLoadState('networkidle');
  await fillPrice('10', { plannedDeliveryDays: '7', minimumOrderQuantity: '2', minimumOrderUnit: 'PC' });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const created = result().filter({ hasText: /Info record IR-\d{7} stands/ });
  await created.waitFor();
  const number = (await created.innerText()).match(/IR-\d{7}/)?.[0] ?? '';
  assert.ok(number, 'the drawn number is shown');
  const afterCreate = await tallies();
  assert.equal(afterCreate.records, beforeCheck.records + 1);
  assert.equal(afterCreate.journals, beforeCheck.journals);
  assert.equal(afterCreate.movements, beforeCheck.movements);
  assert.equal(afterCreate.requisition, beforeCheck.requisition);
  console.log(`  ✓ ${number} stands, and no journal, movement or requisition was touched`);

  await page.getByRole('link', { name: `Open ${number}`, exact: true }).click();
  await page.waitForURL(new RegExp(`record=${number}`), { waitUntil: 'commit' });
  await page.locator('[data-info-record-standing]').waitFor();
  assert.match(await page.locator('[data-info-record-standing]').innerText(), /organisation/);
  console.log('  ✓ the organisation segment is open');

  await openBlank();
  await page.locator('input[name="supplier"]').fill('V-IR');
  await page.locator('input[name="material"]').fill('MAT-IR');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(/supplier=V-IR/, { waitUntil: 'commit' });
  await page.getByText(`Info record ${number} already links this supplier and material.`).waitFor();
  console.log('  ✓ supplier and material name the standing number instead of creating another');

  await refused('a material group', /material-group/, async () => {
    await openBlank();
    await fillPrice('10');
    await page.evaluate(() => {
      const form = document.querySelector('section[aria-labelledby="info-record-create"] form');
      if (!form) throw new Error('the create form is not on the page');
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'materialGroup';
      hidden.value = 'RAW';
      form.appendChild(hidden);
      form.querySelector('[data-info-record-check]')?.removeAttribute('disabled');
      (form.querySelector('[data-info-record-check]') as HTMLButtonElement).click();
    });
  });

  await refused('neither identifier', /A material is required/, async () => {
    await openBlank();
    await fillPrice('10');
    await page.evaluate(() => {
      const form = document.querySelector('section[aria-labelledby="info-record-create"] form');
      if (!form) throw new Error('the create form is not on the page');
      const material = form.querySelector('input[name="materialNumber"]') as HTMLInputElement;
      material.required = false;
      material.value = '';
      (form.querySelector('[data-info-record-check]') as HTMLButtonElement).click();
    });
  });

  await refused('another category', /SUBCONTRACT/, async () => {
    await openBlank();
    await fillPrice('10', { materialNumber: 'MAT-ZERO' });
    await page.evaluate(() => {
      const form = document.querySelector('section[aria-labelledby="info-record-create"] form');
      if (!form) throw new Error('the create form is not on the page');
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'category';
      hidden.value = 'SUBCONTRACT';
      form.appendChild(hidden);
      (form.querySelector('[data-info-record-check]') as HTMLButtonElement).click();
    });
  });

  await refused('an unknown supplier', /does not exist/, async () => {
    await openBlank();
    await fillPrice('10', { partnerNumber: 'NOBODY' });
    await create().getByRole('button', { name: 'Check', exact: true }).click();
  });

  await refused('a blocked supplier', /blocked/, async () => {
    await openBlank();
    await fillPrice('10', { partnerNumber: 'V-OFF' });
    await create().getByRole('button', { name: 'Check', exact: true }).click();
  });

  await refused('a missing plant assignment', /not assigned/, async () => {
    await openBlank();
    await fillPrice('10', { plant: '2000' });
    await create().getByRole('button', { name: 'Check', exact: true }).click();
  });

  await refused('a material procured by production', /procured by production/, async () => {
    await openBlank();
    await fillPrice('10', { materialNumber: 'MAT-MAKE', plant: '1000' });
    await create().getByRole('button', { name: 'Check', exact: true }).click();
  });

  await refused('a foreign currency', /not converted/, async () => {
    await openBlank();
    await fillPrice('10', { materialNumber: 'MAT-ZERO', currency: 'USD' });
    await create().getByRole('button', { name: 'Check', exact: true }).click();
  });

  await refused('a negative price', /negative/, async () => {
    await openBlank();
    await fillPrice('-1', { materialNumber: 'MAT-ZERO' });
    await create().getByRole('button', { name: 'Check', exact: true }).click();
  });

  await refused('an end before the start', /before the start/, async () => {
    await openBlank();
    await fillPrice('10', { materialNumber: 'MAT-ZERO', validFrom: '2026-12-31', validTo: '2026-01-01' });
    await create().getByRole('button', { name: 'Check', exact: true }).click();
  });

  await refused('a missing conversion', /no conversion/, async () => {
    await openBlank();
    await fillPrice('10', { materialNumber: 'MAT-BOX', orderUnit: 'BOX' });
    await create().getByRole('button', { name: 'Check', exact: true }).click();
  });

  await refused('a company code', /not a field of the info record/, async () => {
    await openBlank();
    await fillPrice('10', { materialNumber: 'MAT-ZERO' });
    await page.evaluate(() => {
      const form = document.querySelector('section[aria-labelledby="info-record-create"] form');
      if (!form) throw new Error('the create form is not on the page');
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'companyCode';
      hidden.value = '1000';
      form.appendChild(hidden);
      (form.querySelector('[data-info-record-check]') as HTMLButtonElement).click();
    });
  });

  await openBlank();
  await fillPrice('0', { materialNumber: 'MAT-ZERO' });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const zeroNotice = result().filter({ hasText: /Info record IR-\d{7} stands/ });
  await zeroNotice.waitFor();
  const zero = (await zeroNotice.innerText()).match(/IR-\d{7}/)?.[0] ?? '';
  await page.goto(`${base}${ROUTE}?record=${zero}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-info-record-price]').filter({ hasText: '0.0000' }).waitFor();
  console.log(`  ✓ zero is a price on ${zero}`);

  async function saveOrder(material: string, quantity: string, price?: string) {
    await page.goto(`${base}${ORDERS}`, { waitUntil: 'domcontentloaded' });
    const form = page.locator('section[aria-labelledby="po-create"]');
    await form.locator('label').filter({ hasText: 'Supplier' }).locator('input').fill('V-IR');
    const headerSelects = form.locator('form > div select');
    await headerSelects.nth(0).selectOption('1000');
    await headerSelects.nth(1).evaluate((el) => {
      const select = el as unknown as { options: ArrayLike<{ value: string }>; value: string; dispatchEvent: (event: Event) => void };
      select.value = select.options[1].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await headerSelects.nth(2).selectOption('1000');
    const row = form.locator('tbody tr').first();
    const inputs = row.locator('input');
    await inputs.nth(0).fill(material);
    await inputs.nth(1).fill('Info material');
    await inputs.nth(2).fill(quantity);
    await inputs.nth(3).fill('PC');
    if (price !== undefined) await inputs.nth(4).fill(price);
    await row.locator('select').nth(0).selectOption('1000');
    const panel = form.locator('fieldset').first();
    await panel.locator('input[type="date"]').fill('2026-11-15');
    await panel.locator('input[placeholder="Scheduled quantity"]').fill(quantity);
    await form.getByRole('button', { name: 'Save purchase order', exact: true }).click();
    const confirmation = form.getByText(/Purchase order POF-\d+ created\./);
    await confirmation.waitFor();
    return (await confirmation.textContent())?.match(/POF-\d+/)?.[0] ?? '';
  }

  const taken = await saveOrder('MAT-IR', '1');
  assert.match(await page.locator('section[aria-labelledby="po-create"]').innerText(), /below the info record minimum/);
  const takenRow = await withTenant(client, (tx) => tx.execute(sql`
    select net_price, info_record_number, price_sequence, document_date::text as document_date
      from purchase_order_item i
      join purchase_order o on o.client = i.client and o.order_number = i.order_number
     where i.client = ${client} and i.order_number = ${taken}
  `)) as unknown as Array<{ net_price: string; info_record_number: string; price_sequence: number; document_date: string }>;
  assert.equal(takenRow[0].net_price, '10.00');
  assert.equal(takenRow[0].info_record_number, number);
  assert.equal(takenRow[0].price_sequence, 1);
  console.log(`  ✓ ${taken} took ${number} because no price was typed`);

  const typed = await saveOrder('MAT-IR', '4', '99');
  assert.match(await page.locator('section[aria-labelledby="po-create"]').innerText(), /keeps the price that was typed/);
  const typedRow = await withTenant(client, (tx) => tx.execute(sql`
    select net_price, info_record_number from purchase_order_item
     where client = ${client} and order_number = ${typed}
  `)) as unknown as Array<{ net_price: string; info_record_number: string }>;
  assert.equal(typedRow[0].net_price, '99.00');
  assert.equal(typedRow[0].info_record_number, number);
  console.log(`  ✓ ${typed} kept 99, and the reference was stored because a record qualified`);

  const missing = await saveOrder('MAT-MISS', '2', '5');
  const missingRow = await withTenant(client, (tx) => tx.execute(sql`
    select net_price, info_record_number from purchase_order_item
     where client = ${client} and order_number = ${missing}
  `)) as unknown as Array<{ net_price: string; info_record_number: string | null }>;
  assert.equal(missingRow[0].net_price, '5.00');
  assert.equal(missingRow[0].info_record_number, null);
  console.log(`  ✓ ${missing} kept a typed price with no record`);

  await page.goto(`${base}${ROUTE}?record=${number}`, { waitUntil: 'domcontentloaded' });
  const segment = page.locator('[data-info-record-segment="1"]');
  const change = segment.locator('form').filter({ has: page.getByRole('button', { name: 'Save change', exact: true }) });
  await change.locator('input[name="amount"]').fill('25');
  await change.locator('input[name="currency"]').fill('KWD');
  await change.locator('input[name="priceUnitOfMeasure"]').fill('PC');
  await change.locator('input[name="validFrom"]').fill(takenRow[0].document_date);
  await change.locator('input[name="validTo"]').fill(TO);
  await change.locator('input[name="reason"]').fill('Price moves');
  await change.getByRole('button', { name: 'Save change', exact: true }).click();
  await result().filter({ hasText: /stands at version/ }).waitFor();
  const again = await withTenant(client, (tx) => tx.execute(sql`
    select net_price, price_sequence from purchase_order_item
     where client = ${client} and order_number = ${taken}
  `)) as unknown as Array<{ net_price: string; price_sequence: number }>;
  assert.equal(again[0].net_price, '10.00');
  assert.equal(again[0].price_sequence, 1);
  console.log('  ✓ a later price left the order snapshot untouched');

  await page.goto(`${base}${ROUTE}?record=${number}`, { waitUntil: 'domcontentloaded' });
  const beforeOverlap = await tallies();
  const spanning = page.locator('[data-info-record-segment="1"] form').filter({ has: page.getByRole('button', { name: 'Save change', exact: true }) });
  await spanning.locator('input[name="amount"]').fill('99');
  await spanning.locator('select[name="currency"]').selectOption('KWD');
  await spanning.locator('input[name="priceUnitOfMeasure"]').fill('PC');
  await spanning.locator('input[name="validFrom"]').fill('2026-01-01');
  await spanning.locator('input[name="validTo"]').fill('2099-06-01');
  await spanning.locator('input[name="reason"]').fill('Spans both');
  await spanning.getByRole('button', { name: 'Save change', exact: true }).click();
  await result().filter({ hasText: /overlaps/ }).waitFor();
  assert.equal((await tallies()).records, beforeOverlap.records);
  console.log('  ✓ an overlap was refused, and the record was not rewritten');

  await page.goto(`${base}${ROUTE}?record=${number}`, { waitUntil: 'domcontentloaded' });
  await fillPrice('20', { plant: '1000', validFrom: takenRow[0].document_date });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  await result().filter({ hasText: /segment 2/ }).waitFor();
  await page.goto(`${base}${ROUTE}?record=${number}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-info-record-segment="2"]').waitFor();
  const plantForm = page.locator('[data-info-record-segment="2"] form').filter({ has: page.getByRole('button', { name: 'Deactivate segment', exact: true }) });
  await plantForm.locator('input[name="reason"]').fill('Plant retired');
  await plantForm.getByRole('button', { name: 'Deactivate segment', exact: true }).click();
  await result().filter({ hasText: /stands at version/ }).waitFor();
  console.log('  ✓ a plant segment stands on the same number, and was retired');

  const blocked = await saveOrder('MAT-IR', '3', '8');
  assert.match(await page.locator('section[aria-labelledby="po-create"]').innerText(), /not used in its place/);
  const blockedRow = await withTenant(client, (tx) => tx.execute(sql`
    select net_price, info_record_number from purchase_order_item
     where client = ${client} and order_number = ${blocked}
  `)) as unknown as Array<{ net_price: string; info_record_number: string | null }>;
  assert.equal(blockedRow[0].net_price, '8.00');
  assert.equal(blockedRow[0].info_record_number, null);
  console.log('  ✓ an inactive plant segment did not fall through');

  const raced = await Promise.allSettled([
    createPurchasingInfoRecord({
      client, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-CC', purchasingOrg: '1000',
      price: { amount: 4, currency: 'KWD', priceUnit: 1, priceUnitOfMeasure: 'PC', validFrom: FROM, validTo: TO },
    }),
    createPurchasingInfoRecord({
      client, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-CC', purchasingOrg: '1000',
      price: { amount: 4, currency: 'KWD', priceUnit: 1, priceUnitOfMeasure: 'PC', validFrom: FROM, validTo: TO },
    }),
  ]);
  assert.equal(raced.filter((row) => row.status === 'fulfilled').length, 1);
  const raceRows = await withTenant(client, (tx) => tx.execute(sql`
    select count(*)::int as n from purchasing_info_record
     where client = ${client} and material_number = 'MAT-CC'
  `)) as unknown as Array<{ n: number }>;
  assert.equal(raceRows[0].n, 1);
  const end = await tallies();
  assert.equal(end.journals, beforeCheck.journals);
  assert.equal(end.movements, beforeCheck.movements);
  assert.equal(end.requisition, beforeCheck.requisition);
  console.log('  ✓ two concurrent creates left one record, and the requisition is unchanged');
}
