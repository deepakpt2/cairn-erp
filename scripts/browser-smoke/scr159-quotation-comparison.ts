import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { createRequestForQuotation } from '../../src/modules/purchasing/rfq';
import { createQuotation } from '../../src/modules/purchasing/quotation';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/quotation-comparison';
const ACTOR = 'browser.admin';

/**
 * SCR-159 browser acceptance (T858) — one event is compared, and nothing is written.
 *
 * The production build is the screen under test. The event number is the key.
 * A collective number is a label. A rank is not an award. Rollback and the
 * unit conversion stay in the service test.
 */
export async function scr159QuotationComparison(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-159: one event is compared, and nothing is written');

  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'QUOTATION', subObject: '*', prefix: 'QT', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values
        (${client}, 'V-QT', 'ORGANIZATION', 'Quoted supplier', 'CREATED', ${ACTOR}),
        (${client}, 'V-QT2', 'ORGANIZATION', 'Second supplier', 'CREATED', ${ACTOR}),
        (${client}, 'V-QT3', 'ORGANIZATION', 'Later supplier', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values
        (${client}, 'V-QT', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-QT2', 'SUPPLIER', ${ACTOR}),
        (${client}, 'V-QT3', 'SUPPLIER', ${ACTOR})
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
        (${client}, 'V-QT2', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR}),
        (${client}, 'V-QT3', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR})
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
      { itemNumber: 20, quantity: '3', unit: 'PC', netPrice: '5', priceUnit: '1', deliveryDate: '2026-12-15' },
      { itemNumber: 30, quantity: '1', unit: 'PC', netPrice: '0', priceUnit: '1', deliveryDate: '2026-12-20' },
    ],
  });
  await createQuotation({
    client,
    changedBy: ACTOR,
    rfqNumber: otherRequest,
    lines: [
      { itemNumber: 10, quantity: '12.5', unit: 'PC', netPrice: '1', priceUnit: '1', deliveryDate: '2026-12-01' },
      { itemNumber: 20, quantity: '3', unit: 'PC', netPrice: '5', priceUnit: '1', deliveryDate: '2026-12-15' },
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
        (select net_price::text from purchase_order_item where client = ${client} and order_number = 'PO-QT') as ordered_price
    `)) as unknown as Array<{
      quotations: number;
      changes: number;
      journals: number;
      movements: number;
      info_records: number;
      requisition: string;
      ordered_price: string;
    }>;
    return row;
  }

  const before = await tallies();
  await page.locator('#command-input').fill('ME49');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/quotation-comparison$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Compare quotations', exact: true }).waitFor();
  await page.getByText('PROC.RFQ.COMPARISON · ME49', { exact: true }).waitFor();
  assert.match(await page.locator('[data-comparison-no-award]').first().innerText(), /does not award or buy/);
  assert.equal(await page.locator('[name="price"]').count(), 0);
  assert.equal(await page.locator('[name="status"]').count(), 0);
  assert.equal(await page.locator('[name="currency"]').count(), 0);
  assert.equal(await page.locator('[name="revision"]').count(), 0);
  assert.equal(await page.locator('[name="award"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Award' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Create order' }).count(), 0);
  console.log('  ✓ ME49 opens the comparison, and it does not award or buy');

  await page.locator('[name="event"]').fill(created.eventNumber);
  await page.getByRole('heading', { level: 1, name: 'Compare quotations', exact: true }).click();
  await page.locator('[name="purchasingOrg"] option[value="1000"]').waitFor({ state: 'attached' });
  await page.locator('[name="purchasingOrg"]').selectOption('1000');
  await page.locator('[data-comparison-run]').click();
  await page.locator('[data-quotation-comparison]').waitFor();
  assert.equal(await page.locator('[data-comparison-event]').innerText(), created.eventNumber);
  assert.match(await page.locator('[data-comparison-currency]').innerText(), /KWD/);
  assert.match(await page.locator('[data-comparison-currency-note]').innerText(), /not converted/);
  assert.match(await page.locator('[data-comparison-price-note]').innerText(), /not stored/);
  assert.equal(await page.locator('[data-comparison-rank="10-V-QT2"]').innerText(), '1');
  assert.equal(await page.locator('[data-comparison-price="10-V-QT2"]').innerText(), '1.0000');
  assert.equal(await page.locator('[data-comparison-rank="10-V-QT"]').innerText(), '2');
  assert.equal(await page.locator('[data-comparison-price="10-V-QT"]').innerText(), '2.5000');
  assert.match(await page.locator('[data-comparison-reason="10-V-QT"]').innerText(), /not a disqualification/);
  assert.match(await page.locator('[data-comparison-rank="20-V-QT"]').innerText(), /1/);
  assert.match(await page.locator('[data-comparison-rank="20-V-QT"]').innerText(), /Tie/);
  assert.match(await page.locator('[data-comparison-rank="20-V-QT2"]').innerText(), /Tie/);
  assert.equal(await page.locator('[data-comparison-rank="30-V-QT"]').innerText(), '1');
  assert.equal(await page.locator('[data-comparison-price="30-V-QT"]').innerText(), '0.0000');
  assert.match(await page.locator('[data-comparison-reason="30-V-QT2"]').innerText(), /No offer/);
  assert.equal(await page.locator('[data-comparison-rank="30-V-QT2"]').innerText(), 'Not ranked');
  assert.equal(await page.locator(`[data-comparison-quotation="${saved.quotationNumber}"]`).count(), 3);
  assert.equal(await page.locator(`[data-comparison-maintain="${request}"]`).count(), 3);
  assert.deepEqual(await tallies(), before);
  console.log('  ✓ the lower price ranks first, a tie is named, a zero ranks, and a missing offer does not');

  await page.goto(`${base}${ROUTE}?collectiveNumber=BID-1&purchasingOrg=1000`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-quotation-comparison]').waitFor();
  assert.equal(await page.locator('[data-comparison-event]').innerText(), created.eventNumber);
  assert.match(await page.locator('[data-comparison-label]').innerText(), /not the key/);
  console.log('  ✓ one collective number resolves the event and stays a label');

  const second = await createRequestForQuotation({
    client,
    changedBy: ACTOR,
    purchasingOrg: '1000',
    purchasingGroup: '001',
    rfqDate: '2026-10-22',
    quotationDeadline: '2026-12-31',
    collectiveNumber: 'BID-1',
    suppliers: [{ partnerNumber: 'V-QT3' }],
    lines: [{ materialNumber: 'MAT-QT', quantity: '1', plant: '1000', deliveryDate: '2026-12-01' }],
  });
  await page.goto(`${base}${ROUTE}?collectiveNumber=BID-1&purchasingOrg=1000`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-comparison-miss]').waitFor();
  const miss = await page.locator('[data-comparison-miss]').innerText();
  assert.match(miss, new RegExp(created.eventNumber));
  assert.match(miss, new RegExp(second.eventNumber));
  assert.match(miss, /not the key/);
  assert.equal(await page.locator('[data-quotation-comparison]').count(), 0);
  console.log('  ✓ a shared collective number is refused and names both events');

  await withTenant(client, (tx) => tx.execute(sql`
    update purchasing_rfq_event
       set rfq_date = '2026-01-01', quotation_deadline = '2026-10-21'
     where client = ${client} and event_number = ${created.eventNumber}
  `));
  const held = await tallies();
  await page.goto(`${base}${ROUTE}?event=${created.eventNumber}&purchasingOrg=1000`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-quotation-comparison]').waitFor();
  assert.equal(await page.locator('[data-comparison-rank="10-V-QT2"]').innerText(), '1');
  assert.match(await page.locator('[data-comparison-date]').innerText(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(await page.locator('[data-comparison-bid="10-V-QT3"]').count(), 0);
  console.log('  ✓ a day after the deadline still shows the standing quotations, and the events are not merged');

  await page.goto(`${base}${ROUTE}?event=${created.eventNumber}&purchasingOrg=2000`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-comparison-miss]').waitFor();
  assert.match(await page.locator('[data-comparison-miss]').innerText(), /2000/);
  const end = await tallies();
  assert.deepEqual(end, held);
  assert.equal(end.requisition, '1.000');
  assert.equal(end.ordered_price, '1.00');
  console.log('  ✓ a different purchasing organisation is refused, and nothing was written');
}
