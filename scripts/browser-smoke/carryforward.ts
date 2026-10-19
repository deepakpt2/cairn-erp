import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postGlDocument } from '../../src/modules/finance/gl-document';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const CARRYFORWARD = '/finance/carryforward';

/**
 * SCR-102 browser acceptance: G/L balance carryforward (F.16).
 *
 * The journey: a revenue posting stands in 2026; a test run for
 * target 2027 posts nothing, then the update run closes the P&L
 * balance into retained earnings with a transfer document, and
 * the run history shows both executions.
 */
export async function carryforward(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-102: test-run, then carry 2026 forward into 2027');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'RETAINED_EARNINGS', '', '', '290000', 'browser.admin')
      on conflict do nothing
    `);
  });
  await postGlDocument({
    client, changedBy: 'browser.admin', requestKey: 'browser-cf-seed', companyCode: '1000',
    documentDate: '2026-06-15', postingDate: '2026-06-15', documentType: 'SA', currency: 'KWD',
    lines: [
      { glAccount: '101000', debitCredit: 'S', amount: '5000' },
      { glAccount: '300000', debitCredit: 'H', amount: '5000' },
    ],
  });

  await page.goto(`${base}${CARRYFORWARD}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'G/L Balance Carryforward', exact: true }).waitFor();

  await page.locator('input[name="targetFiscalYear"]').fill('2027');
  await page.getByRole('button', { name: 'Execute carryforward', exact: true }).click();
  await page.getByText(/Test run \S+ completed: .* nothing posted/).waitFor();
  console.log('  ✓ test run completed without posting');

  const revenueBefore = await withTenant(client, async (tx) => tx.execute(sql`
    select coalesce(sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end), 0)::text as bal
    from journal_entry_line l join journal_entry e
      on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
    where l.client = ${client} and l.gl_account = '300000' and e.status = 'POSTED'
  `));
  assert.equal(Number((revenueBefore as unknown as Array<{ bal: string }>)[0]?.bal), -5000);

  await page.locator('select[name="testRun"]').selectOption('false');
  await page.getByRole('button', { name: 'Execute carryforward', exact: true }).click();
  await page.getByText(/Carryforward \S+ completed: .* P&L transfer/).waitFor();
  console.log('  ✓ update run posted the P&L closing transfer');

  const revenueAfter = await withTenant(client, async (tx) => tx.execute(sql`
    select coalesce(sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end), 0)::text as bal
    from journal_entry_line l join journal_entry e
      on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
    where l.client = ${client} and l.gl_account = '300000' and e.status = 'POSTED'
  `));
  assert.equal(Number((revenueAfter as unknown as Array<{ bal: string }>)[0]?.bal), 0);
  const runsStored = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from carryforward_run where client = ${client}
  `));
  assert.ok(Number((runsStored as unknown as Array<{ n: number }>)[0]?.n) >= 2);
  console.log('  ✓ P&L stands closed in the source year and both runs are preserved');
}
