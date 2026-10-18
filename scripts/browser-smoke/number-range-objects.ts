import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/number-range-objects';
const ACTIVITY = 'CFG.PLT.NUMBERRANGE.DEFINE';
const REASON = 'Browser acceptance run';

/**
 * SCR-050 / SNRO browser acceptance: number range objects and intervals.
 *
 * The journey: the registry reads back under its SAP-width names, an
 * object's facts are maintained, an external interval is created
 * through the screen that used to refuse it, and the guarded
 * current-number act moves its counter with the reason standing in the
 * trail. asserted twice, as always: in the browser and in the database.
 */
export async function numberRangeObjectsSnro(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-050 SNRO: verify the registry, the fact change, the external interval creation, and the guarded current-number act');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
  });

  // ── 1. The registry stands under SAP-width names ────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Maintain Number Range Objects', exact: true }).waitFor();
  const section = page.locator('section[aria-labelledby="number-range-objects-grid"]');
  for (const code of ['RF_BELEG', 'MATERIALNR', 'BUSPARTNR']) {
    await section.getByRole('cell', { name: code, exact: true }).waitFor();
  }
  console.log('  ✓ the registry stands under SAP-width names');

  // ── 2. An object's facts are maintained ──────────────────────────────────
  const belegRow = section.locator('tr').filter({
    has: page.getByRole('cell', { name: 'RF_BELEG', exact: true }),
  });
  await belegRow.getByRole('button', { name: 'Change', exact: true }).click();
  await section.locator('#nro-description').fill('Accounting documents (acceptance)');
  await section.locator('#nro-warning').fill('90');
  await section.locator('#nro-reason').fill(REASON);
  await section.getByRole('button', { name: 'Save changes', exact: true }).click();
  await section.getByText('Number range object RF_BELEG saved.').waitFor();
  await belegRow.getByRole('cell', { name: '90.0%', exact: true }).waitFor();
  console.log('  ✓ the object facts change and read back');

  // ── 3. The previously refused external interval is creatable ────────────
  await page.getByRole('link', { name: 'Number range intervals', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Number ranges', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Create interval', exact: true }).click();
  await page.locator('select[name="objectCode"]').selectOption('MATERIALNR');
  await page.locator('input[name="subObject"]').fill('XT');
  await page.locator('input[name="fromNumber"]').fill('100');
  await page.locator('input[name="toNumber"]').fill('199');
  await page.locator('select[name="isExternal"]').selectOption('external');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('link', { name: 'Return to monitor', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('cell', { name: 'MATERIALNR', exact: true }).first().waitFor();
  console.log('  ✓ the external interval stands through the screen');

  // ── 4. The guarded current-number act ────────────────────────────────────
  const xtRow = page.locator('tr').filter({
    has: page.getByRole('cell', { name: 'XT', exact: true }),
  });
  await xtRow.getByRole('link', { name: 'Change', exact: true }).click();
  await page.getByRole('heading', { level: 2, name: 'Adjust current number', exact: true }).waitFor();
  await page.locator('input[name="currentNumber"]').fill('150');
  await page.locator('section[aria-labelledby="adjust-current-title"] input[name="reason"]').fill(REASON);
  await page.getByRole('button', { name: 'Adjust current number', exact: true }).click();
  await page.getByText('Current number adjusted.').waitFor();
  console.log('  ✓ the counter moves only through its guarded act');

  // ── 5. The database remembers it all ─────────────────────────────────────
  const evidence = await withTenant(client, async (tx) => {
    const objects = await tx.execute(sql`
      select description, warning_percent from number_range_object
      where client = ${client} and object_code = 'RF_BELEG'
    `);
    const ranges = await tx.execute(sql`
      select is_external, current_number from number_range
      where client = ${client} and object_code = 'MATERIALNR' and sub_object = 'XT'
    `);
    const history = await changeHistory(tx, client, 'number_range', 'MATERIALNR/*/XT/0');
    return {
      objects: objects as unknown as Record<string, unknown>[],
      ranges: ranges as unknown as Record<string, unknown>[],
      history,
    };
  });
  assert.equal(evidence.objects[0].description, 'Accounting documents (acceptance)');
  assert.equal(String(evidence.objects[0].warning_percent), '90.0');
  assert.equal(evidence.ranges.length, 1);
  assert.equal(evidence.ranges[0].is_external, true);
  assert.equal(Number(evidence.ranges[0].current_number), 150);
  assert.ok(evidence.history.length >= 2, 'Creation and the current-number act are both documented.');
  console.log('  ✓ the database remembers the facts, the interval and the act');
}
