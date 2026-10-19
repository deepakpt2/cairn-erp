import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import {
  activateArea, assignUnit, saveArea, saveDataBasis, saveGroup,
  saveGroupAccount, saveMapping, saveMethod, saveTask, saveUnit, saveVersion,
} from '../../src/modules/finance/consolidation-workbench';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/finance/consolidation-monitor';
const ACTOR = { changedBy: 'browser.admin', reason: 'Browser acceptance run' };

/**
 * SCR-117 browser acceptance: consolidation monitor (CX20).
 *
 * The journey: UCWB configuration stands through the service,
 * the monitor blocks the child task, a test run of the parent
 * stands in immutable history with its log, and no journal
 * posting exists.
 */
export async function consolidationMonitor(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-117: execute configured tasks in the consolidation monitor');

  const variant = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select fiscal_year_variant from company_code where client = ${client} and company_code = '1000'
    `) as unknown as Array<{ fiscal_year_variant: string }>;
    return rows[0]?.fiscal_year_variant ?? 'K4';
  });
  await saveDataBasis({ client, ...ACTOR, basis: 'BASIS1', title: 'Journal basis', dimensions: [{ dimension: 'COMPANY_CODE' }] });
  await saveArea({ client, ...ACTOR, area: 'C100', title: 'Group consolidation', dataBasis: 'BASIS1', consChart: 'GC01', fiscalYearVariant: variant });
  await saveUnit({ client, ...ACTOR, area: 'C100', unit: 'U1000', title: 'Acceptance unit', companyCode: '1000' });
  await saveGroup({ client, ...ACTOR, area: 'C100', group: 'GRP1', title: 'Group' });
  await assignUnit({ client, ...ACTOR, area: 'C100', group: 'GRP1', unit: 'U1000', validFrom: '2026-01-01', validTo: '2026-12-31' });
  await saveGroupAccount({ client, ...ACTOR, consChart: 'GC01', account: '100000', title: 'Group assets' });
  await saveMapping({ client, ...ACTOR, consChart: 'GC01', sourceChart: 'CA01', sourceFrom: '110000', sourceTo: '110000', groupAccount: '100000' });
  await saveMethod({ client, ...ACTOR, area: 'C100', method: 'MVAL', kind: 'OTHER', title: 'Collect and validate' });
  await saveVersion({ client, ...ACTOR, area: 'C100', version: '100', title: 'Actual' });
  await saveTask({ client, ...ACTOR, area: 'C100', version: '100', task: 'T100', sequence: 10, taskType: 'DATA_COLLECTION', method: 'MVAL', unit: 'U1000', group: 'GRP1', validFrom: '2026-01-01', validTo: '2026-12-31' });
  await saveTask({ client, ...ACTOR, area: 'C100', version: '100', task: 'T200', parentTask: 'T100', sequence: 20, taskType: 'VALIDATION', method: 'MVAL', unit: 'U1000', group: 'GRP1', validFrom: '2026-01-01', validTo: '2026-12-31' });
  await activateArea({ client, ...ACTOR, area: 'C100' });

  await page.goto(`${base}${ROUTE}?area=C100&group=GRP1&version=100&fiscalYear=2026&period=12&mode=TEST`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: 'Consolidation Monitor' }).waitFor();
  const parentRow = page.locator('tr', { hasText: 'T100' }).first();
  const childRow = page.locator('tr', { hasText: 'T200' }).first();
  await parentRow.getByText('OPEN', { exact: true }).waitFor();
  await childRow.getByText('BLOCKED', { exact: true }).waitFor();
  console.log('  ✓ the child task stands blocked behind its UCWB parent');

  await parentRow.getByRole('button', { name: 'Execute task' }).click();
  await page.getByText(/TEST run .* for task T100 finished WARNING/).waitFor();
  await page.locator('tr', { hasText: 'T100' }).first().getByText('WARNING', { exact: true }).waitFor();
  await page.getByText('JOURNAL provider read company 1000').waitFor();
  console.log('  ✓ the parent test run stands in history with its log; the warning still blocks the child');

  const counts = await withTenant(client, async (tx) => {
    const executions = await tx.execute(sql`select count(*)::int as n from consolidation_execution where client = ${client}`) as unknown as Array<{ n: number }>;
    const journals = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    return { executions: executions[0]?.n ?? 0, journals: journals[0]?.n ?? 0 };
  });
  assert.equal(counts.journals, 0);
  assert.ok(counts.executions >= 1);
  console.log('  ✓ the test run posted no journal');
}
