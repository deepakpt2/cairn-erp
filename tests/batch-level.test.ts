import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import {
  BatchLevelError,
  createBatchIdentity,
  executeBatchLevelConversion,
  getBatchLevel,
  prepareBatchLevelConversion,
  saveBatchLevel,
} from '../src/modules/inventory/batch-level';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCE_TEST';
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

describe('OMCE batch level', () => {
  it('does not invent a plant level when none is saved', async () => {
    const client = await tenant('omce-unset');
    expect(await getBatchLevel(client)).toBeNull();
  });

  it('stores the SAP character codes and does not consult a posting period', async () => {
    const client = await tenant('omce-codes');
    await withTenant(client, (tx) => tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, 'CFG.INV.BATCHLEVEL.DEFINE', 'NOT_STARTED', ${ACTOR})
      on conflict do nothing
    `));
    const saved = await saveBatchLevel({
      client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant identity', requestKey: 'req-0',
    });
    expect(saved.batchLevel).toBe('0');
    expect(saved.name).toBe('Plant level');
    expect(saved.version).toBe(1);

    const stored = await withTenant(client, (tx) => tx.execute(sql`
      select batch_level, pg_typeof(batch_level) as stored_type
      from batch_level_configuration where client = ${client}
    `)) as unknown as Array<{ batch_level: string; stored_type: string }>;
    expect(stored[0]?.batch_level).toBe('0');
    expect(stored[0]?.stored_type).toBe('character');

    const periods = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from material_period_control where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(Number(periods[0]?.n)).toBe(0);
    const journals = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(Number(journals[0]?.n)).toBe(0);

    const history = await withTenant(client, (tx) => changeHistory(tx, client, 'batch_level', client));
    expect(history.map((row) => row.changeType)).toContain('CREATE');
    const status = await withTenant(client, (tx) => tx.execute(sql`
      select status from config_activity_status
      where client = ${client} and activity_code = 'CFG.INV.BATCHLEVEL.DEFINE'
    `)) as unknown as Array<{ status: string }>;
    expect(status[0]?.status).toBe('COMPLETED');

    const materialLevel = await saveBatchLevel({
      client, changedBy: ACTOR, batchLevel: '1', version: 1, reason: 'Material identity',
    });
    expect(materialLevel.batchLevel).toBe('1');
    expect(materialLevel.version).toBe(2);
    const clientLevel = await saveBatchLevel({
      client, changedBy: ACTOR, batchLevel: '2', version: 2, reason: 'Client identity',
    });
    expect(clientLevel.batchLevel).toBe('2');
    expect(clientLevel.version).toBe(3);
  });

  it('refuses a stale version, a repeated request, and the named extras without changing the row', async () => {
    const client = await tenant('omce-refuse');
    await saveBatchLevel({
      client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Initial plant level', requestKey: 'once',
    });
    const same = await saveBatchLevel({
      client, changedBy: ACTOR, batchLevel: '0', version: 9, reason: 'Same level',
    });
    expect(same.version).toBe(1);

    await expect(saveBatchLevel({
      client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Stale open',
    })).rejects.toMatchObject({ code: 'VERSION_STALE' });

    await expect(saveBatchLevel({
      client, changedBy: ACTOR, batchLevel: '1', version: 1, reason: 'Replay', requestKey: 'once',
    })).rejects.toMatchObject({ code: 'REQUEST_REPLAY' });

    const refused = [
      { transportRequest: 'DEVK900001', code: 'TRANSPORT_REFUSED', named: /transport/i },
      { approval: 'REQUIRED', code: 'APPROVAL_REFUSED', named: /approval/i },
      { postingPeriod: '10', code: 'PERIOD_REFUSED', named: /OB52/ },
      { companyCode: '1000', code: 'COMPANY_REFUSED', named: /company code/i },
      { batchStatusManagement: true, code: 'STATUS_REFUSED', named: /OMCS/ },
      { internalNumbering: true, code: 'NUMBERING_REFUSED', named: /OMCZ/ },
      { batchNumberRange: '01', code: 'RANGE_REFUSED', named: /OMAD/ },
    ] as const;
    for (const extra of refused) {
      const { code, named, ...fields } = extra;
      await expect(saveBatchLevel({
        client, changedBy: ACTOR, batchLevel: '1', version: 1, reason: 'Must not save', ...fields,
      })).rejects.toMatchObject({ code });
      await expect(saveBatchLevel({
        client, changedBy: ACTOR, batchLevel: '1', version: 1, reason: 'Must not save', ...fields,
      })).rejects.toThrow(named);
    }
    expect((await getBatchLevel(client))?.batchLevel).toBe('0');
    await expect(saveBatchLevel({
      client, changedBy: ACTOR, batchLevel: 'plant', version: 1, reason: 'Label is not the code',
    })).rejects.toMatchObject({ code: 'LEVEL_UNKNOWN' });
  });

  it('enforces plant, material, and client uniqueness, and keeps leading zeros', async () => {
    const plantClient = await tenant('omce-plant');
    await saveBatchLevel({ client: plantClient, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    await material(plantClient, 'MAT-A');
    await material(plantClient, 'MAT-B');
    await plant(plantClient, '2000');
    const first = await createBatchIdentity({
      client: plantClient, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: '00012', plant: '1000',
    });
    expect(first.batchNumber).toBe('00012');
    await expect(createBatchIdentity({
      client: plantClient, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: '00012', plant: '1000',
    })).rejects.toMatchObject({ code: 'BATCH_DUPLICATE' });
    await createBatchIdentity({
      client: plantClient, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: '00012', plant: '2000',
    });
    await createBatchIdentity({
      client: plantClient, changedBy: ACTOR, materialNumber: 'MAT-B', batchNumber: '00012', plant: '1000',
    });
    const stored = await withTenant(plantClient, (tx) => tx.execute(sql`
      select batch_number from batch
      where client = ${plantClient} and material_number = 'MAT-A' and plant = '1000'
    `)) as unknown as Array<{ batch_number: string }>;
    expect(stored[0]?.batch_number).toBe('00012');

    const materialClient = await tenant('omce-material');
    await saveBatchLevel({ client: materialClient, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await material(materialClient, 'MAT-A');
    await material(materialClient, 'MAT-B');
    await createBatchIdentity({
      client: materialClient, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1',
    });
    await expect(createBatchIdentity({
      client: materialClient, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1', plant: '1000',
    })).rejects.toMatchObject({ code: 'PLANT_NOT_ALLOWED' });
    await expect(createBatchIdentity({
      client: materialClient, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'B1',
    })).rejects.toMatchObject({ code: 'BATCH_DUPLICATE' });
    await createBatchIdentity({
      client: materialClient, changedBy: ACTOR, materialNumber: 'MAT-B', batchNumber: 'B1',
    });

    const clientLevel = await tenant('omce-client');
    await saveBatchLevel({ client: clientLevel, changedBy: ACTOR, batchLevel: '2', version: 0, reason: 'Client level' });
    await material(clientLevel, 'MAT-A');
    await material(clientLevel, 'MAT-B');
    await createBatchIdentity({
      client: clientLevel, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'ONCE',
    });
    await expect(createBatchIdentity({
      client: clientLevel, changedBy: ACTOR, materialNumber: 'MAT-B', batchNumber: 'ONCE',
    })).rejects.toMatchObject({ code: 'BATCH_DUPLICATE' });
  });

  it('does not edit the level when a batch stands, and does not run a conversion', async () => {
    const client = await tenant('omce-blocked');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Before batches' });
    await material(client, 'MAT-A');
    await createBatchIdentity({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'LIVE', plant: '1000',
    });
    await expect(saveBatchLevel({
      client, changedBy: ACTOR, batchLevel: '2', version: 1, reason: 'Must not rewrite identity',
    })).rejects.toThrow(/Live conversion is not available/);
    expect((await getBatchLevel(client))?.batchLevel).toBe('0');

    const attempt = await prepareBatchLevelConversion({
      client, changedBy: ACTOR, targetLevel: '2', version: 1, reason: 'Read the impact',
    });
    expect(attempt.status).toBe('BLOCKED');
    expect(attempt.counts.batchCount).toBe(1);
    // `bba671d` gave stock and material documents a batch column of their own, so the refusal
    // can no longer be the missing column this case was written against: the impact counts the
    // rows that carry a batch and says, in the same words the operator reads, that a level edit
    // does not convert them. The point of the case — a standing batch blocks the level and no
    // conversion runs — is asserted below and above this line, not by the column flags.
    expect(attempt.counts.stockColumnPresent).toBe(true);
    expect(attempt.counts.documentColumnPresent).toBe(true);
    expect(attempt.errorSummary).toMatch(/stock rows? with a batch/);
    expect(attempt.errorSummary).toMatch(/material-document lines? with a batch/);
    expect(attempt.errorSummary).toMatch(/Live conversion is not available/);
    expect((await getBatchLevel(client))?.version).toBe(1);

    await expect(executeBatchLevelConversion()).rejects.toBeInstanceOf(BatchLevelError);
    await expect(executeBatchLevelConversion()).rejects.toThrow(/was not changed/);
  });

  it('lets one duplicate lose, and hides the row from another client', async () => {
    const client = await tenant('omce-race');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Race level' });
    await material(client, 'MAT-A');
    const results = await Promise.allSettled([
      createBatchIdentity({ client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'RACE' }),
      createBatchIdentity({ client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'RACE' }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'BATCH_DUPLICATE' });

    const other = await tenant('omce-other');
    await saveBatchLevel({ client: other, changedBy: ACTOR, batchLevel: '2', version: 0, reason: 'Other client' });
    const leaked = await withTenant(other, (tx) => tx.execute(sql`
      select batch_level from batch_level_configuration where client = ${client}
    `)) as unknown as Array<{ batch_level: string }>;
    expect(leaked).toHaveLength(0);
    expect((await getBatchLevel(other))?.batchLevel).toBe('2');
    expect((await getBatchLevel(client))?.batchLevel).toBe('1');
  });
});
