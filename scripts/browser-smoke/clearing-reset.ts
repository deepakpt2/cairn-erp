import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postCustomerInvoice } from '../../src/modules/finance/customer-invoice';
import { getReceivables, postIncomingPayment } from '../../src/modules/finance/incoming-payment';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const RESET = '/finance/clearing-reset';

/**
 * SCR-071 browser acceptance: reset cleared items.
 *
 * The journey: two customer invoices are cleared by an incoming
 * payment, then the clearing is displayed on the reset screen and
 * reset with a reason — the items standing open again in the
 * database, the reset standing on its own record, and the clearing
 * document itself unchanged.
 */
export async function clearingResetFbra(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-071: verify clearing display, reset with reason, items reopened, and database evidence');

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
  await postCustomerInvoice({
    client, changedBy: 'BROWSER_SMOKE', customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18', reference: 'BROW-RST-1',
    currency: 'USD', grossAmount: 550, requestKey: 'browser-rst-inv-1',
    lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
  });
  await postCustomerInvoice({
    client, changedBy: 'BROWSER_SMOKE', customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18', reference: 'BROW-RST-2',
    currency: 'USD', grossAmount: 300, requestKey: 'browser-rst-inv-2',
    lines: [{ glAccount: '300000', netAmount: 300 }],
  });
  const view = await getReceivables(client, 'C10000', '1000');
  assert.equal(view.openItems.length, 2);
  const posted = await postIncomingPayment({
    client, changedBy: 'BROWSER_SMOKE', customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-11-20', postingDate: '2026-11-20', clearingDate: '2026-11-21',
    bankGlAccount: '101000', amount: 850, currency: 'USD',
    reference: 'BANK-RST-BROW', requestKey: 'browser-rst-pay-1',
    items: view.openItems.map((i) => ({
      documentNumber: i.documentNumber, fiscalYear: i.fiscalYear, lineNumber: i.lineNumber,
    })),
  });
  const clearingDocument = posted.journalDocumentNumber;
  console.log(`  ✓ two receivables of 550 and 300 stand cleared by ${clearingDocument} on 2026-11-21`);

  await page.goto(`${base}${RESET}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Reset Cleared Items', exact: true }).waitFor();
  const selection = page.locator('section[aria-labelledby="cr-selection"]');
  await selection.locator('input[name="companyCode"]').fill('1000');
  await selection.locator('input[name="clearingDocument"]').fill(clearingDocument);
  await selection.locator('input[name="fiscalYear"]').fill('2026');
  await selection.getByRole('button', { name: 'Display clearing', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const review = page.locator('section[aria-labelledby="cr-review"]');
  await review.getByText(/cleared on 2026-11-21/).waitFor();
  await review.getByText(/2 cleared item\(s\) would stand open again/).waitFor();
  console.log('  ✓ the clearing displays its two cleared items before any reset');

  await review.locator('input[name="reason"]').fill('Payment allocated to the wrong customer account');
  await review.getByRole('button', { name: 'Reset clearing', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const result = page.locator('section[aria-labelledby="cr-result"]');
  const done = result.getByText(/Reset (RST-\d+) stands recorded/);
  await done.waitFor();
  const resetNumber = (await done.textContent())?.match(/Reset (RST-\d+)/)?.[1] ?? '';
  assert.ok(resetNumber, 'the reset number is shown');
  await review.getByText(new RegExp(`This clearing already stands reset by ${resetNumber}`)).waitFor();
  console.log(`  ✓ reset ${resetNumber} stands recorded and the clearing shows as already reset`);

  const evidence = await withTenant(client, async (tx) => {
    const record = await tx.execute(sql`
      select reset_number, clearing_date::text as cd, items_reset, reason from clearing_reset
      where client = ${client} and clearing_document = ${clearingDocument}
    `);
    const stamped = await tx.execute(sql`
      select count(*)::int as n from journal_entry_line
      where client = ${client} and clearing_document = ${clearingDocument}
    `);
    const journal = await tx.execute(sql`
      select status from journal_entry
      where client = ${client} and document_number = ${clearingDocument} and fiscal_year = 2026
    `);
    return {
      record: record as unknown as Array<{ reset_number: string; cd: string; items_reset: number; reason: string }>,
      stamped: (stamped as unknown as Array<{ n: number }>)[0].n,
      status: (journal as unknown as Array<{ status: string }>)[0].status,
    };
  });
  assert.equal(evidence.record.length, 1);
  assert.equal(evidence.record[0].reset_number, resetNumber);
  assert.equal(evidence.record[0].cd, '2026-11-21');
  assert.ok(evidence.record[0].items_reset >= 2);
  assert.ok(evidence.record[0].reason.includes('wrong customer account'));
  assert.equal(evidence.stamped, 0);
  assert.equal(evidence.status, 'POSTED');

  const reopened = await getReceivables(client, 'C10000', '1000');
  assert.equal(reopened.openItems.length, 2);
  assert.equal(reopened.openBalance, 850);
  console.log('  ✓ the database holds the reset record, no stamps remain, and 850.00 stands open again');
}
