import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const PAYMENT = '/finance/vendor-down-payment';
const CONFIG = '/config/special-gl';

/**
 * SCR-081 browser acceptance: vendor down payment.
 *
 * The journey: the special G/L indicator A stands configured to
 * alternative account 230000 (seen on its maintenance screen),
 * then a 10,000 down payment posts against it — and the database
 * remembers the KA journal on the alternative account.
 */
export async function vendorDownPaymentF48(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-081: verify the configured indicator, the posted down payment, and database evidence');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
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
  console.log('  ✓ indicator A stands configured to alternative account 230000');

  await page.goto(`${base}${CONFIG}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Special G/L Indicators', exact: true }).waitFor();
  const list = page.locator('section[aria-labelledby="sgl-list"]');
  await list.getByText('230000').waitFor();
  console.log('  ✓ the maintenance screen shows the configured indicator');

  await page.goto(`${base}${PAYMENT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Post Vendor Down Payment', exact: true }).waitFor();
  const form = page.locator('section[aria-labelledby="vdp-header"]');
  await form.locator('input[name="companyCode"]').fill('1000');
  await form.locator('input[name="vendor"]').fill('V10000');
  await form.locator('input[name="amount"]').fill('10000');
  await form.locator('input[name="currency"]').fill('USD');
  await form.locator('input[name="bankAccount"]').fill('101000');
  await form.locator('input[name="specialGlIndicator"]').fill('A');
  await form.locator('input[name="reference"]').fill('DP-2026-001');
  await form.getByRole('button', { name: 'Post down payment', exact: true }).click();
  const posted = page.getByText(/Down payment posted as document \S+: 10000\.00 standing on alternative account 230000\./);
  await posted.waitFor();
  const journalNumber = (await posted.textContent())?.match(/document (\S+):/)?.[1] ?? '';
  assert.ok(journalNumber, 'the down payment journal number is shown');
  console.log(`  ✓ down payment posted as document ${journalNumber}`);

  const evidence = await withTenant(client, async (tx) => {
    const record = await tx.execute(sql`
      select alternative_reconciliation_account as alt, amount::text as amount from vendor_down_payment
      where client = ${client} and journal_document_number = ${journalNumber}
    `);
    const lines = await tx.execute(sql`
      select gl_account, debit_credit, line_text from journal_entry_line
      where client = ${client} and document_number = ${journalNumber} order by line_number
    `);
    return {
      record: (record as unknown as Array<{ alt: string; amount: string }>)[0],
      lines: lines as unknown as Array<{ gl_account: string; debit_credit: string; line_text: string | null }>,
    };
  });
  assert.equal(evidence.record.alt, '230000');
  assert.equal(evidence.record.amount, '10000.0000');
  assert.deepEqual(
    evidence.lines.map((l) => [l.gl_account, l.debit_credit]),
    [['230000', 'S'], ['101000', 'H']],
  );
  assert.equal(evidence.lines[0].line_text, 'Down payment A');
  console.log('  ✓ the database remembers the down payment on the alternative account');
}
