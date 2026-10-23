import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import { saveBatchNumberInterval } from '../src/modules/inventory/batch-number-range';
import { saveInternalBatchAssignment } from '../src/modules/inventory/batch-number-assignment';
import {
  ProductionOrderError,
  createProductionOrder,
  getProductionOrder,
  releaseProductionOrder,
} from '../src/modules/inventory/production-orders';
import {
  ACTIVITY,
  ALIAS,
  SchedulingProfileError,
  assignSchedulingProfile,
  saveSchedulingProfile,
} from '../src/modules/inventory/scheduling-profile';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'OPKP_TEST';
const PLANT = 'QK01';

describe('OPKP production scheduling profile', () => {
  let fx: TestTenant;
  let client = '';

  beforeAll(async () => {
    fx = await createTenant('opkp');
    client = fx.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
        from (values ('OPKP-FG', 'Finished'), ('OPKP-RM', 'Component')) as v(n, d)
        cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'Profile plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${client} order by company_code limit 1) c
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${client}, v.n, ${PLANT}, ${ACTOR}
        from (values ('OPKP-FG'), ('OPKP-RM')) as v(n)
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, ${PLANT}, 'SK01', 'Profile store', true, false, ${ACTOR})
      `);
      await defineRange(tx, {
        client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR,
      });
    });
  }, 180_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
  }, 180_000);

  async function order(materialNumber: string, batch = '') {
    return createProductionOrder({
      client,
      createdBy: ACTOR,
      materialNumber,
      plant: PLANT,
      orderQuantity: 10,
      scheduledStart: '2026-11-02',
      scheduledFinish: '2026-11-06',
      batch,
      components: [
        { materialNumber: 'OPKP-RM', plant: PLANT, storageLocation: 'SK01', requiredQuantity: 2 },
      ],
    });
  }

  it('keeps the profile key as typed and refuses a padded or cut key', async () => {
    expect(ACTIVITY).toBe('CFG.PROD.SCHEDPROFILE.DEFINE');
    expect(ALIAS).toBe('OPKP');
    const saved = await saveSchedulingProfile({
      client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, profile: '01',
      description: 'Release at creation', releaseOnCreate: 'X', batchCreation: ' ',
      version: 0, reason: 'Create',
    });
    expect(saved.profile).toBe('01');
    expect(saved.releaseOnCreate).toBe('X');
    await expect(saveSchedulingProfile({
      client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, profile: '  AB',
      description: 'Padded', releaseOnCreate: ' ', batchCreation: ' ', version: 0, reason: 'No',
    })).rejects.toBeInstanceOf(SchedulingProfileError);
    await expect(saveSchedulingProfile({
      client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, profile: 'SEVENCH',
      description: 'Too long', releaseOnCreate: ' ', batchCreation: ' ', version: 0, reason: 'No',
    })).rejects.toBeInstanceOf(SchedulingProfileError);
  });

  it('releases at creation from the snapshot and does not rewrite that order later', async () => {
    await assignSchedulingProfile({
      client, changedBy: ACTOR, materialNumber: 'OPKP-FG', plant: PLANT,
      profile: '01', expectedVersion: 1, reason: 'Assign release',
    });
    const created = await order('OPKP-FG');
    expect(created.status).toBe('RELEASED');
    expect(created.batch).toBe('');
    expect(created.schedulingProfile).toBe('01');
    expect(created.releaseNote).toBeNull();
    await saveSchedulingProfile({
      client, changedBy: ACTOR, mode: 'CHANGE', plant: PLANT, profile: '01',
      description: 'No longer releases', releaseOnCreate: ' ', batchCreation: ' ',
      version: 1, reason: 'Change after the order',
    });
    const reread = await getProductionOrder(client, created.orderNumber);
    expect(reread?.schedulingProfile).toBe('01');
    expect(reread?.releaseOnCreate).toBe('X');
    expect(reread?.status).toBe('RELEASED');
  });

  it('does not save an order when batch creation at create cannot draw a number', async () => {
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    await withTenant(client, (tx) => tx.execute(sql`
      update material set batch_managed = true, changed_by = ${ACTOR}
      where client = ${client} and material_number = 'OPKP-FG'
    `));
    await saveSchedulingProfile({
      client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, profile: 'B1',
      description: 'Batch at create', releaseOnCreate: ' ', batchCreation: '1',
      version: 0, reason: 'Create',
    });
    await assignSchedulingProfile({
      client, changedBy: ACTOR, materialNumber: 'OPKP-FG', plant: PLANT,
      profile: 'B1', expectedVersion: 2, reason: 'Assign batch at create',
    });
    await expect(order('OPKP-FG')).rejects.toBeInstanceOf(ProductionOrderError);
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order
      where client = ${client} and scheduling_profile = 'B1'
    `)) as unknown as Array<{ n: number }>;
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  it('creates the batch at order creation when numbering is active, and keeps a named batch', async () => {
    await saveInternalBatchAssignment({
      client, changedBy: ACTOR, internalAssignment: 'X', version: 0, reason: 'Activate',
    });
    await saveBatchNumberInterval({
      client, changedBy: ACTOR, capabilities: ['CFG.INV.BATCHRANGE.DEFINE'],
      interval: '01', fromNumber: '1', toNumber: '10', external: false, mode: 'CREATE', reason: 'Internal',
    });
    const created = await order('OPKP-FG');
    expect(created.status).toBe('CREATED');
    expect(created.batch).toMatch(/\d/);
    expect(created.batchCreation).toBe('1');
    const named = await order('OPKP-FG', created.batch);
    expect(named.batch).toBe(created.batch);
  });

  it('creates the batch at release when the snapshot says 2, and keeps the order created if that release fails', async () => {
    await saveSchedulingProfile({
      client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, profile: 'B2',
      description: 'Batch at release', releaseOnCreate: ' ', batchCreation: '2',
      version: 0, reason: 'Create',
    });
    await assignSchedulingProfile({
      client, changedBy: ACTOR, materialNumber: 'OPKP-FG', plant: PLANT,
      profile: 'B2', expectedVersion: 3, reason: 'Assign batch at release',
    });
    const created = await order('OPKP-FG');
    expect(created.status).toBe('CREATED');
    expect(created.batch).toBe('');
    const released = await releaseProductionOrder({
      client, orderNumber: created.orderNumber, releasedBy: ACTOR,
    });
    expect(released.status).toBe('RELEASED');
    expect(released.batch).toMatch(/\d/);

    await saveSchedulingProfile({
      client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, profile: 'RX',
      description: 'Release needs a batch', releaseOnCreate: 'X', batchCreation: '2',
      version: 0, reason: 'Create',
    });
    await assignSchedulingProfile({
      client, changedBy: ACTOR, materialNumber: 'OPKP-RM', plant: PLANT,
      profile: 'RX', expectedVersion: 1, reason: 'Assign failing release',
    });
    const held = await order('OPKP-RM');
    expect(held.status).toBe('CREATED');
    expect(held.batch).toBe('');
    expect(held.releaseNote).toMatch(/No batch was created/);
    const reread = await getProductionOrder(client, held.orderNumber);
    expect(reread?.status).toBe('CREATED');
  });
});
