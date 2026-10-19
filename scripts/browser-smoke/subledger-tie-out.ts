import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postGlDocument } from '../../src/modules/finance/gl-document';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const REPORT = '/finance/subledger-tie-out';

/**
 * SCR-115 browser acceptance: G/L to subledger tie-out.
 *
 * The journey: a reconciliation account carries one partner
 * line and one partnerless line; the tie-out names the
 * account an exception with the difference standing —
 * persisting nothing.
 */
export async function subledgerTieOut(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-115: display the subledger tie-out with a named exception');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    await tx.execute(sql`
      update gl_account set reconciliation_type = 'CUSTOMERS'
      where client = ${client} and account_number = '110000'
    `);
  });
  await postGlDocument({
    client, changedBy: 'browser.admin', requestKey: 'browser-tie-1', companyCode: '1000',
    documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'KWD',
    lines: [
      { glAccount: '110000', debitCredit: 'S', amount: '7000', businessPartner: 'C10000' },
      { glAccount: '300000', debitCredit: 'H', amount: '7000' },
    ],
  });
  await postGlDocument({
    client, changedBy: 'browser.admin', requestKey: 'browser-tie-2', companyCode: '1000',
    documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'KWD',
    lines: [
      { glAccount: '110000', debitCredit: 'S', amount: '500' },
      { glAccount: '101000', debitCredit: 'H', amount: '500' },
    ],
  });

  await page.goto(`${base}${REPORT}?companyCode=1000&fiscalYear=2026&periodTo=12&ledger=0L`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Execute report' }).waitFor();

  const account = page.locator('tr', { hasText: '110000' }).first();
  await account.getByText('7500.00').first().waitFor();
  await account.getByText('7000.00').first().waitFor();
  await account.getByText('Exception').first().waitFor();
  console.log('  ✓ the account stands as an exception: 7,500.00 against 7,000.00');

  const count = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry where client = ${client}
  `));
  assert.equal((count as unknown as Array<{ n: number }>)[0]?.n, 2);
  console.log('  ✓ the tie-out persisted nothing beyond the fixture postings');
}
