import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import {
  activateArea, assignUnit, saveArea, saveDataBasis, saveGroup,
  saveMethod, saveUnit, saveVersion,
} from '../../src/modules/finance/consolidation-workbench';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/consolidation';
const ACTOR = { changedBy: 'browser.admin', reason: 'Browser acceptance run' };

/**
 * SCR-116 browser acceptance: consolidation workbench (UCWB).
 *
 * The journey: configuration stands through the service, the
 * workbench shows the unit in Master Data, one method is
 * saved through the screen, and no journal posting exists.
 */
export async function consolidationWorkbench(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-116: configure a consolidation area in the workbench');

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
  await saveMethod({ client, ...ACTOR, area: 'C100', method: 'FX01', kind: 'CURRENCY_TRANSLATION', title: 'Translate' });
  await saveVersion({ client, ...ACTOR, area: 'C100', version: '100', title: 'Actual' });
  await activateArea({ client, ...ACTOR, area: 'C100' }).catch(() => undefined); // tasks gate activation; the journey asserts the workbench, activation proof stands in service tests

  await page.goto(`${base}${ROUTE}?area=C100&folder=MASTER_DATA`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: 'Consolidation Workbench' }).waitFor();
  const unitRow = page.locator('tr', { hasText: 'U1000' }).first();
  await unitRow.getByText('Acceptance unit').waitFor();
  await unitRow.getByText('GRP1').waitFor();
  console.log('  ✓ the unit stands in Master Data with its group assignment');

  await page.goto(`${base}${ROUTE}?area=C100&folder=METHODS`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('input[name="method"]').fill('VAL01');
  await page.locator('input[name="title"]').first().fill('Validate');
  await page.locator('input[name="reason"]').fill('Browser acceptance run');
  await page.getByRole('button', { name: 'Save method' }).click();
  await page.getByText('Method VAL01 saved.').waitFor();
  console.log('  ✓ a method saved through the screen stands confirmed');

  const postings = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from journal_entry where client = ${client}
  `));
  assert.equal((postings as unknown as Array<{ n: number }>)[0]?.n, 0);
  console.log('  ✓ configuration posted nothing');
}
