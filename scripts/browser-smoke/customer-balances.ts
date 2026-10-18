import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { derivePosition, getCompanyCode } from '../../src/platform/periods';
import { postJournalEntry } from '../../src/platform/posting';
import { postCustomerInvoice } from '../../src/modules/finance/customer-invoice';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const BALANCES = '/finance/customer-balances';

/**
 * SCR-069 browser acceptance: customer balances.
 *
 * The journey: two customer invoices and a manual receipt stand in
 * the ledger, then the balances screen derives the period matrix
 * from them and drills into the period's line items — the database
 * holding exactly the partner lines the figures derived from.
 */
export async function customerBalancesFd10n(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-069: verify period balances derived from the ledger, drill-down, and database evidence');

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
    reference: 'BROW-CB-1', currency: 'USD', grossAmount: 550, requestKey: 'browser-cb-1',
    lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
  });
  await postCustomerInvoice({
    client, changedBy: 'BROWSER_SMOKE', customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18',
    reference: 'BROW-CB-2', currency: 'USD', grossAmount: 300, requestKey: 'browser-cb-2',
    lines: [{ glAccount: '300000', netAmount: 300, taxCode: '' }],
  });
  await withTenant(client, async (tx) => {
    const company = await getCompanyCode(tx, client, '1000');
    const position = await derivePosition(tx, client, company!.fiscalYearVariant!, '2026-10-20');
    await postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'DZ',
      documentDate: '2026-10-20', postingDate: '2026-10-20',
      fiscalYear: position.fiscalYear, postingPeriod: position.period,
      currency: 'USD', localCurrency: company!.currency,
      reference: 'MANUAL-RECEIPT',
      lines: [
        { glAccount: '101000', debitCredit: 'S', amount: '550.00' },
        { glAccount: '110000', debitCredit: 'H', amount: '550.00', businessPartner: 'C10000' },
      ],
      postedBy: 'BROWSER_SMOKE', transactionCode: 'FIN.AR.BALANCE',
    });
  });
  console.log('  ✓ invoices of 550 and 300 and a receipt of 550 stand in the ledger');

  await page.goto(`${base}${BALANCES}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Customer Balances', exact: true }).waitFor();
  const selection = page.locator('section[aria-labelledby="cb-selection"]');
  await selection.locator('input[name="customer"]').fill('C10000');
  await selection.locator('input[name="companyCode"]').fill('1000');
  await selection.locator('input[name="fiscalYear"]').fill('2026');
  await selection.getByRole('button', { name: 'Display balances', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await selection.getByText(/closing balance 300\.00/).waitFor();
  console.log('  ✓ the year closes at 300.00 derived from the ledger');

  const matrix = page.locator('section[aria-labelledby="cb-matrix"]');
  const octoberRow = matrix.locator('tbody tr').filter({ hasText: '300.00' }).first();
  await octoberRow.getByText('850.00').waitFor();
  await octoberRow.locator('a').click();
  await page.waitForLoadState('networkidle');
  const itemsSection = page.locator('section[aria-labelledby="cb-items"]');
  await itemsSection.locator('tbody tr').nth(2).waitFor();
  console.log('  ✓ period 10 drills down to its three line items');

  const evidence = await withTenant(client, async (tx) => {
    const lines = await tx.execute(sql`
      select debit_credit from journal_entry_line
      where client = ${client} and business_partner = 'C10000'
    `);
    return lines as unknown as Array<{ debit_credit: string }>;
  });
  assert.equal(evidence.length, 3);
  assert.equal(evidence.filter((l) => l.debit_credit === 'S').length, 2);
  console.log('  ✓ the database holds the three partner lines the balances derived from');
}
