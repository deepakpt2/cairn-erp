import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const CREATE = '/finance/assets/new';
const LIST = '/finance/assets';

/**
 * SCR-091 browser acceptance: asset master AS01/AS02.
 *
 * The journey: an asset is created through the tabbed form with
 * class-default depreciation, appears in the list, is renamed on
 * the change screen, and its assignment is appended a year later
 * with the first interval standing closed — master data only,
 * verified in the database with an audit trail.
 */
export async function assetMasterAs01As02(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-091: create an asset through the tabs, change it, and verify the database');

  await page.goto(`${base}${CREATE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Create Asset', exact: true }).waitFor();
  const form = page.locator('section[aria-labelledby="ac-form"]');
  await chooseClosed(form, 'companyCode', '1000');
  await form.locator('input[name="assetClass"]').fill('1000');
  await form.locator('input[name="description1"]').fill('Browser lathe');
  await form.locator('input[name="inventoryNumber"]').fill('INV-BROWSER-1');
  await form.getByRole('tab', { name: 'Time-dependent assignments' }).click();
  await form.locator('input[name="validFrom"]').fill('2026-01-01');
  await form.getByRole('tab', { name: 'Depreciation areas' }).click();
  await form.getByLabel('Depreciation key').first().fill('SL01');
  await form.getByLabel('Useful life years').first().fill('10');
  await form.getByRole('tab', { name: 'General' }).click();
  await form.getByRole('button', { name: 'Create asset', exact: true }).click();
  const created = page.getByText(/Created 1 asset\(s\): AS-\d+\/0000\. No acquisition has posted\./);
  await created.waitFor();
  const assetNumber = (await created.textContent())?.match(/AS-\d+/)?.[0] ?? '';
  assert.ok(assetNumber, 'asset number drawn');
  console.log(`  ✓ asset ${assetNumber} created through the tabbed form`);

  await page.goto(`${base}${LIST}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByText('Browser lathe').waitFor();
  await page.getByRole('link', { name: 'Change', exact: true }).first().click();
  await page.waitForLoadState('networkidle');
  const general = page.locator('section[aria-labelledby="fa-general"]');
  await general.locator('input[name="description1"]').fill('Browser lathe (renamed)');
  await general.getByRole('button', { name: 'Save master data' }).click();
  await page.getByText(/saved \(version 2\)/).waitFor();
  console.log('  ✓ the asset renamed under version control');

  const assign = page.locator('section[aria-labelledby="fa-assign"]');
  await assign.locator('input[name="validFrom"]').fill('2027-01-01');
  await assign.getByRole('button', { name: 'Append assignment' }).click();
  await page.getByText(/history preserved/).waitFor();
  console.log('  ✓ the assignment appended with its history preserved');

  await withTenant(client, async (tx) => {
    const assets = await tx.execute(sql`
      select asset_number, description_1, status, version from fixed_asset where client = ${client}
    `);
    const [row] = assets as unknown as { asset_number: string; description_1: string; status: string; version: number }[];
    assert.equal(row.asset_number, assetNumber);
    assert.equal(row.description_1, 'Browser lathe (renamed)');
    assert.equal(row.status, 'ACTIVE');
    assert.equal(Number(row.version), 3);
    const intervals = await tx.execute(sql`
      select valid_from::text as f, valid_to::text as t from asset_assignment
      where client = ${client} order by valid_from
    `);
    const spans = (intervals as unknown as { f: string; t: string | null }[]).map((i) => ({ f: i.f, t: i.t }));
    assert.deepEqual(spans, [
      { f: '2026-01-01', t: '2027-01-01' },
      { f: '2027-01-01', t: null },
    ]);
    const docs = await tx.execute(sql`
      select count(*)::int as n from change_document where client = ${client} and object_class = 'fixed_asset'
    `);
    assert.equal(Number((docs as unknown as { n: number }[])[0]?.n ?? 0), 3, 'create and two changes audited');
    const journals = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    assert.equal(Number((journals as unknown as { n: number }[])[0]?.n ?? 0), 0, 'master data posted nothing');
  });
  console.log('  ✓ database: versioned master, closed and open intervals, three audit documents, zero journals');
}
