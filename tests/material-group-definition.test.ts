import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import {
  deleteMaterialGroup,
  listMaterialGroups,
  saveMaterialGroup,
  setMaterialGroupActive,
} from '../src/modules/inventory/material-group-definition';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR049_OMSF_TEST';

/**
 * SCR-049 / OMSF acceptance at the service layer: the provisioned
 * groups read back at their narrowed shape, the judged creation with
 * its change document, and the lifecycle — deactivation beside a
 * deletion that refuses under standing materials.
 */
describe('SCR-049 material groups (OMSF)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr049-material-group');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          insert into config_activity_status (client, activity_code, status, created_by)
          values (${client}, 'CFG.INV.MATERIALGROUP.DEFINE', 'NOT_STARTED', ${ACTOR})
          on conflict (client, activity_code) do nothing
        `);
      });
    }
    return client;
  }

  const baseGroup = {
    mode: 'CREATE' as const,
    materialGroup: 'BTEST',
    name: 'Browser test group',
    longDescription: 'A group defined by the acceptance run',
    reason: 'Stage 5 acceptance',
  };

  it('reads the provisioned groups at parity shape', async () => {
    const c = await standingClient();
    const groups = await listMaterialGroups(c);
    expect(groups.map((g) => g.materialGroup)).toEqual([
      'GENERAL', 'MAINT', 'PACKAGING', 'PRODUCTS', 'RAW', 'SERVICES',
    ]);
    expect(groups.every((g) => g.name.length <= 20)).toBe(true);
    expect(groups.find((g) => g.materialGroup === 'MAINT')).toMatchObject({
      name: 'Maintenance',
      longDescription: 'Maintenance and repair',
    });
    expect(groups.find((g) => g.materialGroup === 'PRODUCTS')?.longDescription).toBe(
      'Manufactured products',
    );
  });

  it('refuses a reason-less write', async () => {
    const c = await standingClient();
    await expect(
      saveMaterialGroup({ client: c, changedBy: ACTOR, ...baseGroup, reason: ' ' }),
    ).rejects.toThrow('A reason is required');
  });

  it('creates a group with a change document and completes the activity', async () => {
    const c = await standingClient();
    const created = await saveMaterialGroup({ client: c, changedBy: ACTOR, ...baseGroup });
    expect(created).toEqual({ materialGroup: 'BTEST', changed: true });
    const again = await saveMaterialGroup({
      client: c, changedBy: ACTOR, ...baseGroup, mode: 'CHANGE',
    });
    expect(again.changed).toBe(false);
    const history = await withTenant(c, (tx) =>
      changeHistory(tx, c, 'material_group', 'BTEST'),
    );
    expect(history).toHaveLength(1);
    expect(history[0].transactionCode).toBe('CFG.INV.MATERIALGROUP.DEFINE');
    const [status] = await withTenant(c, async (tx) => {
      const rows = await tx.execute(sql`
        select status from config_activity_status
        where client = ${c} and activity_code = 'CFG.INV.MATERIALGROUP.DEFINE'
      `);
      return rows as unknown as { status: string }[];
    });
    expect(status.status).toBe('COMPLETED');
  });

  it('refuses duplicate keys and oversize keys and descriptions', async () => {
    const c = await standingClient();
    await expect(
      saveMaterialGroup({ client: c, changedBy: ACTOR, ...baseGroup }),
    ).rejects.toThrow('already stands');
    await expect(
      saveMaterialGroup({
        client: c, changedBy: ACTOR, ...baseGroup, materialGroup: 'TOOLONGGROUP',
      }),
    ).rejects.toThrow('one to 9 uppercase');
    await expect(
      saveMaterialGroup({
        client: c, changedBy: ACTOR, ...baseGroup,
        materialGroup: 'NEW1', name: 'A name over twenty chars long',
      }),
    ).rejects.toThrow('at most 20 characters');
    await expect(
      saveMaterialGroup({
        client: c, changedBy: ACTOR, ...baseGroup,
        materialGroup: 'NEW1', longDescription: 'x'.repeat(61),
      }),
    ).rejects.toThrow('at most 60 characters');
  });

  it('changes descriptions and leaves the key standing', async () => {
    const c = await standingClient();
    const changed = await saveMaterialGroup({
      client: c, changedBy: ACTOR, ...baseGroup, mode: 'CHANGE',
      name: 'Acceptance group', longDescription: '',
    });
    expect(changed.changed).toBe(true);
    const groups = await listMaterialGroups(c);
    expect(groups.find((g) => g.materialGroup === 'BTEST')).toMatchObject({
      name: 'Acceptance group',
      longDescription: null,
    });
  });

  it('deactivates, reactivates and refuses deletion under standing materials', async () => {
    const c = await standingClient();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, material_type, material_group, created_by)
        values (${c}, 'SCR049-MAT-1', 'RAW', 'BTEST', ${ACTOR})
        on conflict do nothing
      `);
    });
    await expect(
      deleteMaterialGroup({ client: c, changedBy: ACTOR, materialGroup: 'BTEST', reason: 'Trying' }),
    ).rejects.toThrow('cannot be deleted: 1 material carries it');
    const off = await setMaterialGroupActive({
      client: c, changedBy: ACTOR, materialGroup: 'BTEST', active: false, reason: 'Pause use',
    });
    expect(off.changed).toBe(true);
    const again = await setMaterialGroupActive({
      client: c, changedBy: ACTOR, materialGroup: 'BTEST', active: false, reason: 'Pause again',
    });
    expect(again.changed).toBe(false);
    await setMaterialGroupActive({
      client: c, changedBy: ACTOR, materialGroup: 'BTEST', active: true, reason: 'Resume',
    });
    await withTenant(c, async (tx) => {
      await tx.execute(sql`delete from material where client = ${c} and material_number = 'SCR049-MAT-1'`);
    });
    const removed = await deleteMaterialGroup({
      client: c, changedBy: ACTOR, materialGroup: 'BTEST', reason: 'Unused group',
    });
    expect(removed.changed).toBe(true);
    const groups = await listMaterialGroups(c);
    expect(groups.map((g) => g.materialGroup)).not.toContain('BTEST');
  });
});
