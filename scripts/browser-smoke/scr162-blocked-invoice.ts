import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postGoodsReceipt } from '../../src/modules/inventory/goods-receipt';
import { createOrder } from '../../src/modules/purchasing/orders';
import { postSupplierInvoice } from '../../src/modules/purchasing/invoice-verification';
import { activeBlockedInvoiceNumbers } from '../../src/modules/purchasing/blocked-invoice';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/purchasing/blocked-invoice';
const ACTOR = 'browser.admin';

/**
 * SCR-162 browser acceptance (T861) — releasing a hold does not post.
 *
 * The production build is the screen under test. MRBR opens it. The alias is
 * not an identifier on the page. A posted unpaid invoice is held, then
 * released. The journal amount does not change. A check writes nothing.
 */
export async function scr162BlockedInvoice(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-162: release a manual hold, and do not post');

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
      values (${client}, 'V-HOLD', 'ORGANIZATION', 'Held supplier', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V-HOLD', 'SUPPLIER', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, created_by)
      values (${client}, 'V-HOLD', 'SUPPLIER', '1000', 'KWD', '001', ${ACTOR})
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
      ) values (${client}, 'V-HOLD', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, 'MAT-HOLD', 'Held material', 'RAW', 'PC', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
      values (${client}, 'MAT-HOLD', '1000', 0, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency, created_by
      ) values (${client}, 'MAT-HOLD', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'KWD', ${ACTOR})
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
    supplierNumber: 'V-HOLD', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
    items: [{
      materialNumber: 'MAT-HOLD', shortText: 'Held material', quantity: 5, unit: 'PC',
      netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '0001',
      markedForDeletion: false,
      scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }],
      assignments: [],
    }],
  });
  await postGoodsReceipt({
    client, changedBy: ACTOR, orderNumber: order.orderNumber,
    documentDate: '2026-10-18', postingDate: '2026-10-18',
    requestKey: `gr-mrbr-${order.orderNumber}`, lines: [{ itemNumber: 10, quantity: 5 }],
  });
  const posted = await postSupplierInvoice({
    client, changedBy: ACTOR, orderNumber: order.orderNumber,
    supplierReference: 'HOLD-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
    grossAmount: 500, requestKey: `iv-mrbr-${order.orderNumber}`,
    lines: [{ itemNumber: 10, quantity: 5, netAmount: 500 }],
  });

  async function standing() {
    return withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`
        select
          (select count(*)::int from supplier_invoice_payment_block where client = ${client}) as blocks,
          (select count(*)::int from supplier_invoice_payment_block_event where client = ${client}) as events,
          (select count(*)::int from journal_entry where client = ${client}) as journals,
          (select gross_amount::text from supplier_invoice where client = ${client} and invoice_number = ${posted.invoiceNumber}) as gross,
          (select coalesce(sum(amount_local), 0)::text from journal_entry_line where client = ${client} and document_number = ${posted.journalDocumentNumber}) as line_amount
      `) as unknown as Array<{ blocks: number; events: number; journals: number; gross: string; line_amount: string }>;
      const blocked = await activeBlockedInvoiceNumbers(tx, client);
      return { ...row, held: blocked.has(posted.invoiceNumber) };
    });
  }

  const before = await standing();
  assert.equal(before.blocks, 0);
  assert.equal(before.held, false);

  await page.locator('#command-input').fill('MRBR');
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/purchasing\/blocked-invoice$/, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Release blocked invoices', exact: true }).waitFor();
  await page.getByText('PROC.INV.BLOCK.RELEASE', { exact: true }).waitFor();
  assert.equal(await page.getByText('MRBR', { exact: true }).count(), 0);
  assert.equal(await page.locator('[name="price"]').count(), 0);
  assert.equal(await page.locator('[name="quantity"]').count(), 0);
  assert.equal(await page.locator('[name="batch"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Post', exact: true }).count(), 0);
  assert.match(await page.locator('[data-blocked-invoice-no-post]').innerText(), /does not post/);
  console.log('  ✓ MRBR opens the hold screen, and the alias is not on the page');

  await page.locator('select[name="companyFrom"]').selectOption('1000');
  await page.getByRole('textbox', { name: 'Fiscal year' }).fill('2026');
  await page.locator('[data-blocked-invoice-list]').click();
  await page.locator('[data-blocked-invoice-empty]').waitFor();
  assert.deepEqual(await standing(), before);
  console.log('  ✓ an unheld invoice is not listed, and nothing is written');

  const place = page.getByRole('region', { name: 'Place hold' });
  await place.locator('[name="invoiceNumber"]').fill(posted.invoiceNumber);
  await place.locator('[name="comment"]').fill('hold for acceptance');
  await place.locator('[data-blocked-invoice-place-check]').click();
  await place.locator('[data-blocked-invoice-notice]').waitFor();
  assert.match(await place.locator('[data-blocked-invoice-notice]').innerText(), /Nothing was written/);
  assert.deepEqual(await standing(), before);
  console.log('  ✓ a check names the hold and writes nothing');

  await place.locator('[name="invoiceNumber"]').fill(posted.invoiceNumber);
  await place.locator('[name="comment"]').fill('hold for acceptance');
  await place.locator('[data-blocked-invoice-place-save]').click();
  await page.locator(`[data-blocked-invoice-row="${posted.invoiceNumber}"]`).waitFor();
  assert.match(await page.locator('[data-blocked-invoice-notice]').first().innerText(), /journal was not changed/i);
  const held = await standing();
  assert.equal(held.blocks, 1);
  assert.equal(held.events, 1);
  assert.equal(held.held, true);
  assert.equal(held.journals, before.journals);
  assert.equal(held.gross, before.gross);
  assert.equal(held.line_amount, before.line_amount);
  assert.match(await page.locator(`[data-blocked-invoice-row="${posted.invoiceNumber}"]`).innerText(), /Manual/);
  assert.match(await page.locator(`[data-blocked-invoice-row="${posted.invoiceNumber}"]`).innerText(), /browser\.admin/);
  console.log(`  ✓ ${posted.invoiceNumber} is held, and the journal did not change`);

  const row = page.locator(`[data-blocked-invoice-row="${posted.invoiceNumber}"]`);
  await row.locator('[name="comment"]').fill('reviewed');
  await row.locator('[data-blocked-invoice-release-check]').click();
  await row.locator('[data-blocked-invoice-notice]').waitFor();
  assert.match(await row.locator('[data-blocked-invoice-notice]').innerText(), /Nothing was written/);
  assert.equal((await standing()).events, 1);
  console.log('  ✓ a release check writes nothing');

  await row.locator('[name="comment"]').fill('reviewed');
  await row.locator('[data-blocked-invoice-release-save]').click();
  await page.getByText(/was released/).waitFor();
  await page.locator('[data-blocked-invoice-events]').waitFor();
  assert.match(await page.locator('#blocked-invoice-events').innerText(), /RELEASE/);
  assert.match(await page.locator('#blocked-invoice-events').innerText(), /browser\.admin/);
  const released = await standing();
  assert.equal(released.held, false);
  assert.equal(released.events, 2);
  assert.equal(released.journals, before.journals);
  assert.equal(released.gross, before.gross);
  assert.equal(released.line_amount, before.line_amount);
  assert.equal(await page.locator(`[data-blocked-invoice-row="${posted.invoiceNumber}"]`).count(), 0);
  console.log('  ✓ the hold was released, and the invoice amount still stands');
}
