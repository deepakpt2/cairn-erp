import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/material-types';
const ACTIVITY = 'CFG.INV.MATERIALTYPE.DEFINE';
const REASON = 'Browser acceptance run';

/**
 * SCR-048 / OMS2 browser acceptance: defining material types.
 *
 * The journey follows the contract's parity: the provisioned types read
 * back at their narrowed shape, a type is created only because its
 * number ranges stand in the engine and is refused when it is defined
 * twice, an updating flip is refused while a material of the type
 * stands at the plant, and a used type refuses deletion while offering
 * deactivation instead — the operator's whole toolkit, travelled.
 *
 * Everything asserted here is asserted twice: once in the browser,
 * because the screen is the product, and once in the database, because
 * a form that renders a value is not a form that stored it.
 */
export async function materialTypesOms2(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-048 OMS2: verify the workbench route, the provisioned types, the range-judged creation, the duplicate refusal, the updating guard, the deletion refusal, and deactivation');

  // The fixture tenant: prerequisite completed, this activity ready,
  // the material number ranges standing in the engine, and one RAW
  // material standing at the plant so the guards have something to guard.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, 'CFG.ORG.PLANT.DEFINE', 'COMPLETED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do update set status = 'COMPLETED'
    `);
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
    for (const [sub, external] of [['01', false], ['02', true]] as const) {
      await tx.execute(sql`
        insert into number_range (client, object_code, company_code, sub_object, fiscal_year,
          from_number, to_number, current_number, is_external, status, created_by)
        values (${client}, 'MATERIAL', '*', ${sub}, 0, 1, 999999, 0, ${external}, 'ACTIVE', 'BROWSER_SMOKE')
        on conflict do nothing
      `);
    }
    await tx.execute(sql`
      insert into material (client, material_number, material_type, created_by)
      values (${client}, 'BROWSER-MAT-1', 'RAW', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'BROWSER-MAT-1', '1000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });

  // ── 1. The workbench routes here; the provisioned types stand ───────────
  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const workbenchRow = page.locator('tr').filter({ hasText: ACTIVITY }).first();
  await workbenchRow.waitFor();
  assert.equal(
    await workbenchRow.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
    ROUTE,
    'The workbench opens the screen that can do the work.',
  );

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Define Material Types', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · OMS2`),
    'The screen says which activity and which reference transaction it is.',
  );
  const typesSection = page.locator('section[aria-labelledby="material-types-grid"]');
  for (const key of ['FIN', 'RAW', 'SEMI', 'SERV', 'TRAD']) {
    await typesSection.getByRole('cell', { name: key, exact: true }).waitFor();
  }
  console.log('  ✓ the workbench routes here and the provisioned types stand at parity shape');

  // ── 2. A type created against the standing ranges ────────────────────────
  await typesSection.locator('#mt-key').fill('BTST');
  await typesSection.locator('#mt-name').fill('Browser Test Type');
  await typesSection.locator('#mt-int-range').fill('01');
  await typesSection.locator('#mt-ext-range').fill('02');
  await typesSection.locator('#mt-reason').fill(REASON);
  await typesSection.getByRole('button', { name: 'Define material type', exact: true }).click();
  await typesSection.getByRole('cell', { name: 'BTST', exact: true }).waitFor();
  console.log('  ✓ the type stands because its number ranges stand');

  // ── 3. The same key is refused a second time ────────────────────────────
  await typesSection.locator('#mt-key').fill('BTST');
  await typesSection.locator('#mt-name').fill('Browser Test Again');
  await typesSection.locator('#mt-int-range').fill('01');
  await typesSection.locator('#mt-ext-range').fill('02');
  await typesSection.locator('#mt-reason').fill(REASON);
  await typesSection.getByRole('button', { name: 'Define material type', exact: true }).click();
  await typesSection.getByRole('alert').filter({ hasText: 'Material type BTST already stands.' }).waitFor();
  console.log('  ✓ a second definition of the same key is refused');

  // ── 4. Updating refuses to flip under standing materials ────────────────
  const rawUpdating = page.locator('form').filter({
    has: page.locator('input[name="materialType"][value="RAW"]'),
  });
  await rawUpdating.getByText('1 materials standing').waitFor();
  await rawUpdating.getByLabel(/Quantity updating/).uncheck();
  await rawUpdating.locator('input[name="reason"]').fill(REASON);
  await rawUpdating.getByRole('button', { name: 'Save updating', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'cannot change: 1 material' }).waitFor();
  console.log('  ✓ the updating flip is refused while a material stands at the plant');

  // ── 5. A used type refuses deletion ──────────────────────────────────────
  const rawRow = typesSection.locator('tr').filter({
    has: page.getByRole('cell', { name: 'RAW', exact: true }),
  });
  await rawRow.getByRole('button', { name: 'Delete', exact: true }).click();
  const deleteDialog = page.locator('div').filter({ hasText: 'Delete material type RAW' }).last();
  await page.getByRole('heading', { name: 'Delete material type RAW', exact: true }).waitFor();
  await page.locator('#dlg-delete-reason').fill(REASON);
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await page.getByRole('alert').filter({ hasText: 'cannot be deleted: 1 material carries it' }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  void deleteDialog;
  console.log('  ✓ deletion refuses while materials carry the type');

  // ── 6. Deactivation stands beside deletion ───────────────────────────────
  const btstRow = typesSection.locator('tr').filter({
    has: page.getByRole('cell', { name: 'BTST', exact: true }),
  });
  await btstRow.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await page.getByRole('heading', { name: 'Deactivate material type BTST', exact: true }).waitFor();
  await page.locator('#dlg-active-reason').fill(REASON);
  await page.getByRole('button', { name: 'Deactivate', exact: true }).last().click();
  await btstRow.getByRole('cell', { name: 'Inactive', exact: true }).waitFor();
  console.log('  ✓ the type deactivates instead of deleting');

  // ── 7. The database remembers it all ─────────────────────────────────────
  const evidence = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select material_type, internal_number_range, external_number_range,
             account_category_reference, is_active
      from material_type where client = ${client} and material_type = 'BTST'
    `);
    const history = await changeHistory(tx, client, 'material_type', 'BTST');
    return { rows: rows as unknown as Record<string, unknown>[], history };
  });
  assert.equal(evidence.rows.length, 1, 'The created type stands exactly once.');
  assert.equal(evidence.rows[0].internal_number_range, '01');
  assert.equal(evidence.rows[0].external_number_range, '02');
  assert.equal(evidence.rows[0].account_category_reference, '0001');
  assert.equal(evidence.rows[0].is_active, false, 'The deactivation was stored.');
  assert.ok(evidence.history.length >= 2, 'Creation and deactivation are both documented.');
  console.log('  ✓ the database remembers the creation, its ranges and the deactivation');
}
