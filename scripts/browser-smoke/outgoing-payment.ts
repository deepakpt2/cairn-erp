import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postVendorInvoice } from '../../src/modules/finance/vendor-invoice';
import { postVendorCreditMemo } from '../../src/modules/finance/vendor-credit-memo';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const PAYMENT = '/finance/outgoing-payment';

/**
 * SCR-078 browser acceptance: outgoing payment allocation.
 *
 * The journey: a vendor invoice and its credit memo posted, then
 * the payment allocated against both on the payment screen — the
 * credit item netting the payment to 440, the difference standing
 * at zero before posting — and the items cleared in the database
 * under the clearing date.
 */
export async function outgoingPaymentF53(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-078: verify payables netting, exact allocation, clearing in place, and database evidence');

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
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
      values (${client}, 'KW', 'T10', 'Input tax 10 percent', 'VAT', 10, 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'TAX', '', '', '240000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });
  const invoice = await postVendorInvoice({
    client, changedBy: 'BROWSER_SMOKE', vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18', reference: 'BROW-PAY-1',
    currency: 'USD', grossAmount: 550, requestKey: 'browser-opay-inv-1',
    lines: [{ glAccount: '400000', netAmount: 500, taxCode: 'T10' }],
  });
  await postVendorCreditMemo({
    client, changedBy: 'BROWSER_SMOKE', vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-10-20', postingDate: '2026-10-20', reference: 'BROW-CM-1',
    currency: 'USD', grossAmount: 110, creditOf: invoice.invoiceNumber, requestKey: 'browser-opay-cm-1',
    lines: [{ glAccount: '400000', netAmount: 100, taxCode: 'T10' }],
  });
  console.log('  ✓ a payable of 550 and a credit item of 110 stand open, netting 440');

  await page.goto(`${base}${PAYMENT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Post Outgoing Payment', exact: true }).waitFor();
  const header = page.locator('section[aria-labelledby="op-header"]');
  await header.locator('input[name="companyCode"]').fill('1000');
  await header.locator('input[name="vendor"]').fill('V10000');
  await header.getByRole('button', { name: 'Load open items', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await header.getByText(/2 open items standing at 440\.00/).waitFor();

  const items = page.locator('section[aria-labelledby="op-items"]');
  await items.locator('input[name="documentDate"]').fill('2026-11-20');
  await items.locator('input[name="postingDate"]').fill('2026-11-20');
  await items.locator('input[name="clearingDate"]').fill('2026-11-21');
  await items.locator('input[name="bankAccount"]').fill('101000');
  await items.locator('input[name="amount"]').fill('440');
  await items.locator('input[name="currency"]').fill('USD');
  await items.locator('input[name="reference"]').fill('CHQ-998877');
  const boxes = items.locator('input[name="item"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await items.getByText(/difference 0\.00/).waitFor();
  await items.getByRole('button', { name: 'Post payment', exact: true }).click();
  const posted = page.getByText(/Payment posted as document \S+: 2 items cleared on 2026-11-21\./);
  await posted.waitFor();
  const journalNumber = (await posted.textContent())?.match(/document (\S+):/)?.[1] ?? '';
  assert.ok(journalNumber, 'the payment journal number is shown');
  console.log(`  ✓ payment posted as document ${journalNumber}`);

  const evidence = await withTenant(client, async (tx) => {
    const payment = await tx.execute(sql`
      select items_cleared from outgoing_payment
      where client = ${client} and journal_document_number = ${journalNumber}
    `);
    const cleared = await tx.execute(sql`
      select clearing_date::text as cd from journal_entry_line
      where client = ${client} and business_partner = 'V10000' and clearing_document = ${journalNumber}
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
