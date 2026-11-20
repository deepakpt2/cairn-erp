/**
 * Company-configured components through the intensive worker (9318): the background calculation reads the same
 * recurring entries and approved one-time adjustments, applies an adjustment exactly once across retries and
 * recalculations, and a change after the calculation started leaves the proposal stale until recalculated.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { claimNext, runClaimed } from '../src/platform/job/execute';
import { clearJobRegistry, registerJob } from '../src/platform/job/registry';
import {
  PAYROLL_CALC_JOB,
  PAYROLL_POST_JOB,
  runPayrollCalcChunk,
  runPayrollPostChunk,
  submitPayrollProposal,
  submitPayrollRecalculation,
} from '../src/modules/people/payroll-background';
import {
  ADJUSTMENT_APPROVE_CAPABILITY,
  ADJUSTMENT_ENTER_CAPABILITY,
  COMPONENT_MAINTAIN_CAPABILITY,
  addEmployeeComponent,
  decideAdjustment,
  enterAdjustment,
  listAdjustments,
} from '../src/modules/people/payroll-components';
import { PAYROLL_RUN_CAPABILITY, cancelPayrollRun, getPayrollRun, getResultWithLines, listResults, releasePayrollRun } from '../src/modules/people/payroll-run';
import { assignStructure, defineSalaryStructure, setStructureComponent } from '../src/modules/people/payroll-structure';
import { PAYROLL_ACTOR, PAYROLL_AUTH, buildPayrollFixture, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const YEAR = 2025;
let tenant: TestTenant;
let fx: PayrollFixture;
let runner: FinanceActor;
let pn: string;
let period = 0;
const nextPeriod = () => ++period;

const access = () => ({ authorization: runner.authorization });
const propose = () => submitPayrollProposal(
  { client: tenant.client, changedBy: runner.username, actorUserId: runner.userId, companyCode: fx.companyCode, fiscalYear: YEAR, period: nextPeriod(), requestKey: `bgc-${period}-${Date.now()}` },
  access(),
);
const recalc = (runId: string) => submitPayrollRecalculation({ client: tenant.client, changedBy: runner.username, actorUserId: runner.userId, runId }, access());

async function drive(): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const claimed = await claimNext('worker-intensive', ['INTENSIVE']);
    if (!claimed) break;
    out.push(await runClaimed('worker-intensive', claimed, {}));
  }
  return out;
}
const lineSources = async (runId: string) => {
  const [r] = await listResults(tenant.client, runId, pn, [PAYROLL_RUN_CAPABILITY]);
  return (await getResultWithLines(tenant.client, r!.resultId, [PAYROLL_RUN_CAPABILITY]))!.lines;
};

beforeAll(async () => {
  tenant = await createTenant('pay-comp-bg');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${tenant.client}, 'SAL', 'Salary', 'EARNING', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ADV', 'Advance recovery', 'DEDUCTION', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'BONUS', 'Bonus', 'EARNING', true, true, ${PAYROLL_ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, created_by) values
        (${tenant.client}, 'SAL', ${fx.chart}, '500000', null, 'ASSIGNMENT', ${PAYROLL_ACTOR}),
        (${tenant.client}, 'BONUS', ${fx.chart}, '500000', null, 'ASSIGNMENT', ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ADV', ${fx.chart}, null, '250000', 'NONE', ${PAYROLL_ACTOR}) on conflict do nothing`);
  });
  await defineSalaryStructure({ client: tenant.client, code: 'BGS', name: 'Background', currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  await setStructureComponent({ client: tenant.client, structureCode: 'BGS', componentCode: 'SAL', amountKind: 'FIXED', amountValue: '1000', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  pn = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
  await assignStructure({ client: tenant.client, personnelNumber: pn, structureCode: 'BGS', baseAmount: '1000', currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  runner = await createFinanceActor(tenant.client, { capabilities: [PAYROLL_RUN_CAPABILITY, 'PEOPLE.PAYROLL.POST', 'FIN.JOURNAL.POST'] });
  clearJobRegistry();
  registerJob({ code: PAYROLL_CALC_JOB, chunk: (ctx) => runPayrollCalcChunk(ctx) });
  registerJob({ code: PAYROLL_POST_JOB, chunk: (ctx) => runPayrollPostChunk(ctx) });
}, 180_000);

afterEach(async () => {
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`update payroll_run set status = 'CANCELLED', cancelled_by = 'TEST', cancelled_at = now(), cancel_reason = 'cleanup' where client = ${tenant.client} and status in ('PROPOSED')`);
  });
});

afterAll(async () => {
  clearJobRegistry();
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('background calculation with company-configured components', () => {
  it('picks up an active recurring entry and an approved adjustment exactly once; pending ones are left out; a later change makes the proposal stale', async () => {
    await addEmployeeComponent({
      client: tenant.client, personnelNumber: pn, componentCode: 'ADV', mode: 'ADD', amountKind: 'FIXED', amountValue: '10', currency: fx.currency,
      validFrom: '2024-01-01', prorationPolicy: 'PAYABLE_CALENDAR_DAYS', reason: 'Agreed recovery', changedBy: 'HR1',
    }, [COMPONENT_MAINTAIN_CAPABILITY]);
    const approved = await enterAdjustment({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 1, personnelNumber: pn, componentCode: 'BONUS', amount: '50', reason: 'Award', changedBy: 'CLERK' }, [ADJUSTMENT_ENTER_CAPABILITY]);
    await decideAdjustment({ client: tenant.client, adjustmentId: approved.adjustmentId, decision: 'APPROVE', changedBy: 'BOSS' }, [ADJUSTMENT_APPROVE_CAPABILITY]);
    const pending = await enterAdjustment({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 1, personnelNumber: pn, componentCode: 'BONUS', amount: '70', reason: 'Not yet approved', changedBy: 'CLERK' }, [ADJUSTMENT_ENTER_CAPABILITY]);

    const op = await propose();
    expect(op.status).toBe('QUEUED');
    await drive();
    const run = (await getPayrollRun(tenant.client, op.runId, [PAYROLL_RUN_CAPABILITY]))!;
    expect(run.staleReasons).toEqual([]);
    expect(run.pendingAdjustments).toBe(1);
    const lines = await lineSources(op.runId);
    expect(lines.filter((l) => l.sourceType === 'ONE_TIME').map((l) => [l.sourceId, l.amount])).toEqual([[approved.adjustmentId, '50.0000']]);
    expect(lines.filter((l) => l.sourceType === 'EMPLOYEE_ADD').map((l) => [l.componentCode, l.amount])).toEqual([['ADV', '10.0000']]);
    expect(lines.some((l) => l.sourceId === pending.adjustmentId)).toBe(false);

    // A background recalculation is a retry of the same inputs: still once.
    await recalc(op.runId);
    await drive();
    expect((await lineSources(op.runId)).filter((l) => l.sourceType === 'ONE_TIME')).toHaveLength(1);

    // A change after the calculation makes the proposal stale; the release is refused until a recalculation.
    await addEmployeeComponent({
      client: tenant.client, personnelNumber: pn, componentCode: 'BONUS', mode: 'ADD', amountKind: 'FIXED', amountValue: '5', currency: fx.currency,
      validFrom: '2025-01-01', prorationPolicy: 'FULL_PERIOD', reason: 'Second entry', changedBy: 'HR1',
    }, [COMPONENT_MAINTAIN_CAPABILITY]);
    const stale = (await getPayrollRun(tenant.client, op.runId, [PAYROLL_RUN_CAPABILITY]))!;
    expect(stale.staleReasons.join(' ')).toContain(pn);
    await expect(releasePayrollRun({ client: tenant.client, runId: op.runId, changedBy: PAYROLL_ACTOR, acknowledgePending: true }, [PAYROLL_RUN_CAPABILITY])).rejects.toMatchObject({ code: 'RUN_STALE_INPUTS' });
    await recalc(op.runId);
    await drive();
    expect((await getPayrollRun(tenant.client, op.runId, [PAYROLL_RUN_CAPABILITY]))!.staleReasons).toEqual([]);

    const released = await releasePayrollRun({ client: tenant.client, runId: op.runId, changedBy: PAYROLL_ACTOR, acknowledgePending: true }, [PAYROLL_RUN_CAPABILITY]);
    expect(released.status).toBe('RELEASED');
    const stored = await listAdjustments(tenant.client, { personnelNumber: pn }, [ADJUSTMENT_ENTER_CAPABILITY]);
    expect(stored.find((a) => a.adjustmentId === approved.adjustmentId)).toMatchObject({ status: 'APPLIED', appliedRunId: op.runId });
    expect(stored.find((a) => a.adjustmentId === pending.adjustmentId)?.status).toBe('PENDING');
    await cancelPayrollRun({ client: tenant.client, runId: op.runId, reason: 'cleanup', changedBy: PAYROLL_ACTOR }, [PAYROLL_RUN_CAPABILITY]);
  }, 240_000);
});
