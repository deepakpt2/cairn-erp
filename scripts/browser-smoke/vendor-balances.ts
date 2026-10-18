import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { derivePosition, getCompanyCode } from '../../src/platform/periods';
import { postJournalEntry } from '../../src/platform/posting';
import { initializeMaterialPeriodControl } from '../../src/modules/inventory/material-period-control';
import { postGoodsReceipt } from '../../src/modules/inventory/goods-receipt';
import { postSupplierInvoice } from '../../src/modules/purchasing/invoice-verification';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ORDERS = '/purchasing/orders';
const BALANCES = '/finance/vendor-balances';

/**
 * SCR-064 browser acceptance: vendor open-item clearing.
 *
 * The journey: an order through the grid, its receipt and invoice,
 * a manual payment standing as the debit item, then both items
 * cleared on the clearing screen under three distinct dates — the
 * database remembering the clearing document and its date.
 */
export async function vendorBalancesFk10n(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-065: verify period balances derived from the ledger, drill-down, and database evidence');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
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
             (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', 'BROWSER_SMOKE')
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
  await inputs.nth(2).fill('8');
  await inputs.nth(3).fill('PC');
  await inputs.nth(4).fill('100');
  await row.locator('select').nth(0).selectOption('1000');
  const panel = create.locator('fieldset').first();
  await panel.locator('input[type="date"]').fill('2026-11-15');
  await panel.locator('input[placeholder="Scheduled quantity"]').fill('8');
  await create.getByRole('button', { name: 'Save purchase order', exact: true }).click();
  const confirmation = create.getByText(/Purchase order POF-\d+ created\./);
  await confirmation.waitFor();
  const orderNumber = (await confirmation.textContent())?.match(/POF-\d+/)?.[0] ?? '';
  assert.ok(orderNumber, 'the created order number is shown');
  console.log(`  ✓ purchase order ${orderNumber} created through the grid`);

  const receipt = await postGoodsReceipt({
    client, changedBy: 'BROWSER_SMOKE', orderNumber,
    documentDate: '2026-10-18', postingDate: '2026-10-18',
    requestKey: 'browser-gr-bal', lines: [{ itemNumber: 10, quantity: 8 }],
  });
  console.log(`  ✓ goods receipt ${receipt.materialDocumentNumber} posted for the order`);
  await postSupplierInvoice({
    client, changedBy: 'BROWSER_SMOKE', orderNumber,
    supplierReference: 'BROW-BAL-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
    grossAmount: 500, requestKey: 'browser-iv-bal',
    lines: [{ itemNumber: 10, quantity: 5, netAmount: 500 }],
  });
  await postSupplierInvoice({
    client, changedBy: 'BROWSER_SMOKE', orderNumber,
    supplierReference: 'BROW-BAL-2', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
    grossAmount: 300, requestKey: 'browser-iv-bal-2',
    lines: [{ itemNumber: 10, quantity: 3, netAmount: 300 }],
  });
  await withTenant(client, async (tx) => {
    const company = await getCompanyCode(tx, client, '1000');
    const position = await derivePosition(tx, client, company!.fiscalYearVariant!, '2026-10-20');
    await postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'KZ',
      documentDate: '2026-10-20', postingDate: '2026-10-20',
      fiscalYear: position.fiscalYear, postingPeriod: position.period,
      currency: 'USD', localCurrency: company!.currency,
      reference: 'MANUAL-PAYMENT',
      lines: [
        { glAccount: '200000', debitCredit: 'S', amount: '500.00', businessPartner: 'V10000' },
        { glAccount: '101000', debitCredit: 'H', amount: '500.00' },
      ],
      postedBy: 'BROWSER_SMOKE', transactionCode: 'FIN.AP.CLEAR',
    });
  });
  console.log('  ✓ invoices of 500 and 300 and a payment of 500 stand in the ledger');

  await page.goto(`${base}${BALANCES}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Vendor Balances', exact: true }).waitFor();
  const selection = page.locator('section[aria-labelledby="vb-selection"]');
  await selection.locator('input[name="supplier"]').fill('V10000');
  await selection.locator('input[name="companyCode"]').fill('1000');
  await selection.locator('input[name="fiscalYear"]').fill('2026');
  await selection.getByRole('button', { name: 'Display balances', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await selection.getByText(/closing balance -300\.00/).waitFor();
  console.log('  ✓ the year closes at -300.00 derived from the ledger');

  const matrix = page.locator('section[aria-labelledby="vb-matrix"]');
  const octoberRow = matrix.locator('tbody tr').filter({ hasText: '-300.00' }).first();
  await octoberRow.getByText('800.00').waitFor();
  await octoberRow.locator('a').click();
  await page.waitForLoadState('networkidle');
  const itemsSection = page.locator('section[aria-labelledby="vb-items"]');
  await itemsSection.locator('tbody tr').nth(2).waitFor();
  console.log('  ✓ period 10 drills down to its three line items');

  const evidence = await withTenant(client, async (tx) => {
    const lines = await tx.execute(sql`
      select debit_credit from journal_entry_line
      where client = ${client} and business_partner = 'V10000'
    `);
    return lines as unknown as Array<{ debit_credit: string }>;
  });
  assert.equal(evidence.length, 3);
  assert.equal(evidence.filter((l) => l.debit_credit === 'H').length, 2);
  console.log('  ✓ the database holds the three partner lines the balances derived from');
}
