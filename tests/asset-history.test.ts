import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { executeDepreciationRun } from '../src/modules/finance/asset-depreciation';
import { postAssetAcquisition } from '../src/modules/finance/asset-acquisition';
import { postAssetRetirement, reverseAssetRetirement } from '../src/modules/finance/asset-retirement';
import { createAsset } from '../src/modules/finance/asset-master';
import {
  assetHistoryCsv, getAssetHistorySheet,
} from '../src/modules/finance/asset-history';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'ASSET-HIST-TEST';
let client = '';
let otherClient = '';
const company = '1000';
const OFFSET = '230200';
let assetA = '';
let assetB = '';
let retirementDoc = '';

async function acquire(assetNumber: string, amount: number, valueDate: string, postingDate: string) {
  return postAssetAcquisition({
    client, changedBy: ACTOR, companyCode: company, assetNumber, subNumber: '0000',
    documentDate: postingDate, postingDate, assetValueDate: valueDate,
    documentType: 'AA', currency: 'USD', amount, offsetAccount: OFFSET,
    transactionType: 'ACQ', requestKey: `acq-${Math.random().toString(36).slice(2)}`,
  });
}

function sheet(overrides: Record<string, unknown> = {}) {
  return getAssetHistorySheet(client, {
    companyCodeFrom: company, fiscalYear: 2026, depreciationArea: '01',
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

beforeAll(async () => {
  const fx = await createTenant('asset-history');
  client = fx.client;
  const other = await createTenant('asset-history-other');
  otherClient = other.client;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'ASSETNR', subObject: '*', prefix: 'AS', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: company, subObject: 'GENERAL',
      fiscalYear: 2025, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
    });
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${client}, 'A000', 'CC100', '2020-01-01', '9999-12-31', 'Test cost centre', 'PRODUCTION', ${company}, ${ACTOR})
      on conflict do nothing
    `);
  });

  const [a] = await createAsset({
    client, changedBy: ACTOR, companyCode: company, assetClass: '1000',
    description1: 'History machine', assignment: { validFrom: '2025-01-01', costCenter: 'CC100' },
    depreciation: [{ areaCode: '01', depreciationKey: 'SL01', usefulLifeYears: 10, usefulLifePeriods: 0 }],
  });
  assetA = a.assetNumber;
  const [b] = await createAsset({
    client, changedBy: ACTOR, companyCode: company, assetClass: '2000',
    description1: 'History vehicle', assignment: { validFrom: '2026-01-01', costCenter: 'CC100' },
    depreciation: [{ areaCode: '01', depreciationKey: 'SL01', usefulLifeYears: 5, usefulLifePeriods: 0 }],
  });
  assetB = b.assetNumber;

  await acquire(assetA, 12000, '2025-12-01', '2025-12-15');
  await acquire(assetA, 6000, '2026-03-01', '2026-03-15');
  await acquire(assetB, 6000, '2026-02-01', '2026-02-15');
  await executeDepreciationRun({
    client, changedBy: ACTOR, companyCode: company, fiscalYear: 2026, postingPeriod: 3,
    runType: '1', testRun: false, documentType: 'AF', postingDate: '2026-03-31',
  });
  const retired = await postAssetRetirement({
    client, changedBy: ACTOR, companyCode: company, assetNumber: assetA, subNumber: '0000',
    documentDate: '2026-06-10', postingDate: '2026-06-15', assetValueDate: '2026-06-01',
    documentType: 'AB', currency: 'USD', transactionType: 'RET', scope: 'AMOUNT',
    retirementAmount: 3000, requestKey: 'hist-ret-1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  retirementDoc = retired.documentNumber;
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (otherClient) await destroyTenant(otherClient);
}, 180_000);

describe('SCR-095 asset history sheet S_ALR_87011990 (R-143)', () => {
  it('reconciles beginning, movements, depreciation and NBV per asset and total', async () => {
    const before = await journalCount();
    const result = await sheet();
    expect(result.reportingDate).toBe('2026-12-31');
    const a = result.rows.find((r) => r.assetNumber === assetA);
    const b = result.rows.find((r) => r.assetNumber === assetB);
    expect(a).toMatchObject({
      acquisitionBeginning: 12000, acquisitions: 6000, retirements: 3000, acquisitionEnding: 15000,
      depreciationBeginning: 0, depreciationYear: 150, depreciationOnRetirements: 25,
      depreciationEnding: 125, netBookValue: 14875, currency: 'USD', transfersIn: 0, transfersOut: 0,
    });
    expect(b).toMatchObject({
      acquisitionBeginning: 0, acquisitions: 6000, acquisitionEnding: 6000,
      depreciationYear: 100, depreciationEnding: 100, netBookValue: 5900,
    });
    for (const row of result.rows) {
      expect(row.acquisitionBeginning + row.acquisitions - row.retirements).toBeCloseTo(row.acquisitionEnding, 2);
      expect(row.depreciationBeginning + row.depreciationYear - row.depreciationOnRetirements)
        .toBeCloseTo(row.depreciationEnding, 2);
      expect(row.acquisitionEnding - row.depreciationEnding).toBeCloseTo(row.netBookValue, 2);
    }
    const grand = result.grandTotals.find((t) => t.currency === 'USD');
    expect(grand).toMatchObject({
      acquisitionBeginning: 12000, acquisitions: 12000, retirements: 3000,
      acquisitionEnding: 21000, depreciationEnding: 225, netBookValue: 20775,
    });
    const classTotals = new Map(result.classTotals.map((t) => [t.assetClass, t]));
    expect(classTotals.get('1000')?.netBookValue).toBe(14875);
    expect(classTotals.get('2000')?.netBookValue).toBe(5900);
    expect(await journalCount()).toBe(before); // read-only
  });

  it('reports the prior year and honors mid-year reporting dates', async () => {
    const fy25 = await sheet({ fiscalYear: 2025 });
    const a25 = fy25.rows.find((r) => r.assetNumber === assetA);
    expect(a25).toMatchObject({
      acquisitionBeginning: 0, acquisitions: 12000, acquisitionEnding: 12000,
      depreciationYear: 0, netBookValue: 12000,
    });

    const mid = await sheet({ reportingDate: '2026-02-28' });
    const aMid = mid.rows.find((r) => r.assetNumber === assetA);
    expect(aMid).toMatchObject({
      acquisitionBeginning: 12000, acquisitions: 0, retirements: 0,
      depreciationYear: 0, netBookValue: 12000,
    });
  });

  it('excludes test-run depreciation and reversed retirements', async () => {
    await executeDepreciationRun({
      client, changedBy: ACTOR, companyCode: company, fiscalYear: 2026, postingPeriod: 4,
      runType: '1', testRun: true, documentType: 'AF', postingDate: '2026-04-30',
    });
    const after = await sheet();
    const a = after.rows.find((r) => r.assetNumber === assetA);
    expect(a?.depreciationYear).toBe(150); // the simulated period-4 run added nothing

    await reverseAssetRetirement({
      client, changedBy: ACTOR, companyCode: company, assetNumber: assetA, subNumber: '0000',
      documentNumber: retirementDoc, fiscalYear: 2026, reversalDate: '2026-07-01',
      reason: 'Retirement was premature',
    });
    const restored = await sheet();
    const aRestored = restored.rows.find((r) => r.assetNumber === assetA);
    expect(aRestored).toMatchObject({
      retirements: 0, acquisitionEnding: 18000, depreciationOnRetirements: 0,
      depreciationEnding: 150, netBookValue: 17850,
    });
  });

  it('filters by class and asset ranges, paginates, and exports CSV', async () => {
    const onlyVehicles = await sheet({ assetClassFrom: '2000', assetClassTo: '2000' });
    expect(onlyVehicles.rows.map((r) => r.assetNumber)).toEqual([assetB]);
    const onlyA = await sheet({ assetNumberFrom: assetA, assetNumberTo: assetA });
    expect(onlyA.rows.map((r) => r.assetNumber)).toEqual([assetA]);

    const page1 = await sheet({ pageSize: 1, page: 1 });
    expect(page1.totalRows).toBe(2);
    expect(page1.rows).toHaveLength(1);
    expect(page1.grandTotals[0]?.netBookValue).toBe(23750); // totals span all pages (after the reversal above)

    const csv = assetHistoryCsv((await sheet()).rows);
    expect(csv).toContain('Asset Number,Asset Subnumber');
    expect(csv).toContain('History machine');
    expect(csv).toContain('17850');
  });

  it('refuses invalid selections and stays inside the tenant', async () => {
    await expect(sheet({ depreciationArea: '99' })).rejects.toThrow('not configured active');
    await expect(sheet({ companyCodeFrom: '9000', companyCodeTo: '9999' }))
      .rejects.toThrow('No company code stands');
    await expect(sheet({ reportingDate: '2027-01-15' })).rejects.toThrow('lies outside fiscal year');

    const isolated = await getAssetHistorySheet(otherClient, {
      companyCodeFrom: company, fiscalYear: 2026, depreciationArea: '01',
    });
    expect(isolated.rows).toEqual([]);
    expect(isolated.totalRows).toBe(0);
  });
});
