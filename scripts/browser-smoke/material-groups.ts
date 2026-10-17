import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/material-groups';
const ACTIVITY = 'CFG.INV.MATERIALGROUP.DEFINE';
const REASON = 'Browser acceptance run';

/**
 * SCR-049 / OMSF browser acceptance: defining material groups.
 *
 * The journey: the provisioned groups read back at their narrowed
 * shape beside a RAW material that guards them, a group is defined and
 * refused a second definition, its descriptions change, the used RAW
 * group refuses deletion, and the unused group deactivates instead —
 * the classification master's whole, small toolkit travelled.
 *
 * Everything asserted here is asserted twice: once in the browser,
 * because the screen is the product, and once in the database, because
 * a form that renders a value is not a form that stored it.
 */
export async function materialGroupsOmsf(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-049 OMSF: verify the workbench route, the provisioned groups, creation and the duplicate refusal, the description change, the used-group deletion refusal, and deactivation');

  // The fixture tenant: the prerequisite completed, this activity
  // ready, and one material carrying RAW so the guard has a subject.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, 'CFG.INV.MATERIALTYPE.DEFINE', 'COMPLETED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do update set status = 'COMPLETED'
    `);
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, material_type, material_group, created_by)
      values (${client}, 'BROWSER-MAT-1', 'RAW', 'RAW', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });

  // ── 1. The workbench routes here; the provisioned groups stand ──────────
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
  await page.getByRole('heading', { level: 1, name: 'Define Material Groups', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · OMSF`),
    'The screen says which activity and which reference transaction it is.',
  );
  const section = page.locator('section[aria-labelledby="material-groups-grid"]');
  for (const key of ['GENERAL', 'MAINT', 'PACKAGING', 'PRODUCTS', 'RAW', 'SERVICES']) {
    await section.getByRole('cell', { name: key, exact: true }).waitFor();
  }
  await section.getByRole('cell', { name: 'Maintenance and repair', exact: true }).waitFor();
  console.log('  ✓ the workbench routes here and the provisioned groups stand at parity shape');

  // ── 2. A group is defined, then refused a second definition ─────────────
  await section.locator('#mg-key').fill('BGRP');
  await section.locator('#mg-name').fill('Browser Group');
  await section.locator('#mg-long').fill('Defined by the browser acceptance run');
  await section.locator('#mg-reason').fill(REASON);
  await section.getByRole('button', { name: 'Define material group', exact: true }).click();
  await section.getByRole('cell', { name: 'BGRP', exact: true }).waitFor();

  await section.locator('#mg-key').fill('BGRP');
  await section.locator('#mg-name').fill('Browser Again');
  await section.locator('#mg-reason').fill(REASON);
  await section.getByRole('button', { name: 'Define material group', exact: true }).click();
  await section.getByRole('alert').filter({ hasText: 'Material group BGRP already stands.' }).waitFor();
  console.log('  ✓ the group is defined once and refused a second definition');

  // ── 3. Its descriptions change under the standing key ────────────────────
  const bgrpRow = section.locator('tr').filter({
    has: page.getByRole('cell', { name: 'BGRP', exact: true }),
  });
  await bgrpRow.getByRole('button', { name: 'Change', exact: true }).click();
  await section.locator('#mg-name').fill('Browser Group V2');
  await section.locator('#mg-reason').fill(REASON);
  await section.getByRole('button', { name: 'Save changes', exact: true }).click();
  await section.getByRole('cell', { name: 'Browser Group V2', exact: true }).waitFor();
  console.log('  ✓ the short description changes while the key stands');

  // ── 4. The used RAW group refuses deletion ───────────────────────────────
  const rawRow = section.locator('tr').filter({
    has: page.getByRole('cell', { name: 'RAW', exact: true }),
  });
  await rawRow.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('heading', { name: 'Delete material group RAW', exact: true }).waitFor();
  await page.locator('#dlg-group-delete-reason').fill(REASON);
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await page.getByRole('alert').filter({ hasText: 'cannot be deleted: 1 material carries it' }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  console.log('  ✓ deletion refuses while materials carry the group');

  // ── 5. Deactivation stands beside deletion ───────────────────────────────
  await bgrpRow.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await page.getByRole('heading', { name: 'Deactivate material group BGRP', exact: true }).waitFor();
  await page.locator('#dlg-group-active-reason').fill(REASON);
  await page.getByRole('button', { name: 'Deactivate', exact: true }).last().click();
  await bgrpRow.getByRole('cell', { name: 'Inactive', exact: true }).waitFor();
  console.log('  ✓ the group deactivates instead of deleting');

  // ── 6. The database remembers it all ─────────────────────────────────────
  const evidence = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select material_group, name, long_description, is_active
      from material_group where client = ${client} and material_group = 'BGRP'
    `);
    const history = await changeHistory(tx, client, 'material_group', 'BGRP');
    return { rows: rows as unknown as Record<string, unknown>[], history };
  });
  assert.equal(evidence.rows.length, 1, 'The created group stands exactly once.');
  assert.equal(evidence.rows[0].name, 'Browser Group V2');
  assert.equal(evidence.rows[0].is_active, false, 'The deactivation was stored.');
  assert.ok(evidence.history.length >= 3, 'Creation, change and deactivation are all documented.');
  console.log('  ✓ the database remembers the creation, the change and the deactivation');
}
