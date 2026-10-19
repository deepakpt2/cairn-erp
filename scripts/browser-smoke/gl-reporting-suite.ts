import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postGlDocument } from '../../src/modules/finance/gl-document';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const BALANCES = '/finance/journal/balances';

/**
 * SCR-109 browser acceptance: suite completion — drill from
 * the balance report into line items (document date standing),
 * and back to the balance report with its selection rebuilt.
 */
export async function glReportingSuite(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-109: drill from the balance report to line items and back');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
  });
  await postGlDocument({
    client, changedBy: 'browser.admin', requestKey: 'browser-gs-1', companyCode: '1000',
    documentDate: '2026-04-09', postingDate: '2026-04-10', documentType: 'SA', currency: 'KWD',
    lines: [
      { glAccount: '101000', debitCredit: 'S', amount: '5000' },
      { glAccount: '300000', debitCredit: 'H', amount: '5000' },
    ],
  });

  await page.goto(`${base}${BALANCES}?report=1&reportCompanies=1000&accountFrom=100000&accountTo=499999&reportFiscalYear=2026&periodFrom=1&periodTo=12`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const cashRow = page.locator('tr', { hasText: '101000' }).first();
  await cashRow.getByText('5000.00').first().waitFor();
  await cashRow.getByRole('link', { name: 'Line items', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.getByText('Document date', { exact: true }).first().waitFor();
  await page.getByText('2026-04-09').first().waitFor();
  console.log('  ✓ drill-down lands on line items with the document date standing');

  await page.getByRole('link', { name: '← Balance report', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const backRow = page.locator('tr', { hasText: '101000' }).first();
  await backRow.getByText('5000.00').first().waitFor();
  console.log('  ✓ the return link rebuilds the balance report selection');

  const count = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry where client = ${client}
  `));
  assert.equal((count as unknown as Array<{ n: number }>)[0]?.n, 1);
  console.log('  ✓ the whole journey persisted nothing beyond the fixture posting');
}
