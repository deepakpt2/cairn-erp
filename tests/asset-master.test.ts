import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  changeAsset, changeAssetAssignment, changeAssetDepreciation,
  createAsset, deactivateAsset, getAsset,
} from '../src/modules/finance/asset-master';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'ASSET-TEST';
let client = '';
let otherClient = '';
const company = '1000';

function base(overrides: Record<string, unknown> = {}) {
  return {
    client, changedBy: ACTOR, companyCode: company, assetClass: '1000',
    description1: 'Test machine',
    assignment: { validFrom: '2026-01-01' },
    depreciation: [{ areaCode: '01', depreciationKey: 'SL01', usefulLifeYears: 10, usefulLifePeriods: 0 }],
    ...overrides,
  };
}

async function assetCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from fixed_asset where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

beforeAll(async () => {
  const fx = await createTenant('asset-master');
  client = fx.client;
  const other = await createTenant('asset-master-other');
  otherClient = other.client;
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'ASSETNR', subObject: '*', prefix: 'AS', numberLength: 7, createdBy: ACTOR });
    await tx.execute(sql`
      insert into asset_class (client, asset_class, name, numbering, created_by)
      values (${client}, '9000', 'Externally numbered', 'EXTERNAL', ${ACTOR}) on conflict do nothing
    `);
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

describe('SCR-091 asset master AS01/AS02 (R-139)', () => {
  it('creates with internal numbering and class defaults, audited', async () => {
    const [asset] = await createAsset(base({ depreciation: undefined }));
    expect(asset.assetNumber.startsWith('AS-')).toBe(true);
    expect(asset.subNumber).toBe('0000');
    expect(asset.depreciation).toEqual([expect.objectContaining({ areaCode: '01', depreciationKey: 'SL01', usefulLifeYears: 10 })]);
    const docs = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as n from change_document
        where client = ${client} and object_class = 'fixed_asset' and change_type = 'CREATE'
      `);
      return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
    });
    expect(docs).toBeGreaterThan(0);

    const foreign = await getAsset(otherClient, company, asset.assetNumber, '0000');
    expect(foreign).toBeNull();
  });

  it('creates similar assets as distinct mains atomically, and external and sub-numbers by their rules', async () => {
    const before = await assetCount();
    const batch = await createAsset(base({ similarCount: 3, description1: 'Batch machine' }));
    expect(new Set(batch.map((a) => a.assetNumber)).size).toBe(3);
    expect(await assetCount()).toBe(before + 3);

    await expect(createAsset(base({ similarCount: 2, inventoryNumber: 'INV-DUP' })))
      .rejects.toThrowError(/unique per asset/);
    expect(await assetCount()).toBe(before + 3);

    const [external] = await createAsset(base({
      assetClass: '9000', assetNumber: 'EXT-100', description1: 'External asset',
    }));
    expect(external.assetNumber).toBe('EXT-100');
    await expect(createAsset(base({ assetClass: '9000', assetNumber: 'EXT-100', description1: 'Again' })))
      .rejects.toThrowError(/already stands/);
    await expect(createAsset(base({ assetNumber: 'EXT-200', description1: 'Wrong policy' })))
      .rejects.toThrowError(/numbers internally/);

    const [sub] = await createAsset(base({
      assetClass: '9000', assetNumber: 'EXT-100', subNumber: '0001', description1: 'Component',
    }));
    expect(sub.subNumber).toBe('0001');
    await expect(createAsset(base({
      assetClass: '9000', assetNumber: 'EXT-404', subNumber: '0001', description1: 'Orphan',
    }))).rejects.toThrowError(/does not stand/);
  });

  it('refuses invalid configuration references by name', async () => {
    await expect(createAsset(base({ assetClass: '7777' }))).rejects.toThrowError(/not configured active/);
    await expect(createAsset(base({ companyCode: '9999' }))).rejects.toThrowError(/not configured/);
    await expect(createAsset(base({ assignment: { validFrom: '2026-01-01', costCenter: 'NOPE' } })))
      .rejects.toThrowError(/does not stand/);
    await expect(createAsset(base({
      depreciation: [{ areaCode: '01', depreciationKey: 'NOPE', usefulLifeYears: 5, usefulLifePeriods: 0 }],
    }))).rejects.toThrowError(/not configured active/);
    await expect(createAsset(base({
      depreciation: [{ areaCode: '01', depreciationKey: 'SL01', usefulLifeYears: 0, usefulLifePeriods: 0 }],
    }))).rejects.toThrowError(/stand positive/);
  });

  it('changes under version control, appends assignments with history, and deactivates by reason', async () => {
    const [asset] = await createAsset(base({
      description1: 'Changeable',
      assignment: { validFrom: '2026-01-01', costCenter: 'CC100' },
    }));
    const key = { client, changedBy: ACTOR, companyCode: company, assetNumber: asset.assetNumber, subNumber: '0000' };

    await expect(changeAsset({ ...key, expectedVersion: 99, description1: 'Stale' }))
      .rejects.toThrowError(/has changed since/);
    const changed = await changeAsset({ ...key, expectedVersion: asset.version, description1: 'Changed name' });
    expect(changed.description1).toBe('Changed name');
    expect(changed.version).toBe(asset.version + 1);

    await expect(changeAssetAssignment({
      ...key, expectedVersion: changed.version,
      assignment: { validFrom: '2026-01-01', costCenter: 'CC100' },
    })).rejects.toThrowError(/overlap/);
    const reassigned = await changeAssetAssignment({
      ...key, expectedVersion: changed.version,
      assignment: { validFrom: '2027-01-01', plant: undefined },
    });
    expect(reassigned.assignments).toHaveLength(2);
    expect(reassigned.assignments[0]).toMatchObject({ validFrom: '2026-01-01', validTo: '2027-01-01', costCenter: 'CC100' });
    expect(reassigned.assignments[1].validTo).toBeNull();

    const deprChanged = await changeAssetDepreciation({
      ...key, expectedVersion: reassigned.version,
      depreciation: { areaCode: '01', depreciationKey: 'DB01', usefulLifeYears: 8, usefulLifePeriods: 6 },
    });
    expect(deprChanged.depreciation[0]).toMatchObject({ depreciationKey: 'DB01', usefulLifeYears: 8, usefulLifePeriods: 6 });

    await expect(deactivateAsset({
      ...key, expectedVersion: deprChanged.version, deactivationDate: '2027-06-01',
    })).rejects.toThrowError(/reason is required/);
    const deactivated = await deactivateAsset({
      ...key, expectedVersion: deprChanged.version, deactivationDate: '2027-06-01', reason: 'Sold as scrap',
    });
    expect(deactivated.status).toBe('DEACTIVATED');
    await expect(changeAsset({ ...key, expectedVersion: deactivated.version, description1: 'Too late' }))
      .rejects.toThrowError(/deactivated/);
  });
});
