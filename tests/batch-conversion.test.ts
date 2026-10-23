import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createBatchIdentity, getBatchLevel, saveBatchLevel } from '../src/modules/inventory/batch-level';
import { getBatchStatusManagement } from '../src/modules/inventory/batch-status';
import {
  ACTIVITY,
  ALIAS,
  checkBatchConversion,
  executeBatchConversion,
  listConversionChecks,
} from '../src/modules/inventory/batch-conversion';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCT_TEST';
const AUTH = [ACTIVITY];
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function tenant(seed: string): Promise<string> {
  const created = await createTenant(seed);
  clients.push(created.client);
  return created.client;
}

async function material(client: string, materialNumber: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into material (client, material_number, description, material_type, base_unit, created_by)
    values (${client}, ${materialNumber}, ${materialNumber}, 'RAW', 'PC', ${ACTOR})
    on conflict do nothing
  `));
}

async function plant(client: string, code: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into plant (client, plant, name, country, created_by)
    values (${client}, ${code}, ${`Plant ${code}`}, 'KW', ${ACTOR})
    on conflict do nothing
  `));
}

function check(client: string, extra: Record<string, unknown> = {}) {
  return checkBatchConversion({
    client,
    changedBy: ACTOR,
    capabilities: AUTH,
    targetLevel: '1',
    expectedLevelVersion: 1,
    dryRun: false,
    confirmed: true,
    reason: 'Check the proposed level',
    ...extra,
  });
}

describe('OMCT batch conversion check', () => {
  it('does not set the level and does not execute a conversion', async () => {
    const client = await tenant('omct-empty');
    await expect(check(client)).rejects.toMatchObject({ code: 'NOT_SET' });
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    const dry = await check(client, { targetLevel: '1', dryRun: true, confirmed: false });
    expect(dry.persisted).toBe(false);
    expect(dry.result).toBe('NOT_REQUIRED');
    expect(await listConversionChecks(client)).toMatchObject({ checks: [], batchLevel: '0' });
    const recorded = await check(client, { targetLevel: '1' });
    expect(recorded.result).toBe('NOT_REQUIRED');
    expect(recorded.persisted).toBe(true);
    const statusOnly = await check(client, { targetLevel: '', targetStatus: '1' });
    expect(statusOnly.result).toBe('NOT_REQUIRED');
    expect(statusOnly.persisted).toBe(true);
    expect((await getBatchLevel(client))?.batchLevel).toBe('0');
    expect((await getBatchStatusManagement(client)).statusManagement).toBeNull();
    expect(() => executeBatchConversion()).toThrow(/not changed/);
    await expect(check(client, { targetLevel: '3' })).rejects.toMatchObject({ code: 'LEVEL_UNKNOWN' });
    await expect(check(client, { capabilities: [] })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(check(client, { execute: true })).rejects.toMatchObject({ code: 'CONVERSION_NOT_EXECUTED' });
  });

  it('reports colliding identities and does not merge them', async () => {
    const client = await tenant('omct-collide');
    const other = await tenant('omct-other');
    await plant(client, '1000');
    await plant(client, '2000');
    await material(client, 'RM-1');
    await material(client, 'RM-2');
    await material(other, 'RM-1');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    await saveBatchLevel({ client: other, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Other plant level' });
    await createBatchIdentity({ client, changedBy: ACTOR, materialNumber: 'RM-1', batchNumber: 'B1', plant: '1000' });
    await createBatchIdentity({ client, changedBy: ACTOR, materialNumber: 'RM-1', batchNumber: 'B1', plant: '2000' });
    await createBatchIdentity({ client: other, changedBy: ACTOR, materialNumber: 'RM-1', batchNumber: 'FOREIGN', plant: '1000' });

    const before = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as batches from batch where client = ${client}
    `)) as unknown as Array<{ batches: number }>;
    const found = await check(client, { targetLevel: '1' });
    expect(found.result).toBe('BLOCKED');
    expect(found.conflicts.map((item) => item.conflictCode)).toContain('IDENTITY_COLLISION');
    expect(found.conflicts.some((item) => item.objectKey.includes('FOREIGN'))).toBe(false);
    expect(found.summary).toMatch(/not merged|Nothing was merged/i);
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as batches from batch where client = ${client}
    `)) as unknown as Array<{ batches: number }>;
    expect(after[0]?.batches).toBe(before[0]?.batches);
    expect((await getBatchLevel(client))?.batchLevel).toBe('0');

    const missing = await tenant('omct-missing-plant');
    await material(missing, 'RM-1');
    await saveBatchLevel({ client: missing, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await createBatchIdentity({ client: missing, changedBy: ACTOR, materialNumber: 'RM-1', batchNumber: 'SAME' });
    const beforeChecks = (await listConversionChecks(missing)).checks.length;
    const missingPlant = await checkBatchConversion({
      client: missing,
      changedBy: ACTOR,
      capabilities: AUTH,
      targetLevel: '0',
      expectedLevelVersion: 1,
      dryRun: true,
      confirmed: false,
      reason: 'Plant level would need a plant',
    });
    expect(missingPlant.conflicts.map((item) => item.conflictCode)).toContain('PLANT_MISSING');
    expect(missingPlant.persisted).toBe(false);
    expect((await listConversionChecks(missing)).checks).toHaveLength(beforeChecks);
    expect((await getBatchLevel(missing))?.batchLevel).toBe('1');
  });

  it('does not let a goods movement or the level screen become this check', () => {
    const service = readFileSync('src/modules/inventory/batch-conversion.ts', 'utf8');
    expect(service).toContain('CONVERSION_NOT_EXECUTED');
    expect(service).not.toContain('saveBatchLevel');
    expect(service).not.toContain('saveBatchStatus');
    const page = readFileSync('src/app/config/batch-conversion/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/batch-level.ts',
      'src/modules/inventory/batch-status.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain("from './batch-conversion'");
    }
    expect(ACTIVITY).toBe('CFG.INV.BATCHCONVERT.DEFINE');
    expect(ALIAS).toBe('OMCT');
  });
});
