import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postAssetAcquisition } from '../src/modules/finance/asset-acquisition';
import {
  getAssetRetirements, listRetireableAssets, postAssetRetirement,
  reverseAssetRetirement, simulateAssetRetirement,
} from '../src/modules/finance/asset-retirement';
import { createAsset, getAsset } from '../src/modules/finance/asset-master';
import { reverseDocument } from '../src/modules/finance/document-reversal';
import { postingPeriodRule } from '../src/modules/foundation/schema';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'ASSET-RET-TEST';
let client = '';
let otherClient = '';
const company = '1000';
const OFFSET = '230200';

async function newAsset(assetClass = '1000', extra: Record<string, unknown> = {}) {
  const [asset] = await createAsset({
    client, changedBy: ACTOR, companyCode: company, assetClass,
    description1: 'Retirement test asset',
    assignment: { validFrom: '2026-01-01' },
    depreciation: [{ areaCode: '01', depreciationKey: 'SL01', usefulLifeYears: 10, usefulLifePeriods: 0 }],
    ...extra,
  });
  return asset;
}

async function acquire(assetNumber: string, amount = 12000, clientId = client) {
  return postAssetAcquisition({
    client: clientId, changedBy: ACTOR, companyCode: company, assetNumber, subNumber: '0000',
    documentDate: '2026-03-10', postingDate: '2026-03-15', assetValueDate: '2026-03-01',
    documentType: 'AA', currency: 'USD', amount, offsetAccount: OFFSET,
    transactionType: 'ACQ', requestKey: `acq-${Math.random().toString(36).slice(2)}`,
  });
}

function retire(assetNumber: string, overrides: Record<string, unknown> = {}) {
  return {
    client, changedBy: ACTOR, companyCode: company, assetNumber, subNumber: '0000',
    documentDate: '2026-06-10', postingDate: '2026-06-15', assetValueDate: '2026-06-01',
    documentType: 'AB', currency: 'USD', transactionType: 'RET', scope: 'COMPLETE',
    requestKey: `ret-${Math.random().toString(36).slice(2)}`,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function counts(): Promise<{ journals: number; retirements: number }> {
  return withTenant(client, async (tx) => {
    const j = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client} and origin_class = 'asset_retirement'`);
    const r = await tx.execute(sql`select count(*)::int as n from asset_retirement where client = ${client}`);
    return {
      journals: Number((j as unknown as { n: number }[])[0]?.n ?? 0),
      retirements: Number((r as unknown as { n: number }[])[0]?.n ?? 0),
    };
  });
}

beforeAll(async () => {
  const fx = await createTenant('asset-retirement');
  client = fx.client;
  const other = await createTenant('asset-retirement-other');
  otherClient = other.client;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'ASSETNR', subObject: '*', prefix: 'AS', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${client}, 'A000', 'CC100', '2020-01-01', '9999-12-31', 'Test cost centre', 'PRODUCTION', ${company}, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into asset_class (client, asset_class, name, numbering, recon_account, created_by)
      values (${client}, '9000', 'Determination incomplete', 'EXTERNAL', '150000', ${ACTOR})
      on conflict do nothing
    `);
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (otherClient) await destroyTenant(otherClient);
}, 180_000);

describe('SCR-093 asset retirement by scrapping ABAVN (R-141)', () => {
  it('simulates proportionally and persists nothing', async () => {
    const asset = await newAsset();
    await acquire(asset.assetNumber);
    const before = await counts();
    const preview = await simulateAssetRetirement(retire(asset.assetNumber, {
      scope: 'PERCENT', retirementPercent: 25,
    }));
    expect(preview.acquiredValue).toBe(12000);
    expect(preview.retiredAcquisitionValue).toBe(3000);
    expect(preview.depreciationReversed).toBe(0);
    expect(preview.lossAmount).toBe(3000);
    expect(preview.remainingAcquisitionValue).toBe(9000);
    expect(preview.remainingNetBookValue).toBe(9000);
    expect(preview.reconAccount).toBe('150000');
    expect(preview.lossAccount).toBe('590000');
    expect(await counts()).toEqual(before);
  });

  it('posts percent and amount partials against the remaining value, balanced', async () => {
    const asset = await newAsset();
    await acquire(asset.assetNumber);
    const first = await postAssetRetirement(retire(asset.assetNumber, {
      scope: 'PERCENT', retirementPercent: 25, requestKey: 'ret-pct-1',
    }));
    expect(first.retiredAcquisitionValue).toBe(3000);
    expect(first.remainingAcquisitionValue).toBe(9000);

    const lines = await withTenant(client, async (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_document::float as amt, business_partner
        from journal_entry_line
       where client = ${client} and document_number = ${first.documentNumber} and fiscal_year = 2026
       order by line_number
    `)) as unknown as { gl_account: string; debit_credit: string; amt: number; business_partner: string | null }[];
    expect(lines).toEqual([
      expect.objectContaining({ gl_account: '590000', debit_credit: 'S', amt: 3000 }),
      expect.objectContaining({ gl_account: '150000', debit_credit: 'H', amt: 3000 }),
    ]);
    expect(lines.every((l) => l.business_partner === null)).toBe(true);

    const view = await getAsset(client, company, asset.assetNumber, '0000');
    expect(view?.status).toBe('ACTIVE');

    const second = await postAssetRetirement(retire(asset.assetNumber, {
      scope: 'PERCENT', retirementPercent: 25,
    }));
    expect(second.retiredAcquisitionValue).toBe(2250); // 25% of remaining 9000
    const third = await postAssetRetirement(retire(asset.assetNumber, {
      scope: 'AMOUNT', retirementAmount: 750,
    }));
    expect(third.remainingAcquisitionValue).toBe(6000);

    await expect(postAssetRetirement(retire(asset.assetNumber, {
      scope: 'AMOUNT', retirementAmount: 6000.01,
    }))).rejects.toThrow('exceeds the remaining retireable acquisition value');
    await expect(postAssetRetirement(retire(asset.assetNumber, {
      scope: 'PERCENT', retirementPercent: 101,
    }))).rejects.toThrow('no higher than 100');
    await expect(postAssetRetirement(retire(asset.assetNumber, {
      scope: 'PERCENT', retirementPercent: 0,
    }))).rejects.toThrow('above zero');

    const rows = await getAssetRetirements(client, company, asset.assetNumber, '0000');
    expect(rows.map((r) => [r.scope, r.retiredAcquisitionValue, r.status])).toEqual([
      ['PERCENT', 3000, 'ACTIVE'], ['PERCENT', 2250, 'ACTIVE'], ['AMOUNT', 750, 'ACTIVE'],
    ]);
    const listed = (await listRetireableAssets(client)).find((a) => a.assetNumber === asset.assetNumber);
    expect(listed).toMatchObject({ acquiredValue: 12000, retiredValue: 6000, remainingValue: 6000 });
  });

  it('completes the asset to RETIRED and refuses anything further', async () => {
    const asset = await newAsset();
    await acquire(asset.assetNumber, 5000);
    const done = await postAssetRetirement(retire(asset.assetNumber, { scope: 'COMPLETE' }));
    expect(done.retiredAcquisitionValue).toBe(5000);
    expect(done.remainingAcquisitionValue).toBe(0);
    const view = await getAsset(client, company, asset.assetNumber, '0000');
    expect(view?.status).toBe('RETIRED');
    expect(view?.deactivationDate).toBe('2026-06-01');
    await expect(postAssetRetirement(retire(asset.assetNumber)))
      .rejects.toThrow('already stands retired');
    await expect(acquire(asset.assetNumber, 100)).rejects.toThrow(/deactivated|retired/);
  });

  it('replays the same request key without a second posting', async () => {
    const asset = await newAsset();
    await acquire(asset.assetNumber, 4000);
    const first = await postAssetRetirement(retire(asset.assetNumber, {
      scope: 'AMOUNT', retirementAmount: 1000, requestKey: 'ret-replay',
    }));
    const before = await counts();
    const replay = await postAssetRetirement(retire(asset.assetNumber, {
      scope: 'AMOUNT', retirementAmount: 1000, requestKey: 'ret-replay',
    }));
    expect(replay.documentNumber).toBe(first.documentNumber);
    expect(await counts()).toEqual(before);
  });

  it('refuses invalid configuration, currency and value states by name', async () => {
    const unvalued = await newAsset();
    await expect(postAssetRetirement(retire(unvalued.assetNumber)))
      .rejects.toThrow('no acquisition value to retire');

    const asset = await newAsset();
    await acquire(asset.assetNumber, 4000);
    await expect(postAssetRetirement(retire(asset.assetNumber, { currency: 'EUR' })))
      .rejects.toThrow("not the asset's acquisition currency");
    await expect(postAssetRetirement(retire(asset.assetNumber, { transactionType: 'ACQ' })))
      .rejects.toThrow('not configured as an active retirement type');
    await expect(postAssetRetirement(retire(asset.assetNumber, { documentType: 'ZZ' })))
      .rejects.toThrow('Document type ZZ is not configured');
    await expect(postAssetRetirement(retire(asset.assetNumber, { text: 'x'.repeat(51) })))
      .rejects.toThrow('at most 50 characters');
    await expect(postAssetRetirement(retire(asset.assetNumber, { client: otherClient })))
      .rejects.toThrow('does not stand in company');

    const [ext] = await createAsset({
      client, changedBy: ACTOR, companyCode: company, assetClass: '9000',
      assetNumber: 'EXT-9000-1', description1: 'Incomplete determination asset',
      assignment: { validFrom: '2026-01-01' },
      depreciation: [{ areaCode: '01', depreciationKey: 'SL01', usefulLifeYears: 5, usefulLifePeriods: 0 }],
    });
    await postAssetAcquisition({
      client, changedBy: ACTOR, companyCode: company, assetNumber: ext.assetNumber, subNumber: '0000',
      documentDate: '2026-03-10', postingDate: '2026-03-15', assetValueDate: '2026-03-01',
      documentType: 'AA', currency: 'USD', amount: 2000, offsetAccount: OFFSET,
      transactionType: 'ACQ', requestKey: 'acq-ext-9000',
    });
    await expect(postAssetRetirement(retire(ext.assetNumber)))
      .rejects.toThrow('no accumulated depreciation account determination');
  });

  it('refuses a closed posting period and writes nothing', async () => {
    const asset = await newAsset();
    await acquire(asset.assetNumber, 4000);
    await withTenant(client, async (tx) => {
      await tx.update(postingPeriodRule).set({ periodTo: 10 })
        .where(sql`${postingPeriodRule.client} = ${client}`);
    });
    const before = await counts();
    try {
      await expect(postAssetRetirement(retire(asset.assetNumber, {
        documentDate: '2026-11-05', postingDate: '2026-11-20', assetValueDate: '2026-11-01',
      }))).rejects.toThrow('closed for');
    } finally {
      await withTenant(client, async (tx) => {
        await tx.update(postingPeriodRule).set({ periodTo: 12 })
          .where(sql`${postingPeriodRule.client} = ${client}`);
      });
    }
    expect(await counts()).toEqual(before);
  });

  it('reverses asset-aware, restores eligibility, and FB08 refuses the document', async () => {
    const asset = await newAsset();
    await acquire(asset.assetNumber, 5000);
    const posted = await postAssetRetirement(retire(asset.assetNumber, { scope: 'COMPLETE', requestKey: 'ret-rev-1' }));
    expect((await getAsset(client, company, asset.assetNumber, '0000'))?.status).toBe('RETIRED');

    await expect(reverseDocument({
      client, changedBy: ACTOR, companyCode: company, documentNumber: posted.documentNumber,
      fiscalYear: 2026, reasonCode: '01', documentDate: '2026-06-20', postingDate: '2026-06-20',
      confirmed: true, requestKey: 'fb08-guard-ret',
    })).rejects.toThrow('asset retirement');

    await expect(reverseAssetRetirement({
      client, changedBy: ACTOR, companyCode: company, assetNumber: asset.assetNumber,
      subNumber: '0000', documentNumber: posted.documentNumber, fiscalYear: 2026,
      reversalDate: '2026-06-20',
    })).rejects.toThrow('reason is required');

    const reversal = await reverseAssetRetirement({
      client, changedBy: ACTOR, companyCode: company, assetNumber: asset.assetNumber,
      subNumber: '0000', documentNumber: posted.documentNumber, fiscalYear: 2026,
      reversalDate: '2026-06-20', reason: 'Retired in error',
    });
    expect(reversal.reversalDocumentNumber).toBeTruthy();
    const restored = await getAsset(client, company, asset.assetNumber, '0000');
    expect(restored?.status).toBe('ACTIVE');
    expect(restored?.deactivationDate ?? null).toBeNull();
    const listed = (await listRetireableAssets(client)).find((a) => a.assetNumber === asset.assetNumber);
    expect(listed?.remainingValue).toBe(5000);

    await expect(reverseAssetRetirement({
      client, changedBy: ACTOR, companyCode: company, assetNumber: asset.assetNumber,
      subNumber: '0000', documentNumber: posted.documentNumber, fiscalYear: 2026,
      reversalDate: '2026-06-21', reason: 'Again',
    })).rejects.toThrow('already stands reversed');

    const audit = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select change_type from change_document
         where client = ${client} and object_class = 'asset_retirement'
           and object_key like ${`%/${posted.documentNumber}`}
         order by changed_at, change_type desc
      `);
      return (rows as unknown as { change_type: string }[]).map((r) => r.change_type);
    });
    expect(audit).toEqual(['CREATE', 'REVERSE']);
  });
});
