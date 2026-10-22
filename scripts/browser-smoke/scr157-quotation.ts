import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { createRequestForQuotation } from '../../src/modules/purchasing/rfq';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/quotation';
const ACTOR = 'browser.admin';
const RFQ_DATE = '2026-10-22';
const DEADLINE = '2026-12-31';
const ASKED_DELIVERY = '2026-12-01';
const OFFERED_DELIVERY = '2026-12-20';

/**
 * SCR-157 browser acceptance (T856) — a quotation prices one request.
 *
 * The production build is the screen under test. A check writes nothing,
 * including the number. One quotation stands for one request. The other
 * request of the same event has none. The request's copy and the event's
 * lines stay as asked. The price per one unit is shown and is not stored.
 * Rollback, the tenant boundary and the audit delta stay in the service tests.
 */
export async function scr157Quotation(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-157: a quotation prices one request, and it does not buy');

  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'QUOTATION', subObject: '*', prefix: 'QT', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into unit_of_measure (code, name)
      values ('CS', 'Case')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values
        (${client}, 'V-QT', 'ORGANIZATION', 'Quoted supplier', 'CREATED', ${ACTOR}),
        (${client}, 'V-QT2', 'ORGANIZATION', 'Other supplier', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values
        (${client}, 'V-QT', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-QT2', 'SUPPLIER', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, purchasing_org, created_by)
      values (${client}, '001', 'Buyer', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org
        (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
      values
        (${client}, 'V-QT', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR}),
        (${client}, 'V-QT2', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-QT', 'Asked material', t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, procurement_type, created_by)
      values (${client}, 'MAT-QT', '1000', 'BUY', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_requisition_item
        (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, created_by)
      values (${client}, 'PR-QT', 10, 'Stay', 1, 'PC', '2026-10-22', '2026-11-01', '1000', '001', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_order
        (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
      values (${client}, 'PO-QT', 'V-QT', '1000', '001', '1000', 'KWD', '2026-10-21', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_order_item
        (client, order_number, item_number, material_number, short_text, quantity, unit, net_price, net_value, plant, created_by)
      values (${client}, 'PO-QT', 10, 'MAT-QT', 'Stay', 1, 'PC', 1, 1, '1000', ${ACTOR})
    `);
  });

  const header = {
    purchasingOrg: '1000',
    purchasingGroup: '001',
    rfqDate: RFQ_DATE,
    quotationDeadline: DEADLINE,
    collectiveNumber: 'BID-1',
  };
  const lines = [
    { materialNumber: 'MAT-QT', quantity: '12.5', plant: '1000', deliveryDate: ASKED_DELIVERY },
    { materialNumber: 'MAT-QT', quantity: '3', plant: '1000', deliveryDate: '2026-12-15' },
  ];
  const created = await createRequestForQuotation({
    client, changedBy: ACTOR, ...header, suppliers: [{ partnerNumber: 'V-QT' }, { partnerNumber: 'V-QT2' }], lines,
  });
  const late = await createRequestForQuotation({
    client,
    changedBy: ACTOR,
    purchasingOrg: '1000',
    purchasingGroup: '001',
    rfqDate: '2026-01-01',
    quotationDeadline: '2026-10-21',
    suppliers: [{ partnerNumber: 'V-QT' }],
    lines: [lines[0]],
  });
  const request = created.rfqNumbers[0];
  const otherRequest = created.rfqNumbers[1];
  const lateRequest = late.rfqNumbers[0];

  async function tallies() {
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from purchasing_quotation where client = ${client}) as quotations,
        (select count(*)::int from purchasing_quotation where client = ${client} and rfq_number = ${otherRequest}) as other_quotations,
        (select count(*)::int from purchasing_info_record where client = ${client}) as info_records,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from material_document where client = ${client}) as movements,
        (select current_number::int from number_range where client = ${client} and object_code = 'QUOTATION') as drawn,
        (select quantity::text from purchase_requisition_item where client = ${client} and requisition_number = 'PR-QT') as requisition,
        (select supplier_number from purchase_order where client = ${client} and order_number = 'PO-QT') as supplier,
        (select net_price::text from purchase_order_item where client = ${client} and order_number = 'PO-QT') as ordered_price,
        (select quantity::text from purchasing_rfq_event_item where client = ${client} and event_number = ${created.eventNumber} and item_number = 10) as asked,
        (select quantity::text from purchasing_rfq_item where client = ${client} and rfq_number = ${request} and item_number = 10) as copy,
        (select quantity::text from purchasing_rfq_item where client = ${client} and rfq_number = ${otherRequest} and item_number = 10) as other_copy
    `)) as unknown as Array<{
      quotations: number;
      other_quotations: number;
      info_records: number;
      journals: number;
      movements: number;
      drawn: number;
      requisition: string;
      supplier: string;
      ordered_price: string;
      asked: string;
      copy: string;
      other_copy: string;
    }>;
    return row;
  }

  const form = () => page.locator('form').filter({ has: page.locator('[name="rfqNumber"]') });
  const result = () => page.locator('[data-quotation-result]');

  async function openRequest(number: string) {
    await page.goto(`${base}${ROUTE}?request=${number}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-quotation-identity]').waitFor();
    assert.match(await page.locator('[data-quotation-identity]').innerText(), new RegExp(number));
  }

  async function dismissSuggestions() {
    await page.getByRole('heading', { level: 1, name: 'Quotation', exact: true }).click();
  }

  async function fillOffer(values: { quantity?: string; unit?: string; price?: string; priceUnit?: string; delivery?: string }) {
    const offer = form();
    if (values.quantity !== undefined) await offer.locator('[name="line0Quantity"]').fill(values.quantity);
    if (values.unit !== undefined) await offer.locator('[name="line0Unit"]').fill(values.unit);
    if (values.price !== undefined) await offer.locator('[name="line0NetPrice"]').fill(values.price);
    if (values.priceUnit !== undefined) await offer.locator('[name="line0PriceUnit"]').fill(values.priceUnit);
    if (values.delivery !== undefined) await offer.locator('[name="line0Delivery"]').fill(values.delivery);
    await dismissSuggestions();
  }

  async function refused(label: string, message: RegExp, prepare: () => Promise<void>) {
    const before = await tallies();
    await prepare();
    await result().filter({ hasText: message }).waitFor();
    assert.deepEqual(await tallies(), before, `${label} wrote something`);
    console.log(`  ✓ ${label} was refused, and nothing was written`);
  }

  await page.locator('#command-input').fill('ME47');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/quotation$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Quotation', exact: true }).waitFor();
  assert.equal(await page.locator('[name="price"]').count(), 0);
  assert.equal(await page.locator('[name="status"]').count(), 0);
  assert.equal(await page.locator('[name="currency"]').count(), 0);
  assert.equal(await page.locator('[name="revision"]').count(), 0);
  assert.equal(await page.locator('[name="award"]').count(), 0);
  assert.equal(await page.locator('[name="rejection"]').count(), 0);
  assert.equal(await page.locator('[name="condition"]').count(), 0);
  assert.match(await page.locator('[data-quotation-no-comparison]').innerText(), /does not compare/);
  console.log('  ✓ ME47 opens the one screen, and a price, a status, a currency, a revision, an award, a rejection and a condition are not fields');

  await page.locator('[name="request"]').fill(request);
  await dismissSuggestions();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('[data-quotation-identity]').waitFor();
  assert.match(await page.locator('[data-quotation-identity]').innerText(), /V-QT/);
  assert.match(await page.locator('[data-quotation-identity]').innerText(), /KWD/);
  console.log(`  ✓ ${request} opens the asked lines, and the supplier and the currency are the request's`);

  const beforeCheck = await tallies();
  await fillOffer({ quantity: '8', price: '250', priceUnit: '100', delivery: OFFERED_DELIVERY });
  await page.locator('[data-quotation-check]').click();
  await page.locator('[data-quotation-number-not-drawn]').waitFor();
  assert.match(await result().innerText(), /Nothing has been written/);
  assert.equal(await page.locator('[data-quotation-per-unit="10"]').innerText(), '2.5000');
  assert.match(await page.locator('[data-quotation-preview]').innerText(), /2026-12-01/);
  assert.match(await page.locator('[data-quotation-preview]').innerText(), new RegExp(OFFERED_DELIVERY));
  assert.match(await page.locator('[data-quotation-unquoted]').innerText(), /Item 20 has no offer/);
  assert.match(await page.locator('[data-quotation-currency]').innerText(), /KWD/);
  assert.deepEqual(await tallies(), beforeCheck);
  console.log('  ✓ a price unit of 100 showed 2.5000, and the check wrote nothing, including the number');

  await openRequest(request);
  await fillOffer({ quantity: '8', price: '0', priceUnit: '100', delivery: OFFERED_DELIVERY });
  await page.locator('[data-quotation-save]').click();
  await result().filter({ hasText: /Quotation QT-\d{7} stands/ }).waitFor();
  const savedText = await result().filter({ hasText: /Quotation QT-/ }).innerText();
  const quotationNumber = savedText.match(/QT-\d{7}/)?.[0];
  assert.ok(quotationNumber, 'a quotation number was drawn');
  const afterSave = await tallies();
  assert.equal(afterSave.quotations, beforeCheck.quotations + 1);
  assert.equal(afterSave.other_quotations, 0);
  assert.equal(afterSave.drawn, beforeCheck.drawn + 1);
  assert.equal(afterSave.asked, '12.500');
  assert.equal(afterSave.copy, '12.500');
  assert.equal(afterSave.other_copy, '12.500');
  assert.equal(afterSave.journals, beforeCheck.journals);
  assert.equal(afterSave.movements, beforeCheck.movements);
  assert.equal(afterSave.info_records, beforeCheck.info_records);
  const stored = await withTenant(client, (tx) => tx.execute(sql`
    select i.net_price::text, i.price_unit::text, i.quantity::text, i.unit, i.delivery_date::text, i.remark
      from purchasing_quotation_item i
     where i.client = ${client} and i.quotation_number = ${quotationNumber}
  `)) as unknown as Array<{ net_price: string; price_unit: string; quantity: string; unit: string; delivery_date: string; remark: string | null }>;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].net_price, '0.0000');
  assert.equal(stored[0].price_unit, '100');
  assert.equal(stored[0].quantity, '8.000');
  assert.equal(stored[0].unit, 'PC');
  assert.equal(stored[0].delivery_date, OFFERED_DELIVERY);
  assert.equal(stored[0].remark, null);
  assert.notEqual(stored[0].net_price, '2.5000');
  console.log(`  ✓ ${quotationNumber} stands at a zero price, the other request has none, and 2.5000 was not stored`);

  await refused('a second quotation for the same request', /already stands/, async () => {
    await openRequest(request);
    await page.locator('[name="expectedChangedAt"]').evaluate((el) => el.remove());
    await page.locator('[name="quotationNumber"]').evaluate((el) => el.remove());
    await page.locator('[data-quotation-save]').click();
  });
  await refused('an unknown request', /does not stand/, async () => {
    await openRequest(request);
    await form().locator('[name="rfqNumber"]').evaluate((el) => { (el as HTMLInputElement).value = 'NO-RQ'; });
    await page.locator('[data-quotation-save]').click();
  });
  await refused('a supplier that is not the request\'s', /not the request's supplier/, async () => {
    await openRequest(request);
    await form().evaluate((node) => {
      const input = document.createElement('input');
      input.name = 'partnerNumber';
      input.value = 'V-OTHER';
      node.appendChild(input);
    });
    await page.locator('[name="reason"]').fill('Wrong supplier');
    await page.locator('[data-quotation-save]').click();
  });
  await refused('an item that is not on the request', /not on the request/, async () => {
    await openRequest(request);
    await form().locator('[name="line0Item"]').evaluate((el) => { (el as HTMLInputElement).value = '99'; });
    await page.locator('[name="reason"]').fill('Wrong item');
    await page.locator('[data-quotation-save]').click();
  });
  await refused('a currency that is not the company\'s', /not a field on the quotation/, async () => {
    await openRequest(request);
    await form().evaluate((node) => {
      const input = document.createElement('input');
      input.name = 'currency';
      input.value = 'USD';
      node.appendChild(input);
    });
    await page.locator('[name="reason"]').fill('Wrong currency');
    await page.locator('[data-quotation-save]').click();
  });
  await refused('a day after the deadline', /after the quotation deadline/, async () => {
    await openRequest(lateRequest);
    await fillOffer({ quantity: '8', price: '1', priceUnit: '1', delivery: OFFERED_DELIVERY });
    await page.locator('[data-quotation-save]').click();
  });
  await refused('a stale screen', /stands as of/, async () => {
    await openRequest(request);
    await form().locator('[name="expectedChangedAt"]').evaluate((el) => { (el as HTMLInputElement).value = '2000-01-01T00:00:00.000Z'; });
    await form().locator('[name="line0Quantity"]').fill('9');
    await page.locator('[name="reason"]').fill('Stale screen');
    await page.locator('[data-quotation-save]').click();
  });
  await refused('a missing price', /A price is required/, async () => {
    await openRequest(request);
    await form().locator('[name="line0NetPrice"]').fill('');
    await page.locator('[name="reason"]').fill('Missing price');
    await page.locator('[data-quotation-save]').click();
  });
  await refused('a negative price', /must not be negative/, async () => {
    await openRequest(request);
    await form().locator('[name="line0NetPrice"]').fill('-1');
    await page.locator('[name="reason"]').fill('Negative price');
    await page.locator('[data-quotation-save]').click();
  });
  await refused('a zero quantity', /greater than zero/, async () => {
    await openRequest(request);
    await form().locator('[name="line0Quantity"]').fill('0');
    await page.locator('[name="reason"]').fill('Zero quantity');
    await page.locator('[data-quotation-save]').click();
  });
  await refused('a negative quantity', /greater than zero/, async () => {
    await openRequest(request);
    await form().locator('[name="line0Quantity"]').fill('-1');
    await page.locator('[name="reason"]').fill('Negative quantity');
    await page.locator('[data-quotation-save]').click();
  });
  await refused('a zero price unit', /positive integer/, async () => {
    await openRequest(request);
    await form().locator('[name="line0PriceUnit"]').fill('0');
    await page.locator('[name="reason"]').fill('Zero price unit');
    await page.locator('[data-quotation-save]').click();
  });
  await refused('an unknown unit', /not a standing unit/, async () => {
    await openRequest(request);
    await form().locator('[name="line0Unit"]').fill('ZZ');
    await page.locator('[name="reason"]').fill('Unknown unit');
    await dismissSuggestions();
    await page.locator('[data-quotation-save]').click();
  });
  await refused('an alternate unit with no conversion', /no conversion/, async () => {
    await openRequest(request);
    await form().locator('[name="line0Unit"]').fill('CS');
    await page.locator('[name="reason"]').fill('No conversion');
    await dismissSuggestions();
    await page.locator('[data-quotation-save]').click();
  });

  const columns = await withTenant(client, (tx) => tx.execute(sql`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public'
       and (
         (table_name = 'purchasing_quotation_item' and column_name in ('price_per_unit', 'currency'))
         or (table_name = 'purchasing_quotation' and column_name in ('partner_number', 'currency', 'status'))
         or (table_name in ('purchasing_rfq', 'purchase_order', 'purchase_requisition_item', 'purchasing_info_record') and column_name = 'quotation_number')
       )
  `)) as unknown as Array<{ table_name: string; column_name: string }>;
  assert.equal(columns.length, 0);
  const end = await tallies();
  assert.equal(end.quotations, 1);
  assert.equal(end.other_quotations, 0);
  assert.equal(end.drawn, beforeCheck.drawn + 1);
  assert.equal(end.journals, beforeCheck.journals);
  assert.equal(end.movements, beforeCheck.movements);
  assert.equal(end.info_records, beforeCheck.info_records);
  assert.equal(end.requisition, '1.000');
  assert.equal(end.supplier, 'V-QT');
  assert.equal(end.ordered_price, '1.00');
  assert.equal(end.asked, '12.500');
  assert.equal(end.copy, '12.500');
  assert.equal(end.other_copy, '12.500');
  const lateCount = await withTenant(client, (tx) => tx.execute(sql`
    select count(*)::int as n from purchasing_quotation where client = ${client} and rfq_number = ${lateRequest}
  `)) as unknown as Array<{ n: number }>;
  assert.equal(lateCount[0].n, 0);
  console.log('  ✓ the order, the requisition and the info record were unchanged, and no journal or material document was written');
}
