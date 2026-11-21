/**
 * MD01 background plant run (job MRP.PLANT.RUN, queue INTENSIVE).
 *
 * Real database effects throughout: crash windows are produced by actually reaping a live lease
 * between a business commit and the job's progress write, not by mocking a counter.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { claimNext, runClaimed } from '../src/platform/job/execute';
import { reapOrphans, requestCancel, retryRun } from '../src/platform/job/queue';
import { clearJobRegistry, registerJob } from '../src/platform/job/registry';
import { defineRange } from '../src/platform/numbering';
import { appUser, userCapability } from '../src/platform/tables/security';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { createMaterialBomForProvisioning as createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { MRP_PLANT_JOB, runMrpPlantChunk, submitMrpBackgroundRun, getMrpRunProgressForProvisioning as getMrpRunProgress } from '../src/modules/production/mrp-background';
import { MrpRunError, cancelMrpRunForProvisioning as cancelMrpRun, getMrpRunForProvisioning as getMrpRun, planMaterialsForProvisioning as planMaterials } from '../src/modules/production/mrp-run';
import { createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { createWorkCenterForProvisioning as createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'MD01_BG';
const PLANT = '1000';
const N = 41; // above the foreground limit of 40, for initial AND dependent materials

let tenant: TestTenant;
let planner: { id: string; username: string };
let key = 0;
const nextKey = () => `md01-bg-${++key}`;
const pad = (n: number) => String(n).padStart(3, '0');

async function extend(materialNumber: string, procurement: 'MAKE' | 'BUY', safety: string) {
  await saveMaterialView({
    client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'MD01', view: 'BASIC', description: materialNumber, materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  await saveMaterialView({
    client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
    reason: 'MD01', view: 'PURCHASING', plant: PLANT, purchasingGroup: '001', orderUnit: 'PC',
    overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });
  await saveMaterialView({
    client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
    reason: 'MD01', view: 'MRP', plant: PLANT,
    mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: procurement, lotSizing: 'EXACT',
    fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: safety, reorderPoint: '0',
    plannedDeliveryDays: 0, inHouseProductionDays: 0,
  });
}

async function markNetChange(materials: string[]) {
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`update planning_file set net_change = false where client = ${tenant.client}`);
    for (const m of materials) {
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${tenant.client} and material_number = ${m} and plant = ${PLANT}`);
    }
  });
}

const submit = (over: Partial<Parameters<typeof submitMrpBackgroundRun>[0]> = {}) =>
  submitMrpBackgroundRun({
    client: tenant.client, requestedBy: planner.username, actorUserId: planner.id, requestKey: nextKey(),
    processingKey: 'NETCH', plantFrom: PLANT, ...over,
  });

async function jobOf(runNumber: string) {
  return withTenant(tenant.client, async (tx) => {
    const r = (await tx.execute(sql`
      select j.* from job_run j join mrp_run m on m.client = j.client and m.job_run_id = j.id
       where m.client = ${tenant.client} and m.run_number = ${runNumber}`)) as unknown as Array<Record<string, unknown>>;
    return r[0]!;
  });
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  return withTenant(tenant.client, async (tx) => Number(((await tx.execute(query)) as unknown as Array<{ n: number }>)[0]!.n));
}

/** Drive the intensive worker's claim/run loop until nothing is claimable. */
async function drive(options: { heartbeatMs?: number } = {}): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    const claimed = await claimNext('worker-intensive', ['INTENSIVE']);
    if (!claimed) break;
    out.push(await runClaimed('worker-intensive', claimed, options));
  }
  return out;
}

async function resetPlant() {
  // Clear runs between tests so the plant overlap check starts clean.
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`update mrp_run set status = 'CANCELLED' where client = ${tenant.client} and status in ('QUEUED','RUNNING','CANCELLING')`);
    await tx.execute(sql`delete from job_run where client = ${tenant.client} and job_code = ${MRP_PLANT_JOB}`);
  });
}

beforeAll(async () => {
  tenant = await createTenant('md01-bg');
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, { client: tenant.client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client: tenant.client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client: tenant.client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR });
    const id = randomUUID();
    await tx.insert(appUser).values({ id, client: tenant.client, username: 'planner', fullName: 'Planner', passwordHash: 'TEST_ONLY_NOT_A_CREDENTIAL', createdBy: 'TEST' });
    for (const cap of ['PROD.MRP.RUN', 'PROD.MRP.REGENERATE']) {
      await tx.insert(userCapability).values({
        id: randomUUID(), client: tenant.client, userId: id, capabilityCode: cap,
        validFrom: '2020-01-01', reason: 'DIRECT', granter: 'boss', createdBy: 'TEST',
      });
    }
    // The planner's Company Code scope is explicit: a missing restriction reaches no plant.
    await tx.execute(sql`insert into auth_org_restriction (id, client, user_id, scope_type, scope_value, created_by)
      select ${randomUUID()}, ${tenant.client}, ${id}, 'COMPANY_CODE', company_code, 'TEST' from company_code where client = ${tenant.client}`);
    planner = { id, username: 'planner' };
  });
  for (let i = 1; i <= N; i += 1) await extend(`INIT-${pad(i)}`, 'BUY', '5');
  await extend('FG-B', 'MAKE', '1');
  for (let i = 1; i <= N; i += 1) await extend(`COMP-${pad(i)}`, 'BUY', '0');
  await saveBomUsage({ client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production', productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.' });
  await saveBomItemCategory({ client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+', allowPhantom: 'X' });
  await createMaterialBom({
    client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-B', plant: PLANT, usage: 'P', alternative: '01',
    baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
    items: Array.from({ length: N }, (_, i) => ({ itemNumber: String((i + 1) * 10).padStart(4, '0'), itemCategory: 'S', componentMaterial: `COMP-${pad(i + 1)}`, quantity: '1', unit: 'PC' })),
  });
  await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
  await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
  await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal' });
  await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
  await createWorkCenter({ client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC01', category: 'MACH', description: 'Assembly' });
  await createRouting({
    client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1', routingGroup: '53000001', groupCounter: '01',
    baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01', assignments: [{ materialNumber: 'FG-B' }],
    operations: [{ operationNumber: '0010', shortText: 'Cut', workCenter: 'WC01', controlKey: 'PP01' }],
  });
  await createProductionVersion({
    client: tenant.client, changedBy: ACTOR, materialNumber: 'FG-B', plant: PLANT, productionVersion: '0001',
    validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC', bomUsage: 'P', bomAlternative: '01',
    taskListType: 'N', routingGroup: '53000001', groupCounter: '01',
  });
}, 300_000);

afterEach(async () => {
  clearJobRegistry();
  await resetPlant();
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

// Handler registration for each test: the real one, or a wrapper that injects a fault.
function useHandler(wrap?: (ctx: Parameters<typeof runMrpPlantChunk>[0], run: () => ReturnType<typeof runMrpPlantChunk>, call: number) => ReturnType<typeof runMrpPlantChunk>) {
  clearJobRegistry();
  let call = 0;
  registerJob({ code: MRP_PLANT_JOB, chunk: (ctx) => { call += 1; return wrap ? wrap(ctx, () => runMrpPlantChunk(ctx), call) : runMrpPlantChunk(ctx); } });
}

describe('submission', () => {
  it('returns QUEUED at once, enumerates nothing, and queues only the run number on INTENSIVE', async () => {
    await markNetChange(Array.from({ length: N }, (_, i) => `INIT-${pad(i + 1)}`));
    const run = await submit();
    expect(run.status).toBe('QUEUED');
    expect(run.executionMode).toBe('BACKGROUND');
    expect(run.materials).toEqual([]); // the population is selected by the job
    const job = await jobOf(run.runNumber);
    expect(job.status).toBe('QUEUED');
    expect(job.parameters).toEqual({ runNumber: run.runNumber });
    expect(await claimNext('worker-regular', ['DEFAULT', 'MAIL', 'OUTPUT'])).toBeNull();
    expect(run.job?.status).toBe('QUEUED');
  });

  it('duplicate submits give one run and one job; a changed scope under the same key is refused', async () => {
    const k = nextKey();
    const [a, b] = await Promise.all([submit({ requestKey: k }), submit({ requestKey: k })]);
    expect(b.runNumber).toBe(a.runNumber);
    expect(await count(sql`select count(*)::int as n from mrp_run where client = ${tenant.client} and request_key = ${k}`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from job_run where client = ${tenant.client} and job_code = ${MRP_PLANT_JOB}`)).toBe(1);
    await expect(submit({ requestKey: k, materialFrom: 'A', materialTo: 'B' })).rejects.toThrow(/different scope/);
    await expect(submit()).rejects.toThrow(/already planning this plant/);
  });

  it('refuses regenerative planning without confirmation, and without the regenerative authority', async () => {
    await expect(submit({ processingKey: 'NEUPL' })).rejects.toThrow(/needs confirmation/);
    await withTenant(tenant.client, (tx) =>
      tx.delete(userCapability).where(and(eq(userCapability.userId, planner.id), eq(userCapability.capabilityCode, 'PROD.MRP.REGENERATE'))),
    );
    await expect(submit({ processingKey: 'NEUPL', confirmRegenerative: true })).rejects.toThrow(/PROD.MRP.REGENERATE/);
    await withTenant(tenant.client, (tx) =>
      tx.insert(userCapability).values({
        id: randomUUID(), client: tenant.client, userId: planner.id, capabilityCode: 'PROD.MRP.REGENERATE',
        validFrom: '2020-01-01', reason: 'DIRECT', granter: 'boss', createdBy: 'TEST',
      }),
    );
  });

  it('keeps the foreground limit and refusal for a foreground run', async () => {
    await markNetChange(Array.from({ length: N }, (_, i) => `INIT-${pad(i + 1)}`));
    await expect(
      planMaterials({ client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT }),
    ).rejects.toThrow(/foreground limit of 40/);
    await expect(
      planMaterials({ client: tenant.client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT, executionMode: 'BACKGROUND' }),
    ).rejects.toThrow(MrpRunError);
  });
});

describe('execution', () => {
  it('plans more than 40 initial and more than 40 dependent materials with nothing truncated', async () => {
    await markNetChange([...Array.from({ length: N }, (_, i) => `INIT-${pad(i + 1)}`), 'FG-B']);
    const run = await submit();
    useHandler();
    expect(await drive()).toEqual(['SUCCEEDED']);
    const done = (await getMrpRun(tenant.client, run.runNumber))!;
    expect(['COMPLETED', 'COMPLETED_WITH_WARNINGS']).toContain(done.status);
    const names = done.materials.map((m) => m.materialNumber);
    for (let i = 1; i <= N; i += 1) {
      expect(names).toContain(`INIT-${pad(i)}`);
      expect(names).toContain(`COMP-${pad(i)}`); // dependent: enqueued by the explosion of FG-B
    }
    expect(done.materials.filter((m) => m.status === 'PENDING' || m.status === 'RUNNING' || m.status === 'CANCELLED')).toEqual([]);
    expect(done.diagnostics.some((d) => d.diagnosticCode === 'FOREGROUND_LIMIT')).toBe(false);
    expect((await jobOf(run.runNumber)).status).toBe('SUCCEEDED');
    const progress = await getMrpRunProgress(tenant.client, run.runNumber);
    expect(progress).toMatchObject({ pending: 0, executionMode: 'BACKGROUND' });
  });

  it('a simulated run writes no supply', async () => {
    await markNetChange(['INIT-001', 'INIT-002']);
    const before = await count(sql`select (select count(*) from purchase_requisition_item where client = ${tenant.client})::int + (select count(*) from planned_order where client = ${tenant.client})::int as n`);
    const run = await submit({ simulationOnly: true, materialFrom: 'INIT-001', materialTo: 'INIT-002' });
    useHandler();
    expect(await drive()).toEqual(['SUCCEEDED']);
    const after = await count(sql`select (select count(*) from purchase_requisition_item where client = ${tenant.client})::int + (select count(*) from planned_order where client = ${tenant.client})::int as n`);
    expect(after).toBe(before);
    expect((await getMrpRun(tenant.client, run.runNumber))!.simulationOnly).toBe(true);
  });

  it('recovers a material left RUNNING by a dead worker without planning anything twice', async () => {
    await markNetChange(['INIT-001', 'INIT-002', 'INIT-003']);
    const run = await submit({ materialFrom: 'INIT-001', materialTo: 'INIT-003' });
    // Chunk 1 only selects the materials; then the "dead worker" leaves INIT-002 RUNNING.
    useHandler(async (ctx, real, call) => {
      if (call !== 1) return real();
      const selected = await runMrpPlantChunk({ ...ctx, chunkSize: 0 });
      await withTenant(tenant.client, (tx) =>
        tx.execute(sql`update mrp_run_material set status = 'RUNNING' where client = ${tenant.client} and run_number = ${run.runNumber} and material_number = 'INIT-002'`),
      );
      return selected;
    });
    expect(await drive()).toEqual(['SUCCEEDED']);
    const done = (await getMrpRun(tenant.client, run.runNumber))!;
    expect(done.materials.map((m) => [m.materialNumber, m.status])).toEqual([
      ['INIT-001', 'COMPLETED'], ['INIT-002', 'COMPLETED'], ['INIT-003', 'COMPLETED'],
    ]);
    expect(done.diagnostics.some((d) => d.diagnosticCode === 'RECOVERED_RUNNING' && d.materialNumber === 'INIT-002')).toBe(true);
    expect(await count(sql`select count(*)::int as n from mrp_run_proposal where client = ${tenant.client} and run_number = ${run.runNumber} and material_number = 'INIT-002'`)).toBe(1);
  });
});

describe('cancellation, failure and authority', () => {
  it('cancels a queued run and its job, and frees the plant', async () => {
    const run = await submit();
    const cancelled = await cancelMrpRun(tenant.client, run.runNumber, planner.username);
    expect(cancelled.status).toBe('CANCELLED');
    expect((await jobOf(run.runNumber)).status).toBe('CANCELLED');
    await expect(submit()).resolves.toMatchObject({ status: 'QUEUED' });
  });

  it('an administrator cancelling the queued job from the monitor also closes the run', async () => {
    const run = await submit();
    const job = await jobOf(run.runNumber);
    await withTenant(tenant.client, (tx) => requestCancel(tx, tenant.client, String(job.id)));
    expect((await getMrpRun(tenant.client, run.runNumber))!.status).toBe('CANCELLED');
  });

  it('cancelling mid-work stops at a safe boundary; planned materials stand and are disclosed', async () => {
    await markNetChange(Array.from({ length: N }, (_, i) => `INIT-${pad(i + 1)}`));
    const run = await submit();
    useHandler(async (ctx, real, call) => {
      const result = await real();
      if (call === 1) await cancelMrpRun(tenant.client, run.runNumber, planner.username);
      return result;
    });
    await drive();
    const done = (await getMrpRun(tenant.client, run.runNumber))!;
    expect(done.status).toBe('CANCELLED');
    const planned = done.materials.filter((m) => m.status === 'COMPLETED').length;
    expect(planned).toBeGreaterThan(0);
    expect(planned).toBeLessThan(N);
    expect(done.materialsPlanned).toBe(planned); // the counts say what was actually committed
    expect(done.materials.filter((m) => m.status === 'PENDING' || m.status === 'RUNNING')).toEqual([]);
    expect((await jobOf(run.runNumber)).status).toBe('CANCELLED');
    await expect(submit()).resolves.toMatchObject({ status: 'QUEUED' }); // no stranded overlap lock
  });

  it('a forced handler failure ends the job FAILED, closes the run FAILED, keeps planned work, frees the plant', async () => {
    await markNetChange(Array.from({ length: N }, (_, i) => `INIT-${pad(i + 1)}`));
    const run = await submit();
    useHandler(async (ctx, real, call) => {
      if (call === 2) throw new Error('forced failure');
      return real();
    });
    expect(await drive()).toEqual(['FAILED']);
    const failed = (await getMrpRun(tenant.client, run.runNumber))!;
    expect(failed.status).toBe('FAILED');
    expect(failed.errorSummary).toContain('forced failure');
    const planned = failed.materials.filter((m) => m.status === 'COMPLETED').length;
    expect(planned).toBe(25); // the first chunk committed and stands
    expect(failed.materialsPlanned).toBe(25);
    expect(failed.materials.filter((m) => m.status === 'PENDING' || m.status === 'RUNNING')).toEqual([]);
    await expect(submit()).resolves.toMatchObject({ status: 'QUEUED' });
  });

  it('retrying a failed job from the monitor is refused with a clear error and plans nothing more', async () => {
    await markNetChange(Array.from({ length: N }, (_, i) => `INIT-${pad(i + 1)}`));
    const run = await submit();
    useHandler(async (ctx, real, call) => {
      if (call === 2) throw new Error('forced failure');
      return real();
    });
    await drive();
    const job = await jobOf(run.runNumber);
    useHandler();
    await withTenant(tenant.client, (tx) => retryRun(tx, tenant.client, String(job.id)));
    expect(await drive()).toEqual(['FAILED']);
    expect(String((await jobOf(run.runNumber)).error_text)).toContain('A failed run is not resumed');
    expect((await getMrpRun(tenant.client, run.runNumber))!.materials.filter((m) => m.status === 'COMPLETED')).toHaveLength(25);
  });

  it('fails closed when the submitter lost the grant or was deactivated before execution', async () => {
    await markNetChange(['INIT-001']);
    const run = await submit({ materialFrom: 'INIT-001', materialTo: 'INIT-001' });
    await withTenant(tenant.client, (tx) => tx.update(appUser).set({ isActive: false }).where(eq(appUser.id, planner.id)));
    useHandler();
    expect(await drive()).toEqual(['FAILED']);
    await withTenant(tenant.client, (tx) => tx.update(appUser).set({ isActive: true }).where(eq(appUser.id, planner.id)));
    const failed = (await getMrpRun(tenant.client, run.runNumber))!;
    expect(failed.status).toBe('FAILED');
    expect(failed.errorSummary).toMatch(/no longer active/);
    expect(failed.materials.filter((m) => m.status === 'COMPLETED')).toEqual([]);

    await resetPlant();
    const run2 = await submit({ materialFrom: 'INIT-001', materialTo: 'INIT-001' });
    await withTenant(tenant.client, (tx) => tx.delete(userCapability).where(and(eq(userCapability.userId, planner.id), eq(userCapability.capabilityCode, 'PROD.MRP.RUN'))));
    expect(await drive()).toEqual(['FAILED']);
    await withTenant(tenant.client, (tx) =>
      tx.insert(userCapability).values({ id: randomUUID(), client: tenant.client, userId: planner.id, capabilityCode: 'PROD.MRP.RUN', validFrom: '2020-01-01', reason: 'DIRECT', granter: 'boss', createdBy: 'TEST' }),
    );
    expect((await getMrpRun(tenant.client, run2.runNumber))!.errorSummary).toMatch(/no longer holds PROD.MRP.RUN/);
  });
});

describe('crash windows and leases', () => {
  /** Kill the lease after the real chunk committed: reap it as another process would, then return. */
  const diesAfterCommit = (atCall: number) => async (ctx: Parameters<typeof runMrpPlantChunk>[0], real: () => ReturnType<typeof runMrpPlantChunk>, call: number) => {
    const result = await real();
    if (call === atCall) {
      await withTenant(tenant.client, (tx) => tx.execute(sql`update job_run set heartbeat_at = now() - interval '5 minutes' where id = ${ctx.runId}`));
      const reaped = await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1000));
      expect(reaped).toContain(ctx.runId);
    }
    return result;
  };

  it('worker dies after a business commit but before the progress write: the replay plans nothing twice', async () => {
    await markNetChange(Array.from({ length: N }, (_, i) => `INIT-${pad(i + 1)}`));
    const run = await submit();
    useHandler(diesAfterCommit(1));
    const statuses = await drive();
    expect(statuses[0]).toBe('LEASE_LOST'); // the first owner learns it lost the lease at its progress write
    expect(statuses.slice(1)).toEqual(['SUCCEEDED']);
    const done = (await getMrpRun(tenant.client, run.runNumber))!;
    expect(done.materials.filter((m) => m.status === 'COMPLETED')).toHaveLength(N);
    // Exactly one proposal row per material: nothing was planned twice by the replay.
    expect(await count(sql`select count(*)::int as n from mrp_run_proposal where client = ${tenant.client} and run_number = ${run.runNumber}`)).toBe(N);
    expect(await count(sql`select count(distinct material_number)::int as n from mrp_run_proposal where client = ${tenant.client} and run_number = ${run.runNumber}`)).toBe(N);
  });

  it('worker dies after the final commit but before the job is marked SUCCEEDED: the replay changes nothing', async () => {
    await markNetChange(['INIT-001', 'INIT-002']);
    const run = await submit({ materialFrom: 'INIT-001', materialTo: 'INIT-002' });
    let last = 0;
    useHandler(async (ctx, real, call) => {
      const result = await real();
      if (result.cursor === null && last === 0) {
        last = call;
        await withTenant(tenant.client, (tx) => tx.execute(sql`update job_run set heartbeat_at = now() - interval '5 minutes' where id = ${ctx.runId}`));
        await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1000));
      }
      return result;
    });
    const statuses = await drive();
    expect(statuses).toEqual(['LEASE_LOST', 'SUCCEEDED']);
    const done = (await getMrpRun(tenant.client, run.runNumber))!;
    expect(done.status).toMatch(/^COMPLETED/);
    expect(await count(sql`select count(*)::int as n from mrp_run_proposal where client = ${tenant.client} and run_number = ${run.runNumber}`)).toBe(2);
  });

  it('a live chunk longer than the heartbeat timeout is not reaped while another process reaps', async () => {
    await markNetChange(['INIT-001']);
    const run = await submit({ materialFrom: 'INIT-001', materialTo: 'INIT-001' });
    useHandler(async (ctx, real, call) => {
      if (call === 1) await new Promise((r) => setTimeout(r, 2500)); // alive and busy, longer than the 1 s timeout used below
      return real();
    });
    let reaping = true;
    const reaped: string[] = [];
    const reaper = (async () => {
      while (reaping) {
        reaped.push(...(await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1000))));
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    const statuses = await drive({ heartbeatMs: 200 });
    reaping = false;
    await reaper;
    expect(statuses).toEqual(['SUCCEEDED']);
    expect(reaped).toEqual([]);
    expect((await getMrpRun(tenant.client, run.runNumber))!.status).toMatch(/^COMPLETED/);
  });

  it('a stale owner cannot commit material planning after its lease is lost', async () => {
    await markNetChange(['INIT-001']);
    const run = await submit({ materialFrom: 'INIT-001', materialTo: 'INIT-001' });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let started = false;
    useHandler(async (ctx, real, call) => {
      if (call === 1) {
        started = true;
        await held; // paused past its lease; nothing has been written by this chunk yet
      }
      return real();
    });
    const a = await claimNext('worker-a', ['INTENSIVE']);
    const aDone = runClaimed('worker-a', a!, { heartbeatMs: 600_000 });
    while (!started) await new Promise((r) => setTimeout(r, 20));
    await withTenant(tenant.client, (tx) => tx.execute(sql`update job_run set heartbeat_at = now() - interval '5 minutes' where id = ${a!.runId}`));
    await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1000));
    // Worker B takes over and finishes the whole run.
    clearJobRegistry();
    registerJob({ code: MRP_PLANT_JOB, chunk: runMrpPlantChunk });
    const b = await claimNext('worker-b', ['INTENSIVE']);
    expect(await runClaimed('worker-b', b!)).toBe('SUCCEEDED');
    // A wakes: its fenced transaction fails, it writes nothing.
    release();
    expect(await aDone).toBe('LEASE_LOST');
    expect(await count(sql`select count(*)::int as n from mrp_run_proposal where client = ${tenant.client} and run_number = ${run.runNumber}`)).toBe(1);
    expect((await jobOf(run.runNumber)).status).toBe('SUCCEEDED');
  });
});

describe('monitor exposure', () => {
  it('the generic job row carries only the run number and counts, no material names or quantities', async () => {
    await markNetChange(['INIT-001']);
    const run = await submit({ materialFrom: 'INIT-001', materialTo: 'INIT-001' });
    useHandler();
    await drive();
    const job = await jobOf(run.runNumber);
    expect(job.parameters).toEqual({ runNumber: run.runNumber });
    expect(String(job.progress_text ?? '')).not.toMatch(/INIT-|COMP-/);
    expect(String(job.result_summary ?? '')).not.toMatch(/INIT-|COMP-/);
    const logs = (await withTenant(tenant.client, (tx) => tx.execute(sql`select message, context from job_log where client = ${tenant.client} and job_run_id = ${String(job.id)}`))) as unknown as Array<{ message: string }>;
    expect(logs.map((l) => l.message).join(' ')).not.toMatch(/INIT-|COMP-/);
  });
});
