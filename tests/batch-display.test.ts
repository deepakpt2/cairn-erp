import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { saveBatchStatus } from '../src/modules/inventory/batch-status';
import { createBatch } from '../src/modules/inventory/batch-master';
import { changeBatch } from '../src/modules/inventory/batch-change';
import { batchStatusLabel, displayBatch } from '../src/modules/inventory/batch-display';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'MSC3N_TEST';
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

describe('MSC3N display batch', () => {
  it('reads the standing batch and writes nothing', async () => {
    const client = await tenant('msc3n-read');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await material(client, 'MAT-A');
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: '00012', reason: 'Create',
      manufactureDate: '2026-04-30', shelfLifeExpirationDate: '2026-01-01', vendorBatch: 'VEND-LOT-9988', countryOfOrigin: 'KW',
    });
    const before = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from stock_quantity where client = ${client}) as stock,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from change_document where client = ${client} and object_class = 'batch') as changes,
        (select version from batch where client = ${client} and batch_number = '00012') as version
    `)) as unknown as Array<{ stock: number; journals: number; changes: number; version: number }>;
    const shown = await displayBatch({ client, materialNumber: 'MAT-A', batchNumber: '00012' });
    expect(shown?.batchNumber).toBe('00012');
    expect(shown?.manufactureDate).toBe('2026-04-30');
    expect(shown?.shelfLifeExpirationDate).toBe('2026-01-01');
    expect(shown?.vendorBatch).toBe('VEND-LOT-9988');
    expect(shown?.countryOfOrigin).toBe('KW');
    expect(shown?.statusLabel).not.toMatch(/1 = Unrestricted|2 = Restricted|HERDT/);
    expect(shown?.deletionStored).toBe(false);
    expect(shown?.classificationStored).toBe(false);
    expect(shown?.history.map((row) => row.changeType)).toContain('CREATE');
    const again = await displayBatch({ client, materialNumber: 'MAT-A', batchNumber: '00012' });
    const after = await withTenant(client, (tx) => tx.execute(sql`
      select
        (select count(*)::int from stock_quantity where client = ${client}) as stock,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select count(*)::int from change_document where client = ${client} and object_class = 'batch') as changes,
        (select version from batch where client = ${client} and batch_number = '00012') as version
    `)) as unknown as Array<{ stock: number; journals: number; changes: number; version: number }>;
    expect(Number(after[0]?.stock)).toBe(Number(before[0]?.stock));
    expect(Number(after[0]?.journals)).toBe(Number(before[0]?.journals));
    expect(Number(after[0]?.changes)).toBe(Number(before[0]?.changes));
    expect(Number(after[0]?.version)).toBe(Number(before[0]?.version));
    expect(again?.version).toBe(shown?.version);
  });

  it('keeps plant identity and does not show another client', async () => {
    const client = await tenant('msc3n-plant');
    const other = await tenant('msc3n-other');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    await saveBatchLevel({ client: other, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Other level' });
    await material(client, 'MAT-A');
    await withTenant(client, (tx) => tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      values (${client}, '2000', 'Plant 2000', 'KW', ${ACTOR})
      on conflict do nothing
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      insert into material_plant (client, material_number, plant, batch_managed, created_by)
      values (${client}, 'MAT-A', '1000', true, ${ACTOR}), (${client}, 'MAT-A', '2000', true, ${ACTOR})
      on conflict (client, material_number, plant) do update set batch_managed = true
    `));
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '1000', batchNumber: 'B1', reason: 'One', vendorBatch: 'P1000' });
    await createBatch({ client, changedBy: ACTOR, materialNumber: 'MAT-A', plant: '2000', batchNumber: 'B1', reason: 'Two', vendorBatch: 'P2000' });
    const first = await displayBatch({ client, materialNumber: 'MAT-A', plant: '1000', batchNumber: 'B1' });
    const second = await displayBatch({ client, materialNumber: 'MAT-A', plant: '2000', batchNumber: 'B1' });
    expect(first?.vendorBatch).toBe('P1000');
    expect(second?.vendorBatch).toBe('P2000');
    await expect(displayBatch({ client, materialNumber: 'MAT-A', batchNumber: 'B1' })).rejects.toMatchObject({ code: 'PLANT_REQUIRED' });
    expect(await displayBatch({ client: other, materialNumber: 'MAT-A', batchNumber: 'B1' })).toBeNull();
    await expect(displayBatch({
      client, materialNumber: 'MAT-A', plant: '1000', batchNumber: 'B1', companyCode: '1000',
    })).rejects.toMatchObject({ code: 'COMPANY_REFUSED' });
  });

  it('shows X or blank, and a change document, without treating status as 1 or 2', async () => {
    const client = await tenant('msc3n-status');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Level' });
    await saveBatchStatus({ client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate status' });
    await material(client, 'MAT-A');
    await createBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', restrictedUse: 'X', reason: 'Restricted',
    });
    const restricted = await displayBatch({ client, materialNumber: 'MAT-A', batchNumber: 'S1' });
    expect(restricted?.statusLabel).toBe('X — restricted. Not the number 2.');
    expect(restricted?.statusLabel).not.toContain('1 =');
    await changeBatch({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'S1', expectedVersion: 1, restrictedUse: '', reason: 'Clear status',
    });
    const unrestricted = await displayBatch({ client, materialNumber: 'MAT-A', batchNumber: 'S1' });
    expect(unrestricted?.statusLabel).toBe('Blank — unrestricted. Not the number 1.');
    expect(unrestricted?.statusLabel).not.toContain('2 =');
    expect(unrestricted?.history.map((row) => row.transactionCode)).toContain('MSC2N');
    expect(await displayBatch({ client, materialNumber: 'MAT-A', batchNumber: 'MISSING' })).toBeNull();
  });
});
