import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import { createBatchIdentity, getBatchLevel, saveBatchLevel } from '../src/modules/inventory/batch-level';
import {
  BatchStatusError,
  batchStatusScope,
  executeBatchStatusConversion,
  getBatchStatusManagement,
  saveBatchStatus,
} from '../src/modules/inventory/batch-status';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMCS_TEST';
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

describe('OMCS batch status management', () => {
  it('is not active until saved, and does not invent a plant selection', () => {
    expect(batchStatusScope({ batchLevel: '1', active: false }).scope).toBe('INACTIVE');
    expect(batchStatusScope({ batchLevel: '0', active: true }).scope).toBe('PLANT_NOT_SELECTED');
    expect(batchStatusScope({ batchLevel: '0', active: true, plantSelected: true }).scope).toBe('PLANT');
    expect(batchStatusScope({ batchLevel: '2', active: true }).effective).toBe(true);
    expect(batchStatusScope({ batchLevel: null, active: true }).scope).toBe('LEVEL_MISSING');
  });

  it('stores the SAP character and does not consult a posting period', async () => {
    const client = await tenant('omcs-codes');
    expect((await getBatchStatusManagement(client)).statusManagement).toBeNull();
    await expect(saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Too early',
    })).rejects.toMatchObject({ code: 'LEVEL_REQUIRED' });

    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await withTenant(client, (tx) => tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, 'CFG.INV.BATCHSTATUS.DEFINE', 'NOT_STARTED', ${ACTOR})
      on conflict do nothing
    `));
    const saved = await saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate status', requestKey: 'req-1',
    });
    expect(saved.statusManagement).toBe('1');
    expect(saved.version).toBe(1);
    expect(saved.batchLevel).toBe('1');
    expect(saved.scope.scope).toBe('ALL_PLANTS');
    expect(saved.scope.effective).toBe(true);

    const stored = await withTenant(client, (tx) => tx.execute(sql`
      select status_management, pg_typeof(status_management) as stored_type
      from batch_status_management where client = ${client}
    `)) as unknown as Array<{ status_management: string; stored_type: string }>;
    expect(stored[0]?.status_management).toBe('1');
    expect(stored[0]?.stored_type).toBe('character');
    expect((await getBatchLevel(client))?.batchLevel).toBe('1');

    const periods = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from material_period_control where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(Number(periods[0]?.n)).toBe(0);
    const journals = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${client}
    `)) as unknown as Array<{ n: number }>;
    expect(Number(journals[0]?.n)).toBe(0);
    const history = await withTenant(client, (tx) => changeHistory(tx, client, 'batch_status_management', client));
    expect(history.map((row) => row.changeType)).toContain('CREATE');

    const off = await saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: '', version: 1, reason: 'Turn it off',
    });
    expect(off.statusManagement).toBeNull();
    expect(off.version).toBe(2);
    const blank = await withTenant(client, (tx) => tx.execute(sql`
      select status_management from batch_status_management where client = ${client}
    `)) as unknown as Array<{ status_management: string }>;
    expect(blank[0]?.status_management).toBe(' ');
  });

  it('applies in every plant only at material or client level', async () => {
    const plantClient = await tenant('omcs-plant');
    await saveBatchLevel({ client: plantClient, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    const plantStatus = await saveBatchStatus({
      client: plantClient, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate at plant level',
    });
    expect(plantStatus.scope.scope).toBe('PLANT_NOT_SELECTED');
    expect(plantStatus.scope.effective).toBe(false);
    expect(plantStatus.scope.explanation).toMatch(/OMCU/);

    const clientLevel = await tenant('omcs-client');
    await saveBatchLevel({ client: clientLevel, changedBy: ACTOR, batchLevel: '2', version: 0, reason: 'Client level' });
    const clientStatus = await saveBatchStatus({
      client: clientLevel, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate at client level',
    });
    expect(clientStatus.scope.scope).toBe('ALL_PLANTS');
    expect(clientStatus.scope.explanation).toMatch(/every plant/);
  });

  it('refuses a stale version, a repeated request, and the named extras', async () => {
    const client = await tenant('omcs-refuse');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Level first' });
    await saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Initial active', requestKey: 'once',
    });
    const same = await saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: '1', version: 9, reason: 'Same indicator',
    });
    expect(same.version).toBe(1);

    await expect(saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: '', version: 0, reason: 'Stale open',
    })).rejects.toMatchObject({ code: 'VERSION_STALE' });
    await expect(saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: '', version: 1, reason: 'Replay', requestKey: 'once',
    })).rejects.toMatchObject({ code: 'REQUEST_REPLAY' });

    const refused = [
      { transportRequest: 'DEVK900001', code: 'TRANSPORT_REFUSED', named: /transport/i },
      { approval: 'REQUIRED', code: 'APPROVAL_REFUSED', named: /approval/i },
      { postingPeriod: '10', code: 'PERIOD_REFUSED', named: /OB52/ },
      { companyCode: '1000', code: 'COMPANY_REFUSED', named: /company code/i },
      { batchLevel: '2', code: 'LEVEL_REFUSED', named: /OMCE/ },
      { plant: '1000', code: 'PLANT_REFUSED', named: /OMCU/ },
      { initialStatus: 'RESTRICTED', code: 'INITIAL_STATUS_REFUSED', named: /OMAB/ },
      { classification: true, code: 'CLASSIFICATION_REFUSED', named: /classif/i },
      { internalNumbering: true, code: 'NUMBERING_REFUSED', named: /OMCZ/ },
      { batchNumberRange: '01', code: 'RANGE_REFUSED', named: /OMAD/ },
    ] as const;
    for (const extra of refused) {
      const { code, named, ...fields } = extra;
      await expect(saveBatchStatus({
        client, changedBy: ACTOR, statusManagement: '', version: 1, reason: 'Must not save', ...fields,
      })).rejects.toMatchObject({ code });
      await expect(saveBatchStatus({
        client, changedBy: ACTOR, statusManagement: '', version: 1, reason: 'Must not save', ...fields,
      })).rejects.toThrow(named);
    }
    expect((await getBatchStatusManagement(client)).statusManagement).toBe('1');
    expect((await getBatchLevel(client))?.batchLevel).toBe('1');
    await expect(saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: 'active', version: 1, reason: 'Label is not the code',
    })).rejects.toMatchObject({ code: 'STATUS_UNKNOWN' });
  });

  it('does not change the indicator when a batch stands, and does not run a conversion', async () => {
    const client = await tenant('omcs-blocked');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Before batches' });
    await material(client, 'MAT-A');
    await createBatchIdentity({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'LIVE',
    });
    await expect(saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Must not convert',
    })).rejects.toThrow(/341/);
    expect((await getBatchStatusManagement(client)).statusManagement).toBeNull();

    await withTenant(client, (tx) => tx.execute(sql`delete from batch where client = ${client}`));
    await saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'Activate before the next batch',
    });
    await createBatchIdentity({
      client, changedBy: ACTOR, materialNumber: 'MAT-A', batchNumber: 'LIVE',
    });
    await expect(saveBatchStatus({
      client, changedBy: ACTOR, statusManagement: '', version: 1, reason: 'Must not turn it off',
    })).rejects.toMatchObject({ code: 'CONVERSION_BLOCKED' });
    expect((await getBatchStatusManagement(client)).statusManagement).toBe('1');
    await expect(executeBatchStatusConversion()).rejects.toBeInstanceOf(BatchStatusError);
    await expect(executeBatchStatusConversion()).rejects.toThrow(/was not changed/);
  });

  it('hides the indicator from another client', async () => {
    const client = await tenant('omcs-one');
    const other = await tenant('omcs-other');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'One level' });
    await saveBatchStatus({ client, changedBy: ACTOR, statusManagement: '1', version: 0, reason: 'One indicator' });
    const leaked = await withTenant(other, (tx) => tx.execute(sql`
      select status_management from batch_status_management where client = ${client}
    `)) as unknown as Array<{ status_management: string }>;
    expect(leaked).toHaveLength(0);
    expect((await getBatchStatusManagement(other)).statusManagement).toBeNull();
    expect((await getBatchStatusManagement(client)).statusManagement).toBe('1');
  });
});
