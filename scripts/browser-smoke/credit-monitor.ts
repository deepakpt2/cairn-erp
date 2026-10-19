import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { saveCustomerCredit } from '../../src/modules/finance/credit';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const MONITOR = '/finance/credit-monitor';

/**
 * SCR-104 browser acceptance: credit exposure monitor (F.31).
 *
 * The journey: a customer with a credit record and an open
 * receivable appears in the overview with its utilization; a
 * second customer with exposure but no record is flagged, never
 * hidden. The monitor stays read-only throughout.
 */
export async function creditMonitor(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-104: read the credit exposure overview');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
      values (${client}, '1000', 'Main credit area', 'KWD', 90, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`update company_code set credit_control_area = '1000' where client = ${client} and company_code = '1000'`);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name)
      values (${client}, 'C100', 'Monitor Customer'), (${client}, 'C200', 'Unrecorded Customer')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into credit_risk_category (client, risk_category, name, created_by)
      values (${client}, 'A', 'Low risk', 'browser.admin') on conflict do nothing
    `);
    for (const [customer, amount, key] of [['C100', 4000, 'MON-BROWSER-1'], ['C200', 2500, 'MON-BROWSER-2']] as const) {
      await tx.execute(sql`
        insert into journal_entry
          (client, document_number, fiscal_year, document_type, company_code, document_date,
           posting_date, posting_period, document_currency, local_currency, status, created_by)
        values (${client}, ${key}, 2026, 'SA', '1000', '2026-04-10', '2026-04-10', 4, 'KWD', 'KWD', 'POSTED', 'browser.admin')
      `);
      await tx.execute(sql`
        insert into journal_entry_line
          (client, document_number, fiscal_year, line_number, gl_account, company_code,
           debit_credit, amount_local, amount_document, currency, business_partner)
        values
          (${client}, ${key}, 2026, 1, '101000', '1000', 'S', ${amount}, ${amount}, 'KWD', ${customer}),
          (${client}, ${key}, 2026, 2, '300000', '1000', 'H', ${amount}, ${amount}, 'KWD', null)
      `);
    }
  });
  await saveCustomerCredit({
    client, changedBy: 'browser.admin', customer: 'C100', creditControlArea: '1000',
    creditLimit: '5000', riskCategory: 'A', isBlocked: false, changeReason: 'Initial assessment',
  });

  await page.goto(`${base}${MONITOR}?areaFrom=1000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Credit Exposure Monitor', exact: true }).waitFor();

  const recorded = page.locator('tr', { hasText: 'Monitor Customer' }).first();
  await recorded.getByText('80.0%').waitFor();
  console.log('  ✓ recorded customer shows limit, exposure and utilization');

  const unrecorded = page.locator('tr', { hasText: 'Unrecorded Customer' }).first();
  await unrecorded.getByText('No credit record').waitFor();
  console.log('  ✓ exposure without a record is flagged, never hidden');

  const version = await withTenant(client, async (tx) => tx.execute(sql`
    select version from customer_credit where client = ${client} and customer = 'C100'
  `));
  assert.equal((version as unknown as Array<{ version: number }>)[0]?.version, 1);
  console.log('  ✓ the monitor wrote nothing — the record still stands at version 1');
}
