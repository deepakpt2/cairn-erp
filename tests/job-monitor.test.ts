/**
 * The reads behind the jobs status page.
 *
 * The page is the user's only window onto work happening out of sight, so what
 * these tests protect is the accuracy of what it claims: a run is finished only
 * when it is finished, a tenant sees only its own work, and the flags that
 * decide whether Cancel and Retry are offered agree with the status.
 */

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { enqueue } from '../src/platform/job/queue';
import { handlerFor, registerJob } from '../src/platform/job/registry';
import { listLogs, listRuns } from '../src/platform/job/monitor';
import { jobDefinition, jobLog, jobRun } from '../src/platform/tables/system';
import { DEFAULT_CHUNK_SIZE, DEFAULT_GRACE_SECONDS } from '../src/platform/job/types';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'JOB_MONITOR_TEST';

let tenant: TestTenant;
let other: TestTenant;

beforeAll(async () => {
  tenant = await createTenant('job-monitor-a');
  other = await createTenant('job-monitor-b');
});

afterAll(async () => {
  await destroyTenant(other.client);
  await destroyTenant(tenant.client);
});

afterEach(async () => {
  await withTenant(tenant.client, (tx) => tx.delete(jobRun).where(eq(jobRun.client, tenant.client)));
  await withTenant(other.client, (tx) => tx.delete(jobRun).where(eq(jobRun.client, other.client)));
});

/** Put a definition in place, with whatever flags the case needs. */
async function define(
  code: string,
  over: { name?: string; maxRetries?: number; isEnabled?: boolean; module?: string } = {},
): Promise<void> {
  await withTenant(tenant.client, (tx) =>
    tx
      .insert(jobDefinition)
      .values({
        code,
        module: 'PLT',
        name: over.name ?? code,
        description: code,
        queue: 'DEFAULT',
        maxRetries: over.maxRetries ?? 0,
        chunkSize: DEFAULT_CHUNK_SIZE,
        gracePeriodSeconds: DEFAULT_GRACE_SECONDS,
        mayTerminateSessions: false,
        retentionDays: 30,
        isEnabled: over.isEnabled ?? true,
      })
      .onConflictDoUpdate({
        target: jobDefinition.code,
        set: { name: over.name ?? code, maxRetries: over.maxRetries ?? 0, isEnabled: over.isEnabled ?? true },
      }),
  );
  await withTenant(other.client, (tx) =>
    tx
      .insert(jobDefinition)
      .values({
        code,
        module: 'PLT',
        name: over.name ?? code,
        description: code,
        queue: 'DEFAULT',
        maxRetries: over.maxRetries ?? 0,
        chunkSize: DEFAULT_CHUNK_SIZE,
        gracePeriodSeconds: DEFAULT_GRACE_SECONDS,
        mayTerminateSessions: false,
        retentionDays: 30,
        isEnabled: over.isEnabled ?? true,
      })
      .onConflictDoNothing(),
  );
}

/** enqueue returns the run and whether it was collapsed into an existing one. */
async function queueRun(client: string, code: string): Promise<string> {
  const run = await withTenant(client, (tx) =>
    enqueue(tx, { client, jobCode: code, triggerType: 'MANUAL', triggeredBy: ACTOR }),
  );
  return run.id;
}

async function setStatus(client: string, runId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  await withTenant(client, (tx) =>
    tx
      .update(jobRun)
      .set({ status, ...extra })
      .where(eq(jobRun.id, runId)),
  );
}

describe('the jobs status page', () => {
  it('shows the submitter, the job and its progress', async () => {
    await define('JOBMON.BASIC', { name: 'Basic job' });
    const id = await queueRun(tenant.client, 'JOBMON.BASIC');
    await setStatus(tenant.client, id, 'RUNNING', { progressPercent: 40, progressText: '400 of 1000' });

    const rows = await listRuns(tenant.client);
    const row = rows.find((r) => r.id === id)!;

    expect(row.jobCode).toBe('JOBMON.BASIC');
    expect(row.jobName).toBe('Basic job');
    expect(row.triggeredBy).toBe(ACTOR);
    expect(row.progressPercent).toBe(40);
    expect(row.progressText).toBe('400 of 1000');
  });

  it('never shows one tenant the other tenant’s runs', async () => {
    await define('JOBMON.SHARED');
    const theirs = await queueRun(other.client, 'JOBMON.SHARED');
    const mine = await queueRun(tenant.client, 'JOBMON.SHARED');

    const mine_ = await listRuns(tenant.client);
    const theirs_ = await listRuns(other.client);

    expect(mine_.map((r) => r.id)).toEqual([mine]);
    expect(theirs_.map((r) => r.id)).toEqual([theirs]);
  });

  it('offers cancel only while a run can still be stopped', async () => {
    await define('JOBMON.CANCEL');
    const queued = await queueRun(tenant.client, 'JOBMON.CANCEL');
    const running = await queueRun(tenant.client, 'JOBMON.CANCEL');
    const done = await queueRun(tenant.client, 'JOBMON.CANCEL');
    await setStatus(tenant.client, running, 'RUNNING');
    await setStatus(tenant.client, done, 'SUCCEEDED');

    const rows = await listRuns(tenant.client);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(by[queued]!.canCancel).toBe(true);
    expect(by[running]!.canCancel).toBe(true);
    expect(by[done]!.canCancel).toBe(false);
  });

  it('offers retry only where a retry would do something', async () => {
    await define('JOBMON.RETRY');
    const ok = await queueRun(tenant.client, 'JOBMON.RETRY');
    const failed = await queueRun(tenant.client, 'JOBMON.RETRY');
    const cancelled = await queueRun(tenant.client, 'JOBMON.RETRY');
    const dead = await queueRun(tenant.client, 'JOBMON.RETRY');
    await setStatus(tenant.client, ok, 'SUCCEEDED');
    await setStatus(tenant.client, failed, 'FAILED');
    await setStatus(tenant.client, cancelled, 'CANCELLED');
    await setStatus(tenant.client, dead, 'DEAD_LETTER');

    const rows = await listRuns(tenant.client);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));

    // A job that worked does not need running again.
    expect(by[ok]!.canRetry).toBe(false);
    expect(by[failed]!.canRetry).toBe(true);
    expect(by[cancelled]!.canRetry).toBe(true);
    expect(by[dead]!.canRetry).toBe(true);
  });

  it('separates finished work from work still in flight', async () => {
    await define('JOBMON.SPLIT');
    const running = await queueRun(tenant.client, 'JOBMON.SPLIT');
    const done = await queueRun(tenant.client, 'JOBMON.SPLIT');
    await setStatus(tenant.client, running, 'RUNNING');
    await setStatus(tenant.client, done, 'FAILED', { errorText: 'it broke' });

    const history = await listRuns(tenant.client, { finishedOnly: true });
    expect(history.map((r) => r.id)).toEqual([done]);
    expect(history[0]!.errorText).toBe('it broke');
  });

  it('names the holder when a run is waiting on a locked document', async () => {
    await define('JOBMON.BLOCKED');
    const id = await queueRun(tenant.client, 'JOBMON.BLOCKED');
    await setStatus(tenant.client, id, 'BLOCKED', {
      blockedOn: {
        documents: [
          { lockObject: 'MATERIAL', argument: 'M-7', holderUser: 'holder.user', holderSessionId: 'session-held' },
        ],
      },
    });

    const rows = await listRuns(tenant.client);
    const row = rows.find((r) => r.id === id)!;

    expect(row.status).toBe('BLOCKED');
    expect(row.blockedOn?.documents[0]?.holderUser).toBe('holder.user');
    // Blocked is not finished, so it is still cancellable — but it is waiting,
    // not broken, which is why the page says so rather than showing an error.
    expect(row.canCancel).toBe(true);
  });

  it('reads a run’s log oldest first, the order it happened', async () => {
    await define('JOBMON.LOG');
    const id = await queueRun(tenant.client, 'JOBMON.LOG');
    await withTenant(tenant.client, (tx) =>
      tx.insert(jobLog).values([
        { id: 'log-b', client: tenant.client, jobRunId: id, level: 'ERROR', message: 'second', loggedAt: new Date(Date.now() + 2000) },
        { id: 'log-a', client: tenant.client, jobRunId: id, level: 'INFO', message: 'first', loggedAt: new Date(Date.now() + 1000) },
      ]),
    );

    const lines = await listLogs(tenant.client, id);
    expect(lines.map((l) => l.message)).toEqual(['first', 'second']);
    expect(lines[1]!.level).toBe('ERROR');
  });

  it('does not hand a tenant another tenant’s log lines', async () => {
    await define('JOBMON.LOGX');
    const id = await queueRun(tenant.client, 'JOBMON.LOGX');
    await withTenant(tenant.client, (tx) =>
      tx.insert(jobLog).values([
        { id: 'log-secret', client: tenant.client, jobRunId: id, level: 'INFO', message: 'private', loggedAt: new Date() },
      ]),
    );

    expect(await listLogs(other.client, id)).toEqual([]);
  });

  it('lists the newest run first, because that is the one just submitted', async () => {
    await define('JOBMON.ORDER');
    const first = await queueRun(tenant.client, 'JOBMON.ORDER');
    const second = await queueRun(tenant.client, 'JOBMON.ORDER');

    const rows = await listRuns(tenant.client);
    expect(rows.map((r) => r.id)).toEqual([second, first]);
  });

  it('reports the retry allowance a run is working through', async () => {
    await define('JOBMON.ATTEMPTS', { maxRetries: 3 });
    const id = await queueRun(tenant.client, 'JOBMON.ATTEMPTS');
    await setStatus(tenant.client, id, 'QUEUED', { retryCount: 2 });

    const rows = await listRuns(tenant.client);
    const row = rows.find((r) => r.id === id)!;
    expect(row.retryCount).toBe(2);
    expect(row.maxRetries).toBe(3);
  });

  it('leaves the registry alone — reading the page registers no handler', async () => {
    await define('JOBMON.NOREG');
    await queueRun(tenant.client, 'JOBMON.NOREG');
    await listRuns(tenant.client);
    expect(handlerFor('JOBMON.NOREG')).toBeUndefined();
  });

  it('survives a run whose handler is no longer registered at all', async () => {
    // A worker restart, or a feature removed: the run is still on the queue and
    // the page must still describe it instead of failing to render.
    await define('JOBMON.GONE');
    const id = await queueRun(tenant.client, 'JOBMON.GONE');

    const rows = await listRuns(tenant.client);
    expect(rows.find((r) => r.id === id)).toBeDefined();
  });
});

describe('a registered handler appearing after the run was queued', () => {
  it('is found when the run is claimed, not when it was queued', async () => {
    await define('JOBMON.LATE');
    const id = await queueRun(tenant.client, 'JOBMON.LATE');
    expect(handlerFor('JOBMON.LATE')).toBeUndefined();

    registerJob({ code: 'JOBMON.LATE', async chunk() { return { cursor: null, processed: 0 }; } });
    expect(handlerFor('JOBMON.LATE')).toBeDefined();

    await setStatus(tenant.client, id, 'RUNNING');
    const rows = await listRuns(tenant.client);
    expect(rows.find((r) => r.id === id)!.status).toBe('RUNNING');
  });
});
