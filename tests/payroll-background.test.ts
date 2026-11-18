/**
 * Background payroll: PAYROLL.RUN.CALC (proposal and recalculation) and PAYROLL.RUN.POST, queue INTENSIVE.
 *
 * Real database effects: crash windows are produced by reaping a live lease between a business commit
 * and the job's own write; fencing is exercised with a worker that sleeps past its lease.
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { claimNext, runClaimed } from '../src/platform/job/execute';
import { reapOrphans, requestCancel, retryRun } from '../src/platform/job/queue';
import { clearJobRegistry, registerJob } from '../src/platform/job/registry';
import { appUser, roleCapability } from '../src/platform/tables/security';
import { maintainNumberRange } from '../src/modules/foundation/number-ranges';
import { assignStructure, defineSalaryStructure, setStructureComponent } from '../src/modules/people/payroll-structure';
import {
  PAYROLL_CALC_JOB,
  PAYROLL_POST_JOB,
  cancelPayrollOperation,
  getPayrollOperation,
  listPayrollOperations,
  runPayrollCalcChunk,
  runPayrollPostChunk,
  submitPayrollPosting,
  submitPayrollProposal,
  submitPayrollRecalculation,
} from '../src/modules/people/payroll-background';
import { PAYROLL_RUN_CAPABILITY, PayrollRunError, cancelPayrollRun, getPayrollRun, listResults, proposePayrollRun, recalculatePayrollRun, releasePayrollRun } from '../src/modules/people/payroll-run';
import { PayrollPostingError, postPayrollRun } from '../src/modules/people/payroll-posting';
import { PAYROLL_ACTOR, PAYROLL_AUTH, buildPayrollFixture, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const YEAR = 2025;
const CAPS = [PAYROLL_RUN_CAPABILITY, 'PEOPLE.PAYROLL.POST', 'FIN.JOURNAL.POST'];

let tenant: TestTenant;
let fx: PayrollFixture;
let runner: FinanceActor;
let structureCode: string;
const employees: string[] = [];
let period = 0;
/** Periods 1..8 are reused: afterEach cancels the runs a test left, so they stop covering anybody. */
const nextPeriod = () => (period = (period % 8) + 1);
let postSlot = 8;
/** Posted runs cannot be cancelled, so each posting test takes its own period. */
const postPeriod = () => ++postSlot;

const access = () => ({ authorization: runner.authorization });
const propose = (over: Partial<Parameters<typeof submitPayrollProposal>[0]> = {}, who: FinanceActor = runner) =>
  submitPayrollProposal(
    { client: tenant.client, changedBy: who.username, actorUserId: who.userId, companyCode: fx.companyCode, fiscalYear: YEAR, period: nextPeriod(), requestKey: `pay-${randomUUID()}`, ...over },
    { authorization: who.authorization },
  );
const recalc = (runId: string) =>
  submitPayrollRecalculation({ client: tenant.client, changedBy: runner.username, actorUserId: runner.userId, runId }, access());
const queuePost = (runId: string) =>
  submitPayrollPosting({ client: tenant.client, changedBy: runner.username, actorUserId: runner.userId, runId, authorization: runner.authorization });

async function drive(options: { heartbeatMs?: number } = {}): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    const claimed = await claimNext('worker-intensive', ['INTENSIVE']);
    if (!claimed) break;
    out.push(await runClaimed('worker-intensive', claimed, options));
  }
  return out;
}

type CalcCtx = Parameters<typeof runPayrollCalcChunk>[0];
type Wrap = (ctx: CalcCtx, real: () => ReturnType<typeof runPayrollCalcChunk>, call: number) => ReturnType<typeof runPayrollCalcChunk>;
function useHandlers(calc?: Wrap, post?: Wrap) {
  clearJobRegistry();
  let c = 0;
  let p = 0;
  registerJob({ code: PAYROLL_CALC_JOB, chunk: (ctx) => { c += 1; return calc ? calc(ctx, () => runPayrollCalcChunk(ctx), c) : runPayrollCalcChunk(ctx); } });
  registerJob({ code: PAYROLL_POST_JOB, chunk: (ctx) => { p += 1; return post ? post(ctx, () => runPayrollPostChunk(ctx), p) : runPayrollPostChunk(ctx); } });
}

/** A context whose first fenced transaction fails with this error, as a refusal inside the business code would. */
function failingFirstFence(ctx: CalcCtx, error: Error): CalcCtx {
  let first = true;
  return { ...ctx, fence: async (tx) => { if (first) { first = false; throw error; } return ctx.fence(tx); } };
}

async function dieAfterCommit(ctx: CalcCtx) {
  await withTenant(tenant.client, (tx) => tx.execute(sql`update job_run set heartbeat_at = now() - interval '5 minutes' where id = ${ctx.runId}`));
  const reaped = await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1000));
  expect(reaped).toContain(ctx.runId);
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  return withTenant(tenant.client, async (tx) => Number(((await tx.execute(query)) as unknown as Array<{ n: number }>)[0]!.n));
}
const resultCount = (runId: string) => count(sql`select count(*)::int as n from payroll_result where client = ${tenant.client} and run_id = ${runId}`);
const stageCount = () => count(sql`select count(*)::int as n from payroll_calc_stage where client = ${tenant.client}`);
async function opRow(operationId: string) {
  const v = await withTenant(tenant.client, (tx) => tx.execute(sql`select o.*, j.status as job_status, j.parameters, j.error_text as job_error, j.progress_text from payroll_run_operation o join job_run j on j.client = o.client and j.id = o.job_run_id where o.client = ${tenant.client} and o.operation_id = ${operationId}`));
  return (v as unknown as Array<Record<string, unknown>>)[0]!;
}
async function expectRefusal(promise: Promise<unknown>, code: string) {
  try { await promise; } catch (error) {
    expect((error as { code?: string }).code, (error as Error).message).toBe(code);
    return error;
  }
  throw new Error(`Expected refusal ${code}`);
}

async function resetJobs() {
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`update payroll_run_operation set status = 'CANCELLED' where client = ${tenant.client} and status in ('QUEUED','RUNNING')`);
    await tx.execute(sql`update payroll_run set status = 'CANCELLED', cancelled_by = 'TEST', cancelled_at = now(), cancel_reason = 'test cleanup' where client = ${tenant.client} and status in ('PROPOSED','RELEASED')`);
    await tx.execute(sql`delete from job_run where client = ${tenant.client} and job_code in (${PAYROLL_CALC_JOB}, ${PAYROLL_POST_JOB}) and status in ('QUEUED','RUNNING','BLOCKED')`);
  });
}

async function structure(): Promise<string> {
  const s = `PB${Date.now().toString(36).slice(-6)}`.slice(0, 10).toUpperCase();
  await defineSalaryStructure({ client: tenant.client, code: s, name: `Background ${s}`, currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  await setStructureComponent({ client: tenant.client, structureCode: s, componentCode: 'SAL', amountKind: 'FIXED', amountValue: '1000', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  return s;
}
async function newEmployee(options: { from?: string; to?: string; withStructure?: boolean } = {}): Promise<string> {
  const pn = await payrollEmployee(fx, { positionFrom: options.from ?? '2024-01-01', ...(options.to ? { positionTo: options.to } : {}) });
  if (options.withStructure !== false) {
    await assignStructure({ client: tenant.client, personnelNumber: pn, structureCode, baseAmount: '1000', currency: fx.currency, validFrom: options.from ?? '2024-01-01', validTo: options.to ?? null, changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  }
  return pn;
}

beforeAll(async () => {
  tenant = await createTenant('payroll-bg');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${tenant.client}, 'SAL', 'Salary', 'EARNING', true, true, ${PAYROLL_ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, created_by) values
        (${tenant.client}, 'SAL', ${fx.chart}, '500000', null, 'ASSIGNMENT', ${PAYROLL_ACTOR}) on conflict do nothing`);
    await tx.execute(sql`delete from account_determination where client = ${tenant.client} and chart_of_accounts = ${fx.chart} and event = 'PAYROLL_NET_PAY'`);
    await tx.execute(sql`insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${tenant.client}, ${fx.chart}, 'PAYROLL_NET_PAY', '', '', '250000', ${PAYROLL_ACTOR})`);
    // Small chunks, so five employees take three chunks and a crash can fall between them.
    await tx.execute(sql`update job_definition set chunk_size = 2 where code = ${PAYROLL_CALC_JOB}`);
  });
  await maintainNumberRange({
    client: tenant.client, objectCode: 'RF_BELEG', companyCode: fx.companyCode, subObject: 'GENERAL', fiscalYear: 0,
    prefix: 'PR', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE',
    mode: 'CREATE', changedBy: 'TEST', reason: 'Payroll background test setup',
  });
  structureCode = await structure();
  for (let i = 0; i < 5; i += 1) employees.push(await newEmployee());
  runner = await createFinanceActor(tenant.client, { capabilities: CAPS });
}, 180_000);

afterEach(async () => {
  clearJobRegistry();
  await resetJobs();
});

afterAll(async () => {
  await withTenant(tenant.client, (tx) => tx.execute(sql`update job_definition set chunk_size = 50 where code = ${PAYROLL_CALC_JOB}`)).catch(() => undefined);
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('submission', () => {
  it('returns QUEUED at once with only the operation id in the queue; nothing is calculated in the request', async () => {
    const op = await propose();
    expect(op.status).toBe('QUEUED');
    const row = await opRow(op.operationId);
    expect(row.parameters).toEqual({ operationId: op.operationId });
    expect(row.job_status).toBe('QUEUED');
    expect(await resultCount(op.runId)).toBe(0);
    expect(await stageCount()).toBe(0);
    expect(await claimNext('worker-regular', ['DEFAULT', 'MAIL', 'OUTPUT'])).toBeNull();
    // The run exists as PROPOSED, but it cannot be released, posted, recalculated twice, or cancelled underneath the job.
    const r = { client: tenant.client, runId: op.runId, changedBy: runner.username };
    await expectRefusal(releasePayrollRun(r, access()), 'OPERATION_ACTIVE');
    await expectRefusal(cancelPayrollRun({ ...r, reason: 'x' }, access()), 'OPERATION_ACTIVE');
    await expectRefusal(recalculatePayrollRun(r, access()), 'OPERATION_ACTIVE');
    await expectRefusal(postPayrollRun({ client: tenant.client, changedBy: runner.username, runId: op.runId, authorization: runner.authorization }), 'OPERATION_ACTIVE');
  });

  it('duplicate clicks give one operation; a changed scope under the same key is refused', async () => {
    const key = `pay-${randomUUID()}`;
    const p = nextPeriod();
    const [a, b] = await Promise.all([propose({ requestKey: key, period: p }), propose({ requestKey: key, period: p })]);
    expect(b.operationId).toBe(a.operationId);
    expect(await count(sql`select count(*)::int as n from payroll_run_operation where client = ${tenant.client} and request_key = ${key}`)).toBe(1);
    await expectRefusal(propose({ requestKey: key, period: nextPeriod() }), 'REQUEST_REUSED');
    const again = await recalc(a.runId);
    expect(again.operationId).toBe(a.operationId); // an operation is already active for the run
  });

  it('refuses a user outside the company scope or without the capability, before queuing anything', async () => {
    const outside = await createFinanceActor(tenant.client, { capabilities: CAPS, companyScopes: ['ZZZ9'] });
    const before = await count(sql`select count(*)::int as n from payroll_run_operation where client = ${tenant.client}`);
    await expectRefusal(propose({}, outside), 'COMPANY_SCOPE');
    const nobody = await createFinanceActor(tenant.client, { capabilities: ['FIN.JOURNAL.POST'] });
    await expectRefusal(propose({}, nobody), 'PAYROLL_AUTHORITY');
    expect(await count(sql`select count(*)::int as n from payroll_run_operation where client = ${tenant.client}`)).toBe(before);
  });
});

describe('proposal and recalculation', () => {
  it('calculates every employee in chunks, publishes once, and neither releases nor posts', async () => {
    useHandlers();
    const op = await propose();
    expect(await drive()).toEqual(['SUCCEEDED']);
    const done = (await getPayrollOperation(tenant.client, op.operationId, access()))!;
    expect(done).toMatchObject({ status: 'SUCCEEDED', employeesDone: 5, jobStatus: 'SUCCEEDED' });
    const view = (await getPayrollRun(tenant.client, op.runId, access()))!;
    expect(view).toMatchObject({ status: 'PROPOSED', employeeCount: 5, exceptionCount: 0 });
    expect(await resultCount(op.runId)).toBe(5);
    expect(await stageCount()).toBe(0);
    // A person releases; the job did not.
    expect((await releasePayrollRun({ client: tenant.client, runId: op.runId, changedBy: runner.username }, access())).status).toBe('RELEASED');
  });

  it('reports an unready employee as a named exception and blocks release', async () => {
    const pn = await newEmployee({ withStructure: false });
    useHandlers();
    const op = await propose();
    expect(await drive()).toEqual(['SUCCEEDED']);
    const view = (await getPayrollRun(tenant.client, op.runId, access()))!;
    expect(view.exceptions.map((e) => e.personnelNumber)).toContain(pn);
    await expectRefusal(releasePayrollRun({ client: tenant.client, runId: op.runId, changedBy: runner.username }, access()), 'RELEASE_EXCEPTIONS');
    // Remove the cause of the exception for the later tests: delimit the position so later periods ignore it.
    await withTenant(tenant.client, (tx) => tx.execute(sql`update position_assignment set valid_to = '2024-01-02' where client = ${tenant.client} and personnel_number = ${pn}`));
  });

  it('keeps the previous valid proposal while a recalculation runs, and publishes the new one atomically', async () => {
    useHandlers();
    const first = await propose();
    await drive();
    const sixth = await newEmployee();
    employees.push(sixth);
    const op = await recalc(first.runId);
    const seenDuring: number[] = [];
    useHandlers(async (ctx, real, call) => {
      const result = await real();
      // After each chunk but the last, a reader still sees the old, complete proposal.
      if (result.cursor !== null) seenDuring.push(await resultCount(first.runId));
      return result;
    });
    expect(await drive()).toEqual(['SUCCEEDED']);
    expect(seenDuring.length).toBeGreaterThan(0);
    expect(seenDuring.every((n) => n === 5)).toBe(true);
    expect(await resultCount(first.runId)).toBe(6);
    expect((await getPayrollOperation(tenant.client, op.operationId, access()))!.status).toBe('SUCCEEDED');
  });

  it('a failed recalculation leaves the previous proposal intact, ends FAILED, and blocks release until recalculated', async () => {
    useHandlers();
    const first = await propose();
    await drive();
    const before = await resultCount(first.runId);
    const op = await recalc(first.runId);
    useHandlers(async (ctx, real, call) => {
      if (call === 2) return runPayrollCalcChunk(failingFirstFence(ctx, new PayrollRunError('forced failure', 'x', 'FORCED')));
      return real();
    });
    expect(await drive()).toEqual(['FAILED']);
    const failed = (await getPayrollOperation(tenant.client, op.operationId, access()))!;
    expect(failed.status).toBe('FAILED');
    expect(failed.errorText).toContain('forced failure');
    expect(await resultCount(first.runId)).toBe(before);
    expect(await stageCount()).toBe(0);
    await expectRefusal(releasePayrollRun({ client: tenant.client, runId: first.runId, changedBy: runner.username }, access()), 'CALCULATION_INCOMPLETE');
    // A retry from the monitor is refused with a reason and changes nothing.
    const row = await opRow(op.operationId);
    useHandlers();
    await withTenant(tenant.client, (tx) => retryRun(tx, tenant.client, String(row.job_run_id)));
    expect(await drive()).toEqual(['FAILED']);
    expect(String((await opRow(op.operationId)).error_text)).toContain('forced failure');
    expect(await resultCount(first.runId)).toBe(before);
    // A new recalculation (the business retry) completes and re-enables release.
    useHandlers();
    await recalc(first.runId);
    expect(await drive()).toEqual(['SUCCEEDED']);
    expect((await releasePayrollRun({ client: tenant.client, runId: first.runId, changedBy: runner.username }, access())).status).toBe('RELEASED');
  });

  it('keeps off-cycle coverage: employees another live run covers become ALREADY_COVERED, and an all-covered run is closed', async () => {
    const p = nextPeriod();
    useHandlers();
    const first = await propose({ period: p });
    await drive();
    const extra = await newEmployee();
    employees.push(extra);
    const second = await propose({ period: p });
    await drive();
    const view = (await getPayrollRun(tenant.client, second.runId, access()))!;
    expect(view.employeeCount).toBe(1);
    expect(view.predecessorRunId).toBe(first.runId);
    expect(view.exceptions.filter((e) => e.reasonCode === 'ALREADY_COVERED').length).toBe(employees.length - 1);
    expect(view.exceptions.every((e) => e.informational)).toBe(true);
    // Everyone is now covered: a third run has nothing to pay and says so.
    const third = await propose({ period: p });
    expect(await drive()).toEqual(['FAILED']);
    const op = (await getPayrollOperation(tenant.client, third.operationId, access()))!;
    expect(op).toMatchObject({ status: 'FAILED', errorCode: 'ALL_COVERED' });
    expect((await getPayrollRun(tenant.client, third.runId, access()))!.status).toBe('CANCELLED');
  });

  it('fails closed when the submitter loses the grant or is deactivated before the job runs', async () => {
    const other = await createFinanceActor(tenant.client, { capabilities: CAPS });
    const op = await propose({}, other);
    await withTenant(tenant.client, (tx) => tx.update(appUser).set({ isActive: false }).where(eq(appUser.id, other.userId)));
    useHandlers();
    expect(await drive()).toEqual(['FAILED']);
    const failed = (await getPayrollOperation(tenant.client, op.operationId, access()))!;
    expect(failed.status).toBe('FAILED');
    expect(failed.errorText).toMatch(/no longer active/);
    expect(await resultCount(op.runId)).toBe(0);

    const third = await createFinanceActor(tenant.client, { capabilities: CAPS });
    const op2 = await propose({}, third);
    await withTenant(tenant.client, (tx) => tx.execute(sql`delete from role_capability rc using user_role ur where ur.client = ${tenant.client} and ur.user_id = ${third.userId} and rc.client = ur.client and rc.role_code = ur.role_code and rc.capability_code = ${PAYROLL_RUN_CAPABILITY}`));
    expect(await drive()).toEqual(['FAILED']);
    expect((await getPayrollOperation(tenant.client, op2.operationId, access()))!.errorText).toMatch(/do not hold/);
    void roleCapability;
  });
});

describe('cancellation', () => {
  it('cancels a queued operation and its job from the payroll screen', async () => {
    const op = await propose();
    const cancelled = await cancelPayrollOperation({ client: tenant.client, operationId: op.operationId, changedBy: runner.username }, access());
    expect(cancelled.status).toBe('CANCELLED');
    expect((await opRow(op.operationId)).job_status).toBe('CANCELLED');
    // The run is free for a human decision again: it can be cancelled or recalculated.
    expect((await recalc(op.runId)).status).toBe('QUEUED');
  });

  it('an administrator cancelling the queued job in the monitor also ends the operation', async () => {
    const op = await propose();
    const row = await opRow(op.operationId);
    await withTenant(tenant.client, (tx) => requestCancel(tx, tenant.client, String(row.job_run_id)));
    expect((await getPayrollOperation(tenant.client, op.operationId, access()))!.status).toBe('CANCELLED');
  });

  it('cancelling mid-calculation stops at a chunk boundary, drops the staged amounts, and leaves the previous proposal', async () => {
    useHandlers();
    const first = await propose();
    await drive();
    const before = await resultCount(first.runId);
    const op = await recalc(first.runId);
    useHandlers(async (ctx, real, call) => {
      const result = await real();
      if (call === 1) await cancelPayrollOperation({ client: tenant.client, operationId: op.operationId, changedBy: runner.username }, access());
      return result;
    });
    expect(await drive()).toEqual(['CANCELLED']);
    expect((await getPayrollOperation(tenant.client, op.operationId, access()))!.status).toBe('CANCELLED');
    expect(await stageCount()).toBe(0);
    expect(await resultCount(first.runId)).toBe(before);
  });
});

describe('crash windows and leases', () => {
  it('worker dies after a chunk committed but before progress is written: the replay calculates nothing twice', async () => {
    useHandlers(async (ctx, real, call) => {
      const result = await real();
      if (call === 2) await dieAfterCommit(ctx); // chunk 1 of the employees committed its stage rows
      return result;
    });
    const op = await propose();
    const statuses = await drive();
    expect(statuses[0]).toBe('LEASE_LOST');
    expect(statuses.slice(1)).toEqual(['SUCCEEDED']);
    expect(await resultCount(op.runId)).toBe(employees.length);
    expect(await count(sql`select count(distinct personnel_number)::int as n from payroll_result where client = ${tenant.client} and run_id = ${op.runId}`)).toBe(employees.length);
  });

  it('worker dies after the publish committed but before the job is marked SUCCEEDED: the replay changes nothing', async () => {
    let published = 0;
    useHandlers(async (ctx, real) => {
      const result = await real();
      if (result.cursor === null && published === 0) {
        published += 1;
        await dieAfterCommit(ctx);
      }
      return result;
    });
    const op = await propose();
    expect(await drive()).toEqual(['LEASE_LOST', 'SUCCEEDED']);
    expect(await resultCount(op.runId)).toBe(employees.length);
    expect((await getPayrollOperation(tenant.client, op.operationId, access()))!.status).toBe('SUCCEEDED');
  });

  it('a stale owner cannot publish or write after its lease is lost', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let started = false;
    useHandlers(async (ctx, real, call) => {
      if (call === 1) { started = true; await held; }
      return real();
    });
    const op = await propose();
    const a = await claimNext('worker-a', ['INTENSIVE']);
    const aDone = runClaimed('worker-a', a!, { heartbeatMs: 600_000 });
    while (!started) await new Promise((r) => setTimeout(r, 20));
    await withTenant(tenant.client, (tx) => tx.execute(sql`update job_run set heartbeat_at = now() - interval '5 minutes' where id = ${a!.runId}`));
    await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1000));
    const b = await claimNext('worker-b', ['INTENSIVE']);
    expect(await runClaimed('worker-b', b!)).toBe('SUCCEEDED');
    release();
    expect(await aDone).toBe('LEASE_LOST');
    expect(await resultCount(op.runId)).toBe(employees.length);
    expect((await getPayrollOperation(tenant.client, op.operationId, access()))!.status).toBe('SUCCEEDED');
  });

  it('a live calculation longer than the heartbeat timeout is not reaped while another process reaps', async () => {
    useHandlers(async (ctx, real, call) => {
      if (call === 1) await new Promise((r) => setTimeout(r, 2500));
      return real();
    });
    const op = await propose();
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
    expect(await resultCount(op.runId)).toBe(employees.length);
  });
});

describe('posting', () => {
  async function releasedRun() {
    useHandlers();
    const op = await propose({ period: postPeriod() });
    await drive();
    await releasePayrollRun({ client: tenant.client, runId: op.runId, changedBy: runner.username }, access());
    return op.runId;
  }
  const journals = (runId: string) => count(sql`select count(*)::int as n from journal_entry j join payroll_run r on r.client = j.client and r.document_number = j.document_number and r.document_fiscal_year = j.fiscal_year where r.client = ${tenant.client} and r.run_id = ${runId}`);

  it('is refused before release; after release it is queued, blocks other actions, and posts one balanced journal', async () => {
    useHandlers();
    const proposed = await propose();
    await drive();
    await expectRefusal(queuePost(proposed.runId), 'RUN_NOT_RELEASED');

    const runId = await releasedRun();
    const op = await queuePost(runId);
    expect(op.status).toBe('QUEUED');
    expect((await queuePost(runId)).operationId).toBe(op.operationId); // duplicate click
    await expect(postPayrollRun({ client: tenant.client, changedBy: runner.username, runId, authorization: runner.authorization })).rejects.toMatchObject({ code: 'OPERATION_ACTIVE' });
    await expectRefusal(cancelPayrollRun({ client: tenant.client, runId, changedBy: runner.username, reason: 'x' }, access()), 'OPERATION_ACTIVE');

    useHandlers();
    expect(await drive()).toEqual(['SUCCEEDED']);
    const view = (await getPayrollRun(tenant.client, runId, access()))!;
    expect(view.status).toBe('POSTED');
    expect(await journals(runId)).toBe(1);
    const lines = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select sum(case when debit_credit = 'S' then amount_document else 0 end)::text as d, sum(case when debit_credit = 'H' then amount_document else 0 end)::text as c
        from journal_entry_line l join payroll_run r on r.client = l.client and r.document_number = l.document_number and r.document_fiscal_year = l.fiscal_year
       where r.client = ${tenant.client} and r.run_id = ${runId}`)) as unknown as Array<{ d: string; c: string }>;
    expect(lines[0]!.d).toBe(lines[0]!.c);
    expect((await getPayrollOperation(tenant.client, op.operationId, access()))!.status).toBe('SUCCEEDED');
  });

  it('worker dies after the journal committed but before the operation says so: the replay posts nothing again', async () => {
    const runId = await releasedRun();
    const op = await queuePost(runId);
    // The posting commits exactly as the job would do it...
    await postPayrollRun({ client: tenant.client, changedBy: runner.username, runId, exceptOperationId: op.operationId, authorization: runner.authorization });
    expect(await journals(runId)).toBe(1);
    // ...and the job, run afterwards, recognises it instead of posting again.
    useHandlers();
    expect(await drive()).toEqual(['SUCCEEDED']);
    expect(await journals(runId)).toBe(1);
    expect((await getPayrollOperation(tenant.client, op.operationId, access()))!.status).toBe('SUCCEEDED');
  });

  it('worker dies after the final commit but before the job is SUCCEEDED: the replay is a no-op', async () => {
    const runId = await releasedRun();
    const op = await queuePost(runId);
    let died = false;
    useHandlers(undefined, async (ctx, real) => {
      const result = await real();
      if (!died) { died = true; await dieAfterCommit(ctx); }
      return result;
    });
    expect(await drive()).toEqual(['LEASE_LOST', 'SUCCEEDED']);
    expect(await journals(runId)).toBe(1);
    expect((await getPayrollOperation(tenant.client, op.operationId, access()))!.status).toBe('SUCCEEDED');
  });

  it('a revoked grant fails the posting closed, posts nothing, and a monitor retry is refused', async () => {
    const runId = await releasedRun();
    const poster = await createFinanceActor(tenant.client, { capabilities: CAPS });
    const op = await submitPayrollPosting({ client: tenant.client, changedBy: poster.username, actorUserId: poster.userId, runId, authorization: poster.authorization });
    await withTenant(tenant.client, (tx) => tx.execute(sql`delete from role_capability rc using user_role ur where ur.client = ${tenant.client} and ur.user_id = ${poster.userId} and rc.client = ur.client and rc.role_code = ur.role_code and rc.capability_code = 'PEOPLE.PAYROLL.POST'`));
    useHandlers();
    expect(await drive()).toEqual(['FAILED']);
    const failed = (await getPayrollOperation(tenant.client, op.operationId, access()))!;
    expect(failed.status).toBe('FAILED');
    expect(await journals(runId)).toBe(0);
    expect((await getPayrollRun(tenant.client, runId, access()))!.status).toBe('RELEASED');
    // Retry from the monitor: refused, the run is still not posted.
    const row = await opRow(op.operationId);
    await withTenant(tenant.client, (tx) => retryRun(tx, tenant.client, String(row.job_run_id)));
    expect(await drive()).toEqual(['FAILED']);
    expect(await journals(runId)).toBe(0);
    // The business retry: post again as somebody who may.
    const again = await queuePost(runId);
    expect(again.operationId).not.toBe(op.operationId);
    expect(await drive()).toEqual(['SUCCEEDED']);
    expect(await journals(runId)).toBe(1);
  });
});

describe('what the generic job tables hold', () => {
  it('carries no employee numbers, amounts or reasons in parameters, progress, results, errors or logs', async () => {
    const pn = await newEmployee({ withStructure: false }); // produces an exception and a named reason
    useHandlers();
    const op = await propose();
    await drive();
    const row = await opRow(op.operationId);
    const logs = (await withTenant(tenant.client, (tx) => tx.execute(sql`select message, context::text as context from job_log where client = ${tenant.client} and job_run_id = ${String(row.job_run_id)}`))) as unknown as Array<{ message: string; context: string }>;
    const job = (await withTenant(tenant.client, (tx) => tx.execute(sql`select parameters::text as p, progress_text, result_summary, error_text, cursor::text as cursor from job_run where client = ${tenant.client} and id = ${String(row.job_run_id)}`))) as unknown as Array<Record<string, string | null>>;
    const blob = JSON.stringify([logs, job[0]]);
    expect(blob).not.toContain(pn);
    for (const e of employees) expect(blob).not.toContain(e);
    expect(blob).not.toMatch(/1000(\.\d+)?/);
    await withTenant(tenant.client, (tx) => tx.execute(sql`update position_assignment set valid_to = '2024-01-02' where client = ${tenant.client} and personnel_number = ${pn}`));

    // A failure's reason (which can name an employee) is on the operation, and the job says only a fixed sentence.
    const failing = await propose();
    useHandlers(async (ctx, real, call) => {
      if (call === 1) return runPayrollCalcChunk(failingFirstFence(ctx, new PayrollRunError(`Employee ${employees[0]} is secret`, 'x', 'FORCED')));
      return real();
    });
    await drive();
    const failedRow = await opRow(failing.operationId);
    expect(String(failedRow.error_text)).toContain(employees[0]!);
    expect(String(failedRow.job_error)).not.toContain(employees[0]!);
    expect(String(failedRow.job_error)).toContain('payroll run screen');
    void listPayrollOperations; void listResults; void PayrollPostingError;
  });
});
