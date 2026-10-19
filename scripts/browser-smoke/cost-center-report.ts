import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postGlDocument } from '../../src/modules/finance/gl-document';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const REPORT = '/controlling/cost-center-report';

/**
 * SCR-112 browser acceptance: cost centre actual/plan report.
 *
 * The journey: a centre stands with a plan, one cost line posts,
 * and the report shows actual against plan with the signed
 * variance judged Unfavorable — persisting nothing.
 */
export async function costCenterReport(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-112: display the cost centre actual/plan report over journal cost lines');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${client}, 'A000', 'CC9001', '2026-01-01', '2026-12-31', 'Acceptance centre', 'PRODUCTION', '1000', 'browser.admin')
      on conflict (client, controlling_area, cost_center, valid_from) do nothing
    `);
    await tx.execute(sql`
      insert into cost_center_plan (client, controlling_area, plan_version, fiscal_year, period, cost_center, cost_element, planned_amount, created_by)
      values (${client}, 'A000', '000', 2026, 4, 'CC9001', '400000', 4500, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into cost_center_hierarchy (client, controlling_area, title, created_by)
      values (${client}, 'A000', 'Standard hierarchy', 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into cost_center_node (client, controlling_area, node, parent_node, title, display_order, created_by)
      values (${client}, 'A000', 'ROOT', null, 'All centres', 10, 'browser.admin')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into cost_center_node_assignment (client, controlling_area, node, cost_center, valid_from, created_by)
      values (${client}, 'A000', 'ROOT', 'CC9001', '2026-01-01', 'browser.admin')
      on conflict do nothing
    `);
  });
  await postGlDocument({
    client, changedBy: 'browser.admin', requestKey: 'browser-cc-1', companyCode: '1000',
    documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency: 'KWD',
    lines: [
      { glAccount: '400000', debitCredit: 'S', amount: '5000', costCenter: 'CC9001' },
      { glAccount: '101000', debitCredit: 'H', amount: '5000' },
    ],
  });

  await page.goto(`${base}${REPORT}?controllingArea=A000&fiscalYear=2026&periodFrom=4&periodTo=4&planVersion=000`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Execute report' }).waitFor();

  const element = page.locator('tr', { hasText: '400000' }).first();
  await element.getByText('5000.00').first().waitFor();
  await element.getByText('4500.00').first().waitFor();
  await element.getByText('500.00').first().waitFor();
  await element.getByText('Unfavorable').first().waitFor();
  console.log('  ✓ the cost element shows actual 5,000.00 against plan 4,500.00, variance judged Unfavorable');

  await page.locator('tr', { hasText: 'All centres (ROOT)' }).first().waitFor();
  console.log('  ✓ the hierarchy group row stands above the centre');

  const count = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry where client = ${client}
  `));
  assert.equal((count as unknown as Array<{ n: number }>)[0]?.n, 1);
  console.log('  ✓ the report persisted nothing beyond the fixture posting');
}
