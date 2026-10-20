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
 * SCR-114 browser acceptance (tolerance follow-up): clear G/L
 * account (F-03).
 *
 * The journey: an open-item-managed account carries two
 * balancing items; the operator ticks both, posts the
 * clearing, and the lines stand stamped in the database.
 * Then a pair standing 5 apart clears under the default
 * tolerance group, the difference posting to the determined
 * account as an ordinary unstamped line.
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

  // Tolerance follow-up: a pair standing 5 apart clears under the
  // default tolerance group, the difference posting on its own line.
  await withTenant(client, async (tx) => {
    const [company] = await tx.execute(sql`
      select chart_of_accounts as chart from company_code where client = ${client} and company_code = '1000'
    `) as unknown as [{ chart: string }];
    await tx.execute(sql`
      insert into employee_tolerance_group
        (client, company_code, group_key, max_document_amount, max_line_amount, max_cash_discount_percent,
         payment_diff_revenue_amount, payment_diff_expense_amount, payment_diff_revenue_percent, payment_diff_expense_percent,
         created_by)
      values (${client}, '', '', 0, 0, 0, 10, 10, 50, 50, 'browser.admin')
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, ${company.chart}, 'PAYMENT_DIFFERENCE', '', 'EXP', '310000', 'browser.admin')
    `);
  });
  for (const [key, debit, credit, amount] of [
    ['browser-gl-3', '400000', '101000', '1000'],
    ['browser-gl-4', '101000', '400000', '995'],
  ] as const) {
    await postGlDocument({
      client, changedBy: 'browser.admin', requestKey: key, companyCode: '1000',
      documentDate: '2026-04-11', postingDate: '2026-04-11', documentType: 'SA', currency: 'KWD',
      lines: [
        { glAccount: debit, debitCredit: 'S', amount },
        { glAccount: credit, debitCredit: 'H', amount },
      ],
    });
  }

  await page.goto(`${base}${ROUTE}?companyCode=1000&glAccount=400000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const tolBoxes = page.locator('input[name="item"]');
  assert.equal(await tolBoxes.count(), 2);
  await tolBoxes.nth(0).check();
  await tolBoxes.nth(1).check();
  await page.getByText(/posts to the payment difference account/).waitFor();
  console.log('  ✓ the standing difference of 5 judges within tolerance on screen');

  await page.locator('input[name="documentType"]').fill('AB');
  await page.locator('input[name="confirmed"]').check();
  await page.getByRole('button', { name: 'Post clearing' }).click();
  await page.getByText(/Clearing posted as document/).waitFor();

  const difference = await withTenant(client, async (tx) => tx.execute(sql`
    select debit_credit, amount_local::text as amount, clearing_document
    from journal_entry_line
    where client = ${client} and gl_account = '310000'
    order by document_number desc, line_number desc limit 1
  `));
  const diffRow = (difference as unknown as Array<{ debit_credit: string; amount: string; clearing_document: string | null }>)[0];
  assert.equal(diffRow?.debit_credit, 'S');
  assert.equal(Number(diffRow?.amount), 5);
  assert.equal(diffRow?.clearing_document, null);
  console.log('  ✓ the difference posted as an ordinary unstamped expense line and the items cleared');
}
