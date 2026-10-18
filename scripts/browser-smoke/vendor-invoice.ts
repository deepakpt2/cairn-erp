import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const INVOICE = '/finance/vendor-invoice';

/**
 * SCR-075 browser acceptance: direct vendor invoice.
 *
 * The journey: the header and one taxed expense line post under
 * the judged gross — the database holding the VI invoice and its
 * KR journal crediting the vendor at the gross as an open payable.
 */
export async function vendorInvoiceFb60(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-075: verify judged gross, KR journal crediting the vendor, and database evidence');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
    await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: 'VI', numberLength: 7, createdBy: 'BROWSER_SMOKE' });
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Browser Vendor', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, 'BROWSER_SMOKE') on conflict do nothing
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
      values (${client}, 'KW', 'T10', 'Input tax 10 percent', 'VAT', 10, 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'TAX', '', '', '240000', 'BROWSER_SMOKE') on conflict do nothing
    `);
  });

  await page.goto(`${base}${INVOICE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Enter Vendor Invoice', exact: true }).waitFor();
  const lines = page.locator('section[aria-labelledby="vi-lines"]');
  await lines.locator('input[name="vendor"]').fill('V10000');
  await lines.locator('input[name="companyCode"]').fill('1000');
  await lines.locator('input[name="currency"]').fill('USD');
  await lines.locator('input[name="reference"]').fill('BROW-VI-1');
  await lines.locator('input[name="documentDate"]').fill('2026-10-16');
  await lines.locator('input[name="postingDate"]').fill('2026-10-18');
  await lines.locator('input[name="grossAmount"]').fill('550');
  await lines.locator('input[name="gl-1"]').fill('400000');
  await lines.locator('input[name="net-1"]').fill('500');
  await lines.locator('select[name="tax-1"]').selectOption('T10');
  await lines.getByText(/Balance: lines net 500\.00 \+ tax 50\.00 = 550\.00/).waitFor();
  await lines.getByRole('button', { name: 'Post invoice', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const done = lines.getByText(/Invoice posted as document VI-\d+; journal \S+/);
  await done.waitFor();
  const invoiceNumber = (await done.textContent())?.match(/document (VI-\d+)/)?.[1] ?? '';
  assert.ok(invoiceNumber, 'the invoice number is shown');
  console.log(`  ✓ invoice ${invoiceNumber} posted at the judged gross of 550`);

  const evidence = await withTenant(client, async (tx) => {
    const header = await tx.execute(sql`
      select status, gross_amount::text as gross, tax_amount::text as tax, due_date::text as due, journal_document_number
      from vendor_invoice where client = ${client} and invoice_number = ${invoiceNumber}
    `);
    const journal = await tx.execute(sql`
      select document_type from journal_entry
      where client = ${client} and document_number = (
        select journal_document_number from vendor_invoice where client = ${client} and invoice_number = ${invoiceNumber})
    `);
    const payable = await tx.execute(sql`
      select debit_credit, amount_local::text as amount from journal_entry_line
      where client = ${client} and business_partner = 'V10000' and clearing_document is null
    `);
    return {
      header: (header as unknown as Array<Record<string, unknown>>)[0],
      type: (journal as unknown as Array<{ document_type: string }>)[0]?.document_type,
      payable: (payable as unknown as Array<Record<string, unknown>>)[0],
    };
  });
  assert.equal(evidence.header.status, 'POSTED');
  assert.equal(evidence.header.gross, '550.0000');
  assert.equal(evidence.header.tax, '50.0000');
  assert.equal(evidence.header.due, '2026-11-15');
  assert.equal(evidence.type, 'KR');
  assert.equal(evidence.payable.debit_credit, 'H');
  assert.equal(evidence.payable.amount, '550.0000');
  console.log('  ✓ the database holds the invoice, its KR journal, and the open payable of 550');
}
