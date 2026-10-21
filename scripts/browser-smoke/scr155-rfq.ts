import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/rfq';
const ACTOR = 'browser.admin';
const RFQ_DATE = '2026-10-22';
const DEADLINE = '2026-11-05';
const DELIVERY = '2026-12-01';

/**
 * SCR-155 browser acceptance (T854) — a request for quotation asks.
 *
 * The production build is the screen under test. A check writes nothing,
 * including either number. Each supplier receives a separate request, and that
 * request keeps the copy. The order and the requisition are not rewritten.
 * Rollback, the tenant boundary and the audit delta stay in the service tests.
 */
export async function scr155Rfq(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-155: a request for quotation, and the order is not rewritten');

  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into unit_of_measure (code, name)
      values ('BX', 'Box')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values
        (${client}, 'V-RFQ', 'ORGANIZATION', 'Asked supplier', 'CREATED', ${ACTOR}),
        (${client}, 'V-RFQ2', 'ORGANIZATION', 'Other supplier', 'CREATED', ${ACTOR}),
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
        (${client}, 'V-RFQ', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-RFQ2', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-OFF', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-BARE', 'SUPPLIER', ${ACTOR})
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
      select ${client}, m.n, m.d, t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values
        ('MAT-RFQ', 'Asked material'), ('MAT-BARE', 'No plant')
      ) m(n, d)
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, '2000', 'Unassigned plant', '1000', 'KW', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, procurement_type, created_by)
      values (${client}, 'MAT-RFQ', '1000', 'BUY', ${ACTOR})
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

  async function tallies() {
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from purchasing_rfq_event where client = ${client}) as events,
        (select count(*)::int from purchasing_rfq where client = ${client}) as requests,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from material_document where client = ${client}) as movements,
        (select current_number::int from number_range where client = ${client} and object_code = 'RFQEVENT') as events_drawn,
        (select current_number::int from number_range where client = ${client} and object_code = 'RFQ') as requests_drawn,
        (select quantity::text from purchase_requisition_item where client = ${client} and requisition_number = 'PR-RFQ') as requisition,
        (select supplier_number from purchase_order where client = ${client} and order_number = 'PO-RFQ') as supplier,
        (select quantity::text from purchase_order_item where client = ${client} and order_number = 'PO-RFQ') as ordered
    `)) as unknown as Array<{
      events: number;
      requests: number;
      journals: number;
      movements: number;
      events_drawn: number;
      requests_drawn: number;
      requisition: string;
      supplier: string;
      ordered: string;
    }>;
    return row;
  }

  const create = () => page.locator('section[aria-labelledby="rfq-create"]');
  const result = () => create().locator('[data-rfq-result]');

  async function openBlank() {
    await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'Request for quotation', exact: true }).waitFor();
  }

  async function choose(form: ReturnType<typeof create>, name: string, value: string) {
    await form.locator(`[name="${name}"] option[value="${value}"]`).waitFor({ state: 'attached' });
    await form.locator(`[name="${name}"]`).selectOption(value);
  }

  async function dismissSuggestions() {
    // The match list is fixed over the next control. A click outside the field closes it.
    await create().getByRole('heading', { name: 'Create a request', exact: true }).click();
  }

  async function fillCreate(fields: {
    material?: string;
    unit?: string;
    quantity?: string;
    deadline?: string;
    rfqDate?: string;
    collective?: string;
    plant?: string;
    suppliers: string[];
  }) {
    const form = create().locator('form');
    await choose(form, 'purchasingOrg', '1000');
    await choose(form, 'purchasingGroup', '001');
    await form.locator('[name="rfqDate"]').fill(fields.rfqDate ?? RFQ_DATE);
    await form.locator('[name="quotationDeadline"]').fill(fields.deadline ?? DEADLINE);
    if (fields.collective !== undefined) await form.locator('[name="collectiveNumber"]').fill(fields.collective);
    for (const [index, partner] of fields.suppliers.entries()) {
      if (index > 0) {
        await dismissSuggestions();
        await create().getByRole('button', { name: 'Add supplier', exact: true }).click();
      }
      await form.locator(`[name="supplier${index}Partner"]`).fill(partner);
    }
    if (fields.plant !== 'inject') await choose(form, 'line0Plant', fields.plant ?? '1000');
    await form.locator('[name="line0Material"]').fill(fields.material ?? 'MAT-RFQ');
    await form.locator('[name="line0Quantity"]').fill(fields.quantity ?? '12.5');
    await form.locator('[name="line0Unit"]').fill(fields.unit ?? 'PC');
    await form.locator('[name="line0Delivery"]').fill(DELIVERY);
    await dismissSuggestions();
  }

  async function refused(label: string, message: RegExp, prepare: () => Promise<void>) {
    const before = await tallies();
    await prepare();
    await result().filter({ hasText: message }).waitFor();
    assert.deepEqual(await tallies(), before, `${label} wrote something`);
    console.log(`  ✓ ${label} was refused, and nothing was written`);
  }

  await page.locator('#command-input').fill('ME41');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/rfq$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Request for quotation', exact: true }).waitFor();
  assert.equal(await page.locator('[name="price"]').count(), 0);
  assert.equal(await page.locator('[name="status"]').count(), 0);
  assert.equal(await page.locator('[name="deliveryChannel"]').count(), 0);
  assert.equal(await page.locator('[name="currency"]').count(), 0);
  console.log('  ✓ ME41 opens the one screen, and a price, a status, a channel and a currency are not fields');

  const beforeCheck = await tallies();
  await fillCreate({ collective: 'BID-1', suppliers: ['V-RFQ', 'V-RFQ2'] });
  await create().getByRole('button', { name: 'Check', exact: true }).click();
  await page.locator('[data-rfq-preview]').waitFor();
  await page.locator('[data-rfq-nothing-created]').waitFor();
  assert.match(await result().innerText(), /Nothing was written/);
  assert.match(await page.locator('[data-rfq-preview]').innerText(), /Neither number was drawn/);
  assert.match(await page.locator('[data-rfq-preview-lines]').innerText(), /Asked material/);
  assert.match(await page.locator('[data-rfq-preview-requests]').innerText(), /number not drawn/);
  assert.deepEqual(await tallies(), beforeCheck);
  console.log('  ✓ a check wrote nothing, including either number');

  await openBlank();
  await fillCreate({ collective: 'BID-1', suppliers: ['V-RFQ', 'V-RFQ2'] });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const created = result().filter({ hasText: /Event EV-\d{7} stands/ });
  await created.waitFor();
  const eventNumber = (await created.innerText()).match(/EV-\d{7}/)?.[0] ?? '';
  assert.ok(eventNumber);
  const afterCreate = await tallies();
  assert.equal(afterCreate.events, beforeCheck.events + 1);
  assert.equal(afterCreate.requests, beforeCheck.requests + 2);
  assert.equal(afterCreate.journals, beforeCheck.journals);
  assert.equal(afterCreate.movements, beforeCheck.movements);
  assert.equal(afterCreate.requisition, beforeCheck.requisition);
  assert.equal(afterCreate.supplier, 'V-RFQ');
  assert.equal(afterCreate.ordered, '1.000');
  console.log(`  ✓ ${eventNumber} stands with two requests, and the order, requisition, journal and movement were not touched`);

  await page.getByRole('link', { name: `Open ${eventNumber}`, exact: true }).click();
  await page.waitForURL(new RegExp(`event=${eventNumber}`), { waitUntil: 'commit' });
  await page.locator('[data-rfq-standing]').waitFor();
  const identity = await page.locator('[data-rfq-identity]').innerText();
  assert.match(identity, /KWD/);
  assert.match(identity, /BID-1/);
  assert.notEqual(eventNumber, 'BID-1');
  assert.equal(await page.locator('[data-rfq-request]').count(), 2);
  assert.match(await page.locator('[data-rfq-line="10"]').innerText(), /Asked material/);
  assert.match(await page.locator('[data-rfq-line="10"]').innerText(), /12\.500/);
  const copies = await page.locator('[data-rfq-request]').allInnerTexts();
  assert.equal(copies.filter((text) => text.includes('Asked material')).length, 2);
  console.log('  ✓ both requests keep the copy, and the collective number is not the key');

  await withTenant(client, (tx) => tx.execute(sql`
    update material set description = 'Changed later'
     where client = ${client} and material_number = 'MAT-RFQ'
  `));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-rfq-standing]').waitFor();
  assert.match(await page.locator('[data-rfq-line="10"]').innerText(), /Asked material/);
  assert.doesNotMatch(await page.locator('[data-rfq-line="10"]').innerText(), /Changed later/);
  console.log('  ✓ a later material description leaves the copy');

  await openBlank();
  await fillCreate({ collective: 'BID-1', suppliers: ['V-RFQ'] });
  await create().getByRole('button', { name: 'Save', exact: true }).click();
  const second = result().filter({ hasText: /Event EV-\d{7} stands/ });
  await second.waitFor();
  const secondEvent = (await second.innerText()).match(/EV-\d{7}/)?.[0] ?? '';
  assert.notEqual(secondEvent, eventNumber);
  const grouped = await withTenant(client, (tx) => tx.execute(sql`
    select event_number,
           (select count(*)::int from purchasing_rfq r where r.client = e.client and r.event_number = e.event_number) as requests
      from purchasing_rfq_event e
     where e.client = ${client} and e.collective_number = 'BID-1'
     order by e.event_number
  `)) as unknown as Array<{ event_number: string; requests: number }>;
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped.map((row) => row.requests).sort(), [1, 2]);
  console.log(`  ✓ ${secondEvent} is a second event under the same collective number, with one request`);

  await refused('an unknown supplier', /does not exist/, async () => {
    await openBlank();
    await fillCreate({ suppliers: ['NOBODY'] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a blocked supplier', /blocked/, async () => {
    await openBlank();
    await fillCreate({ suppliers: ['V-OFF'] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a missing purchasing assignment', /no purchasing assignment/, async () => {
    await openBlank();
    await fillCreate({ suppliers: ['V-BARE'] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an unknown material', /does not exist/, async () => {
    await openBlank();
    await fillCreate({ material: 'NO-MAT', suppliers: ['V-RFQ'] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a missing extension', /not extended/, async () => {
    await openBlank();
    await fillCreate({ material: 'MAT-BARE', suppliers: ['V-RFQ'] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an unknown plant', /Plant 9999 does not exist/, async () => {
    await openBlank();
    await fillCreate({ plant: 'inject', suppliers: ['V-RFQ'] });
    await page.evaluate(() => {
      const select = document.querySelector('section[aria-labelledby="rfq-create"] [name="line0Plant"]') as HTMLSelectElement;
      const option = document.createElement('option');
      option.value = '9999';
      option.text = '9999';
      select.appendChild(option);
      select.value = '9999';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an unassigned plant', /not assigned/, async () => {
    await openBlank();
    await fillCreate({ plant: 'inject', suppliers: ['V-RFQ'] });
    await page.evaluate(() => {
      const select = document.querySelector('section[aria-labelledby="rfq-create"] [name="line0Plant"]') as HTMLSelectElement;
      const option = document.createElement('option');
      option.value = '2000';
      option.text = '2000';
      select.appendChild(option);
      select.value = '2000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an unknown unit', /not a standing unit/, async () => {
    await openBlank();
    await fillCreate({ unit: 'ZZ', suppliers: ['V-RFQ'] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('an alternate unit with no conversion', /no conversion/, async () => {
    await openBlank();
    await fillCreate({ unit: 'BX', suppliers: ['V-RFQ'] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a zero quantity', /greater than zero/, async () => {
    await openBlank();
    await fillCreate({ suppliers: ['V-RFQ'] });
    await create().locator('[name="line0Quantity"]').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.removeAttribute('min');
      input.value = '0';
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a negative quantity', /greater than zero/, async () => {
    await openBlank();
    await fillCreate({ suppliers: ['V-RFQ'] });
    await create().locator('[name="line0Quantity"]').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.removeAttribute('min');
      input.value = '-1';
    });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a deadline before the RFQ date', /before the RFQ date/, async () => {
    await openBlank();
    await fillCreate({ rfqDate: '2026-11-05', deadline: '2026-10-22', suppliers: ['V-RFQ'] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
  });
  await refused('a second invitation of the same supplier', /invited twice/, async () => {
    await openBlank();
    await fillCreate({ suppliers: ['V-RFQ', 'V-RFQ'] });
    await create().getByRole('button', { name: 'Save', exact: true }).click();
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
  console.log('  ✓ the order and the requisition were not rewritten, and no journal or material document was written');
}
