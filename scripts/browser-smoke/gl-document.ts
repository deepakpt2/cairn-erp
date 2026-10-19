import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ENTRY = '/finance/journal/new';

/**
 * SCR-096 browser acceptance: FB50 G/L document entry.
 *
 * The journey: a balanced two-line document is entered on the
 * reworked screen (assignment and line text included), reviewed in
 * the confirmation summary and posted; the posted document carries
 * the assignment in the database, and submitting the same form a
 * second time returns the original document instead of posting a
 * duplicate.
 */
export async function glDocumentEntry(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-096: enter, confirm and post a G/L document; resubmission stays one document');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
  });

  await page.goto(`${base}${ENTRY}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Post a journal entry', exact: true }).waitFor();

  await page.locator('input[name="documentDate"]').fill('2026-04-01');
  await page.locator('input[name="postingDate"]').fill('2026-04-01');
  await page.locator('input[name="reference"]').fill('JE-2026-001');
  await page.locator('input[name="headerText"]').fill('Monthly accrual');

  await page.locator('input[name="line_0_account"]').fill('400000');
  await page.locator('input[name="line_0_amount"]').fill('1500');
  await page.locator('input[name="line_0_assignment"]').fill('ASSIGN-01');
  await page.locator('input[name="line_0_text"]').fill('Office expense');
  await page.locator('input[name="line_1_account"]').fill('101000');
  await page.locator('input[name="line_1_amount"]').fill('1500');

  await page.getByText('Document balances. Ready to post.').waitFor();
  await page.getByRole('button', { name: 'Review posting', exact: true }).click();
  await page.getByText(/Post 2 lines for company 1000/).waitFor();
  await page.getByRole('button', { name: 'Confirm posting', exact: true }).click();
  const success = page.getByText(/Document JE-\S+ posted in fiscal year 2026/);
  await success.waitFor();
  const displayNumber = (await success.textContent())?.match(/JE-\S+/)?.[0] ?? '';
  assert.ok(displayNumber, 'display number reported');
  console.log(`  ✓ document ${displayNumber} posted through the confirmation summary`);

  const stored = await withTenant(client, async (tx) => tx.execute(sql`
    select assignment, cost_center from journal_entry_line
    where client = ${client} and gl_account = '400000'
    order by posted_at desc limit 1
  `));
  expect_assignment: {
    const row = (stored as unknown as Array<{ assignment: string | null }>)[0];
    assert.equal(row?.assignment, 'ASSIGN-01', 'assignment persisted on the canonical line');
  }
  console.log('  ✓ the line assignment stands on the canonical journal line');

  const countBefore = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
  await page.getByRole('button', { name: 'Review posting', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm posting', exact: true }).click();
  await page.getByText(new RegExp(`Document ${displayNumber} posted in fiscal year 2026`)).waitFor();
  const countAfter = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
  assert.equal(countAfter, countBefore, 'the resubmission posted no duplicate');
  console.log('  ✓ resubmitting the same form returned the original document');
}
