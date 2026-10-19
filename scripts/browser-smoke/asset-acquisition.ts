import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const CREATE = '/finance/assets/new';
const ACQUIRE = '/finance/assets/acquire';

/**
 * SCR-092 browser acceptance: asset acquisition ABZON.
 *
 * The journey: an asset is created, simulated (nothing written),
 * acquired against an offsetting account — debit the class
 * reconciliation account through the engine — then reversed
 * asset-aware, with the database carrying the whole story.
 */
export async function assetAcquisitionAbzon(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-092: simulate, acquire, and reverse an asset against its offsetting account');

  await page.goto(`${base}${CREATE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Create Asset', exact: true }).waitFor();
  const createForm = page.locator('section[aria-labelledby="ac-form"]');
  await createForm.locator('input[name="companyCode"]').fill('1000');
  await createForm.locator('input[name="assetClass"]').fill('1000');
  await createForm.locator('input[name="description1"]').fill('Browser milling machine');
  await createForm.getByRole('tab', { name: 'Time-dependent assignments' }).click();
  await createForm.locator('input[name="validFrom"]').fill('2026-01-01');
  await createForm.getByRole('tab', { name: 'General' }).click();
  await createForm.getByRole('button', { name: 'Create asset', exact: true }).click();
  const created = page.getByText(/Created 1 asset\(s\): AS-\d+\/0000/);
  await created.waitFor();
  const assetNumber = (await created.textContent())?.match(/AS-\d+/)?.[0] ?? '';
  assert.ok(assetNumber, 'asset number drawn');
  console.log(`  ✓ asset ${assetNumber} created`);

  await page.goto(`${base}${ACQUIRE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Asset Acquisition', exact: true }).waitFor();
  const entry = page.locator('section[aria-labelledby="aq-entry"]');
  await entry.locator('input[name="companyCode"]').fill('1000');
  await entry.locator('input[name="assetNumber"]').fill(assetNumber);
  await entry.locator('input[name="documentDate"]').fill('2026-03-10');
  await entry.locator('input[name="postingDate"]').fill('2026-03-15');
  await entry.locator('input[name="assetValueDate"]').fill('2026-03-01');
  await entry.locator('input[name="currency"]').fill('USD');
  await entry.locator('input[name="amount"]').fill('25000');
  await entry.locator('input[name="offsetAccount"]').fill('230200');
  await entry.locator('input[name="text"]').fill('Milling machine acquisition');

  await entry.getByRole('button', { name: 'Simulate', exact: true }).click();
  await page.getByText('Simulation stands clean; nothing has been written.').waitFor();
  await page.getByText('150000 (asset)').waitFor();
  await page.getByText('230200 (offsetting)').waitFor();
  const journalsAfterSim = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${client} and origin_class = 'asset_acquisition'
    `);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
  assert.equal(journalsAfterSim, 0, 'simulation wrote no journal');
  console.log('  ✓ simulation previewed 150000/230200 and wrote nothing');

  await entry.getByRole('button', { name: 'Post acquisition', exact: true }).click();
  const posted = page.getByText(/Acquisition posted as document \S+/);
  await posted.waitFor();
  const documentNumber = (await posted.textContent())?.match(/document (\S+?):/)?.[1] ?? '';
  assert.ok(documentNumber, 'document number reported');
  console.log(`  ✓ acquisition posted as document ${documentNumber}`);

  await withTenant(client, async (tx) => {
    const lines = await tx.execute(sql`
      select gl_account, debit_credit, amount_document::float as amt from journal_entry_line
      where client = ${client} and document_number = ${documentNumber} order by line_number
    `);
    const ls = lines as unknown as { gl_account: string; debit_credit: string; amt: number }[];
    assert.deepEqual(ls.map((l) => [l.gl_account, l.debit_credit, l.amt]), [
      ['150000', 'S', 25000], ['230200', 'H', 25000],
    ]);
    const assets = await tx.execute(sql`
      select capitalization_date::text as cap from fixed_asset
      where client = ${client} and asset_number = ${assetNumber}
    `);
    assert.equal((assets as unknown as { cap: string }[])[0]?.cap, '2026-03-01');
    const txns = await tx.execute(sql`
      select status, amount::float as amt from asset_transaction
      where client = ${client} and document_number = ${documentNumber}
    `);
    assert.deepEqual(
      (txns as unknown as { status: string; amt: number }[]).map((r) => [r.status, r.amt]),
      [['ACTIVE', 25000]],
    );
  });
  console.log('  ✓ journal, capitalization and value record verified in the database');

  const reverse = page.locator('section[aria-labelledby="aq-reverse"]');
  await reverse.locator('input[name="companyCode"]').fill('1000');
  await reverse.locator('input[name="assetNumber"]').fill(assetNumber);
  await reverse.locator('input[name="documentNumber"]').fill(documentNumber);
  await reverse.locator('input[name="fiscalYear"]').fill('2026');
  await reverse.locator('input[name="reversalDate"]').fill('2026-03-20');
  await reverse.locator('input[name="reason"]').fill('Wrong amount entered');
  await reverse.getByRole('button', { name: 'Reverse acquisition', exact: true }).click();
  await page.getByText(/Acquisition reversed by document \S+/).waitFor();
  console.log('  ✓ acquisition reversed asset-aware');

  await withTenant(client, async (tx) => {
    const txns = await tx.execute(sql`
      select status, reversal_document_number from asset_transaction
      where client = ${client} and document_number = ${documentNumber}
    `);
    const [row] = txns as unknown as { status: string; reversal_document_number: string }[];
    assert.equal(row.status, 'REVERSED');
    assert.ok(row.reversal_document_number, 'reversal link stands');
  });
  console.log('  ✓ value record stands REVERSED with its reversal link');
}
