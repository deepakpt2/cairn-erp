import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ACCRUALS = '/finance/accruals';

/**
 * SCR-100 browser acceptance: accrual entry (FBS1) and due
 * reversal (F.81).
 *
 * The journey: an accrual document is entered with its reversal
 * date and reason and posted; because the reversal date has
 * already arrived it stands in the due list, and executing the
 * reversal there marks it reversed with its mirror document.
 */
export async function accrualDocument(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-100: post an accrual and reverse it when due');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    await tx.execute(sql`
      insert into reversal_reason (client, reason_code, reason_description, is_active, created_by)
      values (${client}, '01', 'Accrual reversal', true, 'browser.admin') on conflict do nothing
    `);
  });

  await page.goto(`${base}${ACCRUALS}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Accrual/Deferral Documents', exact: true }).waitFor();

  await page.locator('input[name="documentDate"]').fill('2026-04-01');
  await page.locator('input[name="postingDate"]').fill('2026-04-01');
  await page.locator('input[name="reversalDate"]').fill('2026-05-01');
  await page.locator('input[name="line_0_account"]').fill('400000');
  await page.locator('input[name="line_0_amount"]').fill('1200');
  await page.locator('input[name="line_1_account"]').fill('101000');
  await page.locator('input[name="line_1_amount"]').fill('1200');
  await page.getByText(/Document balances at/).waitFor();
  await page.getByRole('button', { name: 'Post accrual document', exact: true }).click();
  await page.getByText(/Accrual document JE-\S+ posted in fiscal year 2026; reversal due 2026-05-01/).waitFor();
  console.log('  ✓ accrual document posted with its reversal metadata');

  const row = page.locator('tr', { hasText: 'PENDING' }).first();
  await row.getByRole('button', { name: 'Reverse now', exact: true }).click();
  await page.locator('tr', { hasText: 'REVERSED' }).first().waitFor();
  console.log('  ✓ the due reversal executed and the document stands reversed');

  const stored = await withTenant(client, async (tx) => tx.execute(sql`
    select reversal_status, reversal_document_number from accrual_document
    where client = ${client} order by created_at desc limit 1
  `));
  const record = (stored as unknown as Array<{ reversal_status: string; reversal_document_number: string }>)[0];
  assert.equal(record?.reversal_status, 'REVERSED');
  assert.ok(record?.reversal_document_number, 'reversal document recorded');
  console.log('  ✓ the metadata names the reversal document in the database');
}
