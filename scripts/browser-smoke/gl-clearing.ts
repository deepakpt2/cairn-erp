import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postGlDocument } from '../../src/modules/finance/gl-document';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/finance/gl-clearing';

/**
 * SCR-114 browser acceptance: clear G/L account (F-03).
 *
 * The journey: an open-item-managed account carries two
 * balancing items; the operator ticks both, posts the
 * clearing, and the lines stand stamped in the database.
 */
export async function glClearing(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-114: clear two balancing G/L open items under one clearing document');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    await tx.execute(sql`
      update gl_account set is_open_item_managed = true
      where client = ${client} and account_number = '400000'
    `);
  });
  for (const [key, debit, credit] of [
    ['browser-gl-1', '400000', '101000'],
    ['browser-gl-2', '101000', '400000'],
  ] as const) {
    await postGlDocument({
      client, changedBy: 'browser.admin', requestKey: key, companyCode: '1000',
      documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'KWD',
      lines: [
        { glAccount: debit, debitCredit: 'S', amount: '5000' },
        { glAccount: credit, debitCredit: 'H', amount: '5000' },
      ],
    });
  }

  await page.goto(`${base}${ROUTE}?companyCode=1000&glAccount=400000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: 'Open items' }).waitFor();
  const boxes = page.locator('input[name="item"]');
  assert.equal(await boxes.count(), 2);
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByText(/difference 0\.00/).waitFor();
  console.log('  ✓ both items stand selected with the difference at zero');

  await page.locator('input[name="documentType"]').fill('AB');
  await page.locator('input[name="confirmed"]').check();
  await page.getByRole('button', { name: 'Post clearing' }).click();
  await page.getByText(/Clearing posted as document/).waitFor();
  console.log('  ✓ the clearing posted and returned its document number');

  const stamped = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry_line
    where client = ${client} and gl_account = '400000' and clearing_document is not null
  `));
  assert.equal((stamped as unknown as Array<{ n: number }>)[0]?.n, 4);
  console.log('  ✓ the two source lines and the two clearing lines stand stamped in the database');
}
