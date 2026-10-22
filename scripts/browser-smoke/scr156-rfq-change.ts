import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { createRequestForQuotation } from '../../src/modules/purchasing/rfq';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/rfq';
const ACTOR = 'browser.admin';
const RFQ_DATE = '2026-10-22';
const DEADLINE = '2026-11-05';
const DELIVERY = '2026-12-01';

/**
 * SCR-156 browser acceptance (T855) — a change of one request.
 *
 * The production build is the screen under test. A check writes nothing,
 * including the change document. A line change rewrites that request's copy.
 * A header change is the event's. The other copy and the other event stay.
 * Rollback, the tenant boundary and the audit delta stay in the service tests.
 */
export async function scr156RfqChange(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-156: a change of one request, and the other copy stays');

  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into unit_of_measure (code, name)
      values ('CS', 'Case')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values
        (${client}, 'V-RFQ', 'ORGANIZATION', 'Asked supplier', 'CREATED', ${ACTOR}),
        (${client}, 'V-RFQ2', 'ORGANIZATION', 'Other supplier', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values
        (${client}, 'V-RFQ', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-RFQ2', 'SUPPLIER', ${ACTOR})
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
        (${client}, 'V-RFQ', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR}),
        (${client}, 'V-RFQ2', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-RFQ', 'Asked material', t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, procurement_type, created_by)
      values (${client}, 'MAT-RFQ', '1000', 'BUY', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into company_code
        (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant, currency, country, created_by)
      select ${client}, '2000', 'Other company', chart_of_accounts, fiscal_year_variant, posting_period_variant, currency, country, ${ACTOR}
        from company_code
       where client = ${client} and company_code = '1000'
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values
        (${client}, '2000', 'Unassigned plant', '1000', 'KW', ${ACTOR}),
        (${client}, '3000', 'Other company plant', '2000', 'KW', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org_plant (client, purchasing_org, plant, created_by)
      values (${client}, '1000', '3000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_requisition_item
        (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, created_by)
      values (${client}, 'PR-RFQ', 10, 'Stay', 1, 'PC', '2026-10-21', '2026-11-01', '1000', '001', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_order
        (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
      values (${client}, 'PO-RFQ', 'V-RFQ', '1000', '001', '1000', 'KWD', '2026-10-21', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_order_item
        (client, order_number, item_number, material_number, short_text, quantity, unit, net_price, net_value, plant, created_by)
      values (${client}, 'PO-RFQ', 10, 'MAT-RFQ', 'Stay', 1, 'PC', 1, 1, '1000', ${ACTOR})
    `);
  });

  const header = {
    purchasingOrg: '1000',
    purchasingGroup: '001',
    rfqDate: RFQ_DATE,
    quotationDeadline: DEADLINE,
    collectiveNumber: 'BID-1',
  };
  const lines = [{ materialNumber: 'MAT-RFQ', quantity: '12.5', plant: '1000', deliveryDate: DELIVERY }];
  const first = await createRequestForQuotation({
    client, changedBy: ACTOR, ...header, suppliers: [{ partnerNumber: 'V-RFQ' }, { partnerNumber: 'V-RFQ2' }], lines,
  });
  const second = await createRequestForQuotation({
    client, changedBy: ACTOR, ...header, suppliers: [{ partnerNumber: 'V-RFQ' }], lines,
  });
  const request = first.rfqNumbers[0];
  const otherRequest = first.rfqNumbers[1];

  async function tallies() {
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from change_document where client = ${client} and change_type = 'CHANGE') as changes,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from material_document where client = ${client}) as movements,
        (select quantity::text from purchase_requisition_item where client = ${client} and requisition_number = 'PR-RFQ') as requisition,
        (select supplier_number from purchase_order where client = ${client} and order_number = 'PO-RFQ') as supplier,
        (select quantity::text from purchase_order_item where client = ${client} and order_number = 'PO-RFQ') as ordered,
        (select quantity::text from purchasing_rfq_event_item where client = ${client} and event_number = ${first.eventNumber}) as asked,
        (select quantity::text from purchasing_rfq_item where client = ${client} and rfq_number = ${request}) as copy,
        (select quantity::text from purchasing_rfq_item where client = ${client} and rfq_number = ${otherRequest}) as other_copy,
        (select collective_number from purchasing_rfq_event where client = ${client} and event_number = ${second.eventNumber}) as other_event
    `)) as unknown as Array<{
      changes: number;
      journals: number;
      movements: number;
      requisition: string;
      supplier: string;
      ordered: string;
      asked: string;
      copy: string;
      other_copy: string;
      other_event: string;
    }>;
    return row;
  }

  const change = () => page.locator('[data-rfq-change]');
  const result = () => change().locator('[data-rfq-change-result]');

  async function openRequest(number: string) {
    await page.goto(`${base}${ROUTE}?event=${number}`, { waitUntil: 'domcontentloaded' });
    await page.locator(`[data-rfq-selected="${number}"]`).waitFor();
  }

  async function dismissSuggestions() {
    await change().getByRole('heading', { name: 'Change a request', exact: true }).click();
  }

  async function fillLines(quantity: string, delivery = '2026-12-15') {
    const form = change().locator('form');
    await form.locator('[name="line0Quantity"]').fill(quantity);
    await form.locator('[name="line0Delivery"]').fill(delivery);
    await form.locator('[name="reason"]').fill('Revised quantity and delivery');
    await dismissSuggestions();
  }

  async function refused(label: string, message: RegExp, prepare: () => Promise<void>) {
    const before = await tallies();
    await prepare();
    await result().filter({ hasText: message }).waitFor();
    assert.deepEqual(await tallies(), before, `${label} wrote something`);
    console.log(`  ✓ ${label} was refused, and nothing was written`);
  }

  await page.locator('#command-input').fill('ME42');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/rfq$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Request for quotation', exact: true }).waitFor();
  assert.equal(await page.locator('[name="price"]').count(), 0);
  assert.equal(await page.locator('[name="status"]').count(), 0);
  assert.equal(await page.locator('[name="deliveryChannel"]').count(), 0);
  assert.equal(await page.locator('[name="currency"]').count(), 0);
  assert.equal(await page.locator('[name="revision"]').count(), 0);
  assert.equal(await page.locator('[name="notification"]').count(), 0);
  console.log('  ✓ ME42 opens the one screen, and a price, a status, a channel, a currency, a revision and a notification are not fields');

  await page.locator('[name="event"]').fill(request);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator(`[data-rfq-selected="${request}"]`).waitFor();
  console.log(`  ✓ ${request} opens its event and selects that request`);

  const beforeCheck = await tallies();
  await fillLines('20');
  await change().locator('[data-rfq-change-check]').click();
  await page.locator('[data-rfq-change-preview]').waitFor();
  assert.match(await result().innerText(), /Nothing has been written/);
  assert.equal(await page.locator('[data-rfq-header-shared]').count(), 0);
  assert.match(await page.locator('[data-rfq-change-diff]').innerText(), /12\.500/);
  assert.match(await page.locator('[data-rfq-change-diff]').innerText(), /20\.000/);
  assert.deepEqual(await tallies(), beforeCheck);
  console.log('  ✓ a check wrote nothing, including the change document');

  await openRequest(request);
  await fillLines('20');
  await change().locator('[data-rfq-change-save]').click();
  await result().filter({ hasText: new RegExp(`Request ${request} stands`) }).waitFor();
  const afterLines = await tallies();
  assert.equal(afterLines.copy, '20.000');
  assert.equal(afterLines.other_copy, '12.500');
  assert.equal(afterLines.asked, '12.500');
  assert.equal(afterLines.changes, beforeCheck.changes + 1);
  assert.equal(afterLines.journals, beforeCheck.journals);
  assert.equal(afterLines.movements, beforeCheck.movements);
  console.log('  ✓ the copy changed, and the other copy and the event lines stayed');

  await openRequest(request);
  const form = change().locator('form');
  await form.locator('[name="quotationDeadline"]').fill('2026-11-20');
  await form.locator('[name="collectiveNumber"]').fill('BID-2');
  await form.locator('[name="reason"]').fill('Extended the deadline');
  await dismissSuggestions();
  await change().locator('[data-rfq-change-check]').click();
  await page.locator('[data-rfq-header-shared]').waitFor();
  assert.match(await result().innerText(), /The header is the event's/);
  assert.match(await page.locator('[data-rfq-change-preview]').innerText(), /Nothing has been written/);
  assert.equal((await tallies()).changes, afterLines.changes);
  console.log('  ✓ the check said the header is the event\'s, and wrote nothing');

  await openRequest(request);
  await change().locator('[name="quotationDeadline"]').fill('2026-11-20');
  await change().locator('[name="collectiveNumber"]').fill('BID-2');
  await change().locator('[name="reason"]').fill('Extended the deadline');
  await dismissSuggestions();
  await change().locator('[data-rfq-change-save]').click();
  await result().filter({ hasText: new RegExp(`Request ${request} stands`) }).waitFor();
  const afterHeader = await tallies();
  assert.equal(afterHeader.other_event, 'BID-1');
  assert.equal(afterHeader.other_copy, '12.500');
  assert.equal(afterHeader.asked, '12.500');
  assert.equal(afterHeader.copy, '20.000');
  const docs = await withTenant(client, (tx) => tx.execute(sql`
    select d.object_class, d.object_key, i.field_name, i.old_value, i.new_value
      from change_document d
      join change_document_item i on i.change_document_id = d.id
     where d.client = ${client} and d.change_type = 'CHANGE'
       and d.object_key in (${request}, ${first.eventNumber})
  `)) as unknown as Array<{ object_class: string; object_key: string; field_name: string; old_value: string; new_value: string }>;
  assert.equal(docs.find((row) => row.object_class === 'purchasing_rfq' && row.field_name === 'line10.quantity')?.old_value, '12.500');
  assert.equal(docs.find((row) => row.object_class === 'purchasing_rfq' && row.field_name === 'line10.quantity')?.new_value, '20.000');
  assert.equal(docs.find((row) => row.object_class === 'purchasing_rfq' && row.field_name === 'line10.deliveryDate')?.old_value, DELIVERY);
  assert.equal(docs.find((row) => row.object_class === 'purchasing_rfq' && row.field_name === 'line10.deliveryDate')?.new_value, '2026-12-15');
  assert.equal(docs.find((row) => row.object_class === 'purchasing_rfq_event' && row.field_name === 'quotationDeadline')?.old_value, '2026-11-05');
  assert.equal(docs.find((row) => row.object_class === 'purchasing_rfq_event' && row.field_name === 'quotationDeadline')?.new_value, '2026-11-20');
  assert.equal(docs.find((row) => row.object_key === first.eventNumber && row.field_name === 'collectiveNumber')?.old_value, 'BID-1');
  assert.equal(docs.find((row) => row.object_key === first.eventNumber && row.field_name === 'collectiveNumber')?.new_value, 'BID-2');
  assert.equal(docs.some((row) => row.object_class === 'purchasing_rfq_event' && row.field_name === 'line10.quantity'), false);
  const copies = await withTenant(client, (tx) => tx.execute(sql`
    select 'event' as kind, quantity::text, delivery_date::text, short_text
      from purchasing_rfq_event_item where client = ${client} and event_number = ${first.eventNumber}
    union all
    select 'other', quantity::text, delivery_date::text, short_text
      from purchasing_rfq_item where client = ${client} and rfq_number = ${otherRequest}
    union all
    select 'copy', quantity::text, delivery_date::text, short_text
      from purchasing_rfq_item where client = ${client} and rfq_number = ${request}
  `)) as unknown as Array<{ kind: string; quantity: string; delivery_date: string; short_text: string }>;
  const asked = copies.find((row) => row.kind === 'event');
  const left = copies.find((row) => row.kind === 'other');
  const changedCopy = copies.find((row) => row.kind === 'copy');
  assert.equal(asked?.quantity, '12.500');
  assert.equal(asked?.delivery_date, DELIVERY);
  assert.equal(asked?.short_text, 'Asked material');
  assert.equal(left?.quantity, '12.500');
  assert.equal(left?.delivery_date, DELIVERY);
  assert.equal(left?.short_text, 'Asked material');
  assert.equal(changedCopy?.quantity, '20.000');
  assert.equal(changedCopy?.delivery_date, '2026-12-15');
  console.log(`  ✓ ${first.eventNumber} took the header, ${second.eventNumber} kept BID-1, and each document named the old and new values`);

  await refused('an unknown request', /does not stand/, async () => {
    await openRequest(request);
    await change().locator('[name="rfqNumber"]').evaluate((el) => { (el as HTMLInputElement).value = 'NO-RQ'; });
    await change().locator('[name="reason"]').fill('Should be refused');
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('a stale screen', /stands as of/, async () => {
    await openRequest(request);
    await change().locator('[name="expectedEventChangedAt"]').evaluate((el) => { (el as HTMLInputElement).value = ''; });
    await change().locator('[name="line0Quantity"]').fill('21');
    await change().locator('[name="reason"]').fill('Stale screen');
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('a missing reason', /A reason is required/, async () => {
    await openRequest(request);
    await change().locator('[name="line0Quantity"]').fill('21');
    await change().locator('[name="reason"]').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.removeAttribute('required');
      input.removeAttribute('minLength');
      input.value = '';
    });
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('a deadline before the RFQ date', /before the RFQ date/, async () => {
    await openRequest(request);
    await change().locator('[name="quotationDeadline"]').fill('2026-10-01');
    await change().locator('[name="reason"]').fill('Too early');
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('a zero quantity', /greater than zero/, async () => {
    await openRequest(request);
    await change().locator('[name="line0Quantity"]').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.removeAttribute('min');
      input.value = '0';
    });
    await change().locator('[name="reason"]').fill('Zero quantity');
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('a negative quantity', /greater than zero/, async () => {
    await openRequest(request);
    await change().locator('[name="line0Quantity"]').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.removeAttribute('min');
      input.value = '-1';
    });
    await change().locator('[name="reason"]').fill('Negative quantity');
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('an unknown unit', /not a standing unit/, async () => {
    await openRequest(request);
    await change().locator('[name="line0Unit"]').fill('ZZ');
    await change().locator('[name="reason"]').fill('Unknown unit');
    await dismissSuggestions();
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('an alternate unit with no conversion', /no conversion/, async () => {
    await openRequest(request);
    await change().locator('[name="line0Unit"]').fill('CS');
    await change().locator('[name="reason"]').fill('No conversion');
    await dismissSuggestions();
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('an unassigned plant', /not assigned/, async () => {
    await openRequest(request);
    await page.evaluate(() => {
      const select = document.querySelector('[data-rfq-change] [name="line0Plant"]') as HTMLSelectElement;
      const option = document.createElement('option');
      option.value = '2000';
      option.text = '2000';
      select.appendChild(option);
      select.value = '2000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await change().locator('[name="reason"]').fill('Unassigned plant');
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('a plant in another company', /not the event's company/, async () => {
    await openRequest(request);
    await page.evaluate(() => {
      const select = document.querySelector('[data-rfq-change] [name="line0Plant"]') as HTMLSelectElement;
      const option = document.createElement('option');
      option.value = '3000';
      option.text = '3000';
      select.appendChild(option);
      select.value = '3000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await change().locator('[name="reason"]').fill('Other company');
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('a second invitation of the same supplier', /invited twice/, async () => {
    await openRequest(request);
    await page.evaluate(() => {
      const form = document.querySelector('[data-rfq-change] form') as HTMLFormElement;
      for (const [name, value] of [['supplierCount', '2'], ['supplier0Partner', 'V-RFQ'], ['supplier1Partner', 'V-RFQ']]) {
        const input = document.createElement('input');
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
    });
    await change().locator('[name="reason"]').fill('Invited twice');
    await change().locator('[data-rfq-change-save]').click();
  });
  await refused('a new item', /not added/, async () => {
    await openRequest(request);
    await change().locator('[name="line0Item"]').evaluate((el) => { (el as HTMLInputElement).value = '20'; });
    await change().locator('[name="reason"]').fill('New item');
    await change().locator('[data-rfq-change-save]').click();
  });

  const columns = await withTenant(client, (tx) => tx.execute(sql`
    select column_name from information_schema.columns
     where table_schema = 'public'
       and table_name in ('purchase_order', 'purchase_order_item', 'purchase_requisition_item')
       and column_name in ('rfq_number', 'event_number')
  `)) as unknown as Array<{ column_name: string }>;
  assert.equal(columns.length, 0);
  const end = await tallies();
  assert.equal(end.journals, beforeCheck.journals);
  assert.equal(end.movements, beforeCheck.movements);
  assert.equal(end.requisition, '1.000');
  assert.equal(end.supplier, 'V-RFQ');
  assert.equal(end.ordered, '1.000');
  assert.equal(end.asked, '12.500');
  assert.equal(end.other_copy, '12.500');
  assert.equal(end.other_event, 'BID-1');
  console.log('  ✓ the order and the requisition were not rewritten, and no journal or material document was written');
}
