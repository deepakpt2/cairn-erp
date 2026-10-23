import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { saveBatchStatus } from '../src/modules/inventory/batch-status';
import { savePlantBatchStatus } from '../src/modules/inventory/batch-status-plant';
import { createBatch } from '../src/modules/inventory/batch-master';
import { resolvePostingBatch } from '../src/modules/inventory/batch-posting';
import { saveInternalBatchAssignment } from '../src/modules/inventory/batch-number-assignment';
import { saveBatchNumberInterval } from '../src/modules/inventory/batch-number-range';
import {
  ACTIVITY,
  ALIAS,
  InitialBatchStatusError,
  listInitialBatchStatus,
  saveInitialBatchStatus,
} from '../src/modules/inventory/initial-batch-status';
import { ensureOrderBatch } from '../src/modules/inventory/scheduling-profile';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMAB_TEST';
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
    insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
    values (${client}, ${materialNumber}, ${materialNumber}, 'RAW', 'PC', true, ${ACTOR})
    on conflict (client, material_number) do update set batch_managed = true
  `));
}

async function storedFlag(client: string) {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select initial_batch_restricted from material_type where client = ${client} and material_type = 'RAW'
  `)) as unknown as Array<{ initial_batch_restricted: boolean }>;
  return rows[0]?.initial_batch_restricted;
}

async function storedStatus(client: string, batchNumber: string) {
  const rows = await withTenant(client, (tx) => tx.execute(sql`
    select restricted_use from batch where client = ${client} and batch_number = ${batchNumber}
  `)) as unknown as Array<{ restricted_use: string | null }>;
  return rows[0]?.restricted_use ?? null;
}

describe('OMAB initial status of a new batch', () => {
  it('lists the material type, stores X as true, and does not rewrite an existing batch', async () => {
    const client = await tenant('omab-save');
    expect(ACTIVITY).toBe('CFG.INV.BATCHINITIAL.DEFINE');
    expect(ALIAS).toBe('OMAB');
    const opened = await listInitialBatchStatus(client);
    const raw = opened.types.find((row) => row.materialType === 'RAW');
    expect(raw?.name).toBeTruthy();
    expect(raw?.initialStatus).toBeNull();
    expect(await storedFlag(client)).toBe(false);

    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await saveBatchStatus({ client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate' });
    await material(client, 'MAT-OLD');
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-OLD', batchNumber: 'OLD1', reason: 'Before the flag',
    });
    expect(await storedStatus(client, 'OLD1')).toBe(' ');

    await expect(saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: [], materialType: 'RAW', initialStatus: 'X', expectedStatus: '', confirmed: true, reason: 'No authority',
    })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, materialType: 'NOPE', initialStatus: 'X', expectedStatus: '', confirmed: true, reason: 'Missing type',
    })).rejects.toMatchObject({ code: 'TYPE_UNKNOWN' });
    await expect(saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, materialType: 'RAW', initialStatus: '1', expectedStatus: '', confirmed: true, reason: 'Wrong code',
    })).rejects.toMatchObject({ code: 'STATUS_UNKNOWN' });
    await expect(saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, materialType: 'RAW', initialStatus: 'X', expectedStatus: '', confirmed: true, reason: 'Plant', plant: '1000',
    })).rejects.toMatchObject({ code: 'PLANT_REFUSED' });
    await expect(saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, materialType: 'RAW', initialStatus: 'X', expectedStatus: '', reason: 'Not confirmed',
    })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(await storedFlag(client)).toBe(false);

    const saved = await saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, materialType: 'RAW', initialStatus: 'X', expectedStatus: '', confirmed: true, reason: 'Restrict future batches',
    });
    expect(saved.initialStatus).toBe('X');
    expect(saved.name).toBe(raw?.name);
    expect(await storedFlag(client)).toBe(true);
    expect(await storedStatus(client, 'OLD1')).toBe(' ');
    await expect(saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, materialType: 'RAW', initialStatus: '', expectedStatus: '', confirmed: true, reason: 'Stale',
    })).rejects.toBeInstanceOf(InitialBatchStatusError);
    expect(await storedFlag(client)).toBe(true);
  });

  it('applies the flag only to a new batch when status management is effective', async () => {
    const client = await tenant('omab-create');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await saveBatchStatus({ client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate' });
    await material(client, 'MAT-A');
    await saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, materialType: 'RAW', initialStatus: 'X', expectedStatus: '', confirmed: true, reason: 'Restrict',
    });
    const restricted = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'ON1', reason: 'Use the default',
    });
    expect(restricted.restrictedUse).toBe('X');
    const overridden = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'ON2', restrictedUse: '', reason: 'Override',
    });
    expect(overridden.restrictedUse).toBeNull();
    expect(await storedStatus(client, 'ON2')).toBe(' ');
    await saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, materialType: 'RAW', initialStatus: '', expectedStatus: 'X', confirmed: true, reason: 'Clear',
    });
    const open = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'ON3', reason: 'Blank default',
    });
    expect(open.restrictedUse).toBeNull();
    expect(await storedStatus(client, 'ON3')).toBe(' ');
    expect(await storedStatus(client, 'ON1')).toBe('X');
    await expect(withTenant(client, (tx) => resolvePostingBatch(tx, {
      client, materialNumber: 'MAT-A', plant: '1000', batch: 'ON1', postingDate: '2026-10-23',
    }))).rejects.toThrow(/restricted/);
  });

  it('does not apply the flag in a plant OMCU has not selected, and an order batch uses it when effective', async () => {
    const client = await tenant('omab-plant');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    await saveBatchStatus({ client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate' });
    await material(client, 'MAT-A');
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '1100', 'Second plant', '1000', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, batch_managed, created_by)
        values (${client}, 'MAT-A', '1000', true, ${ACTOR}),
               (${client}, 'MAT-A', '1100', true, ${ACTOR})
        on conflict (client, material_number, plant) do update set batch_managed = true
      `);
    });
    await saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, materialType: 'RAW', initialStatus: 'X', expectedStatus: '', confirmed: true, reason: 'Restrict',
    });
    await savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: ['CFG.INV.BATCHSTATUSPLANT.DEFINE'], plant: '1000', statusActive: 'X', version: 0, confirmed: true, reason: 'Select plant',
    });
    const ignored = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '1100', batchNumber: 'P0', reason: 'Plant not selected',
    });
    expect(ignored.restrictedUse).toBeNull();
    const applied = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '1000', batchNumber: 'P1', reason: 'Plant selected',
    });
    expect(applied.restrictedUse).toBe('X');
    const context = await listInitialBatchStatus(client);
    expect(context.context.selectedPlants).toContain('1000');
    expect(context.context.selectedPlants).not.toContain('1100');

    await saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: 'X', version: 0, reason: 'Activate numbering',
    });
    await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: ['CFG.INV.BATCHRANGE.DEFINE'],
      interval: '01', fromNumber: '1', toNumber: '10', external: false, mode: 'CREATE', reason: 'Internal',
    });
    const number = await withTenant(client, (tx) => ensureOrderBatch(tx, {
      client, materialNumber: 'MAT-A', plant: '1000', batchNumber: '', batchCreation: '1', moment: 'CREATE', changedBy: ACTOR,
    }));
    expect(await storedStatus(client, number)).toBe('X');
    const receipt = readFileSync('src/modules/inventory/goods-receipt.ts', 'utf8');
    const productionReceipt = readFileSync('src/modules/inventory/production-receipt.ts', 'utf8');
    expect(receipt).not.toMatch(/createBatch/);
    expect(productionReceipt).not.toMatch(/createBatch|insert into batch/);
  });

  it('stores the flag while status management is off and does not apply it', async () => {
    const client = await tenant('omab-off');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await material(client, 'MAT-A');
    await saveInitialBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, materialType: 'RAW', initialStatus: 'X', expectedStatus: '', confirmed: true, reason: 'Restrict later',
    });
    const created = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'OFF1', reason: 'Status off',
    });
    expect(created.restrictedUse).toBeNull();
    expect(await storedStatus(client, 'OFF1')).toBeNull();
    expect(await storedFlag(client)).toBe(true);
  });

  it('does not show another tenant the flag', async () => {
    const left = await tenant('omab-left');
    const right = await tenant('omab-right');
    await saveInitialBatchStatus({
      client: left, changedBy: ACTOR, capabilities: AUTH, materialType: 'RAW', initialStatus: 'X', expectedStatus: '', confirmed: true, reason: 'Left only',
    });
    expect((await listInitialBatchStatus(right)).types.find((row) => row.materialType === 'RAW')?.initialStatus).toBeNull();
    expect(await storedFlag(right)).toBe(false);
    const manual = readFileSync('onboarding-manual.md', 'utf8');
    expect(manual).toMatch(/CFG\.INV\.BATCHINITIAL\.DEFINE/);
    expect(manual).toMatch(/\/config\/batch-initial-status/);
  });
});
