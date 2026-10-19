import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postCustomerInvoice } from '../../src/modules/finance/customer-invoice';
import { postCustomerDownPayment } from '../../src/modules/finance/customer-down-payment';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const CLEARING = '/finance/customer-down-payment-clearing';

/**
 * SCR-084 browser acceptance: customer down payment clearing.
 *
 * The journey: an 8,000 advance under indicator A and a 1,200
 * customer invoice stand open; the clearing screen allocates 1,000
 * of the advance to the invoice, and the database remembers the DZ
 * transfer and its allocation mapping row.
 */
export async function customerDownPaymentClearingF39(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-084: verify both selection grids, the pairwise allocation, and database evidence');

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
      insert into special_gl_config (
        client, company_code, account_type, indicator,
        alternative_reconciliation_account, description, created_by
      )
      values (${client}, '', 'AR', 'A', '230000', 'Customer advances', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });
  await postCustomerInvoice({
    client, changedBy: 'BROWSER_SMOKE', customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-16', postingDate: '2026-10-18', reference: 'BROW-CDC-1',
    currency: 'USD', grossAmount: 1200, requestKey: 'browser-cdc-inv-1',
    lines: [{ glAccount: '300000', netAmount: 1200 }],
  });
  const dp = await postCustomerDownPayment({
    client, changedBy: 'BROWSER_SMOKE', customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-19', postingDate: '2026-10-19',
    bankGlAccount: '101000', amount: 8000, currency: 'USD',
    specialGlIndicator: 'A', requestKey: 'browser-cdc-dp-1',
  });
  console.log('  ✓ an 8,000 advance and a 1,200 invoice stand open');

  await page.goto(`${base}${CLEARING}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Clear Customer Down Payment', exact: true }).waitFor();
  const header = page.locator('section[aria-labelledby="cdpc-header"]');
  await header.locator('input[name="companyCode"]').fill('1000');
  await header.locator('input[name="customer"]').fill('C10000');
  await header.locator('input[name="indicator"]').fill('A');
  await header.getByRole('button', { name: 'Load open items', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await header.getByText(/1 down payments stand under indicator/).waitFor();

  const items = page.locator('section[aria-labelledby="cdpc-items"]');
  await items.locator('input[name="currency"]').fill('USD');
  await items.getByRole('button', { name: 'Add allocation', exact: true }).click();
  await items.getByLabel('Down payment', { exact: true }).selectOption({ index: 1 });
  await items.getByLabel('Invoice', { exact: true }).selectOption({ index: 1 });
  await items.getByLabel('Allocation amount', { exact: true }).fill('1000');
  await items.getByText(/Allocating 1000\.00 of advances against invoices/).waitFor();
  await items.getByRole('button', { name: 'Post clearing', exact: true }).click();
  const posted = page.getByText(/Clearing posted as document \S+: 1000\.00 applied/);
  await posted.waitFor();
  const journalNumber = (await posted.textContent())?.match(/document (\S+):/)?.[1] ?? '';
  assert.ok(journalNumber, 'the clearing journal number is shown');
  console.log(`  ✓ clearing posted as document ${journalNumber}`);

  const evidence = await withTenant(client, async (tx) => {
    const record = await tx.execute(sql`
      select total_applied::text as total from customer_down_payment_clearing
      where client = ${client} and journal_document_number = ${journalNumber}
    `);
    const mapping = await tx.execute(sql`
      select down_payment_document_number as dp, allocated_amount::text as amount
      from customer_down_payment_clearing_item
      where client = ${client} and clearing_number = ${journalNumber}
    `);
    const lines = await tx.execute(sql`
      select gl_account, debit_credit from journal_entry_line
      where client = ${client} and document_number = ${journalNumber} order by line_number
    `);
    return {
      total: (record as unknown as Array<{ total: string }>)[0]?.total,
      mapping: mapping as unknown as Array<{ dp: string; amount: string }>,
      lines: lines as unknown as Array<{ gl_account: string; debit_credit: string }>,
    };
  });
  assert.equal(evidence.total, '1000.0000');
  assert.deepEqual(
    evidence.mapping.map((m) => ({ dp: m.dp, amount: m.amount })),
    [{ dp: dp.journalDocumentNumber, amount: '1000.0000' }],
  );
  assert.deepEqual(
    evidence.lines.map((l) => [l.gl_account, l.debit_credit]),
    [['230000', 'S'], ['110000', 'H']],
  );
  console.log('  ✓ the database remembers the transfer and its allocation mapping row');
}
