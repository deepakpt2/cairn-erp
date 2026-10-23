import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createBatchIdentity, saveBatchLevel } from '../src/modules/inventory/batch-level';
import {
  ACTIVITY,
  ALIAS,
  createWipBatch,
  getWipBatchActivation,
  saveWipBatchActivation,
  wipBatchActive,
} from '../src/modules/production/wip-batch';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCWB_TEST';
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

function save(client: string, wipBatchActive: string, version: number, extra: Record<string, unknown> = {}) {
  return saveWipBatchActivation({
    client,
    changedBy: ACTOR,
    wipBatchActive,
    version,
    reason: 'Set the WIP batch indicator',
    ...extra,
  });
}

describe('OMCWB WIP batch activation', () => {
  it('requires a batch level and confirmation, then cannot be revoked', async () => {
    const client = await tenant('omcwb-flag');
    expect(await wipBatchActive(client)).toBe(false);
    await expect(save(client, 'X', 0, { confirmed: true })).rejects.toMatchObject({ code: 'PREREQUISITE_MISSING' });
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await expect(save(client, 'X', 0)).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    const inactive = await save(client, '', 0);
    expect(inactive).toMatchObject({ code: null, version: 1, irreversible: false });
    const active = await save(client, 'X', 1, { confirmed: true });
    expect(active).toMatchObject({ code: 'X', version: 2, irreversible: true });
    const again = await save(client, 'X', 99, { confirmed: false });
    expect(again.version).toBe(2);
    await expect(save(client, '', 2)).rejects.toMatchObject({ code: 'IRREVERSIBLE' });
    expect(() => createWipBatch()).toThrow(/not created/);
    await expect(save(client, '1', 2)).rejects.toMatchObject({ code: 'CODE_UNKNOWN' });
    await expect(save(client, 'X', 2, { plant: '1000' })).rejects.toMatchObject({ code: 'PLANT_REFUSED' });
    await expect(save(client, 'X', 2, { orderNumber: '1000001' })).rejects.toMatchObject({ code: 'ORDER_REFUSED' });
  });

  it('does not create a batch or a document, and does not cross tenants', async () => {
    const client = await tenant('omcwb-batch');
    const other = await tenant('omcwb-other');
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, 'RM-WIP', 'WIP material', 'RAW', 'PC', ${ACTOR})
    `));
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    await createBatchIdentity({ client, changedBy: ACTOR, materialNumber: 'RM-WIP', batchNumber: 'B1', plant: '1000' });
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from batch where client = ${client}) as batches,
        (select count(*)::int from production_order where client = ${client}) as orders,
        (select count(*)::int from material_document where client = ${client}) as documents
    `)) as unknown as Array<{ batches: number; orders: number; documents: number }>;
    await save(client, 'X', 0, { confirmed: true });
    await save(client, 'X', 1, { confirmed: true });
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from batch where client = ${client}) as batches,
        (select count(*)::int from production_order where client = ${client}) as orders,
        (select count(*)::int from material_document where client = ${client}) as documents
    `)) as unknown as Array<{ batches: number; orders: number; documents: number }>;
    expect(after[0]).toEqual(before[0]);
    expect(await wipBatchActive(other)).toBe(false);
    expect((await getWipBatchActivation(client)).code).toBe('X');
  });

  it('does not let a goods movement or an order become this screen', () => {
    const service = readFileSync('src/modules/production/wip-batch.ts', 'utf8');
    expect(service).toContain('WIP_BATCH_NOT_CREATED');
    expect(service).toContain('IRREVERSIBLE');
    const page = readFileSync('src/app/config/wip-batch/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    const actions = readFileSync('src/app/config/wip-batch/actions.ts', 'utf8');
    expect(actions).toContain('requireCapability');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/production-receipt.ts',
      'src/modules/inventory/scheduling-profile.ts',
      'src/modules/production/mrp-run.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('wip-batch');
    }
    expect(ACTIVITY).toBe('CFG.PROD.WIPBATCH.DEFINE');
    expect(ALIAS).toBe('OMCWB');
  });
});
