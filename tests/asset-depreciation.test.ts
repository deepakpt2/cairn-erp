import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  executeDepreciationRun, getPostedDepreciation, listDepreciationRuns,
} from '../src/modules/finance/asset-depreciation';
import { postAssetAcquisition } from '../src/modules/finance/asset-acquisition';
import { getAssetRetirements, postAssetRetirement } from '../src/modules/finance/asset-retirement';
import { createAsset } from '../src/modules/finance/asset-master';
import { postingPeriodRule } from '../src/modules/foundation/schema';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'ASSET-DEPR-TEST';
let client = '';
let otherClient = '';
const company = '1000';
const OFFSET = '230200';

async function newAsset(input: {
  assetClass?: string; key?: string; years?: number; periods?: number; description?: string;
}) {
  const [asset] = await createAsset({
    client, changedBy: ACTOR, companyCode: company, assetClass: input.assetClass ?? '1000',
    description1: input.description ?? 'Depreciation test asset',
    assignment: { validFrom: '2026-01-01', costCenter: 'CC100' },
    depreciation: [{
      areaCode: '01', depreciationKey: input.key ?? 'SL01',
      usefulLifeYears: input.years ?? 10, usefulLifePeriods: input.periods ?? 0,
    }],
  });
  return asset;
}

async function acquire(assetNumber: string, amount: number, valueDate = '2026-03-01', postingDate = '2026-03-15') {
  return postAssetAcquisition({
    client, changedBy: ACTOR, companyCode: company, assetNumber, subNumber: '0000',
    documentDate: postingDate, postingDate, assetValueDate: valueDate,
    documentType: 'AA', currency: 'USD', amount, offsetAccount: OFFSET,
    transactionType: 'ACQ', requestKey: `acq-${Math.random().toString(36).slice(2)}`,
  });
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    client, changedBy: ACTOR, companyCode: company,
    fiscalYear: 2026, postingPeriod: 3, runType: '1', testRun: true,
    documentType: 'AF', postingDate: '2026-03-31',
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::int as n from journal_entry
       where client = ${client} and origin_class = 'asset_depreciation_run'
    `);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

beforeAll(async () => {
  const fx = await createTenant('asset-depreciation');
  client = fx.client;
  const other = await createTenant('asset-depreciation-other');
  otherClient = other.client;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'ASSETNR', subObject: '*', prefix: 'AS', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${client}, 'A000', 'CC100', '2020-01-01', '9999-12-31', 'Test cost centre', 'PRODUCTION', ${company}, ${ACTOR})
      on conflict do nothing
    `);
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (otherClient) await destroyTenant(otherClient);
}, 180_000);

describe('SCR-094 depreciation run AFAB (R-142)', () => {
  it('test run calculates per key and mutates nothing financial', async () => {
    const sl = await newAsset({ description: 'SL machine' });
    await acquire(sl.assetNumber, 12000); // 12000 / 120 months = 100
    const db = await newAsset({ assetClass: '2000', key: 'DB01', years: 5, description: 'DB vehicle' });
    await acquire(db.assetNumber, 6000); // 6000 * 2 / 60 = 200

    const before = await journalCount();
    const result = await executeDepreciationRun(run());
    expect(result.status).toBe('SIMULATED');
    expect(result.testRun).toBe(true);
    expect(result.documentNumber).toBeNull();
    const byAsset = new Map(result.items.map((i) => [i.assetNumber, i]));
    expect(byAsset.get(sl.assetNumber)).toMatchObject({
      calculatedAmount: 100, status: 'CALCULATED', expenseAccount: '520000', accumAccount: '150100', costCenter: 'CC100',
    });
    expect(byAsset.get(db.assetNumber)).toMatchObject({
      calculatedAmount: 200, status: 'CALCULATED', accumAccount: '152100',
    });
    expect(await journalCount()).toBe(before);
    expect(await getPostedDepreciation(client, company, sl.assetNumber, '0000')).toEqual([]);
    const runs = await listDepreciationRuns(client, company);
    expect(runs[0]).toMatchObject({ status: 'SIMULATED', totalCalculated: 300, totalPosted: 0 });
  });

  it('live run posts one balanced document and records posted depreciation', async () => {
    const result = await executeDepreciationRun(run({ testRun: false }));
    expect(result.status).toBe('COMPLETED');
    expect(result.documentNumber).toBeTruthy();
    expect(result.totalPosted).toBe(300);

    const lines = await withTenant(client, async (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_document::float as amt, cost_center
        from journal_entry_line
       where client = ${client} and document_number = ${result.documentNumber} and fiscal_year = 2026
       order by gl_account, debit_credit
    `)) as unknown as { gl_account: string; debit_credit: string; amt: number; cost_center: string | null }[];
    const debits = lines.filter((l) => l.debit_credit === 'S');
    const credits = lines.filter((l) => l.debit_credit === 'H');
    expect(debits.reduce((s, l) => s + l.amt, 0)).toBe(credits.reduce((s, l) => s + l.amt, 0));
    expect(debits).toEqual([expect.objectContaining({ gl_account: '520000', amt: 300, cost_center: 'CC100' })]);
    expect(credits.map((l) => [l.gl_account, l.amt])).toEqual([['150100', 100], ['152100', 200]]);

    const [sl] = await withTenant(client, async (tx) => tx.execute(sql`
      select asset_number from fixed_asset where client = ${client} and description_1 = 'SL machine'
    `)) as unknown as { asset_number: string }[];
    const posted = await getPostedDepreciation(client, company, sl.asset_number, '0000');
    expect(posted).toEqual([expect.objectContaining({
      fiscalYear: 2026, postingPeriod: 3, postedAmount: 100, documentNumber: result.documentNumber,
    })]);
  });

  it('planned rerun skips posted periods; repeat with unchanged values adjusts nothing', async () => {
    const planned = await executeDepreciationRun(run({ testRun: false }));
    expect(planned.documentNumber).toBeNull();
    expect(planned.status).toBe('COMPLETED_WITH_WARNINGS');
    expect(planned.items.every((i) => i.status === 'SKIPPED')).toBe(true);

    // Repeat with no value change: straight-line stands already
    // posted, while declining balance recalculates on the reduced
    // book value and adjusts by the difference alone.
    const repeat = await executeDepreciationRun(run({ testRun: false, runType: '2' }));
    const slItem = repeat.items.find((i) => i.depreciationKey === 'SL01');
    const dbItem = repeat.items.find((i) => i.depreciationKey === 'DB01');
    expect(slItem).toMatchObject({ status: 'SKIPPED', adjustmentAmount: 0 });
    expect(dbItem).toMatchObject({
      calculatedAmount: 193.33, previouslyPostedAmount: 200, adjustmentAmount: -6.67, status: 'POSTED',
    });
    expect(repeat.totalPosted).toBe(-6.67);
    expect(repeat.documentNumber).toBeTruthy();
  });

  it('repeat run posts only the adjustment after an eligible value change', async () => {
    const [sl] = await withTenant(client, async (tx) => tx.execute(sql`
      select asset_number from fixed_asset where client = ${client} and description_1 = 'SL machine'
    `)) as unknown as { asset_number: string }[];
    await acquire(sl.asset_number, 12000, '2026-03-15', '2026-03-20'); // base 24000 -> 200/month
    const repeat = await executeDepreciationRun(run({ testRun: false, runType: '2' }));
    const item = repeat.items.find((i) => i.assetNumber === sl.asset_number);
    expect(item).toMatchObject({ calculatedAmount: 200, previouslyPostedAmount: 100, adjustmentAmount: 100, status: 'POSTED' });
    expect(repeat.documentNumber).toBeTruthy();
    const posted = await getPostedDepreciation(client, company, sl.asset_number, '0000');
    expect(posted[0]?.postedAmount).toBe(200);
  });

  it('retirement reversal of depreciation reads the posted record (SCR-093 plug-in)', async () => {
    const asset = await newAsset({ description: 'Retire after depreciation' });
    await acquire(asset.assetNumber, 12000);
    await executeDepreciationRun(run({ testRun: false, postingPeriod: 4, postingDate: '2026-04-30' }));
    const posted = await getPostedDepreciation(client, company, asset.assetNumber, '0000');
    expect(posted.map((p) => [p.postingPeriod, p.postedAmount])).toEqual([[4, 100]]);

    const retired = await postAssetRetirement({
      client, changedBy: ACTOR, companyCode: company, assetNumber: asset.assetNumber, subNumber: '0000',
      documentDate: '2026-05-10', postingDate: '2026-05-15', assetValueDate: '2026-05-01',
      documentType: 'AB', currency: 'USD', transactionType: 'RET', scope: 'PERCENT',
      retirementPercent: 50, requestKey: 'ret-after-depr',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(retired.retiredAcquisitionValue).toBe(6000);
    expect(retired.depreciationReversed).toBe(50); // 100 posted * 6000/12000
    expect(retired.lossAmount).toBe(5950);
    const rows = await getAssetRetirements(client, company, asset.assetNumber, '0000');
    expect(rows[0]).toMatchObject({ depreciationReversed: 50, lossAmount: 5950 });
  });

  it('skips retired, valueless and life-elapsed assets with named outcomes', async () => {
    const retiredAsset = await newAsset({ description: 'Soon retired' });
    await acquire(retiredAsset.assetNumber, 3000);
    await postAssetRetirement({
      client, changedBy: ACTOR, companyCode: company, assetNumber: retiredAsset.assetNumber, subNumber: '0000',
      documentDate: '2026-05-10', postingDate: '2026-05-15', assetValueDate: '2026-05-01',
      documentType: 'AB', currency: 'USD', transactionType: 'RET', scope: 'COMPLETE',
      requestKey: 'ret-skip-check',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const short = await newAsset({ years: 0, periods: 1, description: 'One month life' });
    await acquire(short.assetNumber, 1000, '2026-01-01', '2026-01-15');

    const result = await executeDepreciationRun(run({ postingPeriod: 5, postingDate: '2026-05-31' }));
    const byDesc = new Map(result.items.map((i) => [i.assetNumber, i]));
    expect(byDesc.get(retiredAsset.assetNumber)).toMatchObject({ status: 'SKIPPED' });
    expect(byDesc.get(retiredAsset.assetNumber)?.message).toMatch(/RETIRED/);
    expect(byDesc.get(short.assetNumber)).toMatchObject({ status: 'SKIPPED' });
    expect(byDesc.get(short.assetNumber)?.message).toMatch(/Useful life has elapsed/);
  });

  it('refuses invalid runs, records FAILED, and restarts safely', async () => {
    await expect(executeDepreciationRun(run({ runType: '4', testRun: false })))
      .rejects.toThrow('Unplanned depreciation');
    await expect(executeDepreciationRun(run({ runType: '3', testRun: false })))
      .rejects.toThrow('must reference the failed run');
    await expect(executeDepreciationRun(run({ postingDate: '2026-05-31' })))
      .rejects.toThrow('not the selected');
    // Tenant isolation: the other tenant's run sees none of our assets.
    const isolated = await executeDepreciationRun(run({ client: otherClient }));
    expect(isolated.items).toEqual([]);
    expect(isolated.totalCalculated).toBe(0);

    await withTenant(client, async (tx) => {
      await tx.update(postingPeriodRule).set({ periodTo: 5 })
        .where(sql`${postingPeriodRule.client} = ${client}`);
    });
    try {
      await expect(executeDepreciationRun(run({
        testRun: false, postingPeriod: 6, postingDate: '2026-06-30',
      }))).rejects.toThrow('closed for');
    } finally {
      await withTenant(client, async (tx) => {
        await tx.update(postingPeriodRule).set({ periodTo: 12 })
          .where(sql`${postingPeriodRule.client} = ${client}`);
      });
    }
    const failed = (await listDepreciationRuns(client, company))
      .find((r) => r.status === 'FAILED' && r.postingPeriod === 6);
    expect(failed).toBeTruthy();

    const before = await journalCount();
    const restarted = await executeDepreciationRun(run({
      testRun: false, runType: '3', restartOfRunId: failed!.runId,
      postingPeriod: 6, postingDate: '2026-06-30',
    }));
    expect(restarted.status).toMatch(/COMPLETED/);
    expect(await journalCount()).toBe(before + 1);
    const again = await executeDepreciationRun(run({
      testRun: false, runType: '3', restartOfRunId: failed!.runId,
      postingPeriod: 6, postingDate: '2026-06-30',
    }));
    expect(again.documentNumber).toBeNull(); // already posted by the restart; nothing duplicates
  });
});
