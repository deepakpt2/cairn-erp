import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { parkSupplierInvoice } from '../../src/modules/purchasing/parked-invoice';
import { createOrder } from '../../src/modules/purchasing/orders';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/invoice-overview';
const ACTOR = 'browser.admin';

/**
 * SCR-161 browser acceptance (T860) — the invoice list does not post.
 *
 * The production build is the screen under test. MIR6 opens it. The alias is
 * not an identifier on the page. A parked invoice is listed without an
 * accounting document. Viewing writes nothing.
 */
export async function scr161InvoiceOverview(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-161: list a supplier invoice, and do not post it');

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
      values (${client}, 'V-LIST', 'ORGANIZATION', 'Listed supplier', 'CREATED', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V-LIST', 'SUPPLIER', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org
        (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
      values (${client}, 'V-LIST', 'SUPPLIER', '1000', 'KWD', '001', 'CREATED', ${ACTOR})
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
      ) values (${client}, 'V-LIST', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-LIST', 'Listed material', t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, procurement_type, created_by)
      values (${client}, 'MAT-LIST', '1000', 'BUY', ${ACTOR})
      on conflict do nothing
    `);
  });

  const order = await createOrder({
    client,
    changedBy: ACTOR,
    supplierNumber: 'V-LIST',
    purchasingOrg: '1000',
    purchasingGroup: '001',
    companyCode: '1000',
    currency: '',
    items: [{
      materialNumber: 'MAT-LIST',
      shortText: 'Listed material',
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
  const parked = await parkSupplierInvoice({
    client,
    changedBy: ACTOR,
    orderNumber: order.orderNumber,
    supplierReference: 'LIST-1',
    invoiceDate: '2026-10-22',
    postingDate: '2026-10-22',
    grossAmount: 800,
    lines: [{ itemNumber: 10, quantity: 8, netAmount: 800 }],
    requestKey: `list-${order.orderNumber}`,
  });

  async function tallies() {
    const [row] = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from parked_supplier_invoice where client = ${client}) as parked,
        (select count(*)::int from supplier_invoice where client = ${client}) as posted,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from change_document where client = ${client}) as changes,
        (select fiscal_year::int from parked_supplier_invoice where client = ${client} and parked_number = ${parked.parkedNumber}) as fiscal_year
    `)) as unknown as Array<{ parked: number; posted: number; journals: number; changes: number; fiscal_year: number }>;
    return row;
  }

  const before = await tallies();
  await page.locator('#command-input').fill('MIR6');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/invoice-overview$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Invoice overview', exact: true }).waitFor();
  await page.getByText('PROC.INV.OVERVIEW', { exact: true }).waitFor();
  assert.equal(await page.getByText('MIR6', { exact: true }).count(), 0);
  assert.equal(await page.locator('[name="draft"]').count(), 0);
  assert.equal(await page.locator('[name="paymentBlock"]').count(), 0);
  assert.equal(await page.locator('[name="export"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Post' }).count(), 0);
  assert.match(await page.locator('[data-invoice-overview-no-post]').innerText(), /does not post/);
  console.log('  ✓ MIR6 opens the list, and the alias is not on the page');

  await page.goto(`${base}${ROUTE}?draft=1&companyFrom=1000&fiscalYear=${before.fiscal_year}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-invoice-overview-error]').waitFor();
  assert.match(await page.locator('[data-invoice-overview-error]').innerText(), /draft/i);
  assert.deepEqual(await tallies(), before);
  console.log('  ✓ a draft is refused, and nothing is written');

  await page.locator('[name="companyFrom"] option[value="1000"]').waitFor();
  await page.locator('[name="companyFrom"]').selectOption('1000');
  await page.locator('[name="fiscalYear"]').fill(String(before.fiscal_year));
  await page.locator('[data-invoice-overview-run]').click();
  await page.locator(`[data-invoice-overview-row="${parked.parkedNumber}"]`).waitFor();
  assert.equal(await page.locator(`[data-lifecycle="${parked.parkedNumber}"]`).innerText(), 'PARKED');
  assert.equal(await page.locator(`[data-posting-date="${parked.parkedNumber}"]`).innerText(), '—');
  assert.equal(await page.locator(`[data-journal="${parked.parkedNumber}"]`).innerText(), '—');
  assert.equal(await page.locator(`[data-payment-state="${parked.parkedNumber}"]`).innerText(), 'NOT_APPLICABLE');
  assert.match(await page.locator('[data-invoice-overview-nothing-written]').innerText(), /Nothing was written/);
  assert.deepEqual(await tallies(), before);
  console.log(`  ✓ ${parked.parkedNumber} is listed, and it has no accounting document`);

  await page.locator(`[data-invoice-overview-row="${parked.parkedNumber}"] a`).click();
  await page.locator('[data-invoice-overview-no-journal]').waitFor();
  assert.match(await page.locator('[data-invoice-overview-no-journal]').innerText(), /No accounting document/);
  await page.locator('[data-invoice-overview-park]').click();
  await page.waitForURL(/\/purchasing\/parked-invoice\?parked=/, { waitUntil: 'commit' });
  await page.locator('[data-parked-invoice-identity]').waitFor();
  assert.deepEqual(await tallies(), before);
  console.log('  ✓ the park opens, and the list still wrote nothing');
}
