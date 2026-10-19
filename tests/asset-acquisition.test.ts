import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  getAssetTransactions, postAssetAcquisition, reverseAssetAcquisition,
  simulateAssetAcquisition,
} from '../src/modules/finance/asset-acquisition';
import { createAsset, deactivateAsset, getAsset } from '../src/modules/finance/asset-master';
import { reverseDocument } from '../src/modules/finance/document-reversal';
import { postingPeriodRule } from '../src/modules/foundation/schema';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'ASSET-ACQ-TEST';
let client = '';
let otherClient = '';
const company = '1000';
const OFFSET = '230200'; // Accrual — utilities: ordinary G/L, no reconciliation

async function newAsset(assetClass = '1000') {
  const [asset] = await createAsset({
    client, changedBy: ACTOR, companyCode: company, assetClass,
    description1: 'Acquisition test asset',
    assignment: { validFrom: '2026-01-01' },
    depreciation: [{ areaCode: '01', depreciationKey: 'SL01', usefulLifeYears: 10, usefulLifePeriods: 0 }],
  });
  return asset;
}

function input(assetNumber: string, overrides: Record<string, unknown> = {}) {
  return {
    client, changedBy: ACTOR, companyCode: company, assetNumber, subNumber: '0000',
    documentDate: '2026-03-10', postingDate: '2026-03-15', assetValueDate: '2026-03-01',
    documentType: 'AA', currency: 'USD', amount: 12000,
    offsetAccount: OFFSET, transactionType: 'ACQ', text: 'Initial acquisition',
    requestKey: `acq-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function counts(): Promise<{ journals: number; txns: number }> {
  return withTenant(client, async (tx) => {
    const j = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client} and origin_class = 'asset_acquisition'`);
    const a = await tx.execute(sql`select count(*)::int as n from asset_transaction where client = ${client}`);
    return {
      journals: Number((j as unknown as { n: number }[])[0]?.n ?? 0),
      txns: Number((a as unknown as { n: number }[])[0]?.n ?? 0),
    };
  });
}

beforeAll(async () => {
  const fx = await createTenant('asset-acquisition');
  client = fx.client;
  const other = await createTenant('asset-acquisition-other');
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

describe('SCR-092 asset acquisition ABZON (R-140)', () => {
  it('simulates with the identical judges and persists nothing', async () => {
    const asset = await newAsset();
    const before = await counts();
    const preview = await simulateAssetAcquisition(input(asset.assetNumber));
    expect(preview.reconAccount).toBe('150000');
    expect(preview.debitAmount).toBe(12000);
    expect(preview.creditAmount).toBe(12000);
    expect(preview.capitalizationDate).toBe('2026-03-01');
    expect(preview.warnings.join(' ')).toMatch(/capitali[sz]e/i);
    expect(await counts()).toEqual(before);
    const view = await getAsset(client, company, asset.assetNumber, '0000');
    expect(view?.capitalizationDate ?? null).toBeNull();
    await expect(simulateAssetAcquisition(input(asset.assetNumber, { amount: 0 })))
      .rejects.toThrow('above zero');
  });

  it('posts debit recon / credit offset through the engine, capitalizes, and totals', async () => {
    const asset = await newAsset();
    const result = await postAssetAcquisition(input(asset.assetNumber, { requestKey: 'acq-main-1' }));
    expect(result.totalAcquiredValue).toBe(12000);
    expect(result.fiscalYear).toBe(2026);

    const lines = await withTenant(client, async (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_document::float as amt, business_partner
        from journal_entry_line
       where client = ${client} and document_number = ${result.documentNumber} and fiscal_year = 2026
       order by line_number
    `)) as unknown as { gl_account: string; debit_credit: string; amt: number; business_partner: string | null }[];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ gl_account: '150000', debit_credit: 'S', amt: 12000 });
    expect(lines[1]).toMatchObject({ gl_account: OFFSET, debit_credit: 'H', amt: 12000 });
    expect(lines.every((l) => l.business_partner === null)).toBe(true);

    const view = await getAsset(client, company, asset.assetNumber, '0000');
    expect(view?.capitalizationDate).toBe('2026-03-01');
    expect(view?.depreciation[0]?.depreciationStartDate).toBe('2026-03-01');

    const txns = await getAssetTransactions(client, company, asset.assetNumber, '0000');
    expect(txns).toEqual([expect.objectContaining({
      documentNumber: result.documentNumber, status: 'ACTIVE', amount: 12000,
      transactionType: 'ACQ', assetValueDate: '2026-03-01', offsetAccount: OFFSET,
    })]);

    // Second acquisition accumulates; capitalization date stands.
    const second = await postAssetAcquisition(input(asset.assetNumber, {
      amount: 3000, assetValueDate: '2026-04-01', postingDate: '2026-04-10', documentDate: '2026-04-09',
    }));
    expect(second.totalAcquiredValue).toBe(15000);
    const after = await getAsset(client, company, asset.assetNumber, '0000');
    expect(after?.capitalizationDate).toBe('2026-03-01');
  });

  it('replays the same request key without a second posting', async () => {
    const asset = await newAsset();
    const first = await postAssetAcquisition(input(asset.assetNumber, { requestKey: 'acq-replay' }));
    const before = await counts();
    const replay = await postAssetAcquisition(input(asset.assetNumber, { requestKey: 'acq-replay' }));
    expect(replay.documentNumber).toBe(first.documentNumber);
    expect(await counts()).toEqual(before);
  });

  it('refuses invalid determinations, types and assets by name', async () => {
    const asset = await newAsset();
    await expect(postAssetAcquisition(input(asset.assetNumber, { offsetAccount: '150000' })))
      .rejects.toThrow('reconciliation account');
    await expect(postAssetAcquisition(input(asset.assetNumber, { offsetAccount: '999999' })))
      .rejects.toThrow('does not stand');
    await expect(postAssetAcquisition(input(asset.assetNumber, { transactionType: 'ZZZ' })))
      .rejects.toThrow('not configured as an active acquisition type');
    await expect(postAssetAcquisition(input(asset.assetNumber, { documentType: 'ZZ' })))
      .rejects.toThrow('Document type ZZ is not configured');
    await expect(postAssetAcquisition(input(asset.assetNumber, { text: 'x'.repeat(51) })))
      .rejects.toThrow('at most 50 characters');

    const building = await newAsset('3000'); // delivered without recon determination
    await expect(postAssetAcquisition(input(building.assetNumber)))
      .rejects.toThrow('no acquisition account determination');

    const gone = await newAsset();
    const view = await getAsset(client, company, gone.assetNumber, '0000');
    await deactivateAsset({
      client, changedBy: ACTOR, companyCode: company, assetNumber: gone.assetNumber,
      subNumber: '0000', expectedVersion: view!.version, deactivationDate: '2026-05-01',
      reason: 'Retired from test',
    });
    await expect(postAssetAcquisition(input(gone.assetNumber)))
      .rejects.toThrow('deactivated');

    await expect(postAssetAcquisition(input(asset.assetNumber, { client: otherClient })))
      .rejects.toThrow('does not stand in company');
  });

  it('refuses a closed posting period and writes nothing', async () => {
    const asset = await newAsset();
    await withTenant(client, async (tx) => {
      await tx.update(postingPeriodRule).set({ periodTo: 10 })
        .where(sql`${postingPeriodRule.client} = ${client}`);
    });
    const before = await counts();
    try {
      await expect(postAssetAcquisition(input(asset.assetNumber, {
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

  it('reverses asset-aware, drops the total, and FB08 refuses the document', async () => {
    const asset = await newAsset();
    const posted = await postAssetAcquisition(input(asset.assetNumber, { requestKey: 'acq-rev-1' }));

    await expect(reverseDocument({
      client, changedBy: ACTOR, companyCode: company, documentNumber: posted.documentNumber,
      fiscalYear: 2026, reasonCode: '01', documentDate: '2026-03-20', postingDate: '2026-03-20',
      confirmed: true, requestKey: 'fb08-guard',
    })).rejects.toThrow('asset acquisition');

    await expect(reverseAssetAcquisition({
      client, changedBy: ACTOR, companyCode: company, assetNumber: asset.assetNumber,
      subNumber: '0000', documentNumber: posted.documentNumber, fiscalYear: 2026,
      reversalDate: '2026-03-20',
    })).rejects.toThrow('reason is required');

    const reversal = await reverseAssetAcquisition({
      client, changedBy: ACTOR, companyCode: company, assetNumber: asset.assetNumber,
      subNumber: '0000', documentNumber: posted.documentNumber, fiscalYear: 2026,
      reversalDate: '2026-03-20', reason: 'Wrong offsetting account',
    });
    expect(reversal.reversalDocumentNumber).toBeTruthy();

    const txns = await getAssetTransactions(client, company, asset.assetNumber, '0000');
    expect(txns[0]).toMatchObject({ status: 'REVERSED', reversalDocumentNumber: reversal.reversalDocumentNumber });

    await expect(reverseAssetAcquisition({
      client, changedBy: ACTOR, companyCode: company, assetNumber: asset.assetNumber,
      subNumber: '0000', documentNumber: posted.documentNumber, fiscalYear: 2026,
      reversalDate: '2026-03-21', reason: 'Again',
    })).rejects.toThrow('already stands reversed');

    const audit = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select change_type from change_document
         where client = ${client} and object_class = 'asset_acquisition'
           and object_key like ${`%/${posted.documentNumber}`}
         order by changed_at, change_type desc
      `);
      return (rows as unknown as { change_type: string }[]).map((r) => r.change_type);
    });
    expect(audit).toEqual(['CREATE', 'REVERSE']);
  });
});
