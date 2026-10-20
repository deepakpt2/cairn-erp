import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postGlDocument } from '../../src/modules/finance/gl-document';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const REPORT = '/controlling/profit-center-report';

/**
 * SCR-113 browser acceptance (CSV export): profit centre actual
 * line items.
 *
 * The journey: a profit centre stands, one cost line posts
 * against it, the KE5Z grid shows the recorded line with its
 * signed amount, and the Export CSV action downloads exactly
 * that selection — persisting nothing.
 */
export async function profitCenterReport(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-113: display profit centre actual line items over the posted journal');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    await tx.execute(sql`
      insert into profit_center (client, controlling_area, profit_center, valid_from, valid_to, name, created_by)
      values (${client}, 'A000', 'PC9001', '2026-01-01', '2026-12-31', 'Acceptance centre', 'browser.admin')
      on conflict (client, controlling_area, profit_center, valid_from) do nothing
    `);
  });
  await postGlDocument({
    client, changedBy: 'browser.admin', requestKey: 'browser-pc-1', companyCode: '1000',
    documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'KWD',
    lines: [
      { glAccount: '400000', debitCredit: 'S', amount: '5000', profitCenter: 'PC9001' },
      { glAccount: '101000', debitCredit: 'H', amount: '5000' },
    ],
  });

  await page.goto(`${base}${REPORT}?controllingArea=A000&fiscalYear=2026&periodFrom=1&periodTo=12&ledger=0L&maxHits=5000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Execute report' }).waitFor();

  const line = page.locator('tr', { hasText: 'PC9001' }).first();
  await line.getByText('5000.00').first().waitFor();
  await line.getByText('400000').first().waitFor();
  console.log('  ✓ the posted line stands with its profit centre and signed amount');

  await page.getByRole('link', { name: 'Export CSV' }).waitFor();
  const csv = await page.request.get(`${base}${REPORT}/export?controllingArea=A000&fiscalYear=2026&periodFrom=1&periodTo=12&ledger=0L&maxHits=5000`);
  assert.equal(csv.status(), 200);
  const body = await csv.text();
  assert.ok(body.startsWith('Company Code,Document Number'), 'the CSV opens with its header');
  assert.ok(body.includes('PC9001') && body.includes('400000') && body.includes('5000.0000'), 'the CSV carries the posted line');
  console.log('  ✓ the export downloads exactly the shown selection as CSV');

  const count = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry where client = ${client}
  `));
  assert.equal((count as unknown as Array<{ n: number }>)[0]?.n, 1);
  console.log('  ✓ the report persisted nothing beyond the fixture posting');
}
