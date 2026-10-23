import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { saveBatchStatus } from '../src/modules/inventory/batch-status';
import { createBatch } from '../src/modules/inventory/batch-master';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'MSC1N_TEST';
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

async function material(client: string, materialNumber: string, batchManaged = false) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
    values (${client}, ${materialNumber}, ${materialNumber}, 'RAW', 'PC', ${batchManaged}, ${ACTOR})
    on conflict (client, material_number) do update set batch_managed = excluded.batch_managed
  `));
}

async function plantView(client: string, materialNumber: string, plant: string, batchManaged: boolean) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into material_plant (client, material_number, plant, batch_managed, created_by)
    values (${client}, ${materialNumber}, ${plant}, ${batchManaged}, ${ACTOR})
    on conflict (client, material_number, plant) do update set batch_managed = excluded.batch_managed
  `));
}

describe('MSC1N create batch', () => {
  it('refuses a material that is not batch-managed and does not post stock', async () => {
    const client = await tenant('msc1n-eligibility');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await material(client, 'MAT-A', false);
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: '00012', reason: 'Should refuse',
    })).rejects.toMatchObject({ code: 'MATERIAL_NOT_BATCH' });
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MISSING', batchNumber: '00012', reason: 'Missing material',
    })).rejects.toMatchObject({ code: 'MATERIAL_UNKNOWN' });

    await material(client, 'MAT-A', true);
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from stock_quantity where client = ${client}) as stock,
        (select count(*)::int from journal_entry where client = ${client}) as journals
    `)) as unknown as Array<{ stock: number; journals: number }>;
    const created = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: '00012', reason: 'External number',
      manufactureDate: '2026-04-30', shelfLifeExpirationDate: '2026-01-01', vendorBatch: 'VEND-LOT-9988', countryOfOrigin: 'KW',
    });
    expect(created.batchNumber).toBe('00012');
    expect(created.plant).toBeNull();
    expect(created.statusApplies).toBe(false);
    expect(created.shelfLifeExpirationDate).toBe('2026-01-01');
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from stock_quantity where client = ${client}) as stock,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select batch_number from batch where client = ${client} and id = ${created.id}) as batch_number
    `)) as unknown as Array<{ stock: number; journals: number; batch_number: string }>;
    expect(Number(after[0]?.stock)).toBe(Number(before[0]?.stock));
    expect(Number(after[0]?.journals)).toBe(Number(before[0]?.journals));
    expect(after[0]?.batch_number).toBe('00012');
    const history = await withTenant(client, (tx) => changeHistory(tx, client, 'batch', created.id));
    expect(history.map((row) => row.changeType)).toContain('CREATE');
  });

  it('keeps plant identity only at plant level, and client identity across materials', async () => {
    const plantClient = await tenant('msc1n-plant');
    await saveBatchLevel({ client: plantClient, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    await material(plantClient, 'MAT-A', false);
    await withTenant(plantClient, (tx) => tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      values (${plantClient}, '2000', 'Plant 2000', 'KW', ${ACTOR})
      on conflict do nothing
    `));
    await plantView(plantClient, 'MAT-A', '1000', true);
    await plantView(plantClient, 'MAT-A', '2000', true);
    await expect(createBatch({
      client: plantClient, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', reason: 'Missing plant',
    })).rejects.toMatchObject({ code: 'PLANT_REQUIRED' });
    await createBatch({
      client: plantClient, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '1000', batchNumber: 'B1', reason: 'Plant one',
    });
    await createBatch({
      client: plantClient, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '2000', batchNumber: 'B1', reason: 'Plant two',
    });
    await expect(createBatch({
      client: plantClient, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '1000', batchNumber: 'B1', reason: 'Duplicate',
    })).rejects.toMatchObject({ code: 'BATCH_DUPLICATE' });

    const clientLevel = await tenant('msc1n-client');
    await saveBatchLevel({ client: clientLevel, changedBy: ACTOR, batchLevel: '2', version: 0, reason: 'Client level' });
    await material(clientLevel, 'MAT-A', true);
    await material(clientLevel, 'MAT-B', true);
    await createBatch({
      client: clientLevel, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'ONCE', reason: 'First material',
    });
    await expect(createBatch({
      client: clientLevel, changedBy: ACTOR, materialNumber: 'MAT-B', batchNumber: 'ONCE', reason: 'Second material',
    })).rejects.toMatchObject({ code: 'BATCH_DUPLICATE' });
    await expect(createBatch({
      client: clientLevel, changedBy: ACTOR, materialNumber: 'MAT-B', plant: '1000', batchNumber: 'OTHER', reason: 'Plant sent',
    })).rejects.toMatchObject({ code: 'PLANT_NOT_ALLOWED' });
  });

  it('stores X or blank for status, and refuses 1 and 2', async () => {
    const client = await tenant('msc1n-status');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Level' });
    await saveBatchStatus({ client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate status' });
    await material(client, 'MAT-A', true);
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', restrictedUse: '1', reason: 'Numeric status',
    })).rejects.toMatchObject({ code: 'STATUS_UNKNOWN' });
    const unrestricted = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', reason: 'Derived initial status',
    });
    expect(unrestricted.statusApplies).toBe(true);
    expect(unrestricted.restrictedUse).toBeNull();
    const stored = await withTenant(client, (tx) => tx.execute(sql`
      select restricted_use from batch where client = ${client} and batch_number = 'S1'
    `)) as unknown as Array<{ restricted_use: string }>;
    expect(stored[0]?.restricted_use).toBe(' ');

    await withTenant(client, (tx) => tx.execute(sql`
      update material_type set initial_batch_restricted = true
      where client = ${client} and material_type = 'RAW'
    `));
    const restricted = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S2', reason: 'Type initial status',
    });
    expect(restricted.restrictedUse).toBe('X');
  });

  it('refuses internal numbering, classification, a bad country, and a long vendor batch', async () => {
    const client = await tenant('msc1n-refuse');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Level' });
    await material(client, 'MAT-A', true);
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', reason: 'No number',
    })).rejects.toThrow(/OMCZ/);
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', internalNumbering: true, reason: 'Internal',
    })).rejects.toMatchObject({ code: 'NUMBERING_REFUSED' });
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', classification: true, reason: 'Class',
    })).rejects.toMatchObject({ code: 'CLASSIFICATION_REFUSED' });
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', countryOfOrigin: 'ZZ', reason: 'Country',
    })).rejects.toMatchObject({ code: 'COUNTRY_UNKNOWN' });
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', vendorBatch: '1234567890123456', reason: 'Vendor',
    })).rejects.toMatchObject({ code: 'VENDOR_BATCH' });
    await expect(createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', restrictedUse: 'X', reason: 'Status off',
    })).rejects.toMatchObject({ code: 'STATUS_NOT_ACTIVE' });
  });

  it('lets one duplicate lose, and hides the batch from another client', async () => {
    const client = await tenant('msc1n-race');
    const other = await tenant('msc1n-other');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Level' });
    await material(client, 'MAT-A', true);
    const results = await Promise.allSettled([
      createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'RACE', reason: 'One' }),
      createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'RACE', reason: 'Two' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const leaked = await withTenant(other, (tx) => tx.execute(sql`
      select batch_number from batch where client = ${client}
    `)) as unknown as Array<{ batch_number: string }>;
    expect(leaked).toHaveLength(0);
  });
});
