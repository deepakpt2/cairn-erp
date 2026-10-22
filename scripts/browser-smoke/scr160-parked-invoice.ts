import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { createOrder } from '../../src/modules/purchasing/orders';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/parked-invoice';
const ACTOR = 'browser.admin';
const DATES = { invoiceDate: '2026-10-22', postingDate: '2026-10-22' };

/**
 * SCR-160 browser acceptance (T859) — a parked invoice is not a posted invoice.
 *
 * The production build is the screen under test. MIR7 opens it. The alias is
 * not an identifier on the page. A check writes nothing, including the number.
 * A quantity with no receipt is kept and is not invoiced. Invoice verification
 * is a link, not a post.
 */
export async function scr160ParkedInvoice(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-160: park a supplier invoice, and do not post it');

  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PARKINV', subObject: '*', prefix: 'PV', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, purchasing_org, created_by)
      values (${client}, '001', 'Buyer', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values (${client}, 'V-PARK', 'ORGANIZATION', 'Parked supplier', 'CREATED', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V-PARK', 'SUPPLIER', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org
        (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
      values (${client}, 'V-PARK', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_company_code (
        client, partner_number, role_code, company_code, chart_of_accounts,
        reconciliation_account, payment_terms_code, created_by
      ) values (${client}, 'V-PARK', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-PARK', 'Parked material', t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, procurement_type, created_by)
      values (${client}, 'MAT-PARK', '1000', 'BUY', ${ACTOR})
      on conflict do nothing
    `);
  });

  const order = await createOrder({
    client,
    changedBy: ACTOR,
    supplierNumber: 'V-PARK',
    purchasingOrg: '1000',
    purchasingGroup: '001',
    companyCode: '1000',
    currency: '',
    items: [{
      materialNumber: 'MAT-PARK',
      shortText: 'Parked material',
      quantity: 5,
      unit: 'PC',
      netPrice: 100,
      priceUnit: 1,
      taxCode: '',
      plant: '1000',
      storageLocation: '',
      markedForDeletion: false,
      scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }],
      assignments: [],
    }],
  });

  async function tallies() {
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from parked_supplier_invoice where client = ${client}) as parked,
        (select count(*)::int from supplier_invoice where client = ${client}) as posted,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from material_document where client = ${client}) as movements,
        (select current_number::int from number_range where client = ${client} and object_code = 'PARKINV') as park_drawn,
        (select current_number::int from number_range where client = ${client} and object_code = 'VENDINV') as invoice_drawn,
        (select quantity::text from purchase_order_item where client = ${client} and order_number = ${order.orderNumber}) as ordered
    `)) as unknown as Array<{
      parked: number;
      posted: number;
      journals: number;
      movements: number;
      park_drawn: number;
      invoice_drawn: number;
      ordered: string;
    }>;
    return row;
  }

  function form() {
    return page.locator('form[action]').last();
  }

  async function dismiss() {
    await page.getByRole('heading', { level: 1, name: 'Park supplier invoice', exact: true }).click();
  }

  const before = await tallies();
  await page.locator('#command-input').fill('MIR7');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/parked-invoice$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Park supplier invoice', exact: true }).waitFor();
  await page.getByText('PROC.INV.PARK', { exact: true }).waitFor();
  assert.equal(await page.getByText('MIR7', { exact: true }).count(), 0);
  assert.equal(await page.locator('[name="status"]').count(), 0);
  assert.equal(await page.locator('[name="currency"]').count(), 0);
  assert.equal(await page.locator('[name="category"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Post' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Delete' }).count(), 0);
  assert.match(await page.locator('[data-parked-invoice-no-post]').first().innerText(), /does not post a journal/);
  console.log('  ✓ MIR7 opens the park, and the alias is not on the page');

  await page.locator('[name="order"]').click();
  assert.equal(await page.getByRole('listbox').count(), 0);
  await page.locator('[name="order"]').fill(order.orderNumber.slice(0, 3));
  await page.getByRole('option').first().waitFor();
  assert.ok((await page.getByRole('option').count()) <= 5);
  await page.getByRole('option', { name: new RegExp(order.orderNumber) }).click();
  console.log('  ✓ the order is suggested as it is typed, and an empty click suggests nothing');

  await page.goto(`${base}${ROUTE}?order=NO-SUCH`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Purchase order NO-SUCH does not stand.').waitFor();
  assert.deepEqual(await tallies(), before);
  console.log('  ✓ a missing order is named, and nothing is written');

  await page.locator('[name="order"]').fill(order.orderNumber);
  await dismiss();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('[data-parked-invoice-identity]').waitFor();
  assert.match(await page.locator('[data-parked-invoice-identity]').innerText(), /V-PARK/);
  assert.match(await page.locator('[data-parked-invoice-identity]').innerText(), /KWD/);
  assert.equal(await page.locator('[data-received="10"]').innerText(), '0');
  assert.equal(await page.locator('[data-invoiced="10"]').innerText(), '0');
  assert.equal(await page.locator('[data-invoiceable="10"]').innerText(), '0');
  console.log('  ✓ the order opens, and nothing has been received or invoiced');

  await form().locator('[name="supplierReference"]').fill('PARK-1');
  await form().locator('[name="invoiceDate"]').fill(DATES.invoiceDate);
  await form().locator('[name="postingDate"]').fill(DATES.postingDate);
  await form().locator('[name="grossAmount"]').fill('800');
  await form().locator('[name="qty-10"]').fill('8');
  await form().locator('[name="amt-10"]').fill('800');
  await page.locator('[data-parked-invoice-check]').click();
  await page.locator('[data-parked-invoice-nothing-written]').waitFor();
  assert.match(await page.locator('[data-parked-invoice-notes]').innerText(), /nothing has been received/);
  assert.match(await page.locator('[data-parked-invoice-terms]').innerText(), /NET30/);
  assert.match(await page.locator('[data-parked-invoice-terms]').innerText(), /2026-11-21/);
  assert.equal(await page.locator('[data-parked-invoiced="10"]').innerText(), '0');
  assert.deepEqual(await tallies(), before);
  console.log('  ✓ the check names the missing receipt, and the number is not drawn');

  await page.locator('[data-parked-invoice-save]').click();
  await page.locator('[data-parked-invoice-open]').waitFor();
  const parkedNumber = (await page.locator('[data-parked-invoice-open]').innerText()).replace('Open ', '').trim();
  assert.match(parkedNumber, /^PV-/);
  const parked = await tallies();
  assert.equal(parked.parked, before.parked + 1);
  assert.equal(parked.posted, before.posted);
  assert.equal(parked.journals, before.journals);
  assert.equal(parked.movements, before.movements);
  assert.equal(parked.park_drawn, before.park_drawn + 1);
  assert.equal(parked.invoice_drawn, before.invoice_drawn);
  assert.equal(Number(parked.ordered), 5);
  console.log(`  ✓ ${parkedNumber} stands, and it is not an invoice`);

  await page.locator('[data-parked-invoice-open]').click();
  await page.locator('[data-parked-invoice-history]').waitFor();
  assert.match(await page.locator('[data-parked-invoice-history]').innerText(), /CREATE/);
  await form().locator('[name="supplierReference"]').fill('PARK-2');
  await form().locator('[name="grossAmount"]').fill('200');
  await form().locator('[name="qty-10"]').fill('2');
  await form().locator('[name="amt-10"]').fill('200');
  await form().locator('[name="reason"]').fill('The supplier corrected the quantity.');
  await page.locator('[data-parked-invoice-save]').click();
  await page.locator('[data-parked-invoice-open]').waitFor();
  await page.locator('[data-parked-invoice-open]').click();
  await page.locator('[data-parked-invoice-history]').waitFor();
  assert.match(await page.locator('[data-parked-invoice-history]').innerText(), /CHANGE/);
  assert.equal(await form().locator('[name="supplierReference"]').inputValue(), 'PARK-2');
  assert.equal(await page.locator('[data-invoiced="10"]').innerText(), '0');
  const after = await tallies();
  assert.equal(after.parked, parked.parked);
  assert.equal(after.posted, before.posted);
  assert.equal(after.journals, before.journals);
  assert.equal(after.park_drawn, parked.park_drawn);
  console.log('  ✓ the change stands in the history, and the order is still not invoiced');
}
