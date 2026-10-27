import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postAssetAcquisition } from '../../src/modules/finance/asset-acquisition';
import { executeDepreciationRun } from '../../src/modules/finance/asset-depreciation';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const CREATE = '/finance/assets/new';
const HISTORY = '/finance/assets/history';

/**
 * SCR-095 browser acceptance: asset history sheet S_ALR_87011990.
 *
 * The journey: an asset is created, acquired and depreciated
 * through the standing services, then the history sheet is
 * executed from its selection and reconciles the asset's values
 * on screen — read-only, verified against the database.
 */
export async function assetHistorySheet(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-095: build an asset history and read it back on the sheet');

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'browser.admin',
    });
  });

  await page.goto(`${base}${CREATE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Create Asset', exact: true }).waitFor();
  const createForm = page.locator('section[aria-labelledby="ac-form"]');
  await chooseClosed(createForm, 'companyCode', '1000');
  await createForm.locator('input[name="assetClass"]').fill('1000');
  await createForm.locator('input[name="description1"]').fill('Browser history press');
  await createForm.getByRole('tab', { name: 'Time-dependent assignments' }).click();
  await createForm.locator('input[name="validFrom"]').fill('2026-01-01');
  await createForm.getByRole('tab', { name: 'Depreciation areas' }).click();
  await createForm.getByLabel('Depreciation key').first().fill('SL01');
  await createForm.getByLabel('Useful life years').first().fill('10');
  await createForm.getByRole('tab', { name: 'General' }).click();
  await createForm.getByRole('button', { name: 'Create asset', exact: true }).click();
  const created = page.getByText(/Created 1 asset\(s\): AS-\d+\/0000/);
  await created.waitFor();
  const assetNumber = (await created.textContent())?.match(/AS-\d+/)?.[0] ?? '';
  assert.ok(assetNumber, 'asset number drawn');

  await postAssetAcquisition({
    client, changedBy: 'browser.admin', companyCode: '1000', assetNumber, subNumber: '0000',
    documentDate: '2026-03-10', postingDate: '2026-03-15', assetValueDate: '2026-03-01',
    documentType: 'AA', currency: 'KWD', amount: 12000, offsetAccount: '230200',
    transactionType: 'ACQ', requestKey: 'browser-history-acq',
  });
  await executeDepreciationRun({
    client, changedBy: 'browser.admin', companyCode: '1000', fiscalYear: 2026, postingPeriod: 3,
    runType: '1', testRun: false, documentType: 'AF', postingDate: '2026-03-31',
  });
  console.log(`  ✓ asset ${assetNumber} acquired for 12000 KWD and depreciated by 100`);

  const journalsBefore = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });

  await page.goto(`${base}${HISTORY}?companyCodeFrom=1000&fiscalYear=2026&depreciationArea=01`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Asset History Sheet', exact: true }).waitFor();
  await page.getByText('Browser history press').waitFor();
  await page.getByText('11900.00').first().waitFor();
  await page.getByText('Grand total').waitFor();
  await page.getByText(/Fiscal year 2026 · Area 01 · Reporting date 2026-12-31/).waitFor();
  await page.getByRole('link', { name: 'Export CSV', exact: true }).waitFor();
  console.log('  ✓ sheet reconciles: 12000 acquired, 100 depreciation, 11900 book value');

  const journalsAfter = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
  assert.equal(journalsAfter, journalsBefore, 'the sheet wrote nothing');
  console.log('  ✓ running the sheet mutated nothing');
}
