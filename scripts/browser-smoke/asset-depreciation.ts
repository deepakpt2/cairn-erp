import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postAssetAcquisition } from '../../src/modules/finance/asset-acquisition';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const CREATE = '/finance/assets/new';
const RUN = '/finance/assets/depreciate';

/**
 * SCR-094 browser acceptance: depreciation run AFAB.
 *
 * The journey: an asset is created and acquired, a test run
 * calculates its depreciation without touching a balance, then a
 * confirmed live run posts the balanced document and records the
 * posted depreciation — verified in the database.
 */
export async function assetDepreciationAfab(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-094: test-run, then live-post, one period of depreciation');

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
  await createForm.locator('input[name="companyCode"]').fill('1000');
  await createForm.locator('input[name="assetClass"]').fill('1000');
  await createForm.locator('input[name="description1"]').fill('Browser lathe');
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
    transactionType: 'ACQ', requestKey: 'browser-afab-acq',
  });
  console.log(`  ✓ asset ${assetNumber} created and acquired for 12000 KWD`);

  await page.goto(`${base}${RUN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Depreciation Run', exact: true }).waitFor();
  const entry = page.locator('section[aria-labelledby="dp-entry"]');
  await entry.locator('input[name="companyCode"]').fill('1000');
  await entry.locator('input[name="fiscalYear"]').fill('2026');
  await entry.locator('input[name="postingPeriod"]').fill('3');
  await entry.locator('input[name="postingDate"]').fill('2026-03-31');

  await entry.getByRole('button', { name: 'Execute test run', exact: true }).click();
  await page.getByText(/Test run \S+ simulated: 100\.00 KWD calculated/).waitFor();
  await page.getByText('CALCULATED').first().waitFor();
  const financialAfterTest = await withTenant(client, async (tx) => {
    const journals = await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${client} and origin_class = 'asset_depreciation_run'
    `);
    const postings = await tx.execute(sql`
      select count(*)::int as n from asset_depreciation_posting where client = ${client}
    `);
    return {
      journals: Number((journals as unknown as { n: number }[])[0]?.n ?? 0),
      postings: Number((postings as unknown as { n: number }[])[0]?.n ?? 0),
    };
  });
  assert.deepEqual(financialAfterTest, { journals: 0, postings: 0 }, 'test run mutated nothing financial');
  console.log('  ✓ test run calculated 100.00 and mutated nothing');

  await entry.locator('input[type="checkbox"]').first().uncheck();
  await entry.getByText(/I confirm the live run/).waitFor();
  await entry.locator('label').filter({ hasText: 'I confirm the live run' }).locator('input[type="checkbox"]').check();
  await entry.getByRole('button', { name: 'Execute live run', exact: true }).click();
  const postedMsg = page.getByText(/Live run \S+ completed: 100\.00 KWD posted as document \S+/);
  await postedMsg.waitFor();
  const documentNumber = (await postedMsg.textContent())?.match(/document (\S+?)\./)?.[1] ?? '';
  assert.ok(documentNumber, 'document number reported');
  console.log(`  ✓ live run posted as document ${documentNumber}`);

  await withTenant(client, async (tx) => {
    const lines = await tx.execute(sql`
      select gl_account, debit_credit, amount_document::float as amt from journal_entry_line
      where client = ${client} and document_number = ${documentNumber} order by line_number
    `);
    const ls = lines as unknown as { gl_account: string; debit_credit: string; amt: number }[];
    assert.deepEqual(ls.map((l) => [l.gl_account, l.debit_credit, l.amt]), [
      ['520000', 'S', 100], ['150100', 'H', 100],
    ]);
    const postings = await tx.execute(sql`
      select posted_amount::float as amt, posting_period from asset_depreciation_posting
      where client = ${client} and asset_number = ${assetNumber}
    `);
    assert.deepEqual(
      (postings as unknown as { amt: number; posting_period: number }[]).map((r) => [r.posting_period, r.amt]),
      [[3, 100]],
    );
    const runs = await tx.execute(sql`
      select status, is_test_run from asset_depreciation_run where client = ${client} order by started_at
    `);
    assert.deepEqual(
      (runs as unknown as { status: string; is_test_run: boolean }[]).map((r) => [r.status, r.is_test_run]),
      [['SIMULATED', true], ['COMPLETED', false]],
    );
  });
  console.log('  ✓ journal, posted depreciation and run log verified in the database');
}
