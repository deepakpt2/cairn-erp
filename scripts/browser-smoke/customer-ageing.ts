import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postCustomerInvoice } from '../../src/modules/finance/customer-invoice';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const AGEING = '/finance/customer-ageing';

/**
 * SCR-070 browser acceptance: customer ageing.
 *
 * The journey: two customer invoices stand in the ledger, then the
 * ageing screen reconstructs their standing as of the key date and
 * buckets them by due date, with item detail — the database holding
 * exactly the partner lines the figures derived from.
 */
export async function customerAgeingAnalysis(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-070: verify ageing as of the key date, buckets, item detail, and database evidence');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
    await defineRange(tx, { client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: 'BROWSER_SMOKE' });
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
    reference: 'BROW-AGE-1', currency: 'USD', grossAmount: 550, requestKey: 'browser-age-1',
    lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
  });
  await postCustomerInvoice({
    client, changedBy: 'BROWSER_SMOKE', customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18',
    reference: 'BROW-AGE-2', currency: 'USD', grossAmount: 300, requestKey: 'browser-age-2',
    lines: [{ glAccount: '300000', netAmount: 300, taxCode: '' }],
  });
  console.log('  ✓ invoices of 550 and 300, both due 2026-11-15, stand in the ledger');

  await page.goto(`${base}${AGEING}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Customer Ageing', exact: true }).waitFor();
  const selection = page.locator('section[aria-labelledby="ca-selection"]');
  await selection.locator('input[name="companyCode"]').fill('1000');
  await selection.locator('input[name="keyDate"]').fill('2026-12-20');
  await selection.getByRole('button', { name: 'Age the open items', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await selection.getByText(/850\.00 standing open across 1 customers/).waitFor();
  console.log('  ✓ the company stands at 850.00 open as of 2026-12-20');

  const grid = page.locator('section[aria-labelledby="ca-grid"]');
  const customerRow = grid.locator('tbody tr').filter({ hasText: 'C10000' }).first();
  await customerRow.getByText('850.00').first().waitFor();
  await customerRow.getByRole('link', { name: 'C10000' }).click();
  await page.waitForLoadState('networkidle');
  await grid.getByText('Items for C10000').waitFor();
  await grid.locator('tbody tr').filter({ hasText: '35' }).first().waitFor();
  console.log('  ✓ the customer detail shows the items aged by their due dates');

  const evidence = await withTenant(client, async (tx) => {
    const lines = await tx.execute(sql`
      select debit_credit from journal_entry_line
      where client = ${client} and business_partner = 'C10000'
    `);
    return lines as unknown as Array<{ debit_credit: string }>;
  });
  assert.equal(evidence.length, 2);
  assert.equal(evidence.filter((l) => l.debit_credit === 'S').length, 2);
  console.log('  ✓ the database holds the two partner lines the ageing derived from');
}
