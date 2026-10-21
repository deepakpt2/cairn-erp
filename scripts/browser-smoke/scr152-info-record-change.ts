import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/info-record';
const ORDERS = '/purchasing/orders';
const ACTOR = 'browser.admin';
const FROM = '2020-01-01';
const TO = '2099-12-31';

/**
 * SCR-152 browser acceptance (T851) — a change of the standing info record.
 *
 * The production build is the screen under test. ME12 opens the same route.
 * A check writes nothing. A missing segment is named, not created. T850 is not this script.
 */
export async function scr152InfoRecordChange(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-152: a change of the standing info record, and the order keeps the price it used');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values (${client}, 'V-IR', 'ORGANIZATION', 'Info supplier', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V-IR', 'SUPPLIER', ${ACTOR})
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
      select ${client}, 'MAT-IR', 'Info material', material_type, 'PC', ${ACTOR}
      from material_type where client = ${client} order by material_type limit 1
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, '2000', 'Second plant', '1000', 'KW', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchasing_org_plant (client, purchasing_org, plant, created_by)
      values (${client}, '1000', '2000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, procurement_type, created_by)
      values
        (${client}, 'MAT-IR', '1000', 'BUY', ${ACTOR}),
        (${client}, 'MAT-IR', '2000', 'BUY', ${ACTOR})
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
        (select count(*)::int from purchasing_info_record_org where client = ${client}) as segments,
        (select count(*)::int from purchasing_info_record_price where client = ${client}) as prices,
        (select count(*)::int from change_document where client = ${client} and object_class = 'purchasing_info_record') as audits,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from material_document where client = ${client}) as movements,
        (select quantity::text from purchase_requisition_item where client = ${client} and requisition_number = 'PR-IR') as requisition
    `)) as unknown as Array<{
      records: number; segments: number; prices: number; audits: number;
      journals: number; movements: number; requisition: string;
    }>;
    return row;
  }

  const create = () => page.locator('section[aria-labelledby="info-record-create"]');
  const result = () => page.locator('[data-info-record-result]');

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

  async function saveOrder(material: string, quantity: string, plant: string, price?: string) {
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
    await row.locator('select.w-36').selectOption(plant);
    const panel = form.locator('fieldset').first();
    await panel.locator('input[type="date"]').fill('2026-11-15');
    await panel.locator('input[placeholder="Scheduled quantity"]').fill(quantity);
    await form.getByRole('button', { name: 'Save purchase order', exact: true }).click();
    const confirmation = form.getByText(/Purchase order POF-\d+ created\./);
    await confirmation.waitFor();
    return (await confirmation.textContent())?.match(/POF-\d+/)?.[0] ?? '';
  }

  function changeForm() {
    return page.locator('form').filter({ has: page.getByRole('button', { name: 'Save change', exact: true }) });
  }

  async function openRecord(query = '') {
    await page.goto(`${base}${ROUTE}?record=${number}${query}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-info-record-standing]').waitFor();
  }

  await page.locator('#command-input').fill('ME12');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/info-record$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Purchasing info record', exact: true }).waitFor();
  assert.equal(page.url().includes('me12'), false);
  assert.equal(await page.locator('[data-info-record-category="STANDARD"]').count() > 0, true);
  console.log('  ✓ ME12 opens the one screen');

  const beforeCreate = await tallies();
  await fillPrice('10', { plannedDeliveryDays: '7', minimumOrderQuantity: '2', minimumOrderUnit: 'PC' });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const created = result().filter({ hasText: /Info record IR-\d{7} stands/ });
  await created.waitFor();
  const number = (await created.innerText()).match(/IR-\d{7}/)?.[0] ?? '';
  assert.ok(number);
  const afterCreate = await tallies();
  assert.equal(afterCreate.records, beforeCreate.records + 1);
  assert.equal(afterCreate.segments, beforeCreate.segments + 1);
  assert.equal(afterCreate.prices, beforeCreate.prices + 1);
  console.log(`  ✓ ${number} stands`);

  await openRecord('&org=1000&plant=2000');
  await page.locator('[data-info-record-scope-missing]').waitFor();
  assert.match(await page.locator('[data-info-record-scope-missing]').innerText(), /no segment/);
  assert.match(await page.locator('[data-info-record-scope-missing]').innerText(), /does not create/);
  assert.equal(await page.locator('[data-info-record-segment]').count(), 0);
  assert.deepEqual(await tallies(), afterCreate);
  console.log('  ✓ a missing plant segment is named, and not created');

  await openRecord('&org=1000');
  const beforeCheck = await tallies();
  const check = changeForm();
  await check.locator('input[name="plannedDeliveryDays"]').fill('9');
  await check.locator('input[name="minimumOrderQuantity"]').fill('4');
  await check.locator('input[name="reason"]').fill('Lead time only');
  await check.getByRole('button', { name: 'Check change', exact: true }).click();
  const preview = page.locator('[data-info-record-change-preview]');
  await preview.waitFor();
  const previewText = await preview.innerText();
  assert.match(previewText, /Nothing has been written/);
  assert.match(previewText, /Planned delivery days: 7 → 9/);
  assert.match(previewText, /Minimum quantity: 2\.000 → 4\.000/);
  assert.deepEqual(await tallies(), beforeCheck);
  console.log('  ✓ a change check showed the old and proposed values, and wrote nothing');

  await openRecord('&org=1000');
  const lead = changeForm();
  await lead.locator('input[name="plannedDeliveryDays"]').fill('9');
  await lead.locator('input[name="minimumOrderQuantity"]').fill('4');
  await lead.locator('input[name="reason"]').fill('Lead time only');
  await lead.getByRole('button', { name: 'Save change', exact: true }).click();
  await result().filter({ hasText: /stands at version/ }).waitFor();
  const prices = await withTenant(client, (tx) => tx.execute(sql`
    select amount, currency, price_unit, price_unit_of_measure
      from purchasing_info_record_price
     where client = ${client} and info_record_number = ${number}
  `)) as unknown as Array<{ amount: string; currency: string; price_unit: string; price_unit_of_measure: string }>;
  assert.equal(prices.length, 1);
  assert.equal(prices[0].amount, '10.0000');
  assert.equal(prices[0].currency.trim(), 'KWD');
  assert.equal(String(Number(prices[0].price_unit)), '1');
  assert.equal(prices[0].price_unit_of_measure.trim(), 'PC');
  const leadAudit = await withTenant(client, (tx) => tx.execute(sql`
    select i.field_name, i.old_value, i.new_value
      from change_document d
      join change_document_item i on i.change_document_id = d.id
     where d.client = ${client} and d.object_key = ${number} and d.reason = 'Lead time only'
  `)) as unknown as Array<{ field_name: string; old_value: string | null; new_value: string | null }>;
  assert.ok(leadAudit.some((row) => row.field_name === 'plannedDeliveryDays' && row.old_value === '7' && row.new_value === '9'));
  assert.ok(leadAudit.some((row) => row.field_name === 'minimumOrderQuantity' && row.old_value === '2.000' && row.new_value === '4.000'));
  console.log('  ✓ lead time and minimum changed, and the price row was not rewritten');

  const taken = await saveOrder('MAT-IR', '4', '1000');
  const takenRow = await withTenant(client, (tx) => tx.execute(sql`
    select net_price, info_record_number, price_sequence
      from purchase_order_item
     where client = ${client} and order_number = ${taken}
  `)) as unknown as Array<{ net_price: string; info_record_number: string; price_sequence: number }>;
  assert.equal(takenRow[0].net_price, '10.00');
  assert.equal(takenRow[0].info_record_number, number);
  assert.equal(takenRow[0].price_sequence, 1);
  console.log(`  ✓ ${taken} took the standing price`);

  await openRecord('&org=1000');
  const beforePriceCheck = await tallies();
  const priceCheck = changeForm();
  await priceCheck.locator('input[name="amount"]').fill('15');
  await priceCheck.locator('select[name="currency"]').selectOption('KWD');
  await priceCheck.locator('input[name="priceUnitOfMeasure"]').fill('PC');
  await priceCheck.locator('input[name="validFrom"]').fill('2026-06-01');
  await priceCheck.locator('input[name="validTo"]').fill('2026-12-31');
  await priceCheck.locator('input[name="reason"]').fill('Future price');
  await priceCheck.getByRole('button', { name: 'Check change', exact: true }).click();
  await page.locator('[data-info-record-closed-interval]').waitFor();
  assert.match(await page.locator('[data-info-record-closed-interval]').innerText(), /2026-05-31/);
  assert.match(await page.locator('[data-info-record-closed-interval]').innerText(), /2099-12-31/);
  assert.deepEqual(await tallies(), beforePriceCheck);
  console.log('  ✓ a price check named the interval that would close, and wrote nothing');

  async function refuseChange(label: string, message: RegExp, fill: (form: ReturnType<typeof changeForm>) => Promise<void>) {
    await openRecord('&org=1000');
    const before = await tallies();
    const form = changeForm();
    await fill(form);
    await form.locator('input[name="reason"]').fill(label);
    await form.getByRole('button', { name: 'Save change', exact: true }).click();
    await result().filter({ hasText: message }).waitFor();
    assert.deepEqual(await tallies(), before, `${label} wrote something`);
    console.log(`  ✓ ${label} was refused, and nothing was written`);
  }

  await refuseChange('an end before the start', /before the start/, async (form) => {
    await form.locator('input[name="amount"]').fill('15');
    await form.locator('select[name="currency"]').selectOption('KWD');
    await form.locator('input[name="priceUnitOfMeasure"]').fill('PC');
    await form.locator('input[name="validFrom"]').fill('2026-12-31');
    await form.locator('input[name="validTo"]').fill('2026-01-01');
  });
  await refuseChange('a foreign currency', /not converted/, async (form) => {
    await form.locator('input[name="amount"]').fill('15');
    await form.locator('select[name="currency"]').locator('option[value="USD"]').waitFor({ state: 'attached' });
    await form.locator('select[name="currency"]').selectOption('USD');
    await form.locator('input[name="priceUnitOfMeasure"]').fill('PC');
    await form.locator('input[name="validFrom"]').fill('2026-06-01');
    await form.locator('input[name="validTo"]').fill('2026-12-31');
  });
  await refuseChange('a price unit of zero', /positive whole number/, async (form) => {
    await form.locator('input[name="amount"]').fill('15');
    await form.locator('select[name="currency"]').selectOption('KWD');
    await form.locator('input[name="priceUnit"]').fill('0');
    await form.locator('input[name="priceUnitOfMeasure"]').fill('PC');
    await form.locator('input[name="validFrom"]').fill('2026-06-01');
    await form.locator('input[name="validTo"]').fill('2026-12-31');
  });

  await openRecord('&org=1000');
  const price = changeForm();
  await price.locator('input[name="amount"]').fill('15');
  await price.locator('select[name="currency"]').selectOption('KWD');
  await price.locator('input[name="priceUnitOfMeasure"]').fill('PC');
  await price.locator('input[name="validFrom"]').fill('2026-06-01');
  await price.locator('input[name="validTo"]').fill('2026-12-31');
  await price.locator('input[name="reason"]').fill('Future price');
  await price.getByRole('button', { name: 'Save change', exact: true }).click();
  await result().filter({ hasText: /stands at version/ }).waitFor();
  const kept = await withTenant(client, (tx) => tx.execute(sql`
    select price_sequence, amount, valid_to
      from purchasing_info_record_price
     where client = ${client} and info_record_number = ${number}
     order by price_sequence
  `)) as unknown as Array<{ price_sequence: number; amount: string; valid_to: string }>;
  assert.equal(kept[0].amount, '10.0000');
  assert.equal(String(kept[0].valid_to).slice(0, 10), '2026-05-31');
  assert.equal(kept[1].amount, '15.0000');
  const priceAudit = await withTenant(client, (tx) => tx.execute(sql`
    select i.field_name, i.old_value, i.new_value
      from change_document d
      join change_document_item i on i.change_document_id = d.id
     where d.client = ${client} and d.object_key = ${number} and d.reason = 'Future price'
  `)) as unknown as Array<{ field_name: string; old_value: string | null; new_value: string | null }>;
  assert.ok(priceAudit.some((row) => row.field_name === 'amount' && row.new_value === '15.0000'));
  assert.ok(priceAudit.some((row) => row.field_name === 'closedValidTo' && row.old_value === '2099-12-31' && row.new_value === '2026-05-31'));
  console.log('  ✓ the old amount stands, the interval closed, and the document names both');

  const again = await withTenant(client, (tx) => tx.execute(sql`
    select net_price, price_sequence from purchase_order_item
     where client = ${client} and order_number = ${taken}
  `)) as unknown as Array<{ net_price: string; price_sequence: number }>;
  assert.equal(again[0].net_price, '10.00');
  assert.equal(again[0].price_sequence, 1);
  console.log('  ✓ the existing order kept its snapshot');

  const fresh = await saveOrder('MAT-IR', '4', '1000');
  const freshRow = await withTenant(client, (tx) => tx.execute(sql`
    select net_price, info_record_number, price_sequence
      from purchase_order_item
     where client = ${client} and order_number = ${fresh}
  `)) as unknown as Array<{ net_price: string; info_record_number: string; price_sequence: number }>;
  assert.equal(freshRow[0].net_price, '15.00');
  assert.equal(freshRow[0].info_record_number, number);
  assert.equal(freshRow[0].price_sequence, 2);
  console.log(`  ✓ ${fresh} took the new valid price`);

  await openRecord();
  await fillPrice('8', { plant: '1000', plannedDeliveryDays: '5', validFrom: '2026-06-01', validTo: '2026-12-31' });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  await result().filter({ hasText: /segment 2/ }).waitFor();
  await openRecord();
  await fillPrice('6', { plant: '2000', plannedDeliveryDays: '3', validFrom: '2026-06-01', validTo: '2026-12-31' });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  await result().filter({ hasText: /segment 3/ }).waitFor();

  await openRecord('&org=1000&plant=1000');
  const plantChange = changeForm();
  await plantChange.locator('input[name="plannedDeliveryDays"]').fill('6');
  await plantChange.locator('input[name="reason"]').fill('One plant');
  await plantChange.getByRole('button', { name: 'Save change', exact: true }).click();
  await result().filter({ hasText: /stands at version/ }).waitFor();
  const leads = await withTenant(client, (tx) => tx.execute(sql`
    select segment_number, plant, planned_delivery_days
      from purchasing_info_record_org
     where client = ${client} and info_record_number = ${number}
     order by segment_number
  `)) as unknown as Array<{ segment_number: number; plant: string | null; planned_delivery_days: number }>;
  assert.equal(leads.find((row) => row.plant === '1000')?.planned_delivery_days, 6);
  assert.equal(leads.find((row) => row.plant === '2000')?.planned_delivery_days, 3);
  assert.equal(leads.find((row) => row.plant == null)?.planned_delivery_days, 9);
  console.log('  ✓ a change of one plant left the other segment untouched');

  await openRecord('&org=1000&plant=2000');
  const retire = changeForm();
  await retire.locator('input[name="reason"]').fill('Plant retired');
  await retire.getByRole('button', { name: 'Deactivate segment', exact: true }).click();
  await result().filter({ hasText: /stands at version/ }).waitFor();
  const blocked = await saveOrder('MAT-IR', '3', '2000', '8');
  assert.match(await page.locator('section[aria-labelledby="po-create"]').innerText(), /not used in its place/);
  const blockedRow = await withTenant(client, (tx) => tx.execute(sql`
    select net_price, info_record_number from purchase_order_item
     where client = ${client} and order_number = ${blocked}
  `)) as unknown as Array<{ net_price: string; info_record_number: string | null }>;
  assert.equal(blockedRow[0].net_price, '8.00');
  assert.equal(blockedRow[0].info_record_number, null);
  console.log('  ✓ an inactive plant segment was not selected, and the organisation price was not used');

  await openRecord();
  const standingVersion = (await page.locator('[data-info-record-standing]').innerText()).match(/Version (\d+)/)?.[1] ?? '';
  assert.ok(standingVersion);
  const beforeStale = await tallies();
  await page.evaluate(() => {
    const form = document.querySelector('form:has([data-info-record-change])');
    if (!form) throw new Error('the change form is not on the page');
    const version = form.querySelector('input[name="expectedVersion"]') as HTMLInputElement;
    version.value = '1';
    const reason = form.querySelector('input[name="reason"]') as HTMLInputElement;
    reason.value = 'Stale screen';
    (form.querySelector('[data-info-record-change]') as HTMLButtonElement).click();
  });
  await result().filter({ hasText: new RegExp(`stands at version ${standingVersion}`) }).waitFor();
  assert.deepEqual(await tallies(), beforeStale);
  console.log('  ✓ a stale version was refused, and the version that stands was named');

  await openRecord();
  const deactivate = page.locator('form').filter({ has: page.getByRole('button', { name: 'Deactivate record', exact: true }) });
  await deactivate.locator('input[name="reason"]').fill('Record retired');
  await deactivate.getByRole('button', { name: 'Deactivate record', exact: true }).click();
  await result().filter({ hasText: /stands at version/ }).waitFor();
  const absent = await saveOrder('MAT-IR', '2', '1000', '4');
  assert.match(await page.locator('section[aria-labelledby="po-create"]').innerText(), /is inactive/);
  const absentRow = await withTenant(client, (tx) => tx.execute(sql`
    select net_price, info_record_number from purchase_order_item
     where client = ${client} and order_number = ${absent}
  `)) as unknown as Array<{ net_price: string; info_record_number: string | null }>;
  assert.equal(absentRow[0].net_price, '4.00');
  assert.equal(absentRow[0].info_record_number, null);
  console.log('  ✓ a deactivated record was absent from selection');

  const end = await tallies();
  assert.equal(end.journals, beforeCreate.journals);
  assert.equal(end.movements, beforeCreate.movements);
  assert.equal(end.requisition, beforeCreate.requisition);
  console.log('  ✓ no journal, no material document, and the requisition is unchanged');
}
