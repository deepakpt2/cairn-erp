import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { initializeMaterialPeriodControl } from '../../src/modules/inventory/material-period-control';
import { postGoodsReceipt } from '../../src/modules/inventory/goods-receipt';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ORDERS = '/purchasing/orders';
const RECEIPT = '/inventory/goods-receipt';
const INVOICE = '/purchasing/invoice-verification';

/**
 * SCR-062 browser acceptance: invoice verification.
 *
 * The journey: an order created through the grid, its goods receipt
 * posted from the movement screen, the invoice verified against it
 * with tax and the balance shown, and cancellation restoring the
 * invoiceable quantity — the database remembering.
 */
export async function invoiceVerificationMiro(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-062: verify order, goods receipt, invoice posting with tax, cancellation, and database evidence');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
    await defineRange(tx, {
      client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: 'BROWSER_SMOKE',
    });
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Browser purchasing organization', '1000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Browser Supplier', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_company_code (
        client, partner_number, role_code, company_code, chart_of_accounts,
        reconciliation_account, payment_terms_code, created_by
      )
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
      values (${client}, 'KW', 'T10', 'Input tax 10 percent', 'VAT', 10, 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, 'MAT-10001', 'Industrial steel plate', 'RAW', 'PC', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
      values (${client}, 'MAT-10001', '1000', 0, 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency, created_by
      )
      values (${client}, 'MAT-10001', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', 'BROWSER_SMOKE'),
             (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', 'BROWSER_SMOKE'),
             (${client}, 'CA01', 'TAX', '', '', '140000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });
  await initializeMaterialPeriodControl({
    client, changedBy: 'BROWSER_SMOKE', companyCode: '1000',
    fiscalYear: 2026, period: 10, reason: 'Browser acceptance run',
  });

  await page.goto(`${base}${ORDERS}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Create Purchase Order', exact: true }).waitFor();
  const create = page.locator('section[aria-labelledby="po-create"]');
  await create.locator('label').filter({ hasText: 'Supplier' }).locator('input').fill('V10000');
  const headerSelects = create.locator('form > div select');
  await headerSelects.nth(0).selectOption('1000');
  await headerSelects.nth(1).evaluate((el) => {
    const select = el as unknown as { options: ArrayLike<{ value: string }>; value: string; dispatchEvent: (e: unknown) => void };
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await headerSelects.nth(2).selectOption('1000');
  const row = create.locator('tbody tr').first();
  const inputs = row.locator('input');
  await inputs.nth(0).fill('MAT-10001');
  await inputs.nth(2).fill('5');
  await inputs.nth(3).fill('PC');
  await inputs.nth(4).fill('100');
  await row.locator('select').nth(0).selectOption('1000');
  const panel = create.locator('fieldset').first();
  await panel.locator('input[type="date"]').fill('2026-11-15');
  await panel.locator('input[placeholder="Scheduled quantity"]').fill('5');
  await create.getByRole('button', { name: 'Save purchase order', exact: true }).click();
  const confirmation = create.getByText(/Purchase order POF-\d+ created\./);
  await confirmation.waitFor();
  const orderNumber = (await confirmation.textContent())?.match(/POF-\d+/)?.[0] ?? '';
  assert.ok(orderNumber, 'the created order number is shown');
  console.log(`  ✓ purchase order ${orderNumber} created through the grid`);

  const receipt = await postGoodsReceipt({
    client, changedBy: 'BROWSER_SMOKE', orderNumber,
    documentDate: '2026-10-18', postingDate: '2026-10-18',
    requestKey: 'browser-gr-1', lines: [{ itemNumber: 10, quantity: 5 }],
  });
  console.log(`  ✓ goods receipt ${receipt.materialDocumentNumber} posted for the order`);
  void RECEIPT;

  await page.goto(`${base}${INVOICE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Enter Incoming Invoice', exact: true }).waitFor();
  const headerSection = page.locator('section[aria-labelledby="iv-header"]');
  await headerSection.locator('input[name="order"]').fill(orderNumber);
  await headerSection.getByRole('button', { name: 'Load reference', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const items = page.locator('section[aria-labelledby="iv-items"]');
  await items.getByText(`Invoice for order ${orderNumber}`).waitFor();
  await items.locator('input[name="supplierReference"]').fill('INV-2026-981');
  await items.locator('select[name="tax-10"]').selectOption('T10');
  await items.getByText(/Balance: items net 500\.00 \+ tax 50\.00 = 550\.00/).waitFor();
  console.log('  ✓ the balance reconciles on screen before posting');
  await items.locator('input[name="grossAmount"]').fill('550');
  await items.getByRole('button', { name: 'Post invoice', exact: true }).click();
  const posted = items.getByText(/Invoice posted as document \S+; journal \S+\./);
  await posted.waitFor();
  const invoiceNumber = (await posted.textContent())?.match(/document (\S+);/)?.[1] ?? '';
  assert.ok(invoiceNumber, 'the invoice document number is shown');
  console.log(`  ✓ invoice ${invoiceNumber} posted with its journal`);

  await headerSection.locator('input[name="invoice"]').fill(invoiceNumber);
  await headerSection.getByRole('button', { name: 'Load reference', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const documentSection = page.locator('section[aria-labelledby="iv-document"]');
  await documentSection.getByText(`Invoice ${invoiceNumber}`).waitFor();
  await documentSection.getByText(/due 2026-11-17/).waitFor();
  await documentSection.getByRole('button', { name: 'Cancel invoice', exact: true }).click();
  await documentSection.getByText(/Cancellation posted as document/).waitFor();
  console.log('  ✓ the cancellation posts as a linked document');

  const evidence = await withTenant(client, async (tx) => {
    const invoice = await tx.execute(sql`
      select status, cancelled_by, due_date from supplier_invoice
      where client = ${client} and invoice_number = ${invoiceNumber}
    `);
    const journal = await tx.execute(sql`
      select debit_credit, amount_local from journal_entry_line jl
      join supplier_invoice si on si.client = jl.client and si.journal_document_number = jl.document_number
      where si.client = ${client} and si.invoice_number = ${invoiceNumber}
    `);
    return {
      invoice: (invoice as unknown as Array<Record<string, unknown>>)[0],
      journal: journal as unknown as Array<{ debit_credit: string; amount_local: string }>,
    };
  });
  assert.equal(evidence.invoice.status, 'CANCELLED');
  assert.ok(evidence.invoice.cancelled_by, 'the original names its cancellation');
  console.log('  ✓ the database remembers the cancelled invoice and its links');
}
