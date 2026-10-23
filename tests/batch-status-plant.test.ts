import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { saveBatchStatus } from '../src/modules/inventory/batch-status';
import {
  ACTIVITY,
  executePlantStatusConversion,
  listPlantBatchStatus,
  listPlantStatusConversions,
  savePlantBatchStatus,
} from '../src/modules/inventory/batch-status-plant';
import { createBatch } from '../src/modules/inventory/batch-master';
import { resolvePostingBatch } from '../src/modules/inventory/batch-posting';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCU_TEST';
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

async function rows(client: string) {
  return withTenant(client, (tx) => tx.execute(sql`
    select plant, status_active, pg_typeof(status_active) as stored_type, version
    from batch_status_plant
    where client = ${client}
    order by plant
  `)) as Promise<Array<{ plant: string; status_active: string; stored_type: string; version: number }>>;
}

async function plantLevel(client: string) {
  await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
  await saveBatchStatus({ client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate status' });
}

describe('OMCU plant batch status', () => {
  it('does not select a plant by being opened, and reads the plant name from the master', async () => {
    const client = await tenant('omcu-pack-2');
    const opened = await listPlantBatchStatus(client);
    expect(opened.context.applicable).toBe(false);
    expect(opened.plants.length).toBeGreaterThan(0);
    expect(opened.plants.every((row) => row.statusActive === null)).toBe(true);
    expect(opened.plants.find((row) => row.plant === '1000')?.plantName).toBeTruthy();
    expect(await rows(client)).toEqual([]);
    const nameColumn = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'batch_status_plant' and column_name in ('name', 'plant_name')
    `)) as unknown as Array<{ column_name: string }>;
    expect(nameColumn).toEqual([]);
  });

  it('stores X or blank, and refuses a plant that does not stand', async () => {
    const client = await tenant('omcu-pack-3');
    await plantLevel(client);
    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: [], plant: '1000', statusActive: 'X', version: 0, confirmed: true, reason: 'No authority',
    })).rejects.toMatchObject({ code: 'AUTHORITY_REQUIRED' });
    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '9999', statusActive: 'X', version: 0, confirmed: true, reason: 'Missing plant',
    })).rejects.toMatchObject({ code: 'PLANT_UNKNOWN' });
    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: '1', version: 0, confirmed: true, reason: 'Wrong code',
    })).rejects.toMatchObject({ code: 'STATUS_UNKNOWN' });
    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: 'X', version: 0, reason: 'Not confirmed',
    })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: 'X', version: 0, confirmed: true, reason: 'Transport', transportRequest: 'DEVK900001',
    })).rejects.toMatchObject({ code: 'TRANSPORT_REFUSED' });
    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: 'X', version: 0, confirmed: true, reason: 'Rename', plantName: 'Other name',
    })).rejects.toMatchObject({ code: 'PLANT_NAME_REFUSED' });
    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: 'X', version: 0, confirmed: true, reason: 'Movement', movement: '341',
    })).rejects.toMatchObject({ code: 'MOVEMENT_REFUSED' });
    expect(await rows(client)).toEqual([]);

    const saved = await savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: 'X', version: 0, confirmed: true, reason: 'Select plant',
    });
    expect(saved.statusActive).toBe('X');
    expect(saved.effective).toBe(true);
    expect(saved.plantName).not.toBe('');
    const stored = await rows(client);
    expect(stored[0]?.status_active).toBe('X');
    expect(stored[0]?.stored_type).toBe('character');
    const master = await withTenant(client, (tx) => tx.execute(sql`
      select name from plant where client = ${client} and plant = '1000'
    `)) as unknown as Array<{ name: string }>;
    expect(saved.plantName).toBe(master[0]?.name);

    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: ' ', version: 0, confirmed: true, reason: 'Stale',
    })).rejects.toMatchObject({ code: 'VERSION_STALE' });
    expect((await rows(client))[0]?.status_active).toBe('X');
    await expect(executePlantStatusConversion()).rejects.toMatchObject({ code: 'CONVERSION_BLOCKED' });
  });

  it('does not override OMCS when the batch level is not plant', async () => {
    const client = await tenant('omcu-pack-4');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await saveBatchStatus({ client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate status' });
    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: 'X', version: 0, confirmed: true, reason: 'Should not override',
    })).rejects.toMatchObject({ code: 'LEVEL_INAPPLICABLE' });
    expect(await rows(client)).toEqual([]);
    const omcs = await withTenant(client, (tx) => tx.execute(sql`
      select status_management from batch_status_management where client = ${client}
    `)) as unknown as Array<{ status_management: string }>;
    expect(omcs[0]?.status_management).toBe('1');
    const level = await withTenant(client, (tx) => tx.execute(sql`
      select batch_level from batch_level_configuration where client = ${client}
    `)) as unknown as Array<{ batch_level: string }>;
    expect(level[0]?.batch_level).toBe('1');
  });

  it('refuses a change that would need conversion, and does not move stock', async () => {
    const client = await tenant('omcu-pack-5');
    await plantLevel(client);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
      values (${client}, 'MAT-OMCU', 'OMCU material', 'RAW', 'PC', true, ${ACTOR})
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into batch (id, client, batch_number, material_number, plant, batch_level_at_creation, created_by, changed_by)
      values (${`${client}-b9`}, ${client}, 'B9', 'MAT-OMCU', '1000', '0', ${ACTOR}, ${ACTOR})
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into stock_quantity (
        client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by, changed_by
      ) values (${client}, 'MAT-OMCU', '1000', '0001', 'BLOCKED', 'B9', 3, ${ACTOR}, ${ACTOR})
    `));
    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: 'X', version: 0, confirmed: true, reason: 'Too late',
    })).rejects.toThrow(/341/);
    expect(await rows(client)).toEqual([]);
    const stock = await withTenant(client, (tx) => tx.execute(sql`
      select stock_type, quantity::text as quantity from stock_quantity
      where client = ${client} and plant = '1000' and batch_number = 'B9'
    `)) as unknown as Array<{ stock_type: string; quantity: string }>;
    expect(stock[0]).toMatchObject({ stock_type: 'BLOCKED', quantity: '3.000' });
    const documents = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from material_document_line where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(Number(documents[0]?.n)).toBe(0);
    const attempts = await withTenant(client, (tx) => tx.execute(sql`
      select status, prior_active, requested_active from batch_status_plant_conversion where client = ${client}
    `)) as unknown as Array<{ status: string; prior_active: string; requested_active: string }>;
    expect(attempts[0]?.status).toBe('BLOCKED');
    expect(attempts[0]?.requested_active).toBe('X');
    const shown = await listPlantStatusConversions(client, '1000');
    expect(shown[0]?.status).toBe('BLOCKED');
    expect(shown[0]?.requestedActive).toBe('X');
    expect(shown[0]?.errorSummary).toMatch(/341/);
    const history = await withTenant(client, (tx) => tx.execute(sql`
      select change_type from change_document
      where client = ${client} and object_class = 'batch_status_plant' and object_key = '1000'
    `)) as unknown as Array<{ change_type: string }>;
    expect(history.map((row) => row.change_type)).toContain('BLOCK');
  });

  it('applies status only in a selected plant, and a goods movement does not create a batch', async () => {
    const client = await tenant('omcu-pack-7');
    await plantLevel(client);
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '1100', 'Second plant', '1000', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
        values (${client}, 'MAT-OMCU', 'OMCU material', 'RAW', 'PC', true, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, batch_managed, created_by)
        values (${client}, 'MAT-OMCU', '1000', true, ${ACTOR}),
               (${client}, 'MAT-OMCU', '1100', true, ${ACTOR})
      `);
    });
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-OMCU', plant: '1000', batchNumber: 'B1', restrictedUse: 'X', reason: 'Too soon',
    })).rejects.toMatchObject({ code: 'STATUS_NOT_ACTIVE' });
    const plain = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-OMCU', plant: '1000', batchNumber: 'B1', reason: 'No status',
    });
    expect(plain.restrictedUse).toBeNull();
    const resolved = await withTenant(client, (tx) => resolvePostingBatch(tx, {
      client, materialNumber: 'MAT-OMCU', plant: '1000', batch: 'B1', postingDate: '2026-10-18',
    }));
    expect(resolved).toBe('B1');

    await savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1100', statusActive: 'X', version: 0, confirmed: true, reason: 'Select the empty plant',
    });
    const restricted = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-OMCU', plant: '1100', batchNumber: 'B2', restrictedUse: 'X', reason: 'Restricted',
    });
    expect(restricted.restrictedUse).toBe('X');
    await expect(withTenant(client, (tx) => resolvePostingBatch(tx, {
      client, materialNumber: 'MAT-OMCU', plant: '1100', batch: 'B2', postingDate: '2026-10-18',
    }))).rejects.toThrow(/restricted/);
    await expect(savePlantBatchStatus({
      client, changedBy: ACTOR, capabilities: AUTH, plant: '1100', statusActive: '', version: 1, confirmed: true, reason: 'Clear it',
    })).rejects.toMatchObject({ code: 'CONVERSION_BLOCKED' });
    expect((await rows(client)).find((row) => row.plant === '1100')?.status_active).toBe('X');
    const receipt = readFileSync('src/modules/inventory/goods-receipt.ts', 'utf8');
    expect(receipt).not.toMatch(/createBatch|BATCH_CLT/);
  });

  it('does not show another tenant a plant selection', async () => {
    const left = await tenant('omcu-pack-8');
    const right = await tenant('omcu-pack-11');
    await plantLevel(left);
    await plantLevel(right);
    await savePlantBatchStatus({
      client: left, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: 'X', version: 0, confirmed: true, reason: 'Left only',
    });
    expect((await listPlantBatchStatus(right)).plants.every((row) => row.statusActive === null)).toBe(true);
    await expect(savePlantBatchStatus({
      client: right, changedBy: ACTOR, capabilities: AUTH, plant: '1000', statusActive: 'X', version: 1, confirmed: true, reason: 'Wrong version',
    })).rejects.toMatchObject({ code: 'VERSION_STALE' });
    expect(await rows(left)).toHaveLength(1);
    expect(await rows(right)).toEqual([]);
  });

  it('names OMCU in the manual and does not seed a plant selection', () => {
    const manual = readFileSync('onboarding-manual.md', 'utf8');
    expect(manual).toMatch(/CFG\.INV\.BATCHSTATUSPLANT\.DEFINE/);
    expect(manual).toMatch(/\/config\/batch-status-plants/);
    expect(manual).toMatch(/Opening the screen does not select one/);
    const migration = readFileSync('drizzle/9126_omcu_batch_status_plant.sql', 'utf8');
    expect(migration).not.toMatch(/insert into batch_status_plant\b/i);
  });
});
