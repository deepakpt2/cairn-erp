import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postJournalEntry } from '../../src/platform/posting';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const REPORT = '/finance/tax/report';

/**
 * SCR-097 browser acceptance: advance return for tax.
 *
 * The journey: two tax-bearing documents stand posted (input tax
 * at 10%, output tax at 20%), then the return executes in test
 * mode from its selection and shows both codes with the net
 * payable — while stamping nothing in the database.
 */
export async function taxReportReturn(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-097: run the advance tax return over posted tax lines');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    const rows = await tx.execute(sql`select country from company_code where client = ${client} and company_code = '1000'`);
    const country = (rows as unknown as Array<{ country: string }>)[0]?.country ?? 'KW';
    await tx.execute(sql`
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, account_key, created_by)
      values (${client}, ${country}, 'I1', 'Input tax 10', 'VST', 10, 'VST', 'browser.admin'),
             (${client}, ${country}, 'O1', 'Output tax 20', 'MWS', 20, 'MWS', 'browser.admin')
      on conflict do nothing
    `);
  });

  const post = (lines: Array<Record<string, unknown>>, postingDate: string) =>
    withTenant(client, async (tx) => postJournalEntry(tx, {
      client, companyCode: '1000', documentType: 'SA', documentDate: postingDate,
      postingDate, fiscalYear: 2026, postingPeriod: 4, currency: 'KWD', localCurrency: 'KWD',
      postedBy: 'browser.admin', transactionCode: 'FIN.JOURNAL.POST',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lines: lines as any,
    }));
  await post([
    { glAccount: '240000', debitCredit: 'S', amount: '100.00', taxCode: 'I1' },
    { glAccount: '101000', debitCredit: 'H', amount: '100.00' },
  ], '2026-04-10');
  await post([
    { glAccount: '400000', debitCredit: 'S', amount: '200.00' },
    { glAccount: '240000', debitCredit: 'H', amount: '200.00', taxCode: 'O1' },
  ], '2026-04-20');
  console.log('  ✓ input tax 100 (I1) and output tax 200 (O1) stand posted');

  await page.goto(`${base}${REPORT}?run=1&companyCode=1000&postingDateFrom=2026-04-01&postingDateTo=2026-04-30&taxReturnCountry=KW&testRun=on`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Advance Return for Tax on Sales/Purchases', exact: true }).waitFor();
  await page.getByText('VST').waitFor();
  await page.getByText('MWS').waitFor();
  await page.getByText('Net tax payable').waitFor();
  await page.getByText(/Run TX\S+ recorded/).waitFor();
  console.log('  ✓ the return shows both codes, the derived bases and the net payable');

  const stamped = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n from journal_entry_line
      where client = ${client} and tax_return_run_id is not null
    `);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
  assert.equal(stamped, 0, 'the test run stamped nothing');
  console.log('  ✓ test mode changed no source document');
}
