import type { Page } from '@playwright/test'; // eslint-disable-line @typescript-eslint/no-unused-vars
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { initializeMaterialPeriodControl } from '../../src/modules/inventory/material-period-control';
import { postGoodsReceipt } from '../../src/modules/inventory/goods-receipt';
import { postSupplierInvoice } from '../../src/modules/purchasing/invoice-verification';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ORDERS = '/purchasing/orders';
const PAYMENT_RUN = '/finance/payment-run';

/**
 * SCR-063 browser acceptance: the payment run.
 *
 * The journey: an order created through the grid, its receipt and
 * invoice posted, then the run created on the payment-run screen, its
 * proposal generated and executed with the house bank — the database
 * remembering the executed run, the payment document and the cleared
 * item.
 */
export async function paymentRunF110(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-063: verify run creation, proposal, execution, clearing, and database evidence');

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
        reconciliation_account, payment_terms_code, payment_methods, created_by
      )
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', 'T', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into payment_method (client, country, method_code, description, allowed_direction, created_by)
      values (${client}, 'KW', 'T', 'Bank transfer', 'OUTGOING', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bank_master (bank_country, bank_key, name, created_by)
      values ('KW', 'NBK001', 'Browser National Bank', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
      values (${client}, '1000', 'HB01', 'KW', 'NBK001', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
      values (${client}, '1000', 'HB01', 'MAIN', '12345678', 'USD', '101000', 'BROWSER_SMOKE') on conflict do nothing
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
    requestKey: 'browser-gr-pay', lines: [{ itemNumber: 10, quantity: 5 }],
  });
  console.log(`  ✓ goods receipt ${receipt.materialDocumentNumber} posted for the order`);
  await postSupplierInvoice({
    client, changedBy: 'BROWSER_SMOKE', orderNumber,
    supplierReference: 'BROW-INV-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
    grossAmount: 500, requestKey: 'browser-iv-pay',
    lines: [{ itemNumber: 10, quantity: 5, netAmount: 500 }],
  });
  console.log('  ✓ supplier invoice posted, a payable of 500 stands');

  await page.goto(`${base}${PAYMENT_RUN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Payment Run', exact: true }).waitFor();
  const params = page.locator('section[aria-labelledby="pr-parameters"]');
  await params.locator('input[name="runDate"]').fill('2026-10-18');
  await params.locator('input[name="runId"]').fill('BROW1');
  await params.locator('input[name="postingDate"]').fill('2026-11-16');
  await params.locator('input[name="documentCutoffDate"]').fill('2026-10-18');
  await params.locator('input[name="nextPaymentDate"]').fill('2026-11-16');
  await params.locator('input[name="companies"]').fill('1000');
  await params.locator('input[name="methods"]').fill('T');
  await params.getByRole('button', { name: 'Save parameters', exact: true }).click();
  await page.getByText(/Payment run 2026-10-18\/BROW1 created\./).waitFor();
  const statusEarly = page.locator('section[aria-labelledby="pr-status"]');
  await statusEarly.locator('input[name="runDate"]').fill('2026-10-18');
  await statusEarly.locator('input[name="runId"]').fill('BROW1');
  await statusEarly.getByRole('button', { name: 'Load run', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await statusEarly.getByText(/stands PARAMETERS/).waitFor();
  console.log('  ✓ the run stands in parameters on the screen');

  await params.getByRole('button', { name: 'Create proposal', exact: true }).click();
  await page.getByText(/Proposal created: 1 payable, 0 exceptions\./).waitFor();
  const proposal = page.locator('section[aria-labelledby="pr-proposal"]');
  await proposal.getByText(/Payable total 500\.00/).waitFor();
  await proposal.getByText('V10000', { exact: true }).waitFor();
  console.log('  ✓ the proposal shows the payable of 500 due for V10000');

  await proposal.locator('input[name="houseBankKey"]').fill('HB01');
  await proposal.locator('input[name="bankAccountId"]').fill('MAIN');
  await proposal.getByRole('button', { name: 'Execute payments', exact: true }).click();
  await page.getByText(/Run executed: 1 payments posted\./).waitFor();

  const status = page.locator('section[aria-labelledby="pr-status"]');
  await status.locator('input[name="runDate"]').fill('2026-10-18');
  await status.locator('input[name="runId"]').fill('BROW1');
  await status.getByRole('button', { name: 'Load run', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await status.getByText(/stands EXECUTED/).waitFor();
  const journalCell = proposal.locator('table').last().locator('tbody tr td').nth(3);
  const journalNumber = (await journalCell.textContent())?.trim() ?? '';
  assert.ok(journalNumber, 'the payment journal number is shown');
  console.log(`  ✓ execution posted payment journal ${journalNumber}`);

  const evidence = await withTenant(client, async (tx) => {
    const run = await tx.execute(sql`
      select status from payment_run
      where client = ${client} and run_date::date = '2026-10-18'::date and run_id = 'BROW1'
    `);
    const payment = await tx.execute(sql`
      select journal_document_number, amount from payment_document
      where client = ${client} and run_id = 'BROW1'
    `);
    const cleared = await tx.execute(sql`
      select clearing_document from journal_entry_line
      where client = ${client} and business_partner = 'V10000' and debit_credit = 'H' and clearing_document is not null
    `);
    return {
      run: (run as unknown as Array<{ status: string }>)[0],
      payment: (payment as unknown as Array<{ journal_document_number: string; amount: string }>)[0],
      cleared: (cleared as unknown as Array<{ clearing_document: string }>)[0],
    };
  });
  assert.equal(evidence.run.status, 'EXECUTED');
  assert.equal(evidence.payment.journal_document_number, journalNumber);
  assert.equal(evidence.cleared.clearing_document, journalNumber);
  console.log('  ✓ the database remembers the executed run, the payment and the cleared item');
}
