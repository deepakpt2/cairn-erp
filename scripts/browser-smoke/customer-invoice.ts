import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const INVOICE = '/finance/customer-invoice';

/**
 * SCR-067 browser acceptance: direct customer invoice posting.
 *
 * The journey: a customer invoice entered on the screen with tax —
 * the balance reconciling before posting — posted as a receivable,
 * loaded back, and cancelled as a linked document, the database
 * remembering.
 */
export async function customerInvoiceFb70(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-067: verify customer invoice posting with tax, the receivable, cancellation, and database evidence');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
    await defineRange(tx, {
      client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: 'BROWSER_SMOKE',
    });
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'C10000', 'ORGANIZATION', 'Browser Customer', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'C10000', 'CUSTOMER', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into customer_company_code (
        client, partner_number, role_code, company_code, chart_of_accounts,
        reconciliation_account, payment_terms_code, created_by
      )
      values (${client}, 'C10000', 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
      values (${client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'TAX', '', '', '240000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });

  await page.goto(`${base}${INVOICE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Enter Customer Invoice', exact: true }).waitFor();
  const lines = page.locator('section[aria-labelledby="ci-lines"]');
  await lines.locator('input[name="customer"]').fill('C10000');
  await lines.locator('input[name="companyCode"]').fill('1000');
  await lines.locator('input[name="currency"]').fill('USD');
  await lines.locator('input[name="reference"]').fill('INV-2026-981');
  await lines.locator('input[name="documentDate"]').fill('2026-10-16');
  await lines.locator('input[name="postingDate"]').fill('2026-10-18');
  await lines.locator('input[name="gl-1"]').fill('300000');
  await lines.locator('input[name="net-1"]').fill('500');
  await lines.locator('select[name="tax-1"]').selectOption('T10');
  await lines.getByText(/Balance: lines net 500\.00 \+ tax 50\.00 = 550\.00/).waitFor();
  console.log('  ✓ the balance reconciles on screen before posting');
  await lines.locator('input[name="grossAmount"]').fill('550');
  await lines.getByRole('button', { name: 'Post invoice', exact: true }).click();
  const posted = lines.getByText(/Invoice posted as document \S+; journal \S+\./);
  await posted.waitFor();
  const invoiceNumber = (await posted.textContent())?.match(/document (\S+);/)?.[1] ?? '';
  assert.ok(invoiceNumber, 'the invoice document number is shown');
  console.log(`  ✓ invoice ${invoiceNumber} posted with its journal`);

  const header = page.locator('section[aria-labelledby="ci-header"]');
  await header.locator('input[name="invoice"]').fill(invoiceNumber);
  await header.getByRole('button', { name: 'Load invoice', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const documentSection = page.locator('section[aria-labelledby="ci-document"]');
  await documentSection.getByText(new RegExp(`Invoice ${invoiceNumber}`)).waitFor();
  await documentSection.getByText(/due 2026-11-15/).waitFor();
  await documentSection.getByRole('button', { name: 'Cancel invoice', exact: true }).click();
  await documentSection.getByText(/Cancellation posted as document/).waitFor();
  console.log('  ✓ the cancellation posts as a linked document');

  const evidence = await withTenant(client, async (tx) => {
    const invoice = await tx.execute(sql`
      select status, cancelled_by, due_date::text as dd from customer_invoice
      where client = ${client} and invoice_number = ${invoiceNumber}
    `);
    const receivable = await tx.execute(sql`
      select count(*)::int as n from journal_entry_line
      where client = ${client} and business_partner = 'C10000' and gl_account = '110000'
    `);
    return {
      invoice: (invoice as unknown as Array<{ status: string; cancelled_by: string; dd: string }>)[0],
      receivable: (receivable as unknown as Array<{ n: number }>)[0],
    };
  });
  assert.equal(evidence.invoice.status, 'CANCELLED');
  assert.ok(evidence.invoice.cancelled_by, 'the original names its cancellation');
  assert.equal(evidence.invoice.dd, '2026-11-15');
  assert.equal(evidence.receivable.n, 2);
  console.log('  ✓ the database remembers the cancelled invoice, its due date and the mirrored receivable');
}
