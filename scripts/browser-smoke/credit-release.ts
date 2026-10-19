import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { checkSalesDocumentCredit, saveCustomerCredit } from '../../src/modules/finance/credit';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const RELEASE = '/finance/credit-release';

/**
 * SCR-105 browser acceptance: release credit-blocked documents
 * (VKM3).
 *
 * The journey: a blocked determination stands in the queue; a
 * release attempt reports the still-failing fresh check; after
 * the limit is raised, the release succeeds on re-evaluation,
 * and the database shows the released determination.
 */
export async function creditRelease(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-105: release a blocked document after re-evaluation');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
      values (${client}, '1000', 'Main credit area', 'KWD', 90, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`update company_code set credit_control_area = '1000' where client = ${client} and company_code = '1000'`);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name)
      values (${client}, 'C100', 'Release Customer') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into credit_risk_category (client, risk_category, name, created_by)
      values (${client}, 'A', 'Low risk', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into journal_entry
        (client, document_number, fiscal_year, document_type, company_code, document_date,
         posting_date, posting_period, document_currency, local_currency, status, created_by)
      values (${client}, 'REL-BROWSER-1', 2026, 'SA', '1000', '2026-04-10', '2026-04-10', 4, 'KWD', 'KWD', 'POSTED', 'browser.admin')
    `);
    await tx.execute(sql`
      insert into journal_entry_line
        (client, document_number, fiscal_year, line_number, gl_account, company_code,
         debit_credit, amount_local, amount_document, currency, business_partner)
      values
        (${client}, 'REL-BROWSER-1', 2026, 1, '101000', '1000', 'S', 4000, 4000, 'KWD', 'C100'),
        (${client}, 'REL-BROWSER-1', 2026, 2, '300000', '1000', 'H', 4000, 4000, 'KWD', null)
    `);
  });
  await saveCustomerCredit({
    client, changedBy: 'browser.admin', customer: 'C100', creditControlArea: '1000',
    creditLimit: '5000', riskCategory: 'A', isBlocked: false, changeReason: 'Initial assessment',
  });
  const blocked = await checkSalesDocumentCredit({
    client, changedBy: 'browser.admin', salesDocument: 'SO-B1', documentDate: '2026-04-12',
    customer: 'C100', creditControlArea: '1000', orderValue: '2000', orderCurrency: 'KWD',
  });
  assert.equal(blocked.status, 'BLOCKED');

  await page.goto(`${base}${RELEASE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Release Credit-Blocked Documents', exact: true }).waitFor();
  const row = page.locator('tr', { hasText: 'SO-B1' }).first();
  await row.getByText('BLOCKED', { exact: true }).waitFor();
  console.log('  ✓ the blocked determination stands in the queue');

  await row.getByRole('button', { name: 'Release', exact: true }).click();
  await page.getByText(/SO-B1 — The fresh credit check still blocks/).waitFor();
  console.log('  ✓ release refused while the fresh check still fails — no silent bypass');

  await saveCustomerCredit({
    client, changedBy: 'browser.admin', customer: 'C100', creditControlArea: '1000',
    creditLimit: '10000', riskCategory: 'A', isBlocked: false,
    changeReason: 'Limit raised after payment', expectedVersion: 1,
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const rowAgain = page.locator('tr', { hasText: 'SO-B1' }).first();
  await rowAgain.getByRole('button', { name: 'Release', exact: true }).click();
  await page.getByText(/SO-B1 — Released: the fresh credit check passes/).waitFor();
  console.log('  ✓ release succeeded on the re-evaluated standing');

  const stored = await withTenant(client, async (tx) => tx.execute(sql`
    select status, released_by from credit_determination
    where client = ${client} and sales_document = 'SO-B1'
    order by created_at desc limit 1
  `));
  const record = (stored as unknown as Array<{ status: string; released_by: string }>)[0];
  assert.equal(record?.status, 'RELEASED');
  assert.equal(record?.released_by, 'browser.admin');
  console.log('  ✓ the released determination stands in the database with its actor');
}
