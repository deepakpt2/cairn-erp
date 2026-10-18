import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postJournalEntry } from '../../src/platform/posting';
import { postCustomerInvoice } from '../../src/modules/finance/customer-invoice';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const CLEARING = '/finance/customer-clearing';

/**
 * SCR-073 browser acceptance: clear customer open items.
 *
 * The journey: a customer invoice and a manual receipt stand open,
 * the grid shows their signed sum at zero, and the confirmed
 * clearing posts one DZ journal that stamps both items in place
 * under three distinct dates.
 */
export async function customerClearingF32(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-073: verify open-item grid, DZ clearing under three dates, and database evidence');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
    await defineRange(tx, { client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: 'BROWSER_SMOKE' });
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'C10000', 'ORGANIZATION', 'Browser Customer', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'C10000', 'CUSTOMER', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, 'BROWSER_SMOKE') on conflict do nothing
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
      values (${client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'TAX', '', '', '240000', 'BROWSER_SMOKE') on conflict do nothing
    `);
  });

  await postCustomerInvoice({
    client, changedBy: 'BROWSER_SMOKE', customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18',
    reference: 'BROW-CC-1', currency: 'USD', grossAmount: 550, requestKey: 'browser-cc-inv',
    lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
  });
  await withTenant(client, async (tx) => {
    await postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'DZ',
      documentDate: '2026-10-20', postingDate: '2026-10-20',
      fiscalYear: 2026, postingPeriod: 10,
      currency: 'USD', localCurrency: 'USD', reference: 'BROW-CC-RCPT',
      lines: [
        { glAccount: '101000', debitCredit: 'S', amount: '550.00' },
        { glAccount: '110000', debitCredit: 'H', amount: '550.00', businessPartner: 'C10000' },
      ],
      postedBy: 'BROWSER_SMOKE', transactionCode: 'FIN.AR.CLEAR',
    });
  });
  console.log('  ✓ an invoice of 550 and a receipt of 550 stand open');

  await page.goto(`${base}${CLEARING}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Clear Customer Open Items', exact: true }).waitFor();
  const selection = page.locator('section[aria-labelledby="cc-selection"]');
  await selection.locator('input[name="customer"]').fill('C10000');
  await selection.locator('input[name="companyCode"]').fill('1000');
  await selection.getByRole('button', { name: 'Load open items', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await selection.getByText(/2 open items standing at 0\.00/).waitFor();

  const items = page.locator('section[aria-labelledby="cc-items"]');
  await items.locator('tbody tr').nth(1).waitFor();
  await items.getByText(/difference 0\.00/).waitFor();
  const boxes = items.locator('input[name="item"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await items.locator('input[name="clearingDate"]').fill('2026-11-21');
  await items.locator('input[name="postingDate"]').fill('2026-11-20');
  await items.locator('input[name="documentDate"]').fill('2026-11-19');
  await items.locator('input[name="confirmed"]').check();
  await items.getByRole('button', { name: 'Post clearing', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const done = selection.getByText(/Clearing posted as document .*2 items cleared on 2026-11-21/);
  await done.waitFor();
  const clearingDocument = (await done.textContent())?.match(/Clearing posted as document (\S+):/)?.[1] ?? '';
  assert.ok(clearingDocument, 'the clearing document number is shown');
  console.log(`  ✓ clearing ${clearingDocument} posted for two items on 2026-11-21`);

  const evidence = await withTenant(client, async (tx) => {
    const journal = await tx.execute(sql`
      select document_type, document_date::text as dd, posting_date::text as pd, posting_period
      from journal_entry
      where client = ${client} and document_number = ${clearingDocument} and fiscal_year = 2026
    `);
    const stamped = await tx.execute(sql`
      select count(*)::int as n from journal_entry_line
      where client = ${client} and clearing_document = ${clearingDocument}
        and clearing_date = '2026-11-21' and business_partner = 'C10000'
    `);
    const open = await tx.execute(sql`
      select count(*)::int as n from journal_entry_line
      where client = ${client} and business_partner = 'C10000' and clearing_document is null
    `);
    return {
      journal: (journal as unknown as Array<Record<string, unknown>>)[0],
      stamped: (stamped as unknown as Array<{ n: number }>)[0].n,
      open: (open as unknown as Array<{ n: number }>)[0].n,
    };
  });
  assert.equal(evidence.journal.document_type, 'DZ');
  assert.equal(evidence.journal.dd, '2026-11-19');
  assert.equal(evidence.journal.pd, '2026-11-20');
  assert.equal(evidence.journal.posting_period, 11);
  assert.equal(evidence.stamped, 4);
  assert.equal(evidence.open, 0);
  console.log('  ✓ the database holds the DZ clearing and four stamped partner lines, none open');
}
