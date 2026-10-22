import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postGoodsReceipt } from '../../src/modules/inventory/goods-receipt';
import { createOrder } from '../../src/modules/purchasing/orders';
import { postSupplierInvoice } from '../../src/modules/purchasing/invoice-verification';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/grir-clearing';
const ACTOR = 'browser.admin';

/**
 * SCR-163 browser acceptance (T862) — a GR/IR clearing posts, and stock does not move.
 *
 * The production build is the screen under test. MR11 opens it. The alias is
 * not an identifier on the page. A quantity residual is checked, then cleared.
 * A check writes nothing. The material document count and the stock quantity
 * do not change.
 */
export async function scr163GrIrClearing(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-163: clear a GR/IR residual, and do not move stock');

  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
    });
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, purchasing_org, created_by)
      values (${client}, '001', 'Buyer', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V-GRIR', 'ORGANIZATION', 'Clearing supplier', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V-GRIR', 'SUPPLIER', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, created_by)
      values (${client}, 'V-GRIR', 'SUPPLIER', '1000', 'KWD', '001', ${ACTOR})
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
      ) values (${client}, 'V-GRIR', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, 'MAT-GRIR', 'Clearing material', 'RAW', 'PC', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
      values (${client}, 'MAT-GRIR', '1000', 0, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency, created_by
      ) values (${client}, 'MAT-GRIR', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'KWD', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
             (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
             (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_period_control (
        client, company_code, current_fiscal_year, current_period,
        previous_fiscal_year, previous_period, allow_backposting, created_by
      ) values (${client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR})
      on conflict (client, company_code) do update
        set current_fiscal_year = 2026, current_period = 10, allow_backposting = true
    `);
  });

  const order = await createOrder({
    client, changedBy: ACTOR,
    supplierNumber: 'V-GRIR', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
    items: [{
      materialNumber: 'MAT-GRIR', shortText: 'Clearing material', quantity: 5, unit: 'PC',
      netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001',
      markedForDeletion: false,
      scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }],
      assignments: [],
    }],
  });
  await postGoodsReceipt({
    client, changedBy: ACTOR, orderNumber: order.orderNumber,
    documentDate: '2026-10-18', postingDate: '2026-10-18',
    requestKey: `gr-mr11-${order.orderNumber}`, lines: [{ itemNumber: 10, quantity: 5 }],
  });
  await postSupplierInvoice({
    client, changedBy: ACTOR, orderNumber: order.orderNumber,
    supplierReference: 'GRIR-1', invoiceDate: '2026-10-18', postingDate: '2026-10-18',
    grossAmount: 300, requestKey: `iv-mr11-${order.orderNumber}`,
    lines: [{ itemNumber: 10, quantity: 3, netAmount: 300 }],
  });

  async function standing() {
    return withTenant(client, async (tx) => {
      const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      const [documents] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      const [stock] = await tx.execute(sql`select coalesce(sum(quantity), 0)::text as n from stock_quantity where client = ${client}`) as unknown as Array<{ n: string }>;
      const [links] = await tx.execute(sql`select count(*)::int as n from gr_ir_maintenance_link where client = ${client} and reversed_by is null`) as unknown as Array<{ n: number }>;
      return { journals: journals.n, documents: documents.n, stock: stock.n, links: links.n };
    });
  }

  const before = await standing();
  await page.goto(`${base}${ROUTE}`);
  await page.locator('#command-input').fill('MR11');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/grir-clearing$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Maintain GR/IR clearing', exact: true }).waitFor();
  await page.getByText('PROC.GRIR.MAINTAIN', { exact: true }).waitFor();
  assert.equal(await page.getByText('MR11', { exact: true }).count(), 0);
  assert.equal(await page.locator('[name="deliveryCost"]').count(), 0);
  assert.equal(await page.locator('[name="stock"]').count(), 0);
  assert.match(await page.locator('[data-grir-no-stock]').innerText(), /does not change stock/);
  console.log('  ✓ MR11 opens the clearing screen, and the alias is not on the page');

  await page.locator('select[name="companyFrom"]').selectOption('1000');
  await page.locator('[name="keyDate"]').fill('2026-10-18');
  await page.locator('[data-grir-list]').click();
  const row = page.locator(`[data-grir-row="${order.orderNumber}"]`);
  await row.waitFor();
  assert.match(await row.innerText(), /200\.00/);
  assert.match(await row.innerText(), /Further invoice/);
  const checked = await standing();
  assert.deepEqual(checked, before);
  console.log('  ✓ the residual is listed, and the list writes nothing');

  await row.locator('[data-grir-check]').click();
  await row.locator('[data-grir-notice]').waitFor();
  assert.match(await row.locator('[data-grir-notice]').innerText(), /Nothing was written/);
  assert.deepEqual(await standing(), before);
  console.log('  ✓ a check names the residual and writes nothing');

  await row.locator('[name="postingDate"]').fill('2026-10-18');
  await row.locator('[name="comment"]').fill('write off the open quantity');
  await row.locator('[name="acknowledge"]').check();
  await row.locator('[data-grir-post]').click();
  await page.locator('[data-grir-posted]').first().waitFor();
  const cleared = await standing();
  assert.equal(cleared.journals, before.journals + 1);
  assert.equal(cleared.documents, before.documents);
  assert.equal(cleared.stock, before.stock);
  assert.equal(cleared.links, before.links + 1);
  assert.equal(await page.locator(`[data-grir-row="${order.orderNumber}"]`).count(), 0);
  console.log('  ✓ the residual was cleared, and stock did not move');

  const posted = page.locator('[data-grir-posted]').first();
  await posted.locator('[name="reversalDate"]').fill('2026-10-18');
  await posted.locator('[name="comment"]').fill('put the residual back');
  await posted.locator('[data-grir-reverse-save]').click();
  await page.locator(`[data-grir-row="${order.orderNumber}"]`).waitFor();
  const restored = await standing();
  assert.equal(restored.documents, before.documents);
  assert.equal(restored.stock, before.stock);
  assert.equal(restored.journals, before.journals + 2);
  console.log('  ✓ the clearing was reversed, and the original journal still stands');
}
