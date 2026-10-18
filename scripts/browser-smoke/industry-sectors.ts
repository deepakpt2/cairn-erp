import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/industry-sectors';
const ACTIVITY = 'CFG.INV.INDUSTRYSECTOR.DEFINE';
const REASON = 'Browser acceptance run';

/**
 * SCR-052 / OMS3 + MM01 browser acceptance: industry sectors.
 *
 * The journey: the delivered sectors stand on the new master screen, a
 * sector is defined and renamed through it, MM01 creates a material
 * under a picked sector, and the carrying sector refuses deletion.
 * asserted in the browser and in the database.
 */
export async function industrySectorsOms3(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-052 OMS3: verify the delivered sectors, sector maintenance, the MM01 sector pick, and the deletion refusal');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
  });

  // ── 1. The delivered sectors stand ───────────────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Define Industry Sectors', exact: true }).waitFor();
  const section = page.locator('section[aria-labelledby="industry-sectors-grid"]');
  for (const [key, name] of [
    ['A', 'Plant engineering and construction'],
    ['M', 'Mechanical engineering'],
    ['R', 'Retail'],
  ] as const) {
    const row = section.locator('tr').filter({
      has: page.getByRole('cell', { name: key, exact: true }),
    });
    await row.getByRole('cell', { name, exact: true }).waitFor();
  }
  console.log('  ✓ the delivered sectors stand on the master');

  // ── 2. A sector is defined and renamed through the screen ────────────────
  await page.locator('#is-key').fill('Z');
  await page.locator('#is-name').fill('Browser sector');
  await page.locator('#is-reason').fill(REASON);
  await page.getByRole('button', { name: 'Define industry sector', exact: true }).click();
  await page.getByText('Industry sector Z saved.').waitFor();
  const zRow = section.locator('tr').filter({
    has: page.getByRole('cell', { name: 'Z', exact: true }),
  });
  await zRow.getByRole('button', { name: 'Change', exact: true }).click();
  await page.locator('#is-name').fill('Browser pilot sector');
  await page.locator('#is-reason').fill(REASON);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Industry sector Z saved.').waitFor();
  await zRow.getByRole('cell', { name: 'Browser pilot sector', exact: true }).waitFor();
  console.log('  ✓ the sector is defined and renamed through the screen');

  // ── 3. MM01 creates under a picked sector ────────────────────────────────
  await page.goto(`${base}/inventory/materials?new=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('input[name="materialNumber"]').fill('SECTOR-MAT');
  await page.locator('input[name="description"]').fill('Browser sector component');
  await page.locator('select[name="baseUnit"]').selectOption('KG');
  await page.locator('select[name="industrySector"]').selectOption('M');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText(/View saved/).waitFor();
  console.log('  ✓ MM01 creates the material under the picked sector');

  // ── 4. The carrying sector refuses deletion ──────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const mRow = section.locator('tr').filter({
    has: page.getByRole('cell', { name: 'M', exact: true }),
  });
  await mRow.getByRole('cell', { name: '1', exact: true }).waitFor();
  await mRow.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('#dlg-sector-delete-reason').fill(REASON);
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await page.getByText(/cannot be deleted: 1 material carries it/).waitFor();
  console.log('  ✓ the carrying sector refuses deletion');

  // ── 5. The database remembers it all ─────────────────────────────────────
  const evidence = await withTenant(client, async (tx) => {
    const sectors = await tx.execute(sql`
      select name, is_active from industry_sector where client = ${client} and sector = 'Z'
    `);
    const materials = await tx.execute(sql`
      select industry_sector, length(description) as description_length from material
      where client = ${client} and material_number = 'SECTOR-MAT'
    `);
    return {
      sectors: sectors as unknown as Record<string, unknown>[],
      materials: materials as unknown as Record<string, unknown>[],
    };
  });
  assert.equal(evidence.sectors[0].name, 'Browser pilot sector');
  assert.equal(evidence.materials[0].industry_sector, 'M');
  assert.ok(Number(evidence.materials[0].description_length) <= 40);
  console.log('  ✓ the database remembers the sector, the rename and the material');
}
