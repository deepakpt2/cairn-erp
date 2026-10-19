/**
 * SCR-117 / R-165 stage 5 — consolidation monitor (CX20).
 *
 * UCWB configuration drives order and prerequisites. Attempts
 * are immutable history, current status stands separately,
 * test runs never satisfy update prerequisites, unsupported
 * engines block by name, and no journal is posted.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  activateArea, assignUnit, saveArea, saveDataBasis, saveGroup,
  saveGroupAccount, saveMapping, saveMethod, saveTask, saveUnit, saveVersion,
} from '../src/modules/finance/consolidation-workbench';
import {
  cancelConsolidationExecution, executeConsolidationTask,
  executeConsolidationTaskGroup, getConsolidationMonitor,
  type ConsolidationMonitorSelection,
} from '../src/modules/finance/consolidation-monitor';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = { changedBy: 'SCR117-TEST', reason: 'SCR-117 automated backend test' };
let tenant: TestTenant | undefined;
let client = '';
let variant = 'K4';

const selection = (overrides: Partial<ConsolidationMonitorSelection> = {}): ConsolidationMonitorSelection => ({
  area: 'C100', group: 'GRP1', version: '100', fiscalYear: 2026, period: 12,
  taskGroup: '', unit: 'U1000', mode: 'TEST', warningPolicy: 'BLOCK_ON_WARNING',
  ...overrides,
});

beforeAll(async () => {
  tenant = await createTenant('scr117-cx20');
  client = tenant.client;
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select fiscal_year_variant from company_code where client = ${client} and company_code = '1000'
    `) as unknown as Array<{ fiscal_year_variant: string }>;
    variant = rows[0]?.fiscal_year_variant ?? 'K4';
  });
  await saveDataBasis({ client, ...ACTOR, basis: 'BASIS1', title: 'Journal basis', dimensions: [{ dimension: 'COMPANY_CODE' }] });
  await saveArea({ client, ...ACTOR, area: 'C100', title: 'Group consolidation', dataBasis: 'BASIS1', consChart: 'GC01', fiscalYearVariant: variant });
  await saveUnit({ client, ...ACTOR, area: 'C100', unit: 'U1000', title: 'Unit one', companyCode: '1000' });
  await saveGroup({ client, ...ACTOR, area: 'C100', group: 'GRP1', title: 'Group' });
  await assignUnit({ client, ...ACTOR, area: 'C100', group: 'GRP1', unit: 'U1000', validFrom: '2026-01-01', validTo: '2026-12-31' });
  await saveGroupAccount({ client, ...ACTOR, consChart: 'GC01', account: '100000', title: 'Group assets' });
  await saveMapping({ client, ...ACTOR, consChart: 'GC01', sourceChart: 'CA01', sourceFrom: '110000', sourceTo: '110000', groupAccount: '100000' });
  await saveMethod({ client, ...ACTOR, area: 'C100', method: 'MVAL', kind: 'OTHER', title: 'Collect and validate' });
  await saveMethod({ client, ...ACTOR, area: 'C100', method: 'MFX', kind: 'CURRENCY_TRANSLATION', title: 'Translate' });
  await saveVersion({ client, ...ACTOR, area: 'C100', version: '100', title: 'Actual' });
  await saveTask({ client, ...ACTOR, area: 'C100', version: '100', task: 'T100', sequence: 10, taskType: 'DATA_COLLECTION', method: 'MVAL', unit: 'U1000', group: 'GRP1', validFrom: '2026-01-01', validTo: '2026-12-31' });
  await saveTask({ client, ...ACTOR, area: 'C100', version: '100', task: 'T200', parentTask: 'T100', sequence: 20, taskType: 'VALIDATION', method: 'MVAL', unit: 'U1000', group: 'GRP1', validFrom: '2026-01-01', validTo: '2026-12-31' });
  await saveTask({ client, ...ACTOR, area: 'C100', version: '100', task: 'T300', parentTask: 'T200', sequence: 30, taskType: 'CURRENCY_TRANSLATION', method: 'MFX', unit: 'U1000', group: 'GRP1', validFrom: '2026-01-01', validTo: '2026-12-31' });
  await activateArea({ client, ...ACTOR, area: 'C100' });
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
}, 180_000);

describe('SCR-117 consolidation monitor (R-165)', () => {
  it('rejects an undefined consolidation period', async () => {
    await expect(getConsolidationMonitor(client, selection({ period: 20 })))
      .rejects.toThrow(/not defined by fiscal year variant/);
  });

  it('blocks a child until its parent succeeds in the same mode, with warning policy applied', async () => {
    const blocked = await executeConsolidationTask({ client, executedBy: ACTOR.changedBy, selection: selection(), task: 'T200', unit: 'U1000' });
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.resultSummary).toMatch(/Prerequisite task T100/);

    const parent = await executeConsolidationTask({ client, executedBy: ACTOR.changedBy, selection: selection(), task: 'T100', unit: 'U1000' });
    expect(parent.status).toBe('WARNING'); // no journal lines stand yet
    expect(parent.processedCount).toBe(0);

    const stillBlocked = await executeConsolidationTask({ client, executedBy: ACTOR.changedBy, selection: selection(), task: 'T200', unit: 'U1000' });
    expect(stillBlocked.status).toBe('BLOCKED');
    expect(stillBlocked.resultSummary).toMatch(/warning policy blocks/);

    const allowed = await executeConsolidationTask({
      client, executedBy: ACTOR.changedBy,
      selection: selection({ warningPolicy: 'ALLOW_WARNINGS' }), task: 'T200', unit: 'U1000',
    });
    expect(allowed.status).toBe('WARNING');
    expect(allowed.logs.map((log) => log.level)).toContain('INFO');
  });

  it('keeps test success from satisfying update prerequisites and blocks deferred engines by name', async () => {
    const updateBlocked = await executeConsolidationTask({
      client, executedBy: ACTOR.changedBy, selection: selection({ mode: 'UPDATE' }), task: 'T200', unit: 'U1000',
    });
    expect(updateBlocked.status).toBe('BLOCKED');
    expect(updateBlocked.resultSummary).toMatch(/Prerequisite task T100 has no UPDATE run/);

    const group = await executeConsolidationTaskGroup({
      client, executedBy: ACTOR.changedBy, selection: selection({ mode: 'UPDATE' }),
      taskGroup: 'T100', errorPolicy: 'STOP_ON_ERROR',
    });
    expect(group.runs.map((run) => `${run.task}:${run.status}`)).toEqual(['T100:WARNING', 'T200:BLOCKED']);
    expect(group.stopped).toBe(true);

    const fx = await executeConsolidationTask({ client, executedBy: ACTOR.changedBy, selection: selection(), task: 'T300', unit: 'U1000' });
    expect(fx.status).toBe('BLOCKED');
    expect(fx.resultSummary).toMatch(/No consolidation processing adapter stands for CURRENCY_TRANSLATION/);

    const view = await getConsolidationMonitor(client, selection(), true);
    expect(view.rows.map((row) => `${row.task}:${row.status}`)).toEqual(['T100:WARNING', 'T200:BLOCKED', 'T300:BLOCKED']);
    expect(view.executions.length).toBeGreaterThanOrEqual(7);
    expect(new Set(view.executions.map((run) => run.runId)).size).toBe(view.executions.length);
  });

  it('preserves repeated attempts and recovers a cancelled running attempt without posting', async () => {
    const rerun = await executeConsolidationTask({ client, executedBy: ACTOR.changedBy, selection: selection(), task: 'T100', unit: 'U1000' });
    expect(rerun.status).toBe('WARNING');

    const counts = await withTenant(client, async (tx) => {
      const executions = await tx.execute(sql`
        select count(*)::int as n from consolidation_execution where client = ${client} and task = 'T100' and mode = 'TEST'
      `) as unknown as Array<{ n: number }>;
      const journals = await tx.execute(sql`
        select count(*)::int as n from journal_entry where client = ${client}
      `) as unknown as Array<{ n: number }>;
      return { executions: executions[0]!.n, journals: journals[0]!.n };
    });
    expect(counts.executions).toBe(2);
    expect(counts.journals).toBe(0);

    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into consolidation_execution
          (client, run_id, area, group_name, unit, unit_scope, version, fiscal_year, period, task,
           configuration_version, configuration_snapshot, attempt_number, mode, status, executed_by, result_summary)
        values (${client}, 'CXRUNNING117', 'C100', 'GRP1', 'U1000', 'U1000', '100', 2026, 12, 'T100',
                'fixture', '{}', 99, 'UPDATE', 'RUNNING', 'SCR117-TEST', 'Fixture running attempt')
      `);
    });
    const duplicate = await executeConsolidationTask({
      client, executedBy: ACTOR.changedBy, selection: selection({ mode: 'UPDATE' }), task: 'T100', unit: 'U1000',
    });
    expect(duplicate.status).toBe('BLOCKED');
    expect(duplicate.resultSummary).toMatch(/already running/);

    const cancelled = await cancelConsolidationExecution({ client, executedBy: ACTOR.changedBy, runId: 'CXRUNNING117' });
    expect(cancelled.status).toBe('CANCELLED');
    const view = await getConsolidationMonitor(client, selection({ mode: 'UPDATE' }), true);
    expect(view.executions.some((run) => run.runId === 'CXRUNNING117' && run.status === 'CANCELLED')).toBe(true);
  });
});
