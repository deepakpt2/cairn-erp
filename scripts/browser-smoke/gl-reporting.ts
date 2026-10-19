import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postGlDocument } from '../../src/modules/finance/gl-document';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const BALANCES = '/finance/journal/balances';
const ITEMS = '/finance/journal/items';

/**
 * SCR-108 browser acceptance: G/L reporting suite.
 *
 * The journey: one posting stands; the range balance report
 * derives its closing balance with account-group subtotals,
 * and the line-item report paginates over the same journal —
 * both strictly read-only.
 */
export async function glReporting(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-108: run the G/L balance report and drill into line items');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
  });
  await postGlDocument({
    client, changedBy: 'browser.admin', requestKey: 'browser-gr-1', companyCode: '1000',
    documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'KWD',
    lines: [
      { glAccount: '101000', debitCredit: 'S', amount: '5000', assignment: 'INV-100' },
      { glAccount: '300000', debitCredit: 'H', amount: '5000' },
    ],
  });

  await page.goto(`${base}${BALANCES}?report=1&reportCompanies=1000&accountFrom=100000&accountTo=499999&reportFiscalYear=2026&periodFrom=1&periodTo=12`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const cashRow = page.locator('tr', { hasText: '101000' }).first();
  await cashRow.getByText('5000.00').first().waitFor();
  console.log('  ✓ the balance report derives the closing balance over the range');
  await page.getByText('Account group subtotals').waitFor();
  console.log('  ✓ account-group subtotals stand under the report');

  await page.goto(`${base}${ITEMS}?accountFrom=101000&companyCodes=1000&fiscalYear=2026`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByText(/showing 1 of 1 line items/).waitFor();
  await page.getByText('INV-100').first().waitFor();
  console.log('  ✓ line items paginate and carry the assignment');

  const before = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry where client = ${client}
  `));
  await page.goto(`${base}${BALANCES}?report=1&reportCompanies=1000&accountFrom=100000&accountTo=499999&reportFiscalYear=2026&periodFrom=1&periodTo=12`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const after = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry where client = ${client}
  `));
  assert.equal((after as unknown as Array<{ n: number }>)[0]?.n, (before as unknown as Array<{ n: number }>)[0]?.n);
  console.log('  ✓ re-running the reports persisted nothing');
}
