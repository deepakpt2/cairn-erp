import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postJournalEntry } from '../../src/platform/posting';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const VALUATION = '/finance/fx/valuation';

/**
 * SCR-098 browser acceptance: foreign currency valuation.
 *
 * The journey: a EUR receivable stands carried below its key-date
 * value; the valuation executes in test mode from its selection
 * and shows the gain with the exact rate used — while posting
 * nothing to the ledger.
 */
export async function fxValuationRun(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-098: value a EUR receivable at the key-date rate');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    await tx.execute(sql`
      update gl_account set account_type = 'ASSET', gl_account_type = 'BALANCE_SHEET',
        is_balance_sheet = true, is_open_item_managed = true
      where client = ${client} and account_number = '113000'
    `);
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by)
      values (${client}, 'AVERAGE', 'EUR', 'KWD', '2026-03-01', 0.30, 'browser.admin')
      on conflict do nothing
    `);
  });

  await withTenant(client, async (tx) => postJournalEntry(tx, {
    client, companyCode: '1000', documentType: 'SA', documentDate: '2026-04-10',
    postingDate: '2026-04-10', fiscalYear: 2026, postingPeriod: 4,
    currency: 'EUR', localCurrency: 'KWD', exchangeRate: '0.27',
    postedBy: 'browser.admin', transactionCode: 'FIN.JOURNAL.POST',
    lines: [
      { glAccount: '113000', debitCredit: 'S', amount: '1000.00' },
      { glAccount: '400000', debitCredit: 'H', amount: '1000.00' },
    ],
  }));
  console.log('  ✓ EUR 1,000 receivable stands carried at KWD 270 (rate 0.27)');

  const journalsBefore = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });

  await page.goto(`${base}${VALUATION}?run=1&requestKey=browser-fx-1&companyCode=1000&valuationArea=LOCAL&valuationKeyDate=2026-04-30&postingDate=2026-04-30&fiscalYear=2026&valuationMethod=AVERAGE&documentType=SA&openItems=on&balances=on&testRun=on`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Foreign Currency Valuation', exact: true }).waitFor();
  await page.getByText('113000').first().waitFor();
  await page.getByText('GAIN').first().waitFor();
  await page.getByText('300.00').first().waitFor();
  console.log('  ✓ the protocol values the item at 300 (rate 0.30) and classifies the gain');

  const journalsAfter = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
  assert.equal(journalsAfter, journalsBefore, 'the test run posted nothing');
  console.log('  ✓ test mode posted nothing');
}
