import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postAssetAcquisition } from '../../src/modules/finance/asset-acquisition';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const CREATE = '/finance/assets/new';
const RETIRE = '/finance/assets/retire';

/**
 * SCR-093 browser acceptance: asset retirement by scrapping ABAVN.
 *
 * The journey: an asset is created and acquired, partially retired
 * by percentage through the guided screen (simulation first), then
 * the retirement is reversed asset-aware — with the database
 * carrying the whole story.
 */
export async function assetRetirementAbavn(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-093: simulate, scrap part of an asset, and reverse the retirement');

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
  await createForm.locator('input[name="description1"]').fill('Browser press machine');
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
    documentType: 'AA', currency: 'KWD', amount: 20000, offsetAccount: '230200',
    transactionType: 'ACQ', requestKey: 'browser-abavn-acq',
  });
  console.log(`  ✓ asset ${assetNumber} created and acquired for 20000 KWD`);

  await page.goto(`${base}${RETIRE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Asset Retirement', exact: true }).waitFor();
  const picker = page.locator('section[aria-labelledby="rt-select"]');
  await picker.locator('select').selectOption(`1000/${assetNumber}/0000`);

  const entry = page.locator('section[aria-labelledby="rt-entry"]');
  await entry.locator('input[name="documentDate"]').fill('2026-06-10');
  await entry.locator('input[name="postingDate"]').fill('2026-06-15');
  await entry.locator('input[name="assetValueDate"]').fill('2026-06-01');
  await entry.locator('select').selectOption('PERCENT');
  await entry.locator('input[name="retirementPercent"]').fill('25');
  await entry.locator('input[name="text"]').fill('Press scrapped after failure');

  await entry.getByRole('button', { name: 'Simulate', exact: true }).click();
  await page.getByText('Simulation stands clean; nothing has been written.').waitFor();
  await page.getByText('590000 (loss on retirement)').waitFor();
  await page.getByText('150000 (asset)').waitFor();
  const journalsAfterSim = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${client} and origin_class = 'asset_retirement'
    `);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
  assert.equal(journalsAfterSim, 0, 'simulation wrote no journal');
  console.log('  ✓ simulation previewed 590000/150000 and wrote nothing');

  await entry.getByRole('button', { name: 'Post retirement', exact: true }).click();
  const posted = page.getByText(/Retirement posted as document \S+/);
  await posted.waitFor();
  const documentNumber = (await posted.textContent())?.match(/document (\S+?):/)?.[1] ?? '';
  assert.ok(documentNumber, 'document number reported');
  console.log(`  ✓ retirement posted as document ${documentNumber}`);

  await withTenant(client, async (tx) => {
    const lines = await tx.execute(sql`
      select gl_account, debit_credit, amount_document::float as amt from journal_entry_line
      where client = ${client} and document_number = ${documentNumber} order by line_number
    `);
    const ls = lines as unknown as { gl_account: string; debit_credit: string; amt: number }[];
    assert.deepEqual(ls.map((l) => [l.gl_account, l.debit_credit, l.amt]), [
      ['590000', 'S', 5000], ['150000', 'H', 5000],
    ]);
    const assets = await tx.execute(sql`
      select status from fixed_asset where client = ${client} and asset_number = ${assetNumber}
    `);
    assert.equal((assets as unknown as { status: string }[])[0]?.status, 'ACTIVE');
    const rets = await tx.execute(sql`
      select status, scope, retired_acquisition_value::float as v from asset_retirement
      where client = ${client} and document_number = ${documentNumber}
    `);
    assert.deepEqual(
      (rets as unknown as { status: string; scope: string; v: number }[]).map((r) => [r.status, r.scope, r.v]),
      [['ACTIVE', 'PERCENT', 5000]],
    );
  });
  console.log('  ✓ journal, partial values and ACTIVE status verified in the database');

  const reverse = page.locator('section[aria-labelledby="rt-reverse"]');
  await reverse.locator('input[name="companyCode"]').fill('1000');
  await reverse.locator('input[name="assetNumber"]').fill(assetNumber);
  await reverse.locator('input[name="documentNumber"]').fill(documentNumber);
  await reverse.locator('input[name="fiscalYear"]').fill('2026');
  await reverse.locator('input[name="reversalDate"]').fill('2026-06-20');
  await reverse.locator('input[name="reason"]').fill('Scrapped in error');
  await reverse.getByRole('button', { name: 'Reverse retirement', exact: true }).click();
  await page.getByText(/Retirement reversed by document \S+/).waitFor();
  console.log('  ✓ retirement reversed asset-aware');

  await withTenant(client, async (tx) => {
    const rets = await tx.execute(sql`
      select status, reversal_document_number from asset_retirement
      where client = ${client} and document_number = ${documentNumber}
    `);
    const [row] = rets as unknown as { status: string; reversal_document_number: string }[];
    assert.equal(row.status, 'REVERSED');
    assert.ok(row.reversal_document_number, 'reversal link stands');
  });
  console.log('  ✓ retirement record stands REVERSED with its reversal link');
}
