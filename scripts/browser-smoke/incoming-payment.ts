import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postCustomerInvoice } from '../../src/modules/finance/customer-invoice';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const PAYMENT = '/finance/incoming-payment';

/**
 * SCR-068 browser acceptance: incoming payment allocation.
 *
 * The journey: two customer invoices posted, then the receipt
 * allocated against both on the payment screen — the difference
 * standing at zero before posting — and the items cleared in the
 * database under the clearing date.
 */
export async function incomingPaymentF28(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-068: verify receivables, exact allocation, clearing in place, and database evidence');

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
    documentDate: '2026-10-16', postingDate: '2026-10-18', reference: 'BROW-PAY-1',
    currency: 'USD', grossAmount: 550, requestKey: 'browser-pay-inv-1',
    lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
  });
  await postCustomerInvoice({
    client, changedBy: 'BROWSER_SMOKE', customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18', reference: 'BROW-PAY-2',
    currency: 'USD', grossAmount: 300, requestKey: 'browser-pay-inv-2',
    lines: [{ glAccount: '300000', netAmount: 300 }],
  });
  console.log('  ✓ two receivables of 550 and 300 stand open');

  await page.goto(`${base}${PAYMENT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Post Incoming Payment', exact: true }).waitFor();
  const header = page.locator('section[aria-labelledby="ip-header"]');
  await chooseClosed(header, 'companyCode', '1000');
  await header.locator('input[name="customer"]').fill('C10000');
  await header.getByRole('button', { name: 'Load open items', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await header.getByText(/2 open items standing at 850\.00/).waitFor();

  const items = page.locator('section[aria-labelledby="ip-items"]');
  await items.locator('input[name="documentDate"]').fill('2026-11-20');
  await items.locator('input[name="postingDate"]').fill('2026-11-20');
  await items.locator('input[name="clearingDate"]').fill('2026-11-21');
  await items.locator('input[name="bankAccount"]').fill('101000');
  await items.locator('input[name="amount"]').fill('850');
  await chooseClosed(items, 'currency', 'USD');
  await items.locator('input[name="reference"]').fill('BANK-REF-001');
  const boxes = items.locator('input[name="item"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  // The screen's own balance readout: the two open items settle exactly what was entered.
  await items.getByText(/Allocated 850\.00 · unassigned 0\.00\./).waitFor();
  await items.getByRole('button', { name: 'Post payment', exact: true }).click();
  const posted = page.getByText(/Payment posted as document \S+: 2 items cleared on 2026-11-21\./);
  await posted.waitFor();
  const journalNumber = (await posted.textContent())?.match(/document (\S+):/)?.[1] ?? '';
  assert.ok(journalNumber, 'the payment journal number is shown');
  console.log(`  ✓ payment posted as document ${journalNumber}`);

  const evidence = await withTenant(client, async (tx) => {
    const payment = await tx.execute(sql`
      select items_cleared from incoming_payment
      where client = ${client} and journal_document_number = ${journalNumber}
    `);
    const cleared = await tx.execute(sql`
      select clearing_date::text as cd from journal_entry_line
      where client = ${client} and business_partner = 'C10000' and clearing_document = ${journalNumber}
    `);
    return {
      payment: (payment as unknown as Array<{ items_cleared: number }>)[0],
      cleared: cleared as unknown as Array<{ cd: string }>,
    };
  });
  assert.equal(evidence.payment.items_cleared, 2);
  assert.ok(evidence.cleared.length >= 2);
  assert.ok(evidence.cleared.every((r) => r.cd === '2026-11-21'));
  console.log('  ✓ the database remembers the payment and the items cleared on 2026-11-21');
}
