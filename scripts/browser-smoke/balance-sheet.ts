import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postGlDocument } from '../../src/modules/finance/gl-document';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const STATEMENT = '/finance/balance-sheet';

/**
 * SCR-107 browser acceptance: balance sheet / P&L statement.
 *
 * The journey: an FSV stands as configuration, one posting
 * stands, and the COMBINED statement displays closing balances
 * for balance-sheet accounts, P&L movement and the explicit
 * current-year result — derived live, persisting nothing.
 */
export async function balanceSheet(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-107: display the S_ALR_87012284 statement over a configured FSV');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    await tx.execute(sql`
      insert into financial_statement_version (client, version, name, chart_of_accounts, created_by)
      values (${client}, 'T01', 'Browser statement', 'CA01', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into financial_statement_node (client, version, node, description, parent_node, sequence, created_by)
      values
        (${client}, 'T01', 'BS', 'Balance sheet', null, 10, 'browser.admin'),
        (${client}, 'T01', 'ASSETS', 'Assets', 'BS', 10, 'browser.admin'),
        (${client}, 'T01', 'PL', 'Profit and loss', null, 20, 'browser.admin'),
        (${client}, 'T01', 'REVENUE', 'Revenue', 'PL', 10, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into financial_statement_assignment (client, version, node, account_from, account_to, presentation_sign, created_by)
      values
        (${client}, 'T01', 'ASSETS', '100000', '199999', 'NORMAL', 'browser.admin'),
        (${client}, 'T01', 'REVENUE', '300000', '399999', 'INVERTED', 'browser.admin')
      on conflict do nothing
    `);
  });
  await postGlDocument({
    client, changedBy: 'browser.admin', requestKey: 'browser-bs-1', companyCode: '1000',
    documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'KWD',
    lines: [
      { glAccount: '101000', debitCredit: 'S', amount: '5000' },
      { glAccount: '300000', debitCredit: 'H', amount: '5000' },
    ],
  });

  await page.goto(`${base}${STATEMENT}?companyCode=1000&statementVersion=T01&fiscalYear=2026&periodFrom=1&periodTo=12&comparisonFiscalYear=2025&calculationType=COMBINED&summaryLevel=9`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Balance Sheet / Profit and Loss Statement', exact: true }).waitFor();

  const assets = page.locator('tr', { hasText: 'Assets (ASSETS)' }).first();
  await assets.getByText('5000.00').first().waitFor();
  console.log('  ✓ the Assets node carries the COMBINED closing balance');

  const cash = page.locator('tr', { hasText: '101000' }).first();
  await cash.getByText(/5000\.00 KWD/).waitFor();
  console.log('  ✓ the account drill row shows its closing balance in company currency');

  await page.getByText(/Current-year result/).waitFor();
  await page.getByText(/5000\.00 KWD/).first().waitFor();
  console.log('  ✓ the current-year result is explicit under COMBINED');

  const before = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry where client = ${client}
  `));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const after = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry where client = ${client}
  `));
  assert.equal((after as unknown as Array<{ n: number }>)[0]?.n, (before as unknown as Array<{ n: number }>)[0]?.n);
  console.log('  ✓ re-running the statement persisted nothing');
}
