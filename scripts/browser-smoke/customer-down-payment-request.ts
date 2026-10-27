import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const REQUEST = '/finance/customer-down-payment-request';
const RECEIPT = '/finance/customer-down-payment';

/**
 * SCR-085 browser acceptance: customer down payment request.
 *
 * The journey: request indicator F stands configured with target
 * A; a 5,000 request posts as a noted item (no journal), then an
 * F-29 receipt of 2,000 fulfills it in part — and the database
 * remembers the ACTIVE link and the PARTIAL standing.
 */
export async function customerDownPaymentRequestF37(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-085: verify the noted request, its F-29 fulfillment, and database evidence');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
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
        alternative_reconciliation_account, target_special_gl_indicator, description, created_by
      )
      values
        (${client}, '', 'AR', 'A', '230000', null, 'Customer advances', 'BROWSER_SMOKE'),
        (${client}, '', 'AR', 'F', '230000', 'A', 'Advance requests', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });
  console.log('  ✓ request indicator F stands configured with target A');

  await page.goto(`${base}${REQUEST}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Post Customer Down Payment Request', exact: true }).waitFor();
  const form = page.locator('section[aria-labelledby="cdpr-header"]');
  await chooseClosed(form, 'companyCode', '1000');
  await form.locator('input[name="customer"]').fill('C10000');
  await form.locator('input[name="dueDate"]').fill('2026-11-15');
  await form.locator('input[name="amount"]').fill('5000');
  await chooseClosed(form, 'currency', 'USD');
  await form.locator('input[name="indicator"]').fill('F');
  await form.locator('input[name="reference"]').fill('REQ-2026-001');
  await form.getByRole('button', { name: 'Post request', exact: true }).click();
  const posted = page.getByText(/Request \S+ posted: 5000\.00 standing open, expecting indicator A at fulfillment\./);
  await posted.waitFor();
  const requestNumber = (await posted.textContent())?.match(/Request (\S+) posted:/)?.[1] ?? '';
  assert.ok(requestNumber, 'the request number is shown');
  console.log(`  ✓ request ${requestNumber} posted as a noted item`);

  await page.goto(`${base}${RECEIPT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Post Customer Down Payment', exact: true }).waitFor();
  const receipt = page.locator('section[aria-labelledby="cdp-header"]');
  await chooseClosed(receipt, 'companyCode', '1000');
  await receipt.locator('input[name="customer"]').fill('C10000');
  await receipt.locator('input[name="bankAccount"]').fill('101000');
  await receipt.locator('input[name="amount"]').fill('2000');
  await chooseClosed(receipt, 'currency', 'USD');
  await receipt.locator('input[name="specialGlIndicator"]').fill('A');
  await receipt.locator('input[name="fulfillRequest"]').fill(requestNumber);
  await receipt.getByRole('button', { name: 'Post down payment', exact: true }).click();
  await page.getByText(/Down payment posted as document \S+: 2000\.00 standing on alternative account 230000\./).waitFor();
  console.log('  ✓ the F-29 receipt posted against the request');

  await page.goto(`${base}${REQUEST}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const row = page.locator('tr', { hasText: requestNumber });
  await row.getByText('PARTIAL').waitFor();
  await row.getByText('3000.00').waitFor();
  console.log('  ✓ the request stands PARTIAL with 3,000.00 remaining');

  const evidence = await withTenant(client, async (tx) => {
    const status = await tx.execute(sql`
      select status from customer_down_payment_request
      where client = ${client} and request_number = ${requestNumber}
    `);
    const links = await tx.execute(sql`
      select fulfilled_amount::text as amount, status from down_payment_request_fulfillment
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
    [{ amount: '2000.0000', status: 'ACTIVE' }],
  );
  // Exactly one journal exists — the receipt's. The request made none.
  assert.equal(evidence.journals, 1);
  console.log('  ✓ the database remembers the link; the request itself made no journal');
}
