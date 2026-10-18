import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const REASON = 'Browser acceptance run';

/**
 * SCR-053 / MM06 browser acceptance: material deletion flags.
 *
 * The journey: a material standing unflagged at both scopes, the
 * client flag set through its confirmed act, the plant row showing
 * itself covered, the client flag cancelled again, and the plant flag
 * set on its own scope — the database remembering every act.
 */
export async function materialDeletionFlagMm06(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-053 MM06: verify the client flag act, the covered plant row, the cancellation, and the plant flag');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, material_group,
        base_unit, industry_sector, created_by)
      values (${client}, 'FLAG-MAT', 'Flagged browser component', 'RAW', 'RAW', 'KG', 'M', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'FLAG-MAT', '1000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });

  // ── 1. Both scopes stand unflagged ───────────────────────────────────────
  await page.goto(`${base}/inventory/materials?material=FLAG-MAT`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForLoadState('networkidle');
  const panel = page.locator('section[aria-labelledby="material-deletion-title"]');
  await panel.getByRole('heading', { name: 'Deletion flag', exact: true }).waitFor();
  const clientRow = panel.locator('tr').filter({ hasText: 'Client level' });
  const plantRow = panel.locator('tr').filter({ hasText: 'Plant 1000' });
  await clientRow.getByText('Not flagged', { exact: true }).waitFor();
  console.log('  ✓ both scopes stand unflagged');

  // ── 2. The client flag is set through its confirmed act ──────────────────
  await clientRow.getByRole('button', { name: 'Flag for deletion', exact: true }).click();
  await page.locator('#deletion-flag-reason').fill(REASON);
  await page.getByRole('button', { name: 'Flag for deletion', exact: true }).last().click();
  await page.getByText('Deletion flag set at client level.').waitFor();
  await clientRow.getByText('Flagged for deletion', { exact: true }).waitFor();
  await plantRow.getByText('Covered by the client-level flag', { exact: true }).waitFor();
  console.log('  ✓ the client flag stands and covers the plant row');

  // ── 3. The client flag cancels again ─────────────────────────────────────
  await clientRow.getByRole('button', { name: 'Cancel flag', exact: true }).click();
  await page.locator('#deletion-flag-reason').fill(REASON);
  await page.getByRole('button', { name: 'Cancel flag', exact: true }).last().click();
  await page.getByText('Deletion flag cancelled at client level.').waitFor();
  await clientRow.getByText('Not flagged', { exact: true }).waitFor();
  console.log('  ✓ the client flag cancels cleanly');

  // ── 4. The plant flag stands on its own scope ────────────────────────────
  await plantRow.getByRole('button', { name: 'Flag for deletion', exact: true }).click();
  await page.locator('#deletion-flag-reason').fill(REASON);
  await page.getByRole('button', { name: 'Flag for deletion', exact: true }).last().click();
  await page.getByText('Deletion flag set for plant 1000.').waitFor();
  await plantRow.getByText('Flagged for deletion', { exact: true }).waitFor();
  await clientRow.getByText('Not flagged', { exact: true }).waitFor();
  console.log('  ✓ the plant flag stands without touching the client flag');

  // ── 5. The database remembers every act ──────────────────────────────────
  const evidence = await withTenant(client, async (tx) => {
    const materials = await tx.execute(sql`
      select marked_for_deletion from material
      where client = ${client} and material_number = 'FLAG-MAT'
    `);
    const plants = await tx.execute(sql`
      select marked_for_deletion from material_plant
      where client = ${client} and material_number = 'FLAG-MAT' and plant = '1000'
    `);
    const clientHistory = await changeHistory(tx, client, 'material', 'FLAG-MAT');
    const plantHistory = await changeHistory(tx, client, 'material_plant', 'FLAG-MAT/1000');
    return {
      materials: materials as unknown as Record<string, unknown>[],
      plants: plants as unknown as Record<string, unknown>[],
      clientHistory,
      plantHistory,
    };
  });
  assert.equal(evidence.materials[0].marked_for_deletion, false);
  assert.equal(evidence.plants[0].marked_for_deletion, true);
  const flagEntries = (rows: typeof evidence.clientHistory) =>
    rows.filter((h) => h.items.some((i) => i.fieldName === 'markedForDeletion'));
  assert.equal(flagEntries(evidence.clientHistory).length, 2);
  assert.equal(flagEntries(evidence.plantHistory).length, 1);
  console.log('  ✓ the database remembers the set, the cancellation and the plant act');
}
