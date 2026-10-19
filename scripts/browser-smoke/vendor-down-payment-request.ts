import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const REQUEST = '/finance/vendor-down-payment-request';
const PAYMENT = '/finance/vendor-down-payment';

/**
 * SCR-086 browser acceptance: vendor down payment request.
 *
 * The journey: request indicator F stands configured with target
 * A; a 10,000 request posts as a noted item (no journal), then an
 * F-48 payment of 4,000 fulfills it in part — and the database
 * remembers the ACTIVE link and the PARTIAL standing.
 */
export async function vendorDownPaymentRequestF47(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-086: verify the noted request, its F-48 fulfillment, and database evidence');

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
        alternative_reconciliation_account, target_special_gl_indicator, description, created_by
      )
      values
        (${client}, '', 'AP', 'A', '230000', null, 'Vendor advances', 'BROWSER_SMOKE'),
        (${client}, '', 'AP', 'F', '230000', 'A', 'Advance requests', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });
  console.log('  ✓ request indicator F stands configured with target A');

  await page.goto(`${base}${REQUEST}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Post Vendor Down Payment Request', exact: true }).waitFor();
  const form = page.locator('section[aria-labelledby="vdpr-header"]');
  await form.locator('input[name="companyCode"]').fill('1000');
  await form.locator('input[name="vendor"]').fill('V10000');
  await form.locator('input[name="dueDate"]').fill('2026-11-15');
  await form.locator('input[name="amount"]').fill('10000');
  await form.locator('input[name="currency"]').fill('USD');
  await form.locator('input[name="indicator"]').fill('F');
  await form.locator('input[name="reference"]').fill('REQ-V-2026-001');
  await form.getByRole('button', { name: 'Post request', exact: true }).click();
  const posted = page.getByText(/Request \S+ posted: 10000\.00 standing open, expecting indicator A at fulfillment\./);
  await posted.waitFor();
  const requestNumber = (await posted.textContent())?.match(/Request (\S+) posted:/)?.[1] ?? '';
  assert.ok(requestNumber, 'the request number is shown');
  console.log(`  ✓ request ${requestNumber} posted as a noted item`);

  await page.goto(`${base}${PAYMENT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Post Vendor Down Payment', exact: true }).waitFor();
  const payment = page.locator('section[aria-labelledby="vdp-header"]');
  await payment.locator('input[name="companyCode"]').fill('1000');
  await payment.locator('input[name="vendor"]').fill('V10000');
  await payment.locator('input[name="bankAccount"]').fill('101000');
  await payment.locator('input[name="amount"]').fill('4000');
  await payment.locator('input[name="currency"]').fill('USD');
  await payment.locator('input[name="specialGlIndicator"]').fill('A');
  await payment.locator('input[name="fulfillRequest"]').fill(requestNumber);
  await payment.getByRole('button', { name: 'Post down payment', exact: true }).click();
  await page.getByText(/Down payment posted as document \S+: 4000\.00 standing on alternative account 230000\./).waitFor();
  console.log('  ✓ the F-48 payment posted against the request');

  await page.goto(`${base}${REQUEST}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const row = page.locator('tr', { hasText: requestNumber });
  await row.getByText('PARTIAL').waitFor();
  await row.getByText('6000.00').waitFor();
  console.log('  ✓ the request stands PARTIAL with 6,000.00 remaining');

  const evidence = await withTenant(client, async (tx) => {
    const status = await tx.execute(sql`
      select status from vendor_down_payment_request
      where client = ${client} and request_number = ${requestNumber}
    `);
    const links = await tx.execute(sql`
      select fulfilled_amount::text as amount, status from vendor_dp_request_fulfillment
      where client = ${client} and request_number = ${requestNumber}
    `);
    const journals = await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${client}
    `);
    return {
      status: (status as unknown as Array<{ status: string }>)[0]?.status,
      links: links as unknown as Array<{ amount: string; status: string }>,
      journals: (journals as unknown as Array<{ n: number }>)[0]?.n,
    };
  });
  assert.equal(evidence.status, 'PARTIAL');
  assert.deepEqual(
    evidence.links.map((l) => ({ amount: l.amount, status: l.status })),
    [{ amount: '4000.0000', status: 'ACTIVE' }],
  );
  // Exactly one journal exists — the payment's. The request made none.
  assert.equal(evidence.journals, 1);
  console.log('  ✓ the database remembers the link; the request itself made no journal');
}
