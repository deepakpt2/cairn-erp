import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/material-number-ranges';
const ACTIVITY = 'CFG.INV.MATERIALRANGE.DEFINE';
const REASON = 'Browser acceptance run';

/**
 * SCR-051 / MMNR browser acceptance: material number range groups.
 *
 * The journey: intervals standing ungrouped, a group defined over them
 * through the screen, a material type assigned by picking the group on
 * OMS2 (its text then standing beside the type's keys), deletion
 * refused under the carrying type, and MM01 drawing the first internal
 * number for a blank material number. asserted in browser and database.
 */
export async function materialNumberRangesMmnr(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-051 MMNR: verify group definition, group assignment on OMS2, the deletion refusal, and the MM01 draw');

  await withTenant(client, async (tx) => {
    for (const activity of [ACTIVITY, 'CFG.INV.MATERIALTYPE.DEFINE']) {
      await tx.execute(sql`
        insert into config_activity_status (client, activity_code, status, created_by)
        values (${client}, ${activity}, 'NOT_STARTED', 'BROWSER_SMOKE')
        on conflict (client, activity_code) do nothing
      `);
    }
    for (const [sub, from, to, external] of [
      ['01', 1000, 1999, false],
      ['02', 5000, 5999, true],
    ] as const) {
      await tx.execute(sql`
        insert into number_range (client, object_code, company_code, sub_object, fiscal_year,
          from_number, to_number, current_number, is_external, status, created_by)
        values (${client}, 'MATERIALNR', '*', ${sub}, 0, ${from}, ${to}, ${from - 1}, ${external}, 'ACTIVE', 'BROWSER_SMOKE')
        on conflict do nothing
      `);
    }
  });

  // ── 1. The intervals stand ungrouped; the group is defined over them ────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Define Material Number Ranges', exact: true }).waitFor();
  const ungroupedSection = page.locator('section[aria-labelledby="material-range-ungrouped-grid"]');
  await ungroupedSection.getByRole('cell', { name: '01', exact: true }).waitFor();
  await page.locator('#mrg-internal').fill('01');
  await page.locator('#mrg-external').fill('02');
  await page.locator('#mrg-description').fill('Browser range group');
  await page.locator('#mrg-reason').fill(REASON);
  await page.getByRole('button', { name: 'Define number range group', exact: true }).click();
  await page.getByText('Number range group 01/02 saved.').waitFor();
  const groupsSection = page.locator('section[aria-labelledby="material-range-groups-grid"]');
  await groupsSection.getByRole('cell', { name: 'Browser range group', exact: true }).waitFor();
  await groupsSection.getByRole('cell', { name: '1000', exact: true }).waitFor();
  console.log('  ✓ the group stands over its intervals in the matrix');

  // ── 2. OMS2 assigns RAW by picking the group; the text stands beside it ─
  await page.goto(`${base}/config/material-types`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const typesSection = page.locator('section[aria-labelledby="material-types-grid"]');
  const rawRow = typesSection.locator('tr').filter({
    has: page.getByRole('cell', { name: 'RAW', exact: true }),
  });
  await rawRow.getByRole('button', { name: 'Change', exact: true }).click();
  await page.locator('#mt-range-group').selectOption('01/02');
  assert.equal(await page.locator('#mt-int-range').inputValue(), '01');
  assert.equal(await page.locator('#mt-ext-range').inputValue(), '02');
  await page.locator('#mt-reason').fill(REASON);
  await page.getByRole('button', { name: 'Save changes', exact: true }).first().click();
  await page.getByText('Material type RAW saved.').waitFor();
  await rawRow.getByText('Browser range group', { exact: true }).waitFor();
  console.log('  ✓ the picker fills both keys and the group text stands beside them');

  // ── 3. Deletion is refused while RAW carries the pair ────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await groupsSection.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('#dlg-range-group-delete-reason').fill(REASON);
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await page.getByText(/cannot be deleted: 1 material type carries its intervals/).waitFor();
  console.log('  ✓ deletion refuses under the carrying type');

  // ── 4. MM01 draws the first internal number for a blank number ──────────
  await page.goto(`${base}/inventory/materials?new=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('input[name="description"]').fill('Browser drawn component');
  await page.locator('select[name="baseUnit"]').selectOption('KG');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText(/View saved/).waitFor();
  await page.locator('a[href*="material=1000"]').waitFor();
  console.log('  ✓ the blank number drew 1000 from the internal interval');

  // ── 5. The database remembers it all ─────────────────────────────────────
  const evidence = await withTenant(client, async (tx) => {
    const groups = await tx.execute(sql`
      select description from material_number_range_group
      where client = ${client} and internal_range_key = '01' and external_range_key = '02'
    `);
    const types = await tx.execute(sql`
      select internal_number_range, external_number_range from material_type
      where client = ${client} and material_type = 'RAW'
    `);
    const materials = await tx.execute(sql`
      select material_type from material where client = ${client} and material_number = '1000'
    `);
    const ranges = await tx.execute(sql`
      select current_number from number_range
      where client = ${client} and object_code = 'MATERIALNR' and sub_object = '01'
    `);
    return {
      groups: groups as unknown as Record<string, unknown>[],
      types: types as unknown as Record<string, unknown>[],
      materials: materials as unknown as Record<string, unknown>[],
      ranges: ranges as unknown as Record<string, unknown>[],
    };
  });
  assert.equal(evidence.groups[0].description, 'Browser range group');
  assert.deepEqual(
    [evidence.types[0].internal_number_range, evidence.types[0].external_number_range],
    ['01', '02'],
  );
  assert.equal(evidence.materials[0].material_type, 'RAW');
  assert.equal(Number(evidence.ranges[0].current_number), 1000);
  console.log('  ✓ the database remembers the group, the assignment and the draw');
}
