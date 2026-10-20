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

  // Partial clearing: 1,000 settled at 600 stays open for 400.
  for (const [key, debit, credit, amount] of [
    ['browser-gl-5', '400000', '101000', '1000'],
    ['browser-gl-6', '101000', '400000', '600'],
  ] as const) {
    await postGlDocument({
      client, changedBy: 'browser.admin', requestKey: key, companyCode: '1000',
      documentDate: '2026-04-12', postingDate: '2026-04-12', documentType: 'SA', currency: 'KWD',
      lines: [
        { glAccount: debit, debitCredit: 'S', amount },
        { glAccount: credit, debitCredit: 'H', amount },
      ],
    });
  }
  await page.goto(`${base}${ROUTE}?companyCode=1000&glAccount=400000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const partialBoxes = page.locator('input[name="item"]');
  assert.equal(await partialBoxes.count(), 2);
  await partialBoxes.nth(0).check();
  await partialBoxes.nth(1).check();
  await page.locator('select[name="method"]').selectOption('PARTIAL');
  const settlementInputs = page.locator('input[name^="settlement:"]');
  assert.equal(await settlementInputs.count(), 2);
  await settlementInputs.nth(0).fill('600');
  await settlementInputs.nth(1).fill('600');
  await page.locator('input[name="documentType"]').fill('AB');
  await page.locator('input[name="confirmed"]').check();
  await page.getByRole('button', { name: 'Post clearing' }).click();
  await page.getByText(/by partial clearing/).waitFor();
  await page.getByText(/the short-settled items standing open/).waitFor();
  console.log('  ✓ the partial clearing posted and names the short-settled item');

  const remaining = await withTenant(client, async (tx) => tx.execute(sql`
    select l.document_number, l.amount_local::text as amount,
           coalesce(sum(a.allocated_amount), 0)::text as applied
    from journal_entry_line l
    left join gl_clearing_allocation a
      on a.client = l.client and a.source_document = l.document_number
     and a.source_fiscal_year = l.fiscal_year and a.source_line_number = l.line_number and a.is_active
    where l.client = ${client} and l.gl_account = '400000' and l.amount_local = 1000 and l.clearing_document is null
    group by l.document_number, l.amount_local
  `)) as unknown as Array<{ document_number: string; amount: string; applied: string }>;
  assert.equal(remaining.length, 1);
  assert.equal(Number(remaining[0]!.applied), 600);
  assert.equal(Number(remaining[0]!.amount) - Number(remaining[0]!.applied), 400);
  console.log('  ✓ the short-settled item stands open with 400 remaining and one active allocation');

  // Residual clearing: 500 settled at 200 re-stands a 300 residual (R01).
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into residual_reason (client, reason_code, description, created_by)
      values (${client}, 'R01', 'Underpayment remainder', 'browser.admin')
      on conflict do nothing
    `);
  });
  for (const [key, debit, credit, amount] of [
    ['browser-gl-7', '400000', '101000', '500'],
    ['browser-gl-8', '101000', '400000', '200'],
  ] as const) {
    await postGlDocument({
      client, changedBy: 'browser.admin', requestKey: key, companyCode: '1000',
      documentDate: '2026-04-13', postingDate: '2026-04-13', documentType: 'SA', currency: 'KWD',
      lines: [
        { glAccount: debit, debitCredit: 'S', amount },
        { glAccount: credit, debitCredit: 'H', amount },
      ],
    });
  }
  await page.goto(`${base}${ROUTE}?companyCode=1000&glAccount=400000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const resBoxes = page.locator('input[name="item"]');
  assert.equal(await resBoxes.count(), 2);
  await resBoxes.nth(0).check();
  await resBoxes.nth(1).check();
  await page.locator('select[name="method"]').selectOption('RESIDUAL');
  await page.locator('input[name="residualReasonCode"]').fill('R01');
  const resSettlements = page.locator('input[name^="settlement:"]');
  await resSettlements.nth(0).fill('200');
  await resSettlements.nth(1).fill('200');
  await page.locator('input[name="documentType"]').fill('AB');
  await page.locator('input[name="confirmed"]').check();
  await page.getByRole('button', { name: 'Post clearing' }).click();
  await page.getByText(/residual item\(s\) re-stood/).waitFor();
  console.log('  ✓ the residual clearing posted and names its residual item');

  const residual = await withTenant(client, async (tx) => tx.execute(sql`
    select r.reason_code, r.generated_amount::text as amount, l.amount_local::text as line_amount
    from gl_clearing_residual r
    join journal_entry_line l
      on l.client = r.client and l.document_number = r.residual_document
     and l.fiscal_year = r.residual_fiscal_year and l.line_number = r.residual_line_number
    where r.client = ${client} and r.is_active
  `)) as unknown as Array<{ reason_code: string; amount: string; line_amount: string }>;
  assert.equal(residual.length, 1);
  assert.equal(residual[0]!.reason_code, 'R01');
  assert.equal(Number(residual[0]!.amount), 300);
  assert.equal(Number(residual[0]!.line_amount), 300);
  console.log('  ✓ the residual lineage names R01 with a 300 open line');
}
