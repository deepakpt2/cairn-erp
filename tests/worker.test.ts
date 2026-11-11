/**
 * The worker loop.
 *
 * What is worth proving here is not that a job runs — `job-runtime.test.ts`
 * covers that — but that the loop behaves like a process that can be stopped
 * and replaced at any moment: it stops when asked, it stops without abandoning
 * a chunk, and a job nobody wrote a handler for fails loudly instead of being
 * quietly dropped.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { enqueue } from '../src/platform/job/queue';
import { registerJob, clearJobRegistry } from '../src/platform/job/registry';
import { jobDefinition, jobRun } from '../src/platform/tables/system';
import { DEFAULT_CHUNK_SIZE, DEFAULT_GRACE_SECONDS } from '../src/platform/job/types';
import { runWorker, stopWorker } from '../src/worker/index';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'WORKER_TEST';

let tenant: TestTenant;

/** A sleep that records how long the loop waited, so a test need not really wait. */
function fakeSleep(log: number[]) {
  return async (ms: number): Promise<void> => {
    log.push(ms);
  };
}

beforeEach(async () => {
  clearJobRegistry();
  tenant = await createTenant('worker-loop');
});

afterEach(async () => {
  stopWorker();
  await withTenant(tenant.client, (tx) => tx.delete(jobRun).where(eq(jobRun.client, tenant.client)));
  clearJobRegistry();
  await destroyTenant(tenant.client);
});

async function define(code: string): Promise<void> {
  await withTenant(tenant.client, (tx) =>
    tx
      .insert(jobDefinition)
      .values({
        code,
        module: 'PLT',
        name: code,
        description: code,
        queue: 'DEFAULT',
        maxRetries: 0,
        chunkSize: DEFAULT_CHUNK_SIZE,
        gracePeriodSeconds: DEFAULT_GRACE_SECONDS,
        mayTerminateSessions: false,
        retentionDays: 30,
        isEnabled: true,
      })
      .onConflictDoNothing(),
  );
}

async function queueRun(code: string): Promise<string> {
  const run = await withTenant(tenant.client, (tx) =>
    enqueue(tx, { client: tenant.client, jobCode: code, triggerType: 'MANUAL', triggeredBy: ACTOR }),
  );
  return run.id;
}

async function statusOf(runId: string): Promise<string> {
  const rows = await withTenant(tenant.client, (tx) =>
    tx.select({ status: jobRun.status }).from(jobRun).where(eq(jobRun.id, runId)),
  );
  return rows[0]!.status;
}

describe('the worker loop', () => {
  it('picks up a queued job and runs it to completion', async () => {
    await define('WORKER.OK');
    const done: string[] = [];
    registerJob({
      code: 'WORKER.OK',
      async chunk() {
        done.push('chunk');
        return { cursor: null, processed: 1 };
      },
    });
    const id = await queueRun('WORKER.OK');

    // maxRuns 1 so the loop returns instead of polling forever, which is how a
    // test drives it without a real clock.
    await runWorker({ maxRuns: 1, workerId: 'test-worker', sleep: fakeSleep([]) });

    expect(done).toEqual(['chunk']);
    expect(await statusOf(id)).toBe('SUCCEEDED');
  });

  it('stops when asked, rather than being killed mid-flight', async () => {
    await define('WORKER.STOP');
    let chunks = 0;
    registerJob({
      code: 'WORKER.STOP',
      async chunk(ctx) {
        chunks++;
        // One chunk in, ask the loop to stop, exactly as a SIGTERM would.
        stopWorker();
        return { cursor: null, processed: 1 };
      },
    });
    await queueRun('WORKER.STOP');

    const outcome = await runWorker({ workerId: 'test-worker', sleep: fakeSleep([]) });

    expect(outcome.stopped).toBe(true);
    // The chunk in hand was finished, not abandoned.
    expect(chunks).toBeGreaterThanOrEqual(1);
  });

  it('reports how many runs it handled', async () => {
    await define('WORKER.COUNT');
    registerJob({ code: 'WORKER.COUNT', async chunk() { return { cursor: null, processed: 1 }; } });
    await queueRun('WORKER.COUNT');
    await queueRun('WORKER.COUNT');

    const { runs } = await runWorker({ maxRuns: 2, workerId: 'test-worker', sleep: fakeSleep([]) });
    expect(runs).toBe(2);
  });

  it('waits between polls when there is nothing to do', async () => {
    // The run cap counts runs handled, not times round the loop, so an idle
    // loop is bounded here by asking it to stop once it has waited twice.
    const idle: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      idle.push(ms);
      if (idle.length >= 2) stopWorker();
    };

    const outcome = await runWorker({ workerId: 'test-worker', sleep });

    expect(outcome.stopped).toBe(true);
    expect(idle.length).toBe(2);
    // Sleeping the full interval, not spinning.
    expect(idle[0]).toBeGreaterThan(0);
  });

  it('fails a job with no handler loudly, instead of dropping it', async () => {
    await define('WORKER.NOHANDLER');
    const id = await queueRun('WORKER.NOHANDLER');

    await runWorker({ maxRuns: 1, workerId: 'test-worker', sleep: fakeSleep([]) });

    const rows = await withTenant(tenant.client, (tx) =>
      tx.select({ status: jobRun.status, errorText: jobRun.errorText }).from(jobRun).where(eq(jobRun.id, id)),
    );

    // A missing handler is a deployment mistake, not a data condition: the run
    // must be visible and explained, never quietly retried or discarded.
    expect(rows[0]!.status).toBe('FAILED');
    expect(rows[0]!.errorText).toContain('No handler is registered');
  });

  it('records which worker is holding a run, and lets go when it finishes', async () => {
    await define('WORKER.WHO');
    let whileRunning: string | null = 'never observed';
    registerJob({
      code: 'WORKER.WHO',
      async chunk(ctx) {
        const rows = await withTenant(tenant.client, (tx) =>
          tx.select({ worker: jobRun.workerId }).from(jobRun).where(eq(jobRun.id, ctx.runId)),
        );
        whileRunning = rows[0]!.worker;
        return { cursor: null, processed: 1 };
      },
    });
    const id = await queueRun('WORKER.WHO');

    await runWorker({ maxRuns: 1, workerId: 'worker-alpha', sleep: fakeSleep([]) });

    // Who holds it matters while it is held: two workers on one queue are two
    // names in the log, and a stuck run has an owner to look for.
    expect(whileRunning).toBe('worker-alpha');

    // Once finished, nothing is holding it, so orphan reaping has no false
    // positives to trip over.
    const after = await withTenant(tenant.client, (tx) =>
      tx.select({ worker: jobRun.workerId }).from(jobRun).where(eq(jobRun.id, id)),
    );
    expect(after[0]!.worker).toBeNull();
  });

  it('runs each queued job once, not twice', async () => {
    await define('WORKER.ONCE');
    let chunks = 0;
    registerJob({
      code: 'WORKER.ONCE',
      async chunk() { chunks++; return { cursor: null, processed: 1 }; },
    });
    await queueRun('WORKER.ONCE');

    await runWorker({ maxRuns: 1, workerId: 'test-worker', sleep: fakeSleep([]) });
    expect(chunks).toBe(1);
  });
});
