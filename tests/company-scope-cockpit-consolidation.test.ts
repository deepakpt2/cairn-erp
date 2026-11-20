/**
 * Company-scope authorization of the close cockpit (task-list reads and changes), the accrual lists it uses, the
 * GR/IR run read, and the consolidation workbench and monitor (reads, runs and cancels).
 *
 * Companies A (1000) and B (2000), real persisted sessions. A refusal must not disclose the other company, a
 * consolidation group is refused as a whole when any of its units' companies is out of scope, and a missing
 * restriction list is never treated as unrestricted.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  createTaskListFromTemplate, executeTask, finalizeTaskList, getTaskList, listEvents, listExecutions,
  listTaskLists, listTasks, overrideTaskStatus, releaseTaskList, upsertTemplateTask,
} from '../src/modules/finance/close-cockpit';
import { getAccrualDocument, listAccrualDocuments, listDueAccruals } from '../src/modules/finance/accrual';
import { executeGrIrAnalysis, getGrIrRun } from '../src/modules/finance/grir-reclass';
import {
  activateArea, assignUnit, getConsolidationWorkbench, listConsolidationAreas, saveArea, saveDataBasis,
  saveGroup, saveMethod, saveTask, saveUnit, saveVersion,
} from '../src/modules/finance/consolidation-workbench';
import {
  cancelConsolidationExecution, executeConsolidationTask, executeConsolidationTaskGroup,
  getConsolidationMonitor, type ConsolidationMonitorSelection,
} from '../src/modules/finance/consolidation-monitor';
import { createFinanceActor, FINANCE_ACTOR_CAPABILITIES, type FinanceActor } from './helpers/finance-actor';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

const ACTOR = { changedBy: 'SCOPE-COCKPIT', reason: 'company-scope adversarial test' };
const A = '1000';
const B = '2000';

let tenant: TestTenant;
let other: TestTenant;
let client = '';
let onlyA: FinanceActor;
let onlyB: FinanceActor;
let both: FinanceActor;
let noCapability: FinanceActor;
let noScope: FinanceActor;
let plantLimited: FinanceActor;
let otherTenantActor: FinanceActor;
let runA = '';
let runB = '';

const cycle = (company: string) => ({ companyCode: company, taskListId: `SC_${company}`, fiscalYear: 2026, postingPeriod: 4 });
const sel = (group: string, overrides: Partial<ConsolidationMonitorSelection> = {}): ConsolidationMonitorSelection => ({
  area: 'CSC1', group, version: '100', fiscalYear: 2026, period: group === 'GALL' ? 12 : 6, taskGroup: '', unit: '', mode: 'TEST',
  warningPolicy: 'BLOCK_ON_WARNING', ...overrides,
});

/** The refusal is thrown and does not disclose existence. */
async function refused(p: Promise<unknown>, pattern: RegExp = /scope|Company Code|capabilit|authori|session|signed-in|not hold|No company/i) {
  try { await p; } catch (error) {
    expect((error as Error).message).toMatch(pattern);
    expect((error as Error).message).not.toMatch(/does not stand/);
    return;
  }
  throw new Error('Expected a refusal, nothing was thrown.');
}

async function count(table: string): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql.raw(`select count(*)::int as n from ${table} where client = '${client}'`));
    return Number((rows as unknown as Array<{ n: number }>)[0]!.n);
  });
}

beforeAll(async () => {
  tenant = await createTenant('scope-cockpit');
  client = tenant.client;
  other = await createTenant('scope-cockpit-2');
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by)
      select client, ${B}, 'B company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, ${ACTOR.changedBy}
        from company_code where client = ${client} and company_code = ${A} on conflict do nothing`);
    const country = ((await tx.execute(sql`select country from company_code where client = ${client} and company_code = ${A}`)) as unknown as Array<{ country: string }>)[0]!.country;
    await tx.execute(sql`
      insert into plant (client, plant, name, country, company_code, created_by) values
        (${client}, 'PLA1', 'Plant A1', ${country}, ${A}, ${ACTOR.changedBy}), (${client}, 'PLA2', 'Plant A2', ${country}, ${A}, ${ACTOR.changedBy}),
        (${client}, 'PLB1', 'Plant B1', ${country}, ${B}, ${ACTOR.changedBy}), (${client}, 'PLB2', 'Plant B2', ${country}, ${B}, ${ACTOR.changedBy})
      on conflict do nothing`);
  });
  const caps = FINANCE_ACTOR_CAPABILITIES;
  onlyA = await createFinanceActor(client, { capabilities: caps, companyScopes: [A] });
  onlyB = await createFinanceActor(client, { capabilities: caps, companyScopes: [B] });
  both = await createFinanceActor(client, { capabilities: caps, companyScopes: [A, B] });
  noCapability = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
  noScope = await createFinanceActor(client, { capabilities: caps, companyScopes: [] });
  plantLimited = await createFinanceActor(client, { capabilities: caps, companyScopes: [A, B], plantScopes: ['PLA1', 'PLB1'] });
  otherTenantActor = await createFinanceActor(other.client, { capabilities: caps });

  // Close cockpit: one list per company.
  await upsertTemplateTask({
    client, changedBy: ACTOR.changedBy, templateCode: 'SC_TPL',
    task: { taskId: 'P10', taskName: 'Period status', handlerCode: 'PERIOD_STATUS' } as never, predecessors: [],
  });
  for (const company of [A, B]) {
    await createTaskListFromTemplate({
      client, changedBy: ACTOR.changedBy, cycle: cycle(company), templateCode: 'SC_TPL', authorization: both.authorization,
    });
  }

  // GR/IR: one persisted analysis run per company.
  const grir = (company: string) => executeGrIrAnalysis({
    client, changedBy: ACTOR.changedBy,
    selection: { companyCode: company, keyDate: '2026-04-30', testRun: true, createAccruals: false, requestKey: `scope-grir-${company}` } as never,
  }, { authorization: both.authorization });
  runA = (await grir(A)).runId;
  runB = (await grir(B)).runId;

  // Consolidation: area CS with unit UA (company A) and UB (company B); groups GA, GB and GALL.
  const variant = (await withTenant(client, async (tx) => tx.execute(sql`
    select fiscal_year_variant from company_code where client = ${client} and company_code = ${A}`)) as unknown as Array<{ fiscal_year_variant: string }>)[0]!.fiscal_year_variant;
  const c = { client, ...ACTOR };
  await saveDataBasis({ ...c, basis: 'BS', title: 'Journal', dimensions: [{ dimension: 'COMPANY_CODE' }] });
  await saveArea({ ...c, area: 'CSC1', title: 'Scope area', dataBasis: 'BS', consChart: 'GC01', fiscalYearVariant: variant });
  await saveUnit({ ...c, area: 'CSC1', unit: 'UA', title: 'Unit A', companyCode: A });
  await saveUnit({ ...c, area: 'CSC1', unit: 'UB', title: 'Unit B', companyCode: B });
  for (const [group, units] of [['GA', ['UA']], ['GB', ['UB']], ['GALL', ['UA', 'UB']]] as const) {
    await saveGroup({ ...c, area: 'CSC1', group, title: group });
    // A unit stands in one group at a time: GA and GB hold their unit in H1, GALL holds both in H2.
    const [validFrom, validTo] = group === 'GALL' ? ['2026-07-01', '2026-12-31'] : ['2026-01-01', '2026-06-30'];
    for (const unit of units) await assignUnit({ ...c, area: 'CSC1', group, unit, validFrom, validTo });
  }
  await saveMethod({ ...c, area: 'CSC1', method: 'MVAL', kind: 'OTHER', title: 'Collect' });
  await saveVersion({ ...c, area: 'CSC1', version: '100', title: 'Actual' });
  for (const unit of ['UA', 'UB']) {
    await saveTask({ ...c, area: 'CSC1', version: '100', task: `T_${unit}`, sequence: 10, taskType: 'DATA_COLLECTION', method: 'MVAL', unit, group: '', validFrom: '2026-01-01', validTo: '2026-12-31' });
  }
  await activateArea({ ...c, area: 'CSC1' });
}, 300_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  if (other) await destroyTenant(other.client);
  await closeDb();
}, 300_000);

describe('close cockpit is company-scoped', () => {
  it('reads only the lists of companies in scope, and refuses a cycle outside it', async () => {
    const a = await listTaskLists(client, onlyA.authorization);
    expect(a.map((l) => l.companyCode)).toEqual([A]);
    expect((await listTaskLists(client, both.authorization)).map((l) => l.companyCode).sort()).toEqual([A, B]);
    expect(await listTaskLists(client, noScope.authorization)).toEqual([]);
    expect(await listTaskLists(client, undefined)).toEqual([]);
    expect(await listTaskLists(client, otherTenantActor.authorization)).toEqual([]);

    await refused(getTaskList(client, cycle(B), onlyA.authorization), /does not cover company code 2000/);
    await refused(listTasks(client, cycle(B), {}, onlyA.authorization));
    await refused(listExecutions(client, cycle(B), undefined, onlyA.authorization));
    await refused(listEvents(client, cycle(B), onlyA.authorization));
    for (const bad of [noCapability, noScope, plantLimited]) await refused(getTaskList(client, cycle(A), bad.authorization));
    await refused(getTaskList(client, cycle(A), undefined));
    await refused(getTaskList(client, cycle(A), otherTenantActor.authorization));
    expect((await getTaskList(client, cycle(B), onlyB.authorization)).companyCode).toBe(B);
    expect((await listTasks(client, cycle(A), {}, onlyA.authorization)).length).toBe(1);
  });

  it('changes nothing in another company: release, override, execute and finalize are refused and leave no trace', async () => {
    const before = { events: await count('closing_task_event'), logs: await count('closing_execution_log') };
    const snapshot = async () => (await getTaskList(client, cycle(B), both.authorization)).status;
    const status = await snapshot();
    await refused(releaseTaskList({ client, changedBy: ACTOR.changedBy, cycle: cycle(B), authorization: onlyA.authorization }), /company code 2000/);
    await refused(overrideTaskStatus({ client, changedBy: ACTOR.changedBy, cycle: cycle(B), taskId: 'P10', newStatus: 'COMPLETED', reason: 'x', authorization: onlyA.authorization }));
    await refused(executeTask({ client, changedBy: ACTOR.changedBy, cycle: cycle(B), taskId: 'P10', mode: 'FOREGROUND', authorization: onlyA.authorization }));
    await refused(finalizeTaskList({ client, changedBy: ACTOR.changedBy, cycle: cycle(B), authorization: noScope.authorization }));
    await refused(releaseTaskList({ client, changedBy: ACTOR.changedBy, cycle: cycle(B), authorization: undefined }));
    await refused(createTaskListFromTemplate({ client, changedBy: ACTOR.changedBy, cycle: { ...cycle(B), taskListId: 'SC_NEW' }, templateCode: 'SC_TPL', authorization: onlyA.authorization }));
    expect(await snapshot()).toBe(status);
    expect({ events: await count('closing_task_event'), logs: await count('closing_execution_log') }).toEqual(before);
    expect((await releaseTaskList({ client, changedBy: ACTOR.changedBy, cycle: cycle(B), authorization: onlyB.authorization })).status).toBe('RELEASED');
  });

  it('accrual lists never include a company outside the scope', async () => {
    expect(await listDueAccruals(client, '2030-01-01', onlyA.authorization)).toEqual([]);
    expect(await listAccrualDocuments(client, noScope.authorization)).toEqual([]);
    expect(await listAccrualDocuments(client, undefined)).toEqual([]);
    expect(await getAccrualDocument(client, B, 'X', 2026, onlyA.authorization)).toBeNull();
  });
});

describe('GR/IR run read is company-scoped', () => {
  it('hides a run of another company, as not found', async () => {
    expect((await getGrIrRun(client, runA, onlyA.authorization))?.companyCode).toBe(A);
    expect(await getGrIrRun(client, runB, onlyA.authorization)).toBeNull();
    expect(await getGrIrRun(client, runA, undefined)).toBeNull();
    expect(await getGrIrRun(client, runA, noScope.authorization)).toBeNull();
    expect(await getGrIrRun(client, runA, noCapability.authorization)).toBeNull();
    expect(await getGrIrRun(client, runA, otherTenantActor.authorization)).toBeNull();
    expect((await getGrIrRun(client, runB, onlyB.authorization))?.companyCode).toBe(B);
  });
});

describe('consolidation workbench and monitor are company-scoped', () => {
  it('shows an area only to a session whose scope covers every unit company', async () => {
    expect((await listConsolidationAreas(client, both.authorization)).map((x) => x.area)).toEqual(['CSC1']);
    expect(await listConsolidationAreas(client, onlyA.authorization)).toEqual([]); // unit UB is company B
    expect(await getConsolidationWorkbench(client, 'CSC1', onlyA.authorization)).toBeNull();
    expect(await getConsolidationWorkbench(client, 'CSC1', undefined)).toBeNull();
    expect(await getConsolidationWorkbench(client, 'CSC1', noScope.authorization)).toBeNull();
    expect(await getConsolidationWorkbench(client, 'CSC1', noCapability.authorization)).toBeNull();
    expect(await getConsolidationWorkbench(client, 'CSC1', otherTenantActor.authorization)).toBeNull();
    expect((await getConsolidationWorkbench(client, 'CSC1', both.authorization))?.units.map((u) => u.companyCode).sort()).toEqual([A, B]);
  });

  it('refuses a group whole when any unit company is out of scope, and names no derived company', async () => {
    await refused(getConsolidationMonitor(client, sel('GALL'), false, onlyA.authorization), /scope|Company Code/i);
    try { await getConsolidationMonitor(client, sel('GALL'), false, onlyA.authorization); } catch (e) {
      expect((e as Error).message).not.toContain(B);
    }
    await refused(getConsolidationMonitor(client, sel('GB'), false, onlyA.authorization));
    await refused(getConsolidationMonitor(client, sel('GA'), false, undefined));
    await refused(getConsolidationMonitor(client, sel('GA'), false, noScope.authorization));
    await refused(getConsolidationMonitor(client, sel('GA'), false, noCapability.authorization));
    await refused(getConsolidationMonitor(client, sel('GA'), false, plantLimited.authorization));
    expect((await getConsolidationMonitor(client, sel('GA'), false, onlyA.authorization)).rows).toHaveLength(1);
    expect((await getConsolidationMonitor(client, sel('GALL'), false, both.authorization)).rows.length).toBeGreaterThan(0);
  });

  it('runs, group-runs and cancels nothing across a company boundary, leaving no execution rows', async () => {
    const before = await count('consolidation_execution');
    await refused(executeConsolidationTask({ client, executedBy: 'x', selection: sel('GB', { unit: 'UB' }), task: 'T_UB', unit: 'UB', authorization: onlyA.authorization }));
    await refused(executeConsolidationTask({ client, executedBy: 'x', selection: sel('GA', { unit: 'UA' }), task: 'T_UA', unit: 'UA', authorization: undefined }));
    await refused(executeConsolidationTaskGroup({ client, executedBy: 'x', selection: sel('GALL'), taskGroup: 'T_UA', errorPolicy: 'STOP_ON_ERROR', authorization: onlyA.authorization }));
    expect(await count('consolidation_execution')).toBe(before);

    const ran = await executeConsolidationTask({ client, executedBy: 'x', selection: sel('GB', { unit: 'UB' }), task: 'T_UB', unit: 'UB', authorization: onlyB.authorization });
    expect(ran.task).toBe('T_UB');

    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into consolidation_execution
          (client, run_id, area, group_name, unit, unit_scope, version, fiscal_year, period, task,
           configuration_version, configuration_snapshot, attempt_number, mode, status, executed_by, result_summary)
        values (${client}, 'SCRUNB', 'CSC1', 'GB', 'UB', 'UB', '100', 2026, 12, 'T_UB', 'fixture', '{}', 99, 'UPDATE', 'RUNNING', 'x', 'fixture')`);
    });
    await refused(cancelConsolidationExecution({ client, executedBy: 'x', runId: 'SCRUNB', authorization: onlyA.authorization }));
    const still = await withTenant(client, async (tx) => tx.execute(sql`select status from consolidation_execution where client = ${client} and run_id = 'SCRUNB'`)) as unknown as Array<{ status: string }>;
    expect(still[0]!.status).toBe('RUNNING');
    expect((await cancelConsolidationExecution({ client, executedBy: 'x', runId: 'SCRUNB', authorization: onlyB.authorization })).status).toBe('CANCELLED');
  });
});
