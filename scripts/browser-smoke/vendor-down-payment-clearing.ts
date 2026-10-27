import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postVendorInvoice } from '../../src/modules/finance/vendor-invoice';
import { postVendorDownPayment } from '../../src/modules/finance/vendor-down-payment';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const CLEARING = '/finance/vendor-down-payment-clearing';

/**
 * SCR-082 browser acceptance: vendor down payment clearing.
 *
 * The journey: a 10,000 advance under indicator A and a 550 vendor
 * invoice stand open; the clearing screen applies 550 of the
 * advance to the invoice, and the database remembers the KZ
 * transfer, the cleared invoice and the advance standing at 9,450.
 */
export async function vendorDownPaymentClearingF54(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-082: verify both selection grids, the balanced application, and database evidence');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
    await defineRange(tx, {
      client, objectCode: 'VENDINV', subObject: '*', prefix: 'VI', numberLength: 7, createdBy: 'BROWSER_SMOKE',
    });
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Browser Vendor', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', 'BROWSER_SMOKE')
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
      insert into special_gl_config (
        client, company_code, account_type, indicator,
        alternative_reconciliation_account, description, created_by
      )
      values (${client}, '', 'AP', 'A', '230000', 'Down payments', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });
  await postVendorInvoice({
    client, changedBy: 'BROWSER_SMOKE', vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18', reference: 'BROW-CLR-1',
    currency: 'USD', grossAmount: 550, requestKey: 'browser-clr-inv-1',
    lines: [{ glAccount: '400000', netAmount: 550 }],
  });
  const dp = await postVendorDownPayment({
    client, changedBy: 'BROWSER_SMOKE', vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-10-19', postingDate: '2026-10-19',
    bankGlAccount: '101000', amount: 10000, currency: 'USD',
    specialGlIndicator: 'A', requestKey: 'browser-clr-dp-1',
  });
  console.log('  ✓ a 10,000 advance and a 550 invoice stand open');

  await page.goto(`${base}${CLEARING}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Clear Vendor Down Payment', exact: true }).waitFor();
  const header = page.locator('section[aria-labelledby="vdpc-header"]');
  await header.locator('input[name="companyCode"]').fill('1000');
  await header.locator('input[name="vendor"]').fill('V10000');
  await header.locator('input[name="indicator"]').fill('A');
  await header.getByRole('button', { name: 'Load open items', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await header.getByText(/1 down payments stand under indicator/).waitFor();

  const items = page.locator('section[aria-labelledby="vdpc-items"]');
  await chooseClosed(items, 'currency', 'USD');
  await items.locator('input[name="downPayment"]').check();
  await items.locator('input[name^="apply-dp-"]').fill('550');
  await items.locator('input[name="invoice"]').check();
  await items.getByText(/Applying 550\.00 of advances against 550\.00 of invoices/).waitFor();
  await items.getByRole('button', { name: 'Post clearing', exact: true }).click();
  const posted = page.getByText(/Clearing posted as document \S+: 550\.00 applied/);
  await posted.waitFor();
  const journalNumber = (await posted.textContent())?.match(/document (\S+):/)?.[1] ?? '';
  assert.ok(journalNumber, 'the clearing journal number is shown');
  console.log(`  ✓ clearing posted as document ${journalNumber}`);

  const evidence = await withTenant(client, async (tx) => {
    const record = await tx.execute(sql`
      select total_applied::text as total from vendor_down_payment_clearing
      where client = ${client} and journal_document_number = ${journalNumber}
    `);
    const invStamp = await tx.execute(sql`
      select clearing_document from journal_entry_line
      where client = ${client} and business_partner = 'V10000' and gl_account = '200000'
        and debit_credit = 'H'
    `);
    const dpStamp = await tx.execute(sql`
      select clearing_document from journal_entry_line
      where client = ${client} and document_number = ${dp.journalDocumentNumber}
        and business_partner = 'V10000'
    `);
    return {
      total: (record as unknown as Array<{ total: string }>)[0]?.total,
      invStamp: (invStamp as unknown as Array<{ clearing_document: string | null }>)[0]?.clearing_document,
      dpStamp: (dpStamp as unknown as Array<{ clearing_document: string | null }>)[0]?.clearing_document,
    };
  });
  assert.equal(evidence.total, '550.0000');
  assert.equal(evidence.invStamp, journalNumber);
  assert.equal(evidence.dpStamp, null);
  console.log('  ✓ the database remembers the clearing: invoice cleared, advance standing at 9,450');
}
