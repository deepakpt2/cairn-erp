/** MRP controller maintenance (OMD0): the plant-scoped key, its guards, its audit trail and the material master ripple. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { createTenant, destroyTenant, withTenant, closeDb, type TestTenant } from './helpers';
import {
  ACTIVITY,
  MrpControllerError,
  deleteMrpController,
  listMrpControllers,
  mrpControllerKey,
  parseMrpControllerKey,
  saveMrpController,
  setMrpControllerActive,
} from '@/modules/inventory/mrp-controller-maintenance';
import { getMaterialDetail, materialChoices, saveMaterialView, type MaterialInput } from '@/modules/inventory/materials';

let tenant: TestTenant;
let serial = 0;
const ACTOR = 'MRP_ADMIN';

beforeEach(async () => {
  tenant = await createTenant(`mrp-controller-${++serial}`);
  await withTenant(tenant.client, async (tx) => {
    for (const [plant, name] of [['2000', 'Second plant'], ['3000', 'Third plant']] as const) {
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${tenant.client}, ${plant}, ${name}, c.company_code, 'KW', ${ACTOR}
          from (select company_code from company_code where client = ${tenant.client} order by company_code limit 1) c
      `);
    }
  });
});
afterEach(async () => { await destroyTenant(tenant.client); });
afterAll(closeDb);

function input(patch: Partial<Parameters<typeof saveMrpController>[0]> = {}) {
  return { client: tenant.client, changedBy: ACTOR, mode: 'CREATE' as const, plant: '1000', controller: 'A01', name: 'Planner A', reason: 'Test', ...patch };
}
function keyed(plant: string, controller: string, patch: Record<string, unknown> = {}) {
  return { client: tenant.client, changedBy: ACTOR, key: mrpControllerKey(plant, controller), reason: 'Test', ...patch };
}
async function refusal(promise: Promise<unknown>): Promise<MrpControllerError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(MrpControllerError); return error as MrpControllerError; }
  throw new Error('expected a refusal');
}

const number = 'MC-TEST';
function materialCommon() { return { client: tenant.client, materialNumber: number, changedBy: ACTOR, reason: 'Controller test' }; }
async function standMaterial() {
  await saveMaterialView({ ...materialCommon(), view: 'BASIC', expectedVersion: 0, description: 'Raw component', materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '', grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false });
}
function mrpView(plant: string, controller: string, expectedVersion = 0): MaterialInput {
  return { ...materialCommon(), view: 'MRP', expectedVersion, plant, mrpType: 'REQUIREMENTS', mrpController: controller, procurementType: 'BUY',
    lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 1, inHouseProductionDays: 0 };
}
async function changeDocs() {
  return await withTenant(tenant.client, (tx) => tx.execute(sql`
    select d.object_key, d.change_type, d.transaction_code, d.reason, i.field_name, i.old_value, i.new_value, i.is_security_relevant
      from change_document d left join change_document_item i on i.change_document_id = d.id
     where d.object_class = 'mrp_controller' order by d.changed_at, i.field_name`)) as unknown as Array<Record<string, string | null>>;
}

describe('MRP controller key', () => {
  it('round-trips the composite and is unambiguous about where a field ends', () => {
    expect(mrpControllerKey('1000', 'a01')).toBe('4:10003:A01');
    expect(parseMrpControllerKey('4:10003:A01')).toEqual({ plant: '1000', controller: 'A01' });
    expect(mrpControllerKey('1', '23')).not.toBe(mrpControllerKey('12', '3'));
    expect(parseMrpControllerKey('garbage')).toBeNull();
  });
});

describe('define, change, key', () => {
  it('lets the same code stand independently in two plants', async () => {
    await saveMrpController(input({ plant: '1000', controller: 'A01', name: 'North planner' }));
    await saveMrpController(input({ plant: '2000', controller: 'A01', name: 'South planner' }));
    const rows = (await listMrpControllers(tenant.client)).filter((r) => r.controller === 'A01');
    expect(rows.map((r) => [r.plant, r.name])).toEqual([['1000', 'North planner'], ['2000', 'South planner']]);
  });

  it('refuses a create over a standing key and a change of a missing one', async () => {
    await saveMrpController(input());
    expect((await refusal(saveMrpController(input()))).message).toMatch(/already stands in plant 1000/);
    expect((await refusal(saveMrpController(input({ mode: 'CHANGE', plant: '2000' })))).message).toMatch(/does not stand in plant 2000/);
  });

  it('validates the key, the plant and the name', async () => {
    for (const bad of ['', 'ABCD', 'a-1', 'A 1']) {
      expect((await refusal(saveMrpController(input({ controller: bad })))).message).toMatch(/one to 3 uppercase/);
    }
    expect((await refusal(saveMrpController(input({ plant: '9999' })))).message).toMatch(/does not stand or is not active/);
    await withTenant(tenant.client, (tx) => tx.execute(sql`update plant set is_active = false where client = ${tenant.client} and plant = '3000'`));
    expect((await refusal(saveMrpController(input({ plant: '3000' })))).message).toMatch(/not active/);
    expect((await refusal(saveMrpController(input({ plant: '' })))).message).toMatch(/plant is required/);
    expect((await refusal(saveMrpController(input({ name: '  ' })))).message).toMatch(/name is required/);
    expect((await refusal(saveMrpController(input({ name: 'x'.repeat(101) })))).message).toMatch(/at most 100/);
    expect((await saveMrpController(input({ controller: 'z9', name: 'x'.repeat(100) }))).controller).toBe('Z9');
  });

  it('requires a reason on create, change, activate, deactivate and delete', async () => {
    await saveMrpController(input());
    const message = /reason is required/;
    expect((await refusal(saveMrpController(input({ controller: 'B01', reason: ' ' })))).message).toMatch(message);
    expect((await refusal(saveMrpController(input({ mode: 'CHANGE', name: 'Renamed', reason: '' })))).message).toMatch(message);
    expect((await refusal(setMrpControllerActive({ ...keyed('1000', 'A01', { reason: '' }), active: false }))).message).toMatch(message);
    expect((await refusal(setMrpControllerActive({ ...keyed('1000', 'A01', { reason: '' }), active: true }))).message).toMatch(message);
    expect((await refusal(deleteMrpController(keyed('1000', 'A01', { reason: '' })))).message).toMatch(message);
  });

  it('writes a change document with the composite key, the activity code and before/after', async () => {
    await saveMrpController(input());
    await saveMrpController(input({ mode: 'CHANGE', name: 'Planner A2', reason: 'Planner moved' }));
    const docs = (await changeDocs()).filter((d) => d.change_type === 'CHANGE');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ object_key: '4:10003:A01', transaction_code: ACTIVITY, reason: 'Planner moved', field_name: 'name', old_value: 'Planner A', new_value: 'Planner A2' });
  });

  it('reports changed: false and writes nothing when the name already stands', async () => {
    await saveMrpController(input());
    const before = (await changeDocs()).length;
    expect((await saveMrpController(input({ mode: 'CHANGE' }))).changed).toBe(false);
    expect((await changeDocs()).length).toBe(before);
  });
});

describe('guards', () => {
  async function name(plant: string, controller: string) {
    await saveMrpController(input({ plant, controller, name: `Planner ${plant}` }));
    await standMaterial();
  }

  it('refuses deactivation and deletion while a material in that plant names the controller, with the count', async () => {
    await name('1000', 'A01');
    await saveMaterialView(mrpView('1000', 'A01'));
    const deactivate = await refusal(setMrpControllerActive({ ...keyed('1000', 'A01'), active: false }));
    expect(deactivate.message).toBe('MRP controller A01 cannot be deactivated: 1 material in plant 1000 names it.');
    expect(deactivate.remedy).toMatch(/Reassign those materials/);
    const removal = await refusal(deleteMrpController(keyed('1000', 'A01')));
    expect(removal.message).toBe('MRP controller A01 cannot be deleted: 1 material in plant 1000 names it.');
    const row = (await listMrpControllers(tenant.client)).find((r) => r.plant === '1000' && r.controller === 'A01')!;
    expect(row).toMatchObject({ isActive: true, materialCount: 1 });
  });

  it('deactivates a controller nothing names, flags it security-relevant, and can reactivate it', async () => {
    await saveMrpController(input());
    expect((await setMrpControllerActive({ ...keyed('1000', 'A01'), active: false })).changed).toBe(true);
    expect((await setMrpControllerActive({ ...keyed('1000', 'A01'), active: false })).changed).toBe(false);
    const item = (await changeDocs()).find((d) => d.change_type === 'CHANGE' && (d.field_name === 'isActive' || d.field_name === 'is_active'));
    expect(item).toMatchObject({ old_value: 'true', new_value: 'false', is_security_relevant: 'true', transaction_code: ACTIVITY });
    expect((await setMrpControllerActive({ ...keyed('1000', 'A01'), active: true })).changed).toBe(true);
  });

  it('keeps a controller deactivated in plant A active in plant B, where a material can still use it', async () => {
    await saveMrpController(input({ plant: '1000', controller: 'A01' }));
    await saveMrpController(input({ plant: '2000', controller: 'A01' }));
    await setMrpControllerActive({ ...keyed('1000', 'A01'), active: false });
    const rows = await listMrpControllers(tenant.client);
    expect(rows.find((r) => r.plant === '1000' && r.controller === 'A01')!.isActive).toBe(false);
    expect(rows.find((r) => r.plant === '2000' && r.controller === 'A01')!.isActive).toBe(true);
    await standMaterial();
    expect((await saveMaterialView(mrpView('2000', 'A01'))).status).toBe('CREATED');
  });

  it('deletes a controller nothing names, and refuses once something does', async () => {
    await saveMrpController(input({ controller: 'D01' }));
    await deleteMrpController(keyed('1000', 'D01'));
    expect((await listMrpControllers(tenant.client)).some((r) => r.controller === 'D01')).toBe(false);
    expect((await changeDocs()).some((d) => d.change_type === 'DELETE' && d.object_key === '4:10003:D01')).toBe(true);
    expect((await refusal(deleteMrpController(keyed('1000', 'D01')))).message).toMatch(/does not stand/);
  });

  it('marks the workbench activity complete on a write', async () => {
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update config_activity_status set status = 'PENDING', completed_at = null, completed_by = null
       where client = ${tenant.client} and activity_code = ${ACTIVITY}`));
    await saveMrpController(input());
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select status, completed_by from config_activity_status where client = ${tenant.client} and activity_code = ${ACTIVITY}`)) as unknown as Array<Record<string, string>>;
    expect(rows[0]).toEqual({ status: 'COMPLETED', completed_by: ACTOR });
  });
});

describe('material master ripple', () => {
  it('refuses a controller that stands only in another plant, naming the screen', async () => {
    await saveMrpController(input({ plant: '2000', controller: 'B01' }));
    await standMaterial();
    let caught: unknown;
    try { await saveMaterialView(mrpView('1000', 'B01')); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: 'MaterialError' });
    expect((caught as Error).message).toBe('MRP controller B01 does not stand active in plant 1000.');
    expect((caught as { remedy: string }).remedy).toMatch(/\/config\/mrp-controllers/);
  });

  it('refuses an inactive controller', async () => {
    await saveMrpController(input({ controller: 'C01' }));
    await setMrpControllerActive({ ...keyed('1000', 'C01'), active: false });
    await standMaterial();
    await expect(saveMaterialView(mrpView('1000', 'C01'))).rejects.toThrow(/does not stand active in plant 1000/);
  });

  it('offers choices that carry the plant, ordered by plant then code, active only', async () => {
    await saveMrpController(input({ plant: '2000', controller: 'A01', name: 'South' }));
    await saveMrpController(input({ plant: '1000', controller: 'Z01', name: 'North Z' }));
    await saveMrpController(input({ plant: '1000', controller: 'Y01', name: 'North Y' }));
    await setMrpControllerActive({ ...keyed('1000', 'Y01'), active: false });
    const choices = await withTenant(tenant.client, (tx) => tx.execute(sql`select 1`).then(() => materialChoices(tenant.client)));
    const own = choices.controllers.filter((c) => c.plant === '1000').map((c) => c.controller);
    expect(own).toContain('Z01');
    expect(own).not.toContain('Y01');
    expect(choices.controllers.find((c) => c.plant === '2000' && c.controller === 'A01')).toEqual({ plant: '2000', controller: 'A01', name: 'South' });
    const order = choices.controllers.map((c) => `${c.plant}/${c.controller}`);
    expect(order).toEqual([...order].sort());
  });

  it('keeps the delivered 001 standing in the standard plant, so an existing flow still saves', async () => {
    await standMaterial();
    expect((await saveMaterialView(mrpView('1000', '001'))).status).toBe('CREATED');
    expect((await getMaterialDetail(tenant.client, number))!.plants[0].mrpController).toBe('001');
  });
});

describe('list', () => {
  it('orders by plant then controller and carries the usage count and plant name', async () => {
    await saveMrpController(input({ plant: '2000', controller: 'A01' }));
    await saveMrpController(input({ plant: '1000', controller: 'B01' }));
    await saveMrpController(input({ plant: '1000', controller: 'A01' }));
    await standMaterial();
    await saveMaterialView(mrpView('1000', 'B01'));
    const rows = await listMrpControllers(tenant.client);
    const order = rows.map((r) => `${r.plant}/${r.controller}`);
    expect(order).toEqual([...order].sort());
    expect(rows.find((r) => r.plant === '1000' && r.controller === 'B01')).toMatchObject({ materialCount: 1, plantName: expect.any(String) });
    expect(rows.find((r) => r.plant === '2000' && r.controller === 'A01')!.materialCount).toBe(0);
  });
});
