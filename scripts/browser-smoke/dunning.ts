import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postCustomerInvoice } from '../../src/modules/finance/customer-invoice';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const DUNNING = '/finance/dunning';

/**
 * SCR-074 browser acceptance: dunning programme.
 *
 * The journey: an overdue invoice stands against a customer with
 * a dunning procedure; the run proposes it at level 1, and
 * finalization writes the notice — the database holding the
 * completed run and its notice, and no journal posted by dunning.
 */
export async function dunningF150(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-074: verify run proposal at level 1, finalization, notice, and database evidence');

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
        reconciliation_account, payment_terms_code, dunning_procedure, created_by
      )
      values (${client}, 'C10000', 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', 'DUN1', 'BROWSER_SMOKE')
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
    documentDate: '2026-09-16', postingDate: '2026-09-18',
    reference: 'BROW-DUN-1', currency: 'USD', grossAmount: 550, requestKey: 'browser-dun-inv',
    lines: [{ glAccount: '300000', netAmount: 500, taxCode: 'T10' }],
  });
  console.log('  ✓ an invoice of 550 due 2026-10-16 stands open');

  await page.goto(`${base}${DUNNING}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Dunning Programme', exact: true }).waitFor();
  const params = page.locator('section[aria-labelledby="dn-parameters"]');
  await params.locator('input[name="runDate"]').fill('2026-11-20');
  await params.locator('input[name="runId"]').fill('DUN001');
  await params.locator('input[name="dunningDate"]').fill('2026-11-20');
  await params.locator('input[name="postedThrough"]').fill('2026-11-20');
  await params.locator('input[name="companyCodes"]').fill('1000');
  await params.locator('input[name="confirmed"]').check();
  await params.getByRole('button', { name: 'Execute run', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await params.getByText(/Run DUN001 of 2026-11-20 stands proposed: 1 account\(s\) proposed, 0 excluded/).waitFor();

  const proposal = page.locator('section[aria-labelledby="dn-proposal"]');
  await proposal.getByText(/Run DUN001 of 2026-11-20 — PROPOSED/).waitFor();
  await proposal.getByText('C10000').first().waitFor();
  console.log('  ✓ the proposal shows the overdue account at level 1');

  await proposal.locator('input[name="confirmed"]').check();
  await proposal.getByRole('button', { name: 'Finalize run', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await params.getByText(/Run DUN001 of 2026-11-20 stands completed: 1 notice\(s\) written/).waitFor();
  await proposal.getByText(/Run DUN001 of 2026-11-20 — COMPLETED/).waitFor();
  console.log('  ✓ finalization completed the run with one notice');

  const evidence = await withTenant(client, async (tx) => {
    const run = await tx.execute(sql`
      select status from dunning_run
      where client = ${client} and run_date = '2026-11-20' and run_id = 'DUN001'
    `);
    const notice = await tx.execute(sql`
      select notice_number, dunning_level, amount::text as amount, currency from dunning_notice
      where client = ${client} and run_id = 'DUN001'
    `);
    const journals = await tx.execute(sql`
      select count(*)::int as n from journal_entry
      where client = ${client} and origin_class = 'dunning_run'
    `);
    return {
      status: (run as unknown as Array<{ status: string }>)[0]?.status,
      notice: (notice as unknown as Array<Record<string, unknown>>)[0],
      journals: (journals as unknown as Array<{ n: number }>)[0].n,
    };
  });
  assert.equal(evidence.status, 'COMPLETED');
  assert.equal(evidence.notice.dunning_level, 1);
  assert.equal(evidence.notice.amount, '550.0000');
  assert.equal(evidence.notice.currency, 'USD');
  assert.equal(evidence.journals, 0);
  console.log('  ✓ the database holds the COMPLETED run, its level-1 notice, and no dunning journal');
}
