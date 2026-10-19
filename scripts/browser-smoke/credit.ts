import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const CREDIT = '/finance/credit';

/**
 * SCR-103 browser acceptance: customer credit management (FD32).
 *
 * The journey: a customer with no credit record shows the
 * explicit no-record notice; the credit data is then created
 * with a stated reason, the save succeeds, and the append-only
 * change history shows the audited fields in the database.
 */
export async function customerCredit(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-103: create credit data for a customer and read its audit');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
      values (${client}, '1000', 'Main credit area', 'KWD', 90, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      update company_code set credit_control_area = '1000'
      where client = ${client} and company_code = '1000'
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name)
      values (${client}, 'C100', 'Browser Credit Customer') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into credit_risk_category (client, risk_category, name, created_by)
      values (${client}, 'A', 'Low risk', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into credit_block_reason (client, reason_code, name, created_by)
      values (${client}, '01', 'Manual credit hold', 'browser.admin') on conflict do nothing
    `);
  });

  await page.goto(`${base}${CREDIT}?customer=C100&area=1000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Customer Credit Management', exact: true }).waitFor();
  await page.getByText(/No credit record stands for C100 in 1000 yet/).waitFor();
  console.log('  ✓ the missing record is explicit, never silently bypassed');

  await page.locator('input[name="creditLimit"]').fill('10000');
  await page.locator('input[name="changeReason"]').fill('Initial credit assessment');
  await page.getByRole('button', { name: 'Save credit data', exact: true }).click();
  await page.getByText(/Credit data for C100 in 1000 saved \(limit 10000\.00 KWD, version 1\)/).waitFor();
  console.log('  ✓ credit data saved with its stated reason');

  const auditRow = page.locator('tr', { hasText: 'credit_limit' }).first();
  await auditRow.getByText('Initial credit assessment').waitFor();
  console.log('  ✓ the change history shows the audited limit');

  const stored = await withTenant(client, async (tx) => tx.execute(sql`
    select credit_limit::text as lim, version from customer_credit
    where client = ${client} and customer = 'C100' and credit_control_area = '1000'
  `));
  const record = (stored as unknown as Array<{ lim: string; version: number }>)[0];
  assert.equal(Number(record?.lim), 10000);
  assert.equal(record?.version, 1);
  console.log('  ✓ the credit record stands in the database at version 1');
}
