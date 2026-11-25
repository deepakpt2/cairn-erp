/**
 * Worker split and job leases.
 *
 * Covers: Compose renders two disjoint nonempty queue lists with distinct worker ids and the SMTP
 * keyring only on the regular worker; the worker refuses an ambiguous queue configuration; every
 * enabled job definition has a consumer; a held intensive run does not stop the regular worker or
 * the scheduler; queue filters isolate the two workers; concurrent scheduler ticks do not duplicate
 * runs; and the lease epoch really fences a stale owner against a live reaper.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db, withTenant } from '../src/platform/db/client';
import { claimNext, runClaimed } from '../src/platform/job/execute';
import { enqueue, reapOrphans, requestCancel } from '../src/platform/job/queue';
import { clearJobRegistry, registerJob } from '../src/platform/job/registry';
import { tickScheduler } from '../src/platform/job/scheduler';
import { REGULAR_QUEUES, INTENSIVE_QUEUES } from '../src/platform/job/queues';
import { jobDefinition, jobLog, jobRun } from '../src/platform/tables/system';
import { LeaseLostError } from '../src/platform/job/types';
import { resolveWorkerConfig, WorkerConfigError } from '../src/worker/config';
import { runWorker, stopWorker } from '../src/worker/index';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

// ── Compose and configuration (no database) ─────────────────────────────────

function composeServices(): Record<string, string> {
  const text = readFileSync(join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  const start = text.indexOf('\nservices:\n');
  const end = text.indexOf('\nnetworks:\n', start);
  const body = text.slice(start + '\nservices:\n'.length, end);
  const out: Record<string, string> = {};
  let current: string | null = null;
  for (const line of body.split('\n')) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) {
      current = m[1]!;
      out[current] = '';
    } else if (current) {
      out[current] += `${line}\n`;
    }
  }
  return out;
}

function envOf(block: string, name: string): string | null {
  const m = new RegExp(`^ {6}${name}:\\s*(.*)$`, 'm').exec(block);
  return m ? m[1]!.trim().replace(/^"|"$/g, '') : null;
}

describe('compose', () => {
  const services = composeServices();
  const regular = services['worker']!;
  const intensive = services['worker-intensive']!;

  it('renders two worker services with disjoint, nonempty queue lists', () => {
    const a = (envOf(regular, 'CAIRN_WORKER_QUEUES') ?? '').split(',').filter(Boolean);
    const b = (envOf(intensive, 'CAIRN_WORKER_QUEUES') ?? '').split(',').filter(Boolean);
    expect(a).toEqual([...REGULAR_QUEUES]);
    expect(b).toEqual([...INTENSIVE_QUEUES]);
    expect(a.filter((q) => b.includes(q))).toEqual([]);
  });

  it('gives the workers distinct ids', () => {
    const a = envOf(regular, 'CAIRN_WORKER_ID');
    const b = envOf(intensive, 'CAIRN_WORKER_ID');
    expect(a).toContain('worker-regular');
    expect(b).toContain('worker-intensive');
    expect(a).not.toEqual(b);
  });

  it('keeps the SMTP keyring on the regular worker only, and the scheduler with the regular worker', () => {
    expect(envOf(regular, 'CAIRN_BANK_DATA_KEYRING_JSON')).not.toBeNull();
    expect(envOf(intensive, 'CAIRN_BANK_DATA_KEYRING_JSON')).toBeNull();
    expect(envOf(regular, 'CAIRN_WORKER_SCHEDULER')).toBe('true');
    expect(envOf(intensive, 'CAIRN_WORKER_SCHEDULER')).toBe('false');
  });

  it('uses the same image target and app-role connection for both, after migrate', () => {
    for (const block of [regular, intensive]) {
      expect(block).toContain('target: worker');
      expect(block).toContain('cairn_app:');
      expect(block).toContain('service_completed_successfully');
      expect(envOf(block, 'CAIRN_JOB_POLL_MS')).toContain('2000');
    }
  });

  it('gives each build target its own image tag, so a build cannot overwrite another stage', () => {
    // The defect this guards. `app`, `worker` and `worker-intensive` are built from one
    // Dockerfile but stop at different stages, and each stage carries its own CMD:
    // `node server.js` for `app`, `npm run worker` for both workers. They used to share
    // `cairn-app:local`, so `docker compose up --build` left the tag pointing at whichever
    // stage was built last. When that was a worker, the app container ran the worker, which
    // refused for want of CAIRN_WORKER_QUEUES — and nothing served :3000.
    const app = services['app']!;
    // Anchored to a key line and not a comment: the block's own comment quotes `target:` and
    // the stage names, and a loose match would read the prose instead of the configuration.
    // `image` sits at four spaces and `target` at six (it nests under `build:`).
    const keyOf = (block: string, name: string) =>
      new RegExp(`^ {4,6}${name}:\\s*(\\S+)\\s*$`, 'm').exec(block)?.[1];
    const tagOf = (block: string) => keyOf(block, 'image');
    const targetOf = (block: string) => keyOf(block, 'target');

    expect(targetOf(app)).toBe('app');
    expect(targetOf(regular)).toBe('worker');
    expect(targetOf(intensive)).toBe('worker');

    // Two distinct stages, two distinct tags. One tag for two stages is the whole bug.
    expect(tagOf(app)).toBeTruthy();
    expect(tagOf(regular)).toBeTruthy();
    expect(tagOf(app)).not.toBe(tagOf(regular));
    // The two workers really are the same build, so they may share one.
    expect(tagOf(intensive)).toBe(tagOf(regular));
  });

  it('passes a legacy CAIRN_JOB_QUEUES through to both so it is validated, not ignored', () => {
    expect(envOf(regular, 'CAIRN_JOB_QUEUES')).toContain('CAIRN_JOB_QUEUES');
    expect(envOf(intensive, 'CAIRN_JOB_QUEUES')).toContain('CAIRN_JOB_QUEUES');
  });
});

describe('worker configuration', () => {
  it('refuses to start with no queue list, because empty means every queue', () => {
    expect(() => resolveWorkerConfig({})).toThrow(WorkerConfigError);
    expect(() => resolveWorkerConfig({ CAIRN_WORKER_QUEUES: '  ' })).toThrow(/every queue/);
  });

  it('accepts an explicit all-queues single-process mode only when asked', () => {
    const c = resolveWorkerConfig({ CAIRN_WORKER_ALLOW_ALL_QUEUES: 'true' });
    expect(c.queues).toBeNull();
    expect(() =>
      resolveWorkerConfig({ CAIRN_WORKER_ALLOW_ALL_QUEUES: 'true', CAIRN_WORKER_QUEUES: 'MAIL' }),
    ).toThrow(WorkerConfigError);
  });

  it('honours a matching legacy list with a warning and rejects a contradictory one', () => {
    const ok = resolveWorkerConfig({ CAIRN_WORKER_QUEUES: 'MAIL,DEFAULT', CAIRN_JOB_QUEUES: 'DEFAULT, MAIL' });
    expect(ok.queues).toEqual(['MAIL', 'DEFAULT']);
    expect(ok.warnings.join(' ')).toContain('deprecated');
    expect(() => resolveWorkerConfig({ CAIRN_WORKER_QUEUES: 'INTENSIVE', CAIRN_JOB_QUEUES: 'MAIL' })).toThrow(
      /disagree/,
    );
    const legacyOnly = resolveWorkerConfig({ CAIRN_JOB_QUEUES: 'MAIL' });
    expect(legacyOnly.queues).toEqual(['MAIL']);
    expect(legacyOnly.warnings.length).toBe(1);
  });

  it('reads identity, polling (new name wins) and scheduler ownership', () => {
    const c = resolveWorkerConfig({
      CAIRN_WORKER_QUEUES: 'INTENSIVE',
      CAIRN_WORKER_ID: ' worker-intensive ',
      CAIRN_WORKER_POLL_MS: '500',
      CAIRN_JOB_POLL_MS: '9000',
      CAIRN_WORKER_SCHEDULER: 'false',
    });
    expect(c).toMatchObject({ workerId: 'worker-intensive', pollMs: 500, scheduler: false });
    expect(resolveWorkerConfig({ CAIRN_WORKER_QUEUES: 'MAIL' }).scheduler).toBe(true);
  });
});

// ── Database behaviour ───────────────────────────────────────────────────────

const ACTOR = 'WSPLIT_TEST';
const REGULAR = [...REGULAR_QUEUES] as string[];
const INTENSIVE = [...INTENSIVE_QUEUES] as string[];

let tenant: TestTenant;
const definedCodes: string[] = [];

beforeEach(async () => {
  clearJobRegistry();
  tenant = await createTenant('worker-split');
});

afterEach(async () => {
  stopWorker();
  const clients = await allClients();
  for (const client of clients) {
    await withTenant(client, (tx) =>
      tx.execute(sql`delete from job_run where job_code like 'WSPLIT.%'`),
    ).catch(() => undefined);
  }
  for (const code of definedCodes.splice(0)) {
    await db().delete(jobDefinition).where(eq(jobDefinition.code, code));
  }
  clearJobRegistry();
  await destroyTenant(tenant.client);
});

async function allClients(): Promise<string[]> {
  const rows = (await db().execute(sql`select client from job_all_clients()`)) as unknown as Array<{ client: string }>;
  return rows.map((r) => r.client);
}

async function define(
  code: string,
  queue: string,
  extra: Partial<typeof jobDefinition.$inferInsert> = {},
): Promise<void> {
  definedCodes.push(code);
  await withTenant(tenant.client, (tx) =>
    tx
      .insert(jobDefinition)
      .values({
        code,
        module: 'PLT',
        name: code,
        description: code,
        queue,
        maxRetries: 0,
        chunkSize: 10,
        gracePeriodSeconds: 300,
        mayTerminateSessions: false,
        retentionDays: 30,
        isEnabled: true,
        ...extra,
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

async function runRow(runId: string) {
  const rows = await withTenant(tenant.client, (tx) => tx.select().from(jobRun).where(eq(jobRun.id, runId)));
  return rows[0]!;
}

async function until(check: () => Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const fastSleep = async (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('coverage', () => {
  it('every enabled job definition is on a queue one of the two workers serves', async () => {
    const rows = (await db().execute(
      sql`select distinct queue from job_definition where is_enabled`,
    )) as unknown as Array<{ queue: string }>;
    const served = new Set([...REGULAR, ...INTENSIVE]);
    const unserved = rows.map((r) => r.queue).filter((q) => !served.has(q));
    expect(unserved).toEqual([]);
  });
});

describe('two workers at once', () => {
  it('a held intensive run does not stop the regular worker, the scheduler, or queue isolation', async () => {
    await define('WSPLIT.INT', 'INTENSIVE');
    await define('WSPLIT.MAIL', 'MAIL');
    await define('WSPLIT.SCHED', 'DEFAULT', { isScheduled: true, schedule: '* * * * *' });

    const held = gate();
    const intensiveWorkerSeen: string[] = [];
    const mailWorkerSeen: string[] = [];
    const mailTransport: string[] = []; // the test transport: nothing is ever sent
    let intensiveStarted = false;

    registerJob({
      code: 'WSPLIT.INT',
      async chunk(ctx) {
        const row = await runRow(ctx.runId);
        intensiveWorkerSeen.push(row.workerId ?? '');
        intensiveStarted = true;
        await held.promise; // genuinely mid-run
        return { cursor: null, processed: 1 };
      },
    });
    registerJob({
      code: 'WSPLIT.MAIL',
      async chunk(ctx) {
        const row = await runRow(ctx.runId);
        mailWorkerSeen.push(row.workerId ?? '');
        mailTransport.push('test-message');
        return { cursor: null, processed: 1 };
      },
    });

    const intId = await queueRun('WSPLIT.INT');

    // The intensive worker takes the run and holds it.
    const intensiveDone = runWorker({
      workerId: 'worker-intensive',
      queues: INTENSIVE,
      maxRuns: 1,
      scheduler: false,
      sleep: fastSleep,
    });
    await until(async () => intensiveStarted, 'the intensive run to start');
    expect((await runRow(intId)).status).toBe('RUNNING');

    // Queue isolation, while it is held: the regular filter does not see INTENSIVE work.
    const second = await queueRun('WSPLIT.INT');
    expect(await claimNext('worker-regular', REGULAR)).toBeNull();
    expect(await requestCancel_(second)).toBe(true);

    // And the intensive filter does not see MAIL work.
    const mailId = await queueRun('WSPLIT.MAIL');
    expect(await claimNext('worker-intensive-2', INTENSIVE)).toBeNull();

    // The regular worker, with its scheduler on a short timer, runs the mail job to the end
    // while the intensive one is still held, and the scheduler enqueues the scheduled job meanwhile.
    await runWorker({
      workerId: 'worker-regular',
      queues: REGULAR,
      maxRuns: 1,
      scheduler: true,
      schedulerIntervalMs: 100,
      sleep: fastSleep,
    });
    expect((await runRow(mailId)).status).toBe('SUCCEEDED');
    expect(mailWorkerSeen).toEqual(['worker-regular']);
    expect(mailTransport).toEqual(['test-message']);
    expect((await runRow(intId)).status).toBe('RUNNING');
    expect((await runRow(intId)).workerId).toBe('worker-intensive');

    const scheduled = await withTenant(tenant.client, (tx) =>
      tx.select().from(jobRun).where(eq(jobRun.jobCode, 'WSPLIT.SCHED')),
    );
    expect(scheduled.length).toBe(1);

    held.open();
    await intensiveDone;
    expect((await runRow(intId)).status).toBe('SUCCEEDED');
    expect(intensiveWorkerSeen).toEqual(['worker-intensive']);
  });

  async function requestCancel_(runId: string): Promise<boolean> {
    return withTenant(tenant.client, (tx) => requestCancel(tx, tenant.client, runId));
  }

  it('the scheduler keeps ticking while the worker is busy with a long run', async () => {
    await define('WSPLIT.LONG', 'DEFAULT');
    await define('WSPLIT.SCHED2', 'DEFAULT', { isScheduled: true, schedule: '* * * * *' });
    const held = gate();
    let started = false;
    registerJob({
      code: 'WSPLIT.LONG',
      async chunk() {
        started = true;
        await held.promise;
        return { cursor: null, processed: 1 };
      },
    });
    await queueRun('WSPLIT.LONG');
    const done = runWorker({
      workerId: 'worker-regular',
      queues: REGULAR,
      maxRuns: 1,
      scheduler: true,
      schedulerIntervalMs: 100,
      sleep: fastSleep,
    });
    await until(async () => started, 'the long run to start');
    // Remove the scheduled run the start-up tick made, then see whether a later tick makes it again
    // while the loop is still inside the long run. The idempotency key would block a repeat, so
    // instead make a second tenant-independent check: a new definition becomes due only now.
    await define('WSPLIT.SCHED3', 'DEFAULT', { isScheduled: true, schedule: '* * * * *' });
    await until(async () => {
      const rows = await withTenant(tenant.client, (tx) =>
        tx.select().from(jobRun).where(eq(jobRun.jobCode, 'WSPLIT.SCHED3')),
      );
      return rows.length === 1;
    }, 'a scheduler tick during the busy run');
    expect((await withTenant(tenant.client, (tx) => tx.select().from(jobRun).where(eq(jobRun.jobCode, 'WSPLIT.LONG'))))[0]!.status).toBe('RUNNING');
    held.open();
    await done;
  });

  it('concurrent scheduler ticks enqueue a scheduled job once per tenant', async () => {
    await define('WSPLIT.SCHED4', 'DEFAULT', { isScheduled: true, schedule: '* * * * *' });
    const now = new Date();
    await Promise.all(Array.from({ length: 6 }, () => tickScheduler(now)));
    const rows = await withTenant(tenant.client, (tx) =>
      tx.select().from(jobRun).where(eq(jobRun.jobCode, 'WSPLIT.SCHED4')),
    );
    expect(rows.length).toBe(1);
    await tickScheduler(new Date(now.getTime() + 1000));
    const again = await withTenant(tenant.client, (tx) =>
      tx.select().from(jobRun).where(eq(jobRun.jobCode, 'WSPLIT.SCHED4')),
    );
    expect(again.length).toBe(1);
  });
});

describe('leases and fencing', () => {
  it('a live run longer than the heartbeat timeout is not reaped while another process reaps', async () => {
    await define('WSPLIT.LIVE', 'INTENSIVE');
    let chunks = 0;
    registerJob({
      code: 'WSPLIT.LIVE',
      async chunk(ctx) {
        chunks += 1;
        await withTenant(ctx.client, async (tx) => {
          await ctx.fence(tx);
          await tx.execute(sql`select pg_sleep(2.5)`); // one atomic database operation, longer than the timeout below
        });
        return { cursor: null, processed: 1 };
      },
    });
    const id = await queueRun('WSPLIT.LIVE');
    const claimed = await claimNext('worker-a', INTENSIVE);
    expect(claimed!.runId).toBe(id);

    const reaped: string[] = [];
    let reaping = true;
    const reaper = (async () => {
      while (reaping) {
        const ids = await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1000));
        reaped.push(...ids);
        await new Promise((r) => setTimeout(r, 200));
      }
    })();

    const status = await runClaimed('worker-a', claimed!, { heartbeatMs: 200 });
    reaping = false;
    await reaper;

    expect(status).toBe('SUCCEEDED');
    expect(reaped).toEqual([]);
    expect(chunks).toBe(1);
  });

  it('a stale owner cannot commit business writes after its lease is lost', async () => {
    await define('WSPLIT.STALE', 'INTENSIVE');
    const held = gate();
    let aStarted = false;
    registerJob({
      code: 'WSPLIT.STALE',
      async chunk(ctx) {
        if (ctx.epoch === 1) {
          aStarted = true;
          await held.promise;
        }
        await withTenant(ctx.client, async (tx) => {
          await ctx.fence(tx);
          await tx.insert(jobLog).values({
            id: `log-wsplit-${ctx.epoch}`,
            jobRunId: ctx.runId,
            client: ctx.client,
            level: 'INFO',
            message: `BUSINESS:${ctx.epoch}`,
            context: {},
          });
        });
        return { cursor: null, processed: 1 };
      },
    });
    const id = await queueRun('WSPLIT.STALE');
    const a = await claimNext('worker-a', INTENSIVE);
    expect(a).toMatchObject({ runId: id, epoch: 1 });

    // A never beats (heartbeat far in the future) and is paused inside its chunk.
    const aDone = runClaimed('worker-a', a!, { heartbeatMs: 600_000 });
    await until(async () => aStarted, 'worker A to start');

    // The lease times out and another process reaps it.
    await withTenant(tenant.client, (tx) =>
      tx.execute(sql`update job_run set heartbeat_at = now() - interval '5 minutes' where id = ${id}`),
    );
    const reaped = await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1000));
    expect(reaped).toEqual([id]);

    // B claims at epoch 3 (claim 1, reap 2, claim 3) and completes the work.
    const b = await claimNext('worker-b', INTENSIVE);
    expect(b).toMatchObject({ runId: id, epoch: 3 });
    expect(await runClaimed('worker-b', b!)).toBe('SUCCEEDED');

    // A wakes up. Its fenced write fails and rolls back, and it records nothing about the run.
    held.open();
    expect(await aDone).toBe('LEASE_LOST');

    const logs = await withTenant(tenant.client, (tx) =>
      tx.select({ message: jobLog.message }).from(jobLog).where(and(eq(jobLog.jobRunId, id), sql`${jobLog.message} like 'BUSINESS:%'`)),
    );
    expect(logs.map((l) => l.message)).toEqual(['BUSINESS:3']);
    const row = await runRow(id);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.claimEpoch).toBe(3);
  });

  it('the reaper skips a run whose fenced business transaction is still open', async () => {
    await define('WSPLIT.OPENTX', 'INTENSIVE');
    const held = gate();
    let inTx = false;
    registerJob({
      code: 'WSPLIT.OPENTX',
      async chunk(ctx) {
        await withTenant(ctx.client, async (tx) => {
          await ctx.fence(tx);
          inTx = true;
          await held.promise; // transaction stays open, holding the run row
        });
        return { cursor: null, processed: 1 };
      },
    });
    const id = await queueRun('WSPLIT.OPENTX');
    const claimed = await claimNext('worker-a', INTENSIVE);
    const done = runClaimed('worker-a', claimed!, { heartbeatMs: 600_000 });
    await until(async () => inTx, 'the fenced transaction to open');
    await new Promise((r) => setTimeout(r, 50));

    const reaped = await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, 1));
    expect(reaped).toEqual([]);

    held.open();
    expect(await done).toBe('SUCCEEDED');
    expect((await runRow(id)).status).toBe('SUCCEEDED');
  });

  it('a lost lease is not recorded as a job failure', async () => {
    await define('WSPLIT.LOST', 'INTENSIVE');
    registerJob({
      code: 'WSPLIT.LOST',
      async chunk() {
        throw new LeaseLostError();
      },
    });
    const id = await queueRun('WSPLIT.LOST');
    const claimed = await claimNext('worker-a', INTENSIVE);
    expect(await runClaimed('worker-a', claimed!)).toBe('LEASE_LOST');
    const row = await runRow(id);
    expect(row.status).toBe('RUNNING'); // untouched: the owner, not this worker, decides the outcome
    expect(row.errorText).toBeNull();
  });
});
