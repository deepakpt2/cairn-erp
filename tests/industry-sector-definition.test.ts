import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import {
  deleteIndustrySector,
  listIndustrySectors,
  saveIndustrySector,
  setIndustrySectorActive,
} from '../src/modules/inventory/industry-sector-definition';
import { saveMaterialView, type MaterialInput } from '../src/modules/inventory/materials';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR052_OMS3_TEST';

/**
 * SCR-052 / MM01 + OMS3 acceptance: the delivered sectors read back,
 * the master maintained in the standing shape, MM01 requiring and
 * judging the sector, and the description standing at its 40-character
 * width.
 */
describe('SCR-052 industry sectors (OMS3) and MM01 judging', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr052-industry-sector');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          insert into config_activity_status (client, activity_code, status, created_by)
          values (${client}, 'CFG.INV.INDUSTRYSECTOR.DEFINE', 'NOT_STARTED', ${ACTOR})
          on conflict (client, activity_code) do nothing
        `);
      });
    }
    return client;
  }

  const basic = (patch: Partial<Extract<MaterialInput, { view: 'BASIC' }>> = {}): MaterialInput => ({
    client, materialNumber: 'SECTOR-MAT', changedBy: ACTOR, expectedVersion: 0,
    reason: 'Stage 5 acceptance', view: 'BASIC', description: 'Sector judged component',
    materialType: 'RAW', materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M',
    barcode: '', grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false, ...patch,
  });

  it('delivers the five standard sectors at onboarding', async () => {
    const c = await standingClient();
    const sectors = await listIndustrySectors(c);
    expect(sectors.map((s) => s.sector)).toEqual(['A', 'C', 'M', 'P', 'R']);
    expect(sectors.find((s) => s.sector === 'M')?.name).toBe('Mechanical engineering');
    expect(sectors.every((s) => s.isActive)).toBe(true);
  });

  it('maintains the master in the standing shape', async () => {
    const c = await standingClient();
    void c;
    const created = await saveIndustrySector({
      client, changedBy: ACTOR, mode: 'CREATE', sector: 'X', name: 'Experimental sector',
      reason: 'Stage 5 acceptance',
    });
    expect(created.changed).toBe(true);
    await expect(
      saveIndustrySector({
        client, changedBy: ACTOR, mode: 'CREATE', sector: 'X', name: 'Again',
        reason: 'Stage 5 acceptance',
      }),
    ).rejects.toThrow('already stands');
    const renamed = await saveIndustrySector({
      client, changedBy: ACTOR, mode: 'CHANGE', sector: 'X', name: 'Pilot sector',
      reason: 'Stage 5 acceptance',
    });
    expect(renamed.changed).toBe(true);
    const off = await setIndustrySectorActive({
      client, changedBy: ACTOR, sector: 'X', active: false, reason: 'Stage 5 acceptance',
    });
    expect(off.changed).toBe(true);
    const deleted = await deleteIndustrySector({
      client, changedBy: ACTOR, sector: 'X', reason: 'Stage 5 acceptance',
    });
    expect(deleted.changed).toBe(true);
    const history = await withTenant(client, (tx) =>
      changeHistory(tx, client, 'industry_sector', 'X'),
    );
    expect(history.map((h) => h.changeType).sort()).toEqual(['CHANGE', 'CHANGE', 'CREATE', 'DELETE']);
  });

  it('MM01 requires and judges the sector, and the description stands at 40', async () => {
    const c = await standingClient();
    void c;
    await expect(saveMaterialView(basic({ industrySector: '' }))).rejects.toThrow(
      'An industry sector is required',
    );
    await expect(saveMaterialView(basic({ industrySector: 'Q' }))).rejects.toThrow(
      'Industry sector Q does not exist or is inactive',
    );
    await saveIndustrySector({
      client, changedBy: ACTOR, mode: 'CREATE', sector: 'Z', name: 'Dormant sector',
      reason: 'Stage 5 acceptance',
    });
    await setIndustrySectorActive({
      client, changedBy: ACTOR, sector: 'Z', active: false, reason: 'Stage 5 acceptance',
    });
    await expect(saveMaterialView(basic({ industrySector: 'Z' }))).rejects.toThrow(
      'Industry sector Z does not exist or is inactive',
    );
    await expect(
      saveMaterialView(basic({ description: 'x'.repeat(41) })),
    ).rejects.toThrow('description');
    const saved = await saveMaterialView(basic());
    expect(saved.changed).toBe(true);
    // The carrying sector now refuses deletion, the count named.
    await expect(
      deleteIndustrySector({ client, changedBy: ACTOR, sector: 'M', reason: 'Stage 5 acceptance' }),
    ).rejects.toThrow('cannot be deleted: 1 material carries it');
    const sectors = await listIndustrySectors(client);
    expect(sectors.find((s) => s.sector === 'M')?.materialCount).toBe(1);
  });
});
