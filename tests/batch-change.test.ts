import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { saveBatchStatus } from '../src/modules/inventory/batch-status';
import { createBatch } from '../src/modules/inventory/batch-master';
import { changeBatch, readBatch } from '../src/modules/inventory/batch-change';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'MSC2N_TEST';
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

async function plantView(client: string, materialNumber: string, plant: string) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into material_plant (client, material_number, plant, batch_managed, created_by)
    values (${client}, ${materialNumber}, ${plant}, true, ${ACTOR})
    on conflict (client, material_number, plant) do update set batch_managed = true
  `));
}

describe('MSC2N change batch', () => {
  it('changes attributes without regenerating the number or posting stock', async () => {
    const client = await tenant('msc2n-change');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await material(client, 'MAT-A');
    const created = await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: '00012', reason: 'Create',
      manufactureDate: '2026-04-30', vendorBatch: 'OLD-LOT', countryOfOrigin: 'KW',
    });
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from stock_quantity where client = ${client}) as stock,
        (select count(*)::int from journal_entry where client = ${client}) as journals
    `)) as unknown as Array<{ stock: number; journals: number }>;
    const changed = await changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: '00012', expectedVersion: 1, reason: 'Correct dates',
      manufactureDate: '2026-05-01', shelfLifeExpirationDate: '2026-01-01', vendorBatch: 'NEW-LOT', countryOfOrigin: 'IN',
    });
    expect(changed.changed).toBe(true);
    expect(changed.batchNumber).toBe('00012');
    expect(changed.version).toBe(2);
    expect(changed.shelfLifeExpirationDate).toBe('2026-01-01');
    expect(changed.vendorBatch).toBe('NEW-LOT');
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
    const change = history.find((row) => row.changeType === 'CHANGE');
    expect(change?.transactionCode).toBe('MSC2N');
    expect(change?.items.find((item) => item.fieldName === 'vendorBatch')).toMatchObject({
      oldValue: 'OLD-LOT', newValue: 'NEW-LOT',
    });
  });

  it('keeps plant identity separate and refuses a missing batch', async () => {
    const client = await tenant('msc2n-plant');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    await material(client, 'MAT-A');
    await withTenant(client, (tx) => tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      values (${client}, '2000', 'Plant 2000', 'KW', ${ACTOR})
      on conflict do nothing
    `));
    await plantView(client, 'MAT-A', '1000');
    await plantView(client, 'MAT-A', '2000');
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '1000', batchNumber: 'B1', reason: 'Plant one' });
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '2000', batchNumber: 'B1', reason: 'Plant two' });
    await changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '1000', batchNumber: 'B1', expectedVersion: 1, reason: 'Plant one only',
      vendorBatch: 'P1000',
    });
    const other = await readBatch({ client, materialNumber: 'MAT-A', plant: '2000', batchNumber: 'B1' });
    expect(other?.vendorBatch).toBeNull();
    await expect(changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', expectedVersion: 1, reason: 'Missing plant',
    })).rejects.toMatchObject({ code: 'PLANT_REQUIRED' });
    await expect(changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '1000', batchNumber: 'MISSING', expectedVersion: 1, reason: 'Missing batch',
    })).rejects.toMatchObject({ code: 'BATCH_UNKNOWN' });
  });

  it('refuses identity changes, deletion, classification, and a bad status', async () => {
    const client = await tenant('msc2n-refuse');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Level' });
    await saveBatchStatus({ client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate status' });
    await material(client, 'MAT-A');
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', reason: 'Create' });
    await expect(changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', expectedVersion: 1, newBatchNumber: 'B2', reason: 'Rename',
    })).rejects.toMatchObject({ code: 'IDENTITY_REFUSED' });
    await expect(changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', expectedVersion: 1, internalNumbering: true, reason: 'Number',
    })).rejects.toMatchObject({ code: 'NUMBERING_REFUSED' });
    await expect(changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', expectedVersion: 1, deleteBatch: true, reason: 'Delete',
    })).rejects.toMatchObject({ code: 'DELETE_REFUSED' });
    await expect(changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', expectedVersion: 1, classification: true, reason: 'Class',
    })).rejects.toMatchObject({ code: 'CLASSIFICATION_REFUSED' });
    await expect(changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', expectedVersion: 1, companyCode: '1000', reason: 'Company',
    })).rejects.toMatchObject({ code: 'COMPANY_REFUSED' });
    await expect(changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', expectedVersion: 1, restrictedUse: '2', reason: 'Numeric',
    })).rejects.toMatchObject({ code: 'STATUS_UNKNOWN' });
    const stored = await withTenant(client, (tx) => tx.execute(sql`
      select batch_number, version from batch where client = ${client} and batch_number = 'B1'
    `)) as unknown as Array<{ batch_number: string; version: number }>;
    expect(stored[0]?.batch_number).toBe('B1');
    expect(Number(stored[0]?.version)).toBe(1);
  });

  it('stores X or blank only when status management is effective, and a stale version loses', async () => {
    const client = await tenant('msc2n-status');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Level' });
    await material(client, 'MAT-A');
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', reason: 'Create' });
    await expect(changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', expectedVersion: 1, restrictedUse: 'X', reason: 'Status off',
    })).rejects.toMatchObject({ code: 'STATUS_NOT_ACTIVE' });

    const active = await tenant('msc2n-status-on');
    await saveBatchLevel({ client: active, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Level' });
    await saveBatchStatus({ client: active, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate status' });
    await material(active, 'MAT-A');
    await createBatch({ client: active, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', reason: 'Create' });
    const restricted = await changeBatch({
      client: active, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', expectedVersion: 1, restrictedUse: 'X', reason: 'Restrict',
    });
    expect(restricted.restrictedUse).toBe('X');
    const unrestricted = await changeBatch({
      client: active, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', expectedVersion: 2, restrictedUse: '', reason: 'Clear',
    });
    expect(unrestricted.restrictedUse).toBe('');
    const stored = await withTenant(active, (tx) => tx.execute(sql`
      select restricted_use from batch where client = ${active} and batch_number = 'S1'
    `)) as unknown as Array<{ restricted_use: string }>;
    expect(stored[0]?.restricted_use).toBe(' ');
    await expect(changeBatch({
      client: active, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', expectedVersion: 2, vendorBatch: 'LATE', reason: 'Stale',
    })).rejects.toMatchObject({ code: 'VERSION_STALE' });
    const untouched = await changeBatch({
      client: active, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', expectedVersion: 3, vendorBatch: '', reason: 'No change',
    });
    expect(untouched.changed).toBe(false);
    expect(untouched.version).toBe(3);
  });

  it('lets one concurrent change lose, and hides the batch from another client', async () => {
    const client = await tenant('msc2n-race');
    const other = await tenant('msc2n-other');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Level' });
    await material(client, 'MAT-A');
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'RACE', reason: 'Create' });
    const results = await Promise.allSettled([
      changeBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'RACE', expectedVersion: 1, vendorBatch: 'ONE', reason: 'One' }),
      changeBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'RACE', expectedVersion: 1, vendorBatch: 'TWO', reason: 'Two' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await saveBatchLevel({ client: other, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Other level' });
    const leaked = await readBatch({ client: other, materialNumber: 'MAT-A', batchNumber: 'RACE' });
    expect(leaked).toBeNull();
    const hidden = await withTenant(other, (tx) => tx.execute(sql`
      select batch_number from batch where client = ${client}
    `)) as unknown as Array<{ batch_number: string }>;
    expect(hidden).toHaveLength(0);
  });
});
