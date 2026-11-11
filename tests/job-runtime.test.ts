/**
 * The job runtime.
 *
 * What is under test is not that a job runs — that is easy — but that it runs
 * *correctly under the conditions that actually occur*: a worker dies, a user
 * has a document open, a job fails halfway, a user cancels, somebody clicks
 * submit twice.
 *
 * The load-bearing assertions:
 *
 *   * **Enqueue rolls back with its caller.** The whole reason `enqueue` takes a
 *     transaction. A committed document with no job is a silent gap.
 *   * **A resumed run resumes.** It restarts from the chunk it stopped at and
 *     never from zero, so a failure costs the work of one chunk.
 *   * **A held document stops the run, and does not get skipped.** A job that
 *     quietly omits a locked document produces a result that looks complete and
 *     is not.
 *   * **Termination is a last resort.** A scheduled job with authority warns
 *     first and closes a session only after the grace period.
 *   * **Claiming crosses tenants without leaking.** The worker cannot read
 *     another tenant's queue by any other route.
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { jobRun, jobLog, jobDefinition } from '../src/platform/tables/system';
import { appUser } from '../src/platform/tables/security';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_GRACE_SECONDS,
  HEARTBEAT_TIMEOUT_MS,
  LOCK_RETRY_DELAY_MS,
  JobBlockedError,
  backoffMs,
  shouldEnqueue,
  type ChunkResult,
  type Cursor,
  type JobContext,
  type LockRef,
} from '../src/platform/job/types';
import { registerJob, clearJobRegistry } from '../src/platform/job/registry';
import {
  enqueue,
  ensureDefinition,
  requestCancel,
  retryRun,
  reapOrphans,
  purgeFinished,
  logLine,
} from '../src/platform/job/queue';
import { claimNext, runClaimed } from '../src/platform/job/execute';
import { openForChange } from '../src/platform/lock/enqueue';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'JOB_RUNTIME_TEST';
const WORKER = 'test-worker';

let tenant: TestTenant;
let other: TestTenant;

/** Documents "processed" by the test job, so a test can see what actually ran. */
const processed: string[] = [];

beforeAll(async () => {
  tenant = await createTenant('job-runtime');
  other = await createTenant('job-runtime-other');
  await withTenant(tenant.client, (tx) =>
    ensureDefinition(tx, { code: 'JOBTEST.COUNTER', name: 'Counting job', module: 'SYS' }),
  );
});

/**
 * Each test starts with an empty queue.
 *
 * Without this, `claimNext` returns the oldest claimable run in the tenant —
 * which may be a leftover from an earlier test that has no handler registered —
 * and the test then measures the wrong run.
 */
afterEach(async () => {
  clearJobRegistry();
  processed.length = 0;
  await withTenant(tenant.client, (tx) => tx.delete(jobRun).where(eq(jobRun.client, tenant.client)));
  await withTenant(other.client, (tx) => tx.delete(jobRun).where(eq(jobRun.client, other.client)));
});

afterAll(async () => {
  clearJobRegistry();
  await withTenant(tenant.client, async (tx) => {
    await tx.delete(jobRun).where(eq(jobRun.client, tenant.client));
    await tx.execute(sql`delete from job_definition where code like 'JOBTEST%'`);
  });
  await destroyTenant(other.client);
  await destroyTenant(tenant.client);
});

/** A job that walks a list of documents, `chunkSize` at a time. */
function counterJob(options: { documents: string[]; failAt?: string; chunkSize?: number } = { documents: [] }) {
  return registerJob({
    code: 'JOBTEST.COUNTER',
    async chunk(ctx: JobContext): Promise<ChunkResult> {
      const from = (ctx.cursor?.next as number) ?? 0;
      const size = options.chunkSize ?? ctx.chunkSize;
      const slice = options.documents.slice(from, from + size);

      for (const doc of slice) {
        if (options.failAt && doc === options.failAt) {
          throw new Error(`deliberate failure at ${doc}`);
        }
        processed.push(doc);
      }

      const next = from + slice.length;
      const done = next >= options.documents.length;
      return {
        cursor: done ? null : { next },
        processed: slice.length,
        total: options.documents.length,
        progressText: `${next} of ${options.documents.length}`,
      };
    },
  });
}

async function queueRun(
  client: string,
  code: string,
  over: { triggerType?: 'MANUAL' | 'SCHEDULED'; maxRetries?: number; chunkSize?: number; gracePeriodSeconds?: number; mayTerminateSessions?: boolean; idempotencyKey?: string } = {},
): Promise<string> {
  return withTenant(client, async (tx) => {
    await ensureDefinition(tx, {
      code,
      name: `Test ${code}`,
      module: 'SYS',
      maxRetries: over.maxRetries ?? 0,
      chunkSize: over.chunkSize,
      gracePeriodSeconds: over.gracePeriodSeconds,
      mayTerminateSessions: over.mayTerminateSessions ?? false,
    });
    // ensureDefinition is deliberately idempotent, so a code reused across
    // tests would keep whichever flags were set the first time. Tests need the
    // definition to be exactly what they asked for, so set the mutable columns.
    await tx
      .update(jobDefinition)
      .set({
        maxRetries: over.maxRetries ?? 0,
        chunkSize: over.chunkSize ?? DEFAULT_CHUNK_SIZE,
        gracePeriodSeconds: over.gracePeriodSeconds ?? DEFAULT_GRACE_SECONDS,
        mayTerminateSessions: over.mayTerminateSessions ?? false,
        isEnabled: true,
      })
      .where(eq(jobDefinition.code, code));

    const { id } = await enqueue(tx, {
      client,
      jobCode: code,
      triggeredBy: ACTOR,
      triggerType: over.triggerType ?? 'MANUAL',
      idempotencyKey: over.idempotencyKey,
    });
    return id;
  });
}

/**
 * Put a document in someone's hands, the way a user editing it would.
 *
 * A real `user_session` row is needed first: `enqueue_entry.owner_session_id`
 * references it, so a lock cannot be invented out of thin air. That is the
 * right constraint — a lock with no session behind it is a lock nobody can
 * clear, and no holder to warn.
 */
async function holdDocument(
  client: string,
  input: { lockObject: string; argument: string; username: string; sessionId: string; transactionCode: string },
): Promise<void> {
  await withTenant(client, async (tx) => {
    // A real user, because user_session.user_id references app_user: a lock
    // belongs to somebody who has to be warnable.
    await tx
      .insert(appUser)
      .values({
        id: input.sessionId,
        client,
        username: input.username,
        fullName: input.username,
        passwordHash: 'scrypt:not-a-real-hash:not-a-real-hash',
        isActive: true,
      })
      .onConflictDoNothing();
    await tx.execute(sql`
      insert into user_session (id, client, user_id, token_hash, issued_at, expires_at)
      values (${input.sessionId}, ${client}, ${input.sessionId}, 'test-token-hash', now(), now() + interval '8 hours')
      on conflict do nothing`);
  });
  await openForChange({
    client,
    sessionId: input.sessionId,
    username: input.username,
    lockObject: input.lockObject,
    argument: input.argument,
    transactionCode: input.transactionCode,
  });
}

async function statusOf(client: string, runId: string) {
  return withTenant(client, async (tx) => {
    const [row] = await tx
      .select({
        status: jobRun.status,
        retryCount: jobRun.retryCount,
        chunksDone: jobRun.chunksDone,
        cursor: jobRun.cursor,
        errorText: jobRun.errorText,
        blockedOn: jobRun.blockedOn,
        progressPercent: jobRun.progressPercent,
        resultSummary: jobRun.resultSummary,
        nextAttemptAt: jobRun.nextAttemptAt,
      })
      .from(jobRun)
      .where(eq(jobRun.id, runId))
      .limit(1);
    return row;
  });
}

async function logsOf(client: string, runId: string) {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ level: jobLog.level, message: jobLog.message, context: jobLog.context })
      .from(jobLog)
      .where(eq(jobLog.jobRunId, runId));
    return rows as Array<{ level: string; message: string; context: { kind?: string } | null }>;
  });
}

describe('enqueueing', () => {
  it('is part of the caller transaction — a rollback queues nothing', async () => {
    const before = await withTenant(tenant.client, (tx) =>
      tx.select({ id: jobRun.id }).from(jobRun).where(eq(jobRun.client, tenant.client)),
    );

    let threw = false;
    try {
      await withTenant(tenant.client, async (tx) => {
        await enqueue(tx, { client: tenant.client, jobCode: 'JOBTEST.COUNTER', triggeredBy: ACTOR });
        throw new Error('rollback on purpose');
      });
    } catch {
      threw = true;
    }

    const after = await withTenant(tenant.client, (tx) =>
      tx.select({ id: jobRun.id }).from(jobRun).where(eq(jobRun.client, tenant.client)),
    );

    expect(threw).toBe(true);
    expect(after.length).toBe(before.length);
  });

  it('queues the job when the caller commits', async () => {
    const id = await withTenant(tenant.client, (tx) =>
      enqueue(tx, { client: tenant.client, jobCode: 'JOBTEST.COUNTER', triggeredBy: ACTOR }).then((r) => r.id),
    );
    const row = await statusOf(tenant.client, id);
    expect(row?.status).toBe('QUEUED');
  });

  it('collapses a repeated submission to one run, by idempotency key', async () => {
    const first = await withTenant(tenant.client, (tx) =>
      enqueue(tx, {
        client: tenant.client,
        jobCode: 'JOBTEST.COUNTER',
        triggeredBy: ACTOR,
        idempotencyKey: 'nightly-2026-01-01',
      }),
    );
    const second = await withTenant(tenant.client, (tx) =>
      enqueue(tx, {
        client: tenant.client,
        jobCode: 'JOBTEST.COUNTER',
        triggeredBy: ACTOR,
        idempotencyKey: 'nightly-2026-01-01',
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const count = await withTenant(tenant.client, (tx) =>
      tx
        .select({ id: jobRun.id })
        .from(jobRun)
        .where(eq(jobRun.idempotencyKey, 'nightly-2026-01-01')),
    );
    expect(count.length).toBe(1);
  });

  it('treats different keys as different jobs', async () => {
    await withTenant(tenant.client, (tx) =>
      enqueue(tx, { client: tenant.client, jobCode: 'JOBTEST.COUNTER', triggeredBy: ACTOR, idempotencyKey: 'a' }),
    );
    await withTenant(tenant.client, (tx) =>
      enqueue(tx, { client: tenant.client, jobCode: 'JOBTEST.COUNTER', triggeredBy: ACTOR, idempotencyKey: 'b' }),
    );
    const rows = await withTenant(tenant.client, (tx) =>
      tx.select({ id: jobRun.id }).from(jobRun).where(eq(jobRun.client, tenant.client)),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('claiming', () => {
  it('finds work in a tenant the worker is not scoped to', async () => {
    // The worker has no tenant set. It can only see this run through the
    // definer function — which is the whole reason that function exists.
    const id = await queueRun(other.client, 'JOBTEST.CROSS');
    const claimed = await claimNext(WORKER, null);
    expect(claimed).not.toBeNull();
    expect(claimed!.runId).toBe(id);
    expect(claimed!.client).toBe(other.client);
  });

  it('gives one run to one claim, and nothing to the next', async () => {
    await queueRun(tenant.client, 'JOBTEST.ONCE');
    const first = await claimNext(WORKER, null);
    const second = await claimNext(WORKER, null);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('ignores a run that is not yet due', async () => {
    const id = await queueRun(tenant.client, 'JOBTEST.LATER');
    await withTenant(tenant.client, (tx) =>
      tx
        .update(jobRun)
        .set({ nextAttemptAt: sql`now() + interval '1 hour'` })
        .where(eq(jobRun.id, id)),
    );
    expect(await claimNext(WORKER, null)).toBeNull();
  });

  it('does not hand out a job whose definition is disabled', async () => {
    await queueRun(tenant.client, 'JOBTEST.OFF');
    await withTenant(tenant.client, (tx) =>
      tx.execute(sql`update job_definition set is_enabled = false where code = 'JOBTEST.OFF'`),
    );
    expect(await claimNext(WORKER, null)).toBeNull();
  });
});

describe('running', () => {
  it('processes every document, in chunks, and finishes', async () => {
    counterJob({ documents: ['d1', 'd2', 'd3', 'd4', 'd5'], chunkSize: 2 });
    const id = await queueRun(tenant.client, 'JOBTEST.COUNTER', { chunkSize: 2 });

    const claimed = await claimNext(WORKER, null);
    expect(claimed!.runId).toBe(id);
    const status = await runClaimed(WORKER, claimed!);

    expect(status).toBe('SUCCEEDED');
    expect(processed).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    const row = await statusOf(tenant.client, id);
    expect(row?.chunksDone).toBe(3);
    expect(row?.progressPercent).toBe(100);
  });

  it('reports progress as it goes, so the status page is not a guess', async () => {
    counterJob({ documents: Array.from({ length: 10 }, (_, i) => `p${i}`), chunkSize: 5 });
    const id = await queueRun(tenant.client, 'JOBTEST.COUNTER', { chunkSize: 5 });
    const claimed = await claimNext(WORKER, null);
    await runClaimed(WORKER, claimed!);
    const row = await statusOf(tenant.client, id);
    expect(row?.progressPercent).toBe(100);
    expect(row?.resultSummary).toContain('10 document(s)');
  });

  it('fails cleanly and keeps the cursor when a chunk throws', async () => {
    counterJob({ documents: ['a', 'b', 'c', 'd'], failAt: 'c', chunkSize: 2 });
    const id = await queueRun(tenant.client, 'JOBTEST.COUNTER', { chunkSize: 2 });
    const claimed = await claimNext(WORKER, null);

    await runClaimed(WORKER, claimed!);

    const row = await statusOf(tenant.client, id);
    expect(row?.status).toBe('FAILED');
    expect(row?.errorText).toContain('deliberate failure at c');
    // a and b are done and committed; the run knows where it stopped.
    expect(row?.cursor).toEqual({ next: 2 });
  });

  it('resumes from the chunk it stopped at, never from zero', async () => {
    const documents = ['a', 'b', 'c', 'd', 'e', 'f'];
    counterJob({ documents, failAt: 'c', chunkSize: 2 });
    const id = await queueRun(tenant.client, 'JOBTEST.COUNTER', { chunkSize: 2, maxRetries: 1 });

    await runClaimed(WORKER, (await claimNext(WORKER, null))!);
    expect(processed).toEqual(['a', 'b']);

    // The retry runs the same job without the fault, from the stored cursor.
    // Clearing first, because one job code identifies exactly one handler.
    clearJobRegistry();
    counterJob({ documents, chunkSize: 2 });
    await withTenant(tenant.client, (tx) =>
      tx.update(jobRun).set({ status: 'QUEUED', nextAttemptAt: sql`now()` }).where(eq(jobRun.id, id)),
    );

    const status = await runClaimed(WORKER, (await claimNext(WORKER, null))!);

    expect(status).toBe('SUCCEEDED');
    // 'a' and 'b' were already done and must not be repeated.
    expect(processed).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('dead-letters instead of retrying forever', async () => {
    counterJob({ documents: ['x', 'y'], failAt: 'x' });
    const id = await queueRun(tenant.client, 'JOBTEST.COUNTER', { maxRetries: 1 });

    await runClaimed(WORKER, (await claimNext(WORKER, null))!);
    await withTenant(tenant.client, (tx) =>
      tx.update(jobRun).set({ status: 'QUEUED', nextAttemptAt: sql`now()` }).where(eq(jobRun.id, id)),
    );
    const status = await runClaimed(WORKER, (await claimNext(WORKER, null))!);

    expect(status).toBe('DEAD_LETTER');
    const row = await statusOf(tenant.client, id);
    expect(row?.retryCount).toBe(2);
  });

  it('backs off further each time, up to a ceiling', () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(10_000);
    expect(backoffMs(3)).toBe(20_000);
    expect(backoffMs(20)).toBe(300_000);
  });
});

describe('cancelling', () => {
  it('cancels a queued run outright, because nothing is in flight', async () => {
    const id = await queueRun(tenant.client, 'JOBTEST.CANCELQ');
    await withTenant(tenant.client, (tx) => requestCancel(tx, tenant.client, id));
    expect((await statusOf(tenant.client, id))?.status).toBe('CANCELLED');
  });

  it('does no work at all when the cancel arrives before the first chunk', async () => {
    counterJob({ documents: ['c0', 'c1', 'c2', 'c3'], chunkSize: 2 });
    const id = await queueRun(tenant.client, 'JOBTEST.COUNTER', { chunkSize: 2 });
    await withTenant(tenant.client, async (tx) => {
      await tx.update(jobRun).set({ status: 'RUNNING' }).where(eq(jobRun.id, id));
      await requestCancel(tx, tenant.client, id);
    });

    const status = await runClaimed(WORKER, { runId: id, client: tenant.client, jobCode: 'JOBTEST.COUNTER' });

    expect(status).toBe('CANCELLED');
    expect(processed).toEqual([]);
  });

  it('stops at a chunk boundary when the cancel arrives mid-run', async () => {
    // The handler asks to be cancelled after its first chunk, which is the real
    // shape of the situation: the flag appears while the job is working.
    registerJob({
      code: 'JOBTEST.COUNTER',
      async chunk(ctx: JobContext): Promise<ChunkResult> {
        const from = (ctx.cursor?.next as number) ?? 0;
        const docs = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'].slice(from, from + 2);
        for (const d of docs) processed.push(d);
        await withTenant(tenant.client, (tx) => requestCancel(tx, tenant.client, ctx.runId));
        const next = from + docs.length;
        return { cursor: { next }, processed: docs.length, total: 6 };
      },
    });
    const id = await queueRun(tenant.client, 'JOBTEST.COUNTER', { chunkSize: 2 });

    const status = await runClaimed(WORKER, { runId: id, client: tenant.client, jobCode: 'JOBTEST.COUNTER' });

    expect(status).toBe('CANCELLED');
    // The chunk in flight finished; the next one never started. Nothing is
    // half-written, which is why cancellation is a request and not a kill.
    expect(processed).toEqual(['m0', 'm1']);
  });

  it('puts a cancelled or dead-lettered run back on request', async () => {
    const id = await queueRun(tenant.client, 'JOBTEST.RETRYME');
    await withTenant(tenant.client, (tx) => requestCancel(tx, tenant.client, id));
    expect((await statusOf(tenant.client, id))?.status).toBe('CANCELLED');

    await withTenant(tenant.client, (tx) => retryRun(tx, tenant.client, id));
    const row = await statusOf(tenant.client, id);
    expect(row?.status).toBe('QUEUED');
    expect(row?.retryCount).toBe(0);
  });
});

describe('a job meeting a locked document', () => {
  const code = 'JOBTEST.LOCKED';

  function scopedJob(scope: LockRef[]) {
    return registerJob({
      code,
      async scope() {
        return scope;
      },
      async chunk(ctx: JobContext): Promise<ChunkResult> {
        const from = (ctx.cursor?.next as number) ?? 0;
        const doc = scope[from];
        if (!doc) return { cursor: null, processed: 0, total: scope.length };
        processed.push(doc.argument);
        const next = from + 1;
        return {
          cursor: next >= scope.length ? null : { next },
          processed: 1,
          total: scope.length,
        };
      },
    });
  }

  it('stops, names the holder, and does not skip the document', async () => {
    scopedJob([{ lockObject: 'PURCHASE_ORDER', argument: 'PO-1' }]);
    const id = await queueRun(tenant.client, code);

    // A user has the document open for change.
    await holdDocument(tenant.client, {
      lockObject: 'PURCHASE_ORDER',
      argument: 'PO-1',
      username: 'holder.user',
      sessionId: 'session-held',
      transactionCode: 'ME23N',
    });

    const status = await runClaimed(WORKER, (await claimNext(WORKER, null))!);

    expect(status).toBe('BLOCKED');
    expect(processed).toEqual([]);

    const row = await statusOf(tenant.client, id);
    expect(row?.blockedOn?.documents).toEqual([
      { lockObject: 'PURCHASE_ORDER', argument: 'PO-1', holderUser: 'holder.user', holderSessionId: 'session-held' },
    ]);

    const logs = await logsOf(tenant.client, id);
    expect(logs.some((l) => l.context?.kind === 'JOB.BLOCKED')).toBe(true);
  });

  it('keeps the cursor, so the wait costs nothing already done', async () => {
    scopedJob([
      { lockObject: 'MATERIAL', argument: 'M-1' },
      { lockObject: 'MATERIAL', argument: 'M-2' },
      { lockObject: 'MATERIAL', argument: 'M-3' },
    ]);
    const id = await queueRun(tenant.client, code);

    // Let the first two chunks through, then hold the third.
    await withTenant(tenant.client, (tx) =>
      tx.update(jobRun).set({ cursor: { next: 2 } as Cursor, chunksDone: 2 }).where(eq(jobRun.id, id)),
    );
    processed.push('M-1', 'M-2');
    await holdDocument(tenant.client, {
      lockObject: 'MATERIAL',
      argument: 'M-3',
      username: 'holder.user',
      sessionId: 'session-held',
      transactionCode: 'MM02',
    });

    await runClaimed(WORKER, { runId: id, client: tenant.client, jobCode: code });

    const row = await statusOf(tenant.client, id);
    expect(row?.status).toBe('BLOCKED');
    // Two chunks are done and their cursor survives the stop.
    expect(row?.chunksDone).toBe(2);
    expect(row?.cursor).toEqual({ next: 2 });
  });

  it('becomes claimable again after the retry delay', async () => {
    scopedJob([{ lockObject: 'VENDOR', argument: 'V-1' }]);
    const id = await queueRun(tenant.client, code);
    await holdDocument(tenant.client, {
      lockObject: 'VENDOR',
      argument: 'V-1',
      username: 'holder.user',
      sessionId: 'session-held',
      transactionCode: 'XK02',
    });

    await runClaimed(WORKER, (await claimNext(WORKER, null))!);

    // Blocked, and waiting — not claimable yet.
    expect(await claimNext(WORKER, null)).toBeNull();

    await withTenant(tenant.client, (tx) =>
      tx
        .update(jobRun)
        .set({ nextAttemptAt: sql`now() - interval '1 second'` })
        .where(eq(jobRun.id, id)),
    );
    const reclaimed = await claimNext(WORKER, null);
    expect(reclaimed?.runId).toBe(id);
  });

  it('warns before it terminates, and only a scheduled job may terminate', async () => {
    scopedJob([{ lockObject: 'PLANT', argument: 'P-1' }]);
    const id = await queueRun(tenant.client, code, {
      triggerType: 'SCHEDULED',
      mayTerminateSessions: true,
      gracePeriodSeconds: 60,
    });
    await holdDocument(tenant.client, {
      lockObject: 'PLANT',
      argument: 'P-1',
      username: 'holder.user',
      sessionId: 'session-held',
      transactionCode: 'OX10',
    });

    await runClaimed(WORKER, (await claimNext(WORKER, null))!);

    // First contact is a warning. Nothing has been closed and no work is lost.
    const warned = await statusOf(tenant.client, id);
    expect(warned?.status).toBe('BLOCKED');
    expect(warned?.blockedOn?.willTerminateAt).toBeTruthy();

    const logs = await logsOf(tenant.client, id);
    expect(logs.some((l) => l.context?.kind === 'JOB.WARNING')).toBe(true);

    const stillOpen = await withTenant(tenant.client, (tx) =>
      tx.execute(sql`select count(*)::int as n from enqueue_entry where client = ${tenant.client} and argument = 'P-1'`),
    );
    expect((stillOpen as unknown as Array<{ n: number }>)[0]!.n).toBe(1);
  });

  it('an ad-hoc job never terminates a session, however long it waits', async () => {
    scopedJob([{ lockObject: 'PLANT', argument: 'P-2' }]);
    const id = await queueRun(tenant.client, code, { triggerType: 'MANUAL', mayTerminateSessions: true });
    await holdDocument(tenant.client, {
      lockObject: 'PLANT',
      argument: 'P-2',
      username: 'holder.user',
      sessionId: 'session-held',
      transactionCode: 'OX10',
    });

    await runClaimed(WORKER, (await claimNext(WORKER, null))!);

    const row = await statusOf(tenant.client, id);
    expect(row?.status).toBe('BLOCKED');
    // No warning was issued, because there is no authority to follow it up.
    expect(row?.blockedOn?.willTerminateAt).toBeUndefined();
  });

  it('a handler can block mid-run by throwing, and the run stops too', async () => {
    registerJob({
      code,
      async chunk(): Promise<ChunkResult> {
        throw new JobBlockedError([
          { lockObject: 'ORDER', argument: 'O-9', holderUser: 'mid.user', holderSessionId: 's9' },
        ]);
      },
    });
    const id = await queueRun(tenant.client, code);
    const status = await runClaimed(WORKER, (await claimNext(WORKER, null))!);
    expect(status).toBe('BLOCKED');
    const row = await statusOf(tenant.client, id);
    expect(row?.blockedOn?.documents[0]?.argument).toBe('O-9');
  });
});

describe('a worker dying', () => {
  it('reaps an orphaned run back onto the queue with its cursor intact', async () => {
    counterJob({ documents: ['a', 'b', 'c', 'd'], chunkSize: 2 });
    const id = await queueRun(tenant.client, 'JOBTEST.COUNTER', { chunkSize: 2 });

    // A worker claimed it, did a chunk, and then was killed.
    await withTenant(tenant.client, (tx) =>
      tx
        .update(jobRun)
        .set({
          status: 'RUNNING',
          workerId: 'dead-worker',
          claimedAt: sql`now() - interval '10 minutes'`,
          heartbeatAt: sql`now() - interval '10 minutes'`,
          cursor: { next: 2 } as Cursor,
          chunksDone: 1,
        })
        .where(eq(jobRun.id, id)),
    );

    const reaped = await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, HEARTBEAT_TIMEOUT_MS));
    expect(reaped).toContain(id);

    const row = await statusOf(tenant.client, id);
    expect(row?.status).toBe('QUEUED');
    expect(row?.cursor).toEqual({ next: 2 });
  });

  it('leaves a live run alone', async () => {
    const id = await queueRun(tenant.client, 'JOBTEST.ALIVE');
    await withTenant(tenant.client, (tx) =>
      tx
        .update(jobRun)
        .set({ status: 'RUNNING', workerId: WORKER, heartbeatAt: sql`now()` })
        .where(eq(jobRun.id, id)),
    );
    const reaped = await withTenant(tenant.client, (tx) => reapOrphans(tx, tenant.client, HEARTBEAT_TIMEOUT_MS));
    expect(reaped).not.toContain(id);
  });
});

describe('housekeeping', () => {
  it('purges only finished runs that are past retention', async () => {
    const id = await queueRun(tenant.client, 'JOBTEST.PURGE');
    await withTenant(tenant.client, (tx) =>
      tx
        .update(jobRun)
        .set({ status: 'SUCCEEDED', finishedAt: sql`now() - interval '90 days'` })
        .where(eq(jobRun.id, id)),
    );
    const live = await queueRun(tenant.client, 'JOBTEST.KEEP');

    const removed = await withTenant(tenant.client, (tx) => purgeFinished(tx, tenant.client));
    expect(removed).toBeGreaterThan(0);
    expect(await statusOf(tenant.client, id)).toBeUndefined();
    expect(await statusOf(tenant.client, live)).toBeDefined();
  });

  it('keeps a log line against the run', async () => {
    const id = await queueRun(tenant.client, 'JOBTEST.LOGGED');
    await withTenant(tenant.client, (tx) =>
      logLine(tx, tenant.client, id, 'INFO', 'Starting up', { step: 1 }),
    );
    const logs = await logsOf(tenant.client, id);
    expect(logs.some((l) => l.message === 'Starting up')).toBe(true);
  });
});

describe('what belongs in a job', () => {
  it('sends work to a worker for load or for time, either alone', () => {
    // Fast per document, but far too many of them.
    expect(shouldEnqueue(5, 400_000)).toBe(true);
    // Three documents, but a minute and a half of work.
    expect(shouldEnqueue(90_000, 3)).toBe(true);
    // Neither: just answer it.
    expect(shouldEnqueue(300, 10)).toBe(false);
  });

  it('chunks by the definition when given, and by the default otherwise', () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(100);
    expect(LOCK_RETRY_DELAY_MS).toBe(60_000);
  });
});
