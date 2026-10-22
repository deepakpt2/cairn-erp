import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { createRequestForQuotation } from '../../src/modules/purchasing/rfq';
import { changeQuotation, createQuotation, getQuotation } from '../../src/modules/purchasing/quotation';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/quotation-display';
const ACTOR = 'browser.admin';

/**
 * SCR-158 browser acceptance (T857) — a quotation is read, and nothing is written.
 *
 * The production build is the screen under test. The quotation number is the
 * key. A request number is not that key. A day after the deadline does not
 * hide the quotation. Rollback and the tenant boundary stay in the service test.
 */
export async function scr158QuotationDisplay(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-158: a quotation is read, and nothing is written');

  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'QUOTATION', subObject: '*', prefix: 'QT', numberLength: 7, createdBy: ACTOR });
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

  const created = await createRequestForQuotation({
    client,
    changedBy: ACTOR,
    purchasingOrg: '1000',
    purchasingGroup: '001',
    rfqDate: '2026-10-22',
    quotationDeadline: '2026-12-31',
    collectiveNumber: 'BID-1',
    suppliers: [{ partnerNumber: 'V-QT' }, { partnerNumber: 'V-QT2' }],
    lines: [
      { materialNumber: 'MAT-QT', quantity: '12.5', plant: '1000', deliveryDate: '2026-12-01' },
      { materialNumber: 'MAT-QT', quantity: '3', plant: '1000', deliveryDate: '2026-12-15' },
      { materialNumber: 'MAT-QT', quantity: '1', plant: '1000', deliveryDate: '2026-12-20' },
    ],
  });
  const request = created.rfqNumbers[0];
  const otherRequest = created.rfqNumbers[1];
  const saved = await createQuotation({
    client,
    changedBy: ACTOR,
    rfqNumber: request,
    lines: [
      { itemNumber: 10, quantity: '8', unit: 'PC', netPrice: '250', priceUnit: '100', deliveryDate: '2026-12-20' },
      { itemNumber: 20, quantity: '3', unit: 'PC', netPrice: '0', priceUnit: '1', deliveryDate: '2026-12-15' },
    ],
  });
  const standing = await getQuotation(client, saved.quotationNumber);
  await changeQuotation({
    client,
    changedBy: ACTOR,
    rfqNumber: request,
    expectedChangedAt: standing?.changedAt ?? null,
    reason: 'Revised the price',
    lines: [
      { itemNumber: 10, quantity: '8', unit: 'PC', netPrice: '300', priceUnit: '100', deliveryDate: '2026-12-20' },
      { itemNumber: 20, quantity: '3', unit: 'PC', netPrice: '0', priceUnit: '1', deliveryDate: '2026-12-15' },
    ],
  });

  async function tallies() {
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from purchasing_quotation where client = ${client}) as quotations,
        (select count(*)::int from change_document where client = ${client}) as changes,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from material_document where client = ${client}) as movements,
        (select count(*)::int from purchasing_info_record where client = ${client}) as info_records,
        (select quantity::text from purchase_requisition_item where client = ${client} and requisition_number = 'PR-QT') as requisition,
        (select net_price::text from purchase_order_item where client = ${client} and order_number = 'PO-QT') as ordered_price,
        (select quantity::text from purchasing_rfq_item where client = ${client} and rfq_number = ${request} and item_number = 10) as copy
    `)) as unknown as Array<{
      quotations: number;
      changes: number;
      journals: number;
      movements: number;
      info_records: number;
      requisition: string;
      ordered_price: string;
      copy: string;
    }>;
    return row;
  }

  const before = await tallies();
  await page.locator('#command-input').fill('ME48');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/quotation-display$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Display quotation', exact: true }).waitFor();
  assert.equal(await page.locator('[name="price"]').count(), 0);
  assert.equal(await page.locator('[name="status"]').count(), 0);
  assert.equal(await page.locator('[name="currency"]').count(), 0);
  assert.equal(await page.locator('[name="revision"]').count(), 0);
  assert.equal(await page.locator('[name="award"]').count(), 0);
  assert.equal(await page.locator('[name="netPrice"]').count(), 0);
  assert.match(await page.locator('[data-quotation-not-interchangeable]').innerText(), /not a quotation number/);
  console.log('  ✓ ME48 opens the display, and a price, a status, a currency, a revision and an award are not fields');

  await page.locator('[name="quotation"]').fill(request);
  await page.getByRole('heading', { level: 1, name: 'Display quotation', exact: true }).click();
  await page.locator('[data-quotation-open]').click();
  await page.locator('[data-quotation-miss="quotation"]').waitFor();
  assert.match(await page.locator('[data-quotation-miss="quotation"]').innerText(), new RegExp(request));
  assert.deepEqual(await tallies(), before);
  console.log('  ✓ a request number in the quotation field does not open a quotation');

  await page.goto(`${base}${ROUTE}?quotation=${saved.quotationNumber}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-quotation-display]').waitFor();
  assert.equal(await page.locator('[data-quotation-number]').innerText(), saved.quotationNumber);
  assert.match(await page.locator('[data-quotation-supplier]').innerText(), /V-QT/);
  assert.match(await page.locator('[data-quotation-supplier]').innerText(), /Quoted supplier/);
  assert.equal(await page.locator('[data-quotation-request]').innerText(), request);
  assert.match(await page.locator('[data-quotation-currency]').innerText(), /KWD/);
  assert.equal(await page.locator('[data-quotation-per-unit="10"]').innerText(), '3.0000');
  assert.match(await page.locator('[data-quotation-asked="10"]').innerText(), /12\.500/);
  assert.match(await page.locator('[data-quotation-offered="10"]').innerText(), /8\.000/);
  assert.match(await page.locator('[data-quotation-line="20"]').innerText(), /0\.0000/);
  assert.match(await page.locator('[data-quotation-unquoted="30"]').innerText(), /Item 30 has no offer/);
  assert.match(await page.locator('[data-quotation-calculated]').innerText(), /not stored/);
  assert.match(await page.locator('[data-quotation-no-status]').innerText(), /no stored status/);
  assert.match(await page.locator('[data-quotation-no-revision]').innerText(), /no revision stack/);
  assert.match(await page.locator('[data-quotation-no-condition]').innerText(), /not stored/);
  assert.match(await page.locator('[data-quotation-no-award]').innerText(), /does not compare/);
  assert.match(await page.locator('[data-quotation-company]').innerText(), /1000/);
  assert.match(await page.locator('[data-quotation-history]').innerText(), /250\.0000/);
  assert.match(await page.locator('[data-quotation-history]').innerText(), /300\.0000/);
  assert.equal(await page.locator('[data-display-maintain]').count(), 1);
  assert.equal(await page.locator('[data-display-request]').count(), 1);
  assert.deepEqual(await tallies(), before);
  console.log(`  ✓ ${saved.quotationNumber} is read, 3.0000 is calculated, and nothing was written`);

  await page.goto(`${base}${ROUTE}?request=${otherRequest}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-quotation-miss="no-offer"]').waitFor();
  assert.match(await page.locator('[data-quotation-miss="no-offer"]').innerText(), new RegExp(otherRequest));
  assert.equal(await page.locator('[data-quotation-display]').count(), 0);
  console.log('  ✓ the other request has no quotation');

  await page.goto(`${base}${ROUTE}?request=${request}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-quotation-display]').waitFor();
  assert.equal(await page.locator('[data-quotation-number]').innerText(), saved.quotationNumber);
  assert.equal(await page.locator('[data-quotation-request]').innerText(), request);
  console.log('  ✓ the request number resolves the quotation, and the two numbers stay distinct');

  await withTenant(client, (tx) => tx.execute(sql`
    update purchasing_rfq_event
       set rfq_date = '2026-01-01', quotation_deadline = '2026-10-21'
     where client = ${client} and event_number = ${created.eventNumber}
  `));
  await page.goto(`${base}${ROUTE}?quotation=${saved.quotationNumber}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-quotation-display]').waitFor();
  assert.match(await page.locator('[data-quotation-deadline]').innerText(), /2026-10-21/);
  assert.match(await page.locator('[data-quotation-still-visible]').innerText(), /does not hide/);
  const end = await tallies();
  assert.equal(end.quotations, before.quotations);
  assert.equal(end.changes, before.changes);
  assert.equal(end.journals, before.journals);
  assert.equal(end.movements, before.movements);
  assert.equal(end.info_records, before.info_records);
  assert.equal(end.requisition, '1.000');
  assert.equal(end.ordered_price, '1.00');
  assert.equal(end.copy, '12.500');
  console.log('  ✓ a day after the deadline still displays the quotation, and the order and the requisition were unchanged');
}
