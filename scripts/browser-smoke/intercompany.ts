import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const CONFIG_ROUTE = '/config/intercompany-clearing';
const POST_ROUTE = '/finance/intercompany';

/**
 * SCR-122 browser acceptance: intercompany posting and OBYA configuration.
 *
 * The journey: a tenant carrying two company codes configures the pair on
 * screen, posts an intercompany journal from the sending company, and both
 * documents stand posted and balanced, each clearing through its own OBYA
 * account with the trading partner stamped.
 */
export async function intercompany(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-122: configure a company pair and post one intercompany journal across two companies');

  let currency = 'USD';
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select currency from company_code where client = ${client} and company_code = '1000'
    `) as unknown as Array<{ currency: string }>;
    currency = rows[0]?.currency ?? 'USD';
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999_999, createdBy: 'browser.admin',
    });
    await tx.execute(sql`
      insert into company_code (
        client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by
      )
      select client, '2000', 'Partner company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, 'browser.admin'
      from company_code where client = ${client} and company_code = '1000'
      on conflict do nothing
    `);
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '2000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999_999, createdBy: 'browser.admin',
    });
    for (const company of ['1000', '2000']) {
      for (const account of ['500000', '110100']) {
        await tx.execute(sql`
          insert into gl_account_company (client, company_code, chart_of_accounts, gl_account, account_currency, created_by)
          select client, ${company}, chart_of_accounts, ${account}, ${currency}, 'browser.admin'
          from company_code where client = ${client} and company_code = ${company}
          on conflict do nothing
        `);
      }
    }
  });

  // ── The configuration screen ──────────────────────────────────────────────
  await page.goto(`${base}${CONFIG_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: /Intercompany Clearing Configuration/i }).waitFor();
  await page.locator('select[name="sendingCompanyCode"]').selectOption('1000');
  await page.locator('select[name="receivingCompanyCode"]').selectOption('2000');
  await page.getByRole('button', { name: 'Save pair' }).click();
  await page.getByText(/Pair 1000 to 2000 stands configured/).waitFor();
  console.log('  ✓ the company pair stands configured on screen');
  const saved = await withTenant(client, async (tx) => tx.execute(sql`
    select sending_company_code, receiving_company_code from intercompany_clearing_config where client = ${client}
  `)) as unknown as Array<{ sending_company_code: string; receiving_company_code: string }>;
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.receiving_company_code, '2000');

  // ── The posting screen ────────────────────────────────────────────────────
  await page.goto(`${base}${POST_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: /Intercompany Posting/i, exact: true }).waitFor();
  await page.locator('select[name="sendingCompanyCode"]').selectOption('1000');
  await page.locator('select[name="receivingCompanyCode"]').selectOption('2000');
  await page.locator('input[name="postingDate"]').fill('2026-05-10');
  await page.locator('input[name="documentDate"]').fill('2026-05-10');
  await page.locator('input[name="glAccount"]').first().fill('500000');
  await page.locator('input[name="amount"]').first().fill('5000');
  await page.locator('input[name="costCenter"]').first().fill('CC1000');
  await page.locator('input[name="reference"]').fill('IC-2026-001');
  await page.locator('input[name="confirmed"]').check();
  await page.getByRole('button', { name: 'Post intercompany' }).click();
  await page.getByText(/Intercompany posted/).waitFor();
  console.log('  ✓ the posting posted and named both documents');

  const lines = await withTenant(client, async (tx) => tx.execute(sql`
    select company_code, gl_account, debit_credit, amount_local::text as amount, trading_partner_company
    from journal_entry_line
    where client = ${client} and gl_account in ('110100','500000')
    order by company_code, line_number
  `)) as unknown as Array<{
    company_code: string; gl_account: string; debit_credit: string;
    amount: string; trading_partner_company: string | null;
  }>;
  assert.equal(lines.length, 4);
  for (const company of ['1000', '2000']) {
    const side = lines.filter((l) => l.company_code === company);
    const debit = side.reduce((s, l) => s + (l.debit_credit === 'S' ? Number(l.amount) : 0), 0);
    const credit = side.reduce((s, l) => s + (l.debit_credit === 'H' ? Number(l.amount) : 0), 0);
    assert.equal(Math.abs(debit - credit) < 0.005, true, `company ${company} balances`);
  }
  const sender = lines.filter((l) => l.company_code === '1000');
  const receiver = lines.filter((l) => l.company_code === '2000');
  assert.equal(sender.every((l) => l.trading_partner_company === '2000'), true);
  assert.equal(receiver.every((l) => l.trading_partner_company === '1000'), true);
  assert.equal(Number(sender.find((l) => l.gl_account === '500000')!.amount), 5000);
  assert.equal(Number(receiver.find((l) => l.gl_account === '500000')!.amount), 5000);
  console.log('  ✓ both company ledgers balance and every line stamps its trading partner');

  const pair = await withTenant(client, async (tx) => tx.execute(sql`
    select sending_company_code, receiving_company_code, partner_document_number, status
    from intercompany_document_header where client = ${client}
  `)) as unknown as Array<{ sending_company_code: string; receiving_company_code: string; partner_document_number: string; status: string }>;
  assert.equal(pair.length, 1);
  assert.equal(pair[0]!.status, 'POSTED');
  assert.equal(pair[0]!.partner_document_number.includes('/2026/'), true);
  console.log('  ✓ the pairing record links the two posted documents');
}
