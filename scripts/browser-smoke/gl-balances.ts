import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postJournalEntry } from '../../src/platform/posting';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const BALANCES = '/finance/journal/balances';

/**
 * SCR-089 browser acceptance: G/L account balances (FS10N).
 *
 * The journey: a prior-year posting and two current-year postings
 * stand; the grid chains opening 1,000 through period turnover to
 * closing, the special-period row stands apart, and the period
 * drill lands on the line items behind period 3.
 */
export async function glBalancesFs10n(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-089: chain balances by period, separate specials, drill by period');

  await withTenant(client, async (tx) => {
    for (const fiscalYear of [2025, 2026]) {
      await defineRange(tx, {
        client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
        fiscalYear, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
      });
    }
    const post = (fiscalYear: number, period: number, date: string, lines: { glAccount: string; debitCredit: 'S' | 'H'; amount: string }[]) =>
      postJournalEntry(tx, {
        client, companyCode: '1000', documentType: 'SA',
        documentDate: date, postingDate: date, fiscalYear, postingPeriod: period,
        currency: 'USD', localCurrency: 'USD', lines,
        postedBy: 'BROWSER_SMOKE', transactionCode: 'FIN.JOURNAL.POST',
      });
    await post(2025, 12, '2025-12-20', [
      { glAccount: '400000', debitCredit: 'S', amount: '1000.00' },
      { glAccount: '101000', debitCredit: 'H', amount: '1000.00' },
    ]);
    await post(2026, 3, '2026-03-15', [
      { glAccount: '400000', debitCredit: 'S', amount: '500.00' },
      { glAccount: '101000', debitCredit: 'H', amount: '500.00' },
    ]);
    await post(2026, 4, '2026-04-10', [
      { glAccount: '101000', debitCredit: 'S', amount: '200.00' },
      { glAccount: '400000', debitCredit: 'H', amount: '200.00' },
    ]);
    await tx.execute(sql`
      insert into journal_entry (
        client, document_number, fiscal_year, document_type, company_code,
        document_date, posting_date, posting_period, document_currency, local_currency, status, created_by
      ) values (${client}, 'JE-SP-BROWSER', 2026, 'SA', '1000', '2026-12-31', '2026-12-31', 13, 'USD', 'USD', 'POSTED', 'BROWSER_SMOKE')
    `);
    await tx.execute(sql`
      insert into journal_entry_line (
        client, document_number, fiscal_year, line_number, gl_account, company_code,
        debit_credit, amount_local, amount_document, currency
      ) values
        (${client}, 'JE-SP-BROWSER', 2026, 1, '400000', '1000', 'S', 50, 50, 'USD'),
        (${client}, 'JE-SP-BROWSER', 2026, 2, '101000', '1000', 'H', 50, 50, 'USD')
    `);
  });
  console.log('  ✓ prior-year, current-year and stored special-period documents stand');

  await page.goto(`${base}${BALANCES}?account=400000&companyCode=1000&fiscalYear=2026&specialPeriods=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'G/L Account Balances', exact: true }).waitFor();
  const results = page.locator('section[aria-labelledby="gb-results"]');
  await results.getByText('Opening balance 1000.00').waitFor();
  await results.getByText('Special 13').waitFor();
  await results.getByText('1350.00').first().waitFor();
  console.log('  ✓ opening, chained closing and the separate special period read correctly');

  const period3 = results.locator('tr', { hasText: 'Period 3' });
  await period3.getByRole('link', { name: 'Line items' }).click();
  await page.getByRole('heading', { level: 1, name: 'G/L Line Item Report', exact: true }).waitFor();
  const items = page.locator('section[aria-labelledby="ji-results"]');
  await items.getByText('500.00').first().waitFor();
  console.log('  ✓ the period drill lands on the line items behind period 3');

  await withTenant(client, async (tx) => {
    const journals = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    assert.equal(Number((journals as unknown as { n: number }[])[0]?.n ?? 0), 4, 'reading posted nothing');
  });
  console.log('  ✓ the journal stands untouched by the balances');
}
