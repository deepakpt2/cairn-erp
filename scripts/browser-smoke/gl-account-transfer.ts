import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const TRANSFER = '/config/gl-accounts/transfer';

/**
 * SCR-110 browser acceptance: FS15 G/L account master transfer.
 *
 * The journey: a target company stands on the same chart, the
 * test run previews CREATED without copying, the live run
 * creates the segment — and no accounting document is posted.
 */
export async function glAccountTransfer(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-110: transfer a G/L company segment, test run first');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, currency, country)
      values (${client}, '2000', 'Target company', 'CA01', 'KWD', 'KW')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into gl_account_company
        (client, company_code, chart_of_accounts, gl_account, account_currency,
         tax_category, is_open_item_managed, sort_key, is_blocked_posting, created_by)
      values (${client}, '1000', 'CA01', '101000', 'KWD', null, true, '001', false, 'browser.admin')
      on conflict do nothing
    `);
  });

  const selection = 'sourceCompanyCode=1000&targetCompanyCode=2000&chartOfAccounts=CA01&accountFrom=100000&accountTo=199999&withCompanyData=1&overwriteExisting=0';
  await page.goto(`${base}${TRANSFER}?${selection}&testRun=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Transfer G/L Account Master Data', exact: true }).waitFor();
  await page.getByText(/TEST RUN — nothing copied/).waitFor();
  const previewRow = page.locator('tr', { hasText: '101000' }).first();
  await previewRow.getByText('CREATED', { exact: true }).waitFor();
  console.log('  ✓ the test run previews CREATED and copies nothing');
  const afterTest = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from gl_account_company
    where client = ${client} and company_code = '2000' and gl_account = '101000'
  `));
  assert.equal((afterTest as unknown as Array<{ n: number }>)[0]?.n, 0);

  await page.goto(`${base}${TRANSFER}?${selection}&testRun=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByText(/LIVE RUN/).waitFor();
  console.log('  ✓ the live run reports the transfer');
  const afterLive = await withTenant(client, async (tx) => tx.execute(sql`
    select sort_key from gl_account_company
    where client = ${client} and company_code = '2000' and gl_account = '101000'
  `)) as unknown as Array<{ sort_key: string }>;
  assert.equal(afterLive[0]?.sort_key, '001');
  console.log('  ✓ the target segment stands with the source values');

  const journals = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry where client = ${client}
  `));
  assert.equal((journals as unknown as Array<{ n: number }>)[0]?.n, 0);
  console.log('  ✓ the transfer posted no accounting documents');
}
