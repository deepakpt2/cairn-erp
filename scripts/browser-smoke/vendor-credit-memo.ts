import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postVendorInvoice } from '../../src/modules/finance/vendor-invoice';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const MEMO = '/finance/vendor-credit-memo';

/**
 * SCR-076 browser acceptance: vendor credit memo.
 *
 * The journey: a partial credit memo against a standing invoice
 * posts under the judged gross credit — the database holding the
 * memo and its KG journal debiting the vendor at the gross.
 */
export async function vendorCreditMemoFb65(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-076: verify judged gross credit, KG journal debiting the vendor, and database evidence');

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

  const invoice = await postVendorInvoice({
    client, changedBy: 'BROWSER_SMOKE',
    vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18',
    reference: 'BROW-VI-1', currency: 'USD', grossAmount: 550,
    requestKey: `browser-vcm-invoice-${client}`,
    lines: [{ glAccount: '400000', netAmount: 500, taxCode: 'T10' }],
  });

  await page.goto(`${base}${MEMO}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Enter Vendor Credit Memo', exact: true }).waitFor();
  const lines = page.locator('section[aria-labelledby="vm-lines"]');
  await lines.locator('input[name="vendor"]').fill('V10000');
  await chooseClosed(lines, 'companyCode', '1000');
  await chooseClosed(lines, 'currency', 'USD');
  await lines.locator('input[name="reference"]').fill('BROW-CM-1');
  await lines.locator('input[name="documentDate"]').fill('2026-10-20');
  await lines.locator('input[name="postingDate"]').fill('2026-10-20');
  await lines.locator('input[name="creditOf"]').fill(invoice.invoiceNumber);
  await lines.locator('input[name="grossAmount"]').fill('220');
  await lines.locator('input[name="gl-1"]').fill('400000');
  await lines.locator('input[name="net-1"]').fill('200');
  await lines.locator('select[name="tax-1"]').selectOption('T10');
  await lines.getByText(/Balance: lines net 200\.00 \+ tax 20\.00 = 220\.00/).waitFor();
  await lines.getByRole('button', { name: 'Post credit memo', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const done = lines.getByText(/Credit memo posted as document VI-\d+; journal \S+/);
  await done.waitFor();
  const memoNumber = (await done.textContent())?.match(/document (VI-\d+)/)?.[1] ?? '';
  assert.ok(memoNumber, 'the credit memo number is shown');
  console.log(`  ✓ credit memo ${memoNumber} posted at the judged gross credit of 220`);

  const evidence = await withTenant(client, async (tx) => {
    const header = await tx.execute(sql`
      select status, category, credit_of, gross_amount::text as gross, tax_amount::text as tax
      from vendor_invoice where client = ${client} and invoice_number = ${memoNumber}
    `);
    const journal = await tx.execute(sql`
      select document_type from journal_entry
      where client = ${client} and document_number = (
        select journal_document_number from vendor_invoice where client = ${client} and invoice_number = ${memoNumber})
    `);
    const debit = await tx.execute(sql`
      select debit_credit, amount_local::text as amount from journal_entry_line
      where client = ${client} and business_partner = 'V10000'
        and document_number = (
          select journal_document_number from vendor_invoice where client = ${client} and invoice_number = ${memoNumber})
    `);
    return {
      header: (header as unknown as Array<Record<string, unknown>>)[0],
      type: (journal as unknown as Array<{ document_type: string }>)[0]?.document_type,
      debit: (debit as unknown as Array<Record<string, unknown>>)[0],
    };
  });
  assert.equal(evidence.header.status, 'POSTED');
  assert.equal(evidence.header.category, 'CREDIT_MEMO');
  assert.equal(evidence.header.credit_of, invoice.invoiceNumber);
  assert.equal(evidence.header.gross, '220.0000');
  assert.equal(evidence.header.tax, '20.0000');
  assert.equal(evidence.type, 'KG');
  assert.equal(evidence.debit.debit_credit, 'S');
  assert.equal(evidence.debit.amount, '220.0000');
  console.log('  ✓ the database holds the memo, its KG journal, and the 220 debit against the vendor');
}
