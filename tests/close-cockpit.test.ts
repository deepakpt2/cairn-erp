import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  attachEvidence, createTaskListFromTemplate, executeTask, finalizeTaskList,
  getTaskList, listEvents, listExecutions, listTasks, overrideTaskStatus,
  processScheduledExecutions, releaseTaskList, reopenTask, signOffTask, upsertTemplateTask,
} from '../src/modules/finance/close-cockpit';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'CLOSE-TEST';
const TEMPLATE = 'TEST_CLOSE';
let client = '';
let company = '';

const cycle = (taskListId = 'APRIL_CLOSE') => ({
  companyCode: company, taskListId, fiscalYear: 2026, postingPeriod: 4,
});

async function templateTask(taskId: string, handlerCode: string, extra: Record<string, unknown> = {}, predecessors: string[] = []) {
  await upsertTemplateTask({
    client, changedBy: ACTOR, templateCode: TEMPLATE,
    task: {
      taskId, taskName: `Task ${taskId}`, handlerCode,
      ...(extra as object),
    } as never,
    predecessors,
  });
}

beforeAll(async () => {
  const fx = await createTenant('closecockpit');
  client = fx.client;
  company = fx.companyCode;
  await templateTask('T10', 'PERIOD_STATUS');
  await templateTask('T20', 'MANUAL_CONFIRMATION', { requiresEvidence: true, requiresSignoff: true, criticalPath: true }, ['T10']);
  await templateTask('T30', 'MANUAL_CONFIRMATION', {}, ['T10']);
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-101 period-end close cockpit CLOCO (R-149)', () => {
  it('refuses unknown handlers and circular template dependencies', async () => {
    await expect(templateTask('T99', 'NOT_A_HANDLER')).rejects.toThrow('is not registered');
    await expect(templateTask('T10', 'PERIOD_STATUS', {}, ['T30'])).rejects.toThrow('circular dependency');
  });

  it('gates execution on predecessors and completes through the evidence/sign-off gates', async () => {
    const created = await createTaskListFromTemplate({
      client, changedBy: ACTOR, cycle: cycle(), templateCode: TEMPLATE, description: 'April close',
    });
    expect(created.status).toBe('INITIAL');
    expect(created.totalTasks).toBe(3);

    await expect(executeTask({ client, changedBy: ACTOR, cycle: cycle(), taskId: 'T10', mode: 'FOREGROUND' }))
      .rejects.toThrow('release it before executing');

    const released = await releaseTaskList({ client, changedBy: ACTOR, cycle: cycle() });
    expect(released.status).toBe('RELEASED');
    await expect(finalizeTaskList({ client, changedBy: ACTOR, cycle: cycle() }))
      .rejects.toThrow('cannot be finalized');

    await expect(executeTask({ client, changedBy: ACTOR, cycle: cycle(), taskId: 'T20', mode: 'FOREGROUND' }))
      .rejects.toThrow('predecessor(s) T10 are not completed');

    const ran = await executeTask({ client, changedBy: ACTOR, cycle: cycle(), taskId: 'T10', mode: 'FOREGROUND' });
    expect(ran.status).toBe('COMPLETED');
    const log = await listExecutions(client, cycle(), 'T10');
    expect(log[0]?.status).toBe('SUCCEEDED');
    expect(log[0]?.resultSummary).toContain('Period 2026/04');
    await expect(executeTask({ client, changedBy: ACTOR, cycle: cycle(), taskId: 'T10', mode: 'FOREGROUND' }))
      .rejects.toThrow('already stands completed');

    const gated = await executeTask({ client, changedBy: ACTOR, cycle: cycle(), taskId: 'T20', mode: 'FOREGROUND' });
    expect(gated.status).toBe('BLOCKED'); // handler succeeded, gates open
    const afterEvidence = await attachEvidence({
      client, changedBy: ACTOR, cycle: cycle(), taskId: 'T20', evidenceRef: 'close-pack/april.pdf',
    });
    expect(afterEvidence.status).toBe('BLOCKED'); // sign-off still missing
    const afterSignoff = await signOffTask({ client, changedBy: ACTOR, cycle: cycle(), taskId: 'T20' });
    expect(afterSignoff.status).toBe('COMPLETED');

    const tasks = await listTasks(client, cycle());
    const t20 = tasks.find((t) => t.taskId === 'T20');
    expect(t20?.predecessors).toEqual(['T10']);
    expect(t20?.evidenceRef).toBe('close-pack/april.pdf');
    expect(t20?.signedOffBy).toBe(ACTOR);
  });

  it('schedules background executions without completing them until the runner settles them', async () => {
    const scheduled = await executeTask({ client, changedBy: ACTOR, cycle: cycle(), taskId: 'T30', mode: 'BACKGROUND' });
    expect(scheduled.scheduled).toBe(true);
    const before = await listTasks(client, cycle());
    expect(before.find((t) => t.taskId === 'T30')?.status).toBe('RUNNING');
    const pendingLog = await listExecutions(client, cycle(), 'T30');
    expect(pendingLog[0]?.status).toBe('SCHEDULED');

    const processed = await processScheduledExecutions({ client, changedBy: ACTOR, cycle: cycle() });
    expect(processed.processed).toBe(1);
    const after = await listTasks(client, cycle());
    expect(after.find((t) => t.taskId === 'T30')?.status).toBe('COMPLETED');

    const finalized = await finalizeTaskList({ client, changedBy: ACTOR, cycle: cycle() });
    expect(finalized.status).toBe('FINALIZED');
    expect(finalized.completionPercent).toBe(100);
    const events = await listEvents(client, cycle());
    expect(events.map((e) => e.eventType)).toContain('FINALIZED');
  });

  it('requires reasons for overrides and reopens, preserving the trail', async () => {
    await createTaskListFromTemplate({ client, changedBy: ACTOR, cycle: cycle('MAY_CLOSE'), templateCode: TEMPLATE });
    await releaseTaskList({ client, changedBy: ACTOR, cycle: cycle('MAY_CLOSE') });
    await expect(overrideTaskStatus({
      client, changedBy: ACTOR, cycle: cycle('MAY_CLOSE'), taskId: 'T10', newStatus: 'COMPLETED', reason: ' ',
    })).rejects.toThrow('reason is mandatory');
    await overrideTaskStatus({
      client, changedBy: ACTOR, cycle: cycle('MAY_CLOSE'), taskId: 'T10', newStatus: 'COMPLETED', reason: 'Verified in prior cycle pack',
    });
    const may = await listTasks(client, cycle('MAY_CLOSE'));
    expect(may.find((t) => t.taskId === 'T10')?.status).toBe('COMPLETED');
    expect(may.find((t) => t.taskId === 'T10')?.attemptCount).toBe(0); // no fake execution

    await expect(reopenTask({
      client, changedBy: ACTOR, cycle: cycle('MAY_CLOSE'), taskId: 'T10', reason: '',
    })).rejects.toThrow('reason is mandatory');
    const reopened = await reopenTask({
      client, changedBy: ACTOR, cycle: cycle('MAY_CLOSE'), taskId: 'T10', reason: 'Late accrual found',
    });
    expect(reopened.status).toBe('RELEASED');
    expect(reopened.warning).toContain('duplicate accounting effects');
    const events = await listEvents(client, cycle('MAY_CLOSE'));
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(['OVERRIDE', 'REOPENED']));
    const rows = await withTenant(client, async (tx) => tx.execute(sql`
      select count(*)::int as n from closing_execution_log where client = ${client}
    `));
    expect(Number((rows as unknown as Array<{ n: number }>)[0]?.n)).toBeGreaterThan(0);
  });
});
