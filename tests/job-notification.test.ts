/**
 * Notifications raised by the job runtime.
 *
 * The runtime writes three endings: a run completed, a run failed, a run is
 * blocked. Who hears about each one is the whole question, and it has a
 * wrinkle that only shows up against the real queue:
 *
 * today the only thing that ever enqueues a run is the scheduler, and the
 * scheduler writes `triggered_by = 'SCHEDULER'`, which is not a person. A
 * notification addressed to SCHEDULER is one that nobody can ever read, so a
 * naive implementation either fills the table with invisible rows or — having
 * noticed that — tells nobody at all, and a scheduled job that dies at three in
 * the morning dies silently.
 *
 * So the rule under test is:
 *
 *   * a run somebody asked for is reported to that person, whatever the ending;
 *   * a run nobody asked for is reported only when it needs a pair of hands —
 *     failure and blockage — and then to whoever can open the jobs screen;
 *   * a cancellation is not an ending worth announcing at all, because the
 *     person who cancelled is the person who already knows.
 *
 * Asserted against the real database, because the recipient term of the row
 * policy is part of what makes these rows readable: reading as the wrong user
 * returns nothing, which is exactly what a test should not be fooled by.
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { withTenant, withTenantAs } from '../src/platform/db/client';
import { jobRun } from '../src/platform/tables/system';
import { listInbox } from '../src/platform/notification/notify';
import { registerJob, clearJobRegistry } from '../src/platform/job/registry';
import { enqueue, ensureDefinition, requestCancel } from '../src/platform/job/queue';
import { claimNext, runClaimed } from '../src/platform/job/execute';
import { openForChange } from '../src/platform/lock/enqueue';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

import type { ChunkResult, JobContext, LockRef } from '../src/platform/job/types';

const WORKER = 'test-worker';

// What the scheduler writes today. It is the case that makes the fallback
// branch matter, so it is asserted directly rather than assumed.
const SCHEDULER = 'SCHEDULER';

// Whoever can open the jobs screen. The routing table sends a job_run row to
// /platform/jobs, so these are also the only people who could act on one.
const MONITOR_CAPABILITY = 'PLT.JOB.DISPLAY';

let tenant: TestTenant;
let submitter: string; // a real person, named in triggered_by
let monitor: string; // holds MONITOR_CAPABILITY, and nothing else
let holder: string; // owns the session that holds a document
let grant: string;

/** Documents "processed" by the test job, so a test can see what actually ran. */
const processed: string[] = [];

/**
 * A fresh tenant on every run.
 *
 * Not because it is tidier, but because the recipient term of the notification
 * policy governs DELETE as well as SELECT: a `delete from notification` issued
 * with no `cairn.user` set matches nothing and silently succeeds. Rows aimed at
 * yesterday's users are therefore still there today, and a fixed client seed
 * would let them answer assertions meant for this run's rows.
 */
function randomSeed(name: string): string {
  return `${name}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Clear every inbox this file can fill.
 *
 * Deleting has to happen *as* the recipient, for the reason above. Every row
 * these tests create is addressed to one of the three people seeded below, so
 * that is enough; a row addressed to anybody else would survive, and there is
 * no way to notice from inside the application role — which is the policy
 * working as intended, not a gap to work around.
 */
async function clearInboxes(): Promise<void> {
  for (const userId of [submitter, monitor, holder]) {
    if (!userId) continue;
    await withTenantAs(tenant.client, userId, (tx) =>
      tx.execute(sql`delete from notification where client = ${tenant.client}`),
    );
  }
}

beforeAll(async () => {
  tenant = await createTenant(randomSeed('job-notify'));
  submitter = `u-sub-${tenant.client}`;
  monitor = `u-mon-${tenant.client}`;
  holder = `u-hold-${tenant.client}`;
  grant = `g-mon-${tenant.client}`;

  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into app_user (id, client, username, full_name, password_hash, is_active)
      values
        (${submitter}, ${tenant.client}, ${'sub' + tenant.client}, 'Submitter', 'scrypt:x:x', true),
        (${monitor},   ${tenant.client}, ${'mon' + tenant.client}, 'Monitor',   'scrypt:x:x', true),
        (${holder},    ${tenant.client}, ${'hold' + tenant.client}, 'Holder',   'scrypt:x:x', true)
      on conflict (id) do nothing
    `);
    // Deliberately unscoped. Somebody who watches the queue watches all of it;
    // scoping this to one plant would make the fallback depend on which plant
    // the failing run happened to touch, which is not a distinction a failing
    // job makes.
    await tx.execute(sql`
      insert into user_capability (id, client, user_id, capability_code, valid_from, reason, granter)
      values (${grant}, ${tenant.client}, ${monitor}, ${MONITOR_CAPABILITY}, current_date, 'DIRECT', 'TEST')
      on conflict (id) do nothing
    `);
  });
}, 60_000);

/**
 * Each test starts with an empty queue and an empty inbox.
 *
 * The locks have to go too: `holdDocument` leaves a real enqueue entry behind,
 * and a lock surviving into the next test would block a run that was supposed
 * to succeed, making the failure look like a notification problem.
 */
afterEach(async () => {
  clearJobRegistry();
  processed.length = 0;
  await clearInboxes();
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`delete from job_run where client = ${tenant.client}`);
    await tx.execute(sql`delete from enqueue_entry where client = ${tenant.client}`);
  });
});

afterAll(async () => {
  clearJobRegistry();
  await clearInboxes();
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`delete from job_run where client = ${tenant.client}`);
    await tx.execute(sql`delete from enqueue_entry where client = ${tenant.client}`);
    await tx.execute(
      sql`delete from user_capability where client = ${tenant.client} and id = ${grant}`,
    );
  });
  // The tenant goes last, and cascades: sessions and users hang off `client`,
  // and `destroyTenant` deletes that row. Deleting them by hand first would
  // mean issuing deletes the application role was never granted on
  // `user_session`, which fails rather than quietly doing nothing.
  await destroyTenant(tenant.client);
});

/** A job that walks a list of documents one chunk at a time, failing on one if asked. */
function counterJob(documents: string[], failAt?: string) {
  return registerJob({
    code: 'JOBNOTIFY.COUNTER',
    async chunk(ctx: JobContext): Promise<ChunkResult> {
      const from = (ctx.cursor?.next as number) ?? 0;
      const slice = documents.slice(from, from + ctx.chunkSize);

      for (const doc of slice) {
        if (failAt && doc === failAt) throw new Error(`deliberate failure at ${doc}`);
        processed.push(doc);
      }

      const next = from + slice.length;
      return {
        cursor: next >= documents.length ? null : { next },
        processed: slice.length,
        total: documents.length,
      };
    },
  });
}

/** A job that declares the documents it is about to touch. */
function scopedJob(scope: LockRef[]) {
  return registerJob({
    code: 'JOBNOTIFY.SCOPED',
    async scope() {
      return scope;
    },
    async chunk(ctx: JobContext): Promise<ChunkResult> {
      const from = (ctx.cursor?.next as number) ?? 0;
      const doc = scope[from];
      if (!doc) return { cursor: null, processed: 0, total: scope.length };
      processed.push(doc.argument);
      return { cursor: { next: from + 1 }, processed: 1, total: scope.length };
    },
  });
}

async function queueRun(code: string, triggeredBy: string): Promise<string> {
  return withTenant(tenant.client, async (tx) => {
    await ensureDefinition(tx, { code, name: `Test ${code}`, module: 'SYS', maxRetries: 0 });
    const { id } = await enqueue(tx, {
      client: tenant.client,
      jobCode: code,
      triggeredBy,
      // The scheduler is the only thing that enqueues today, and it says so.
      triggerType: triggeredBy === SCHEDULER ? 'SCHEDULED' : 'MANUAL',
    });
    return id;
  });
}

/**
 * Put a document in someone's hands, the way a user editing it would.
 *
 * A real `user_session` row is needed first: `enqueue_entry.owner_session_id`
 * references it. That is the right constraint — a lock with no session behind
 * it is a lock nobody can clear, and no holder to warn.
 */
async function holdDocument(input: { lockObject: string; argument: string }): Promise<void> {
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into user_session (id, client, user_id, token_hash, issued_at, expires_at)
      values (${holder}, ${tenant.client}, ${holder}, 'test-token-hash', now(), now() + interval '8 hours')
      on conflict do nothing`);
  });
  await openForChange({
    client: tenant.client,
    sessionId: holder,
    username: `hold${tenant.client}`,
    lockObject: input.lockObject,
    argument: input.argument,
    transactionCode: 'ME23N',
  });
}

async function statusOf(runId: string): Promise<string | undefined> {
  return withTenant(tenant.client, async (tx) => {
    const [row] = await tx
      .select({ status: jobRun.status })
      .from(jobRun)
      .where(eq(jobRun.id, runId));
    return row?.status;
  });
}

/** The kinds sitting in someone's inbox, which is all this file ever asserts on. */
async function kindsFor(userId: string): Promise<string[]> {
  return (await listInbox(tenant.client, userId)).map((r) => r.kind);
}

describe('a run somebody asked for', () => {
  it('tells that person it finished', async () => {
    counterJob(['d1', 'd2']);
    const id = await queueRun('JOBNOTIFY.COUNTER', submitter);

    expect(await runClaimed(WORKER, (await claimNext(WORKER, null))!)).toBe('SUCCEEDED');
    expect(await statusOf(id)).toBe('SUCCEEDED');

    const found = (await listInbox(tenant.client, submitter)).find((r) => r.kind === 'JOB.COMPLETED');
    expect(found).toBeTruthy();
    // Addressed to the run, not to the job, so opening it lands on that run.
    expect(found!.objectClass).toBe('job_run');
    expect(found!.objectKey).toBe(id);
    expect(found!.isUnseen).toBe(true);
    // The key resolved through the catalogue and the placeholder was filled.
    expect(found!.title).not.toBe(found!.messageKey);
    expect(found!.title).toContain('JOBNOTIFY.COUNTER');
  });

  it('tells that person, and not the queue watchers, when it fails', async () => {
    counterJob(['d1', 'd2'], 'd2');
    const id = await queueRun('JOBNOTIFY.COUNTER', submitter);

    expect(await runClaimed(WORKER, (await claimNext(WORKER, null))!)).toBe('FAILED');

    expect(await kindsFor(submitter)).toContain('JOB.FAILED');
    // A named recipient is enough. Waking everyone who can open the jobs screen
    // for a run that already has an owner is noise, not diligence.
    expect(await kindsFor(monitor)).not.toContain('JOB.FAILED');

    const row = (await listInbox(tenant.client, submitter)).find((r) => r.kind === 'JOB.FAILED')!;
    expect(row.objectKey).toBe(id);
  });

  it('tells that person when the job meets a locked document', async () => {
    scopedJob([{ lockObject: 'PURCHASE_ORDER', argument: 'PO-1' }]);
    const id = await queueRun('JOBNOTIFY.SCOPED', submitter);
    await holdDocument({ lockObject: 'PURCHASE_ORDER', argument: 'PO-1' });

    expect(await runClaimed(WORKER, (await claimNext(WORKER, null))!)).toBe('BLOCKED');
    expect(processed).toEqual([]);

    const found = (await listInbox(tenant.client, submitter)).find((r) => r.kind === 'JOB.BLOCKED');
    expect(found).toBeTruthy();
    expect(found!.objectKey).toBe(id);
  });

  it('says nothing when the run was cancelled, because they cancelled it', async () => {
    registerJob({
      code: 'JOBNOTIFY.CANCELLING',
      async chunk(ctx: JobContext): Promise<ChunkResult> {
        await withTenant(tenant.client, (tx) => requestCancel(tx, tenant.client, ctx.runId));
        processed.push('m0');
        return { cursor: { next: 1 }, processed: 1, total: 2 };
      },
    });
    await queueRun('JOBNOTIFY.CANCELLING', submitter);

    expect(await runClaimed(WORKER, (await claimNext(WORKER, null))!)).toBe('CANCELLED');

    // Cancelling is something the user did, not something that happened to them.
    expect(await kindsFor(submitter)).toEqual([]);
    expect(await kindsFor(monitor)).toEqual([]);
  });
});

describe('a run nobody asked for', () => {
  it('stays quiet when a scheduled run merely finishes', async () => {
    counterJob(['d1', 'd2']);
    const id = await queueRun('JOBNOTIFY.COUNTER', SCHEDULER);

    expect(await runClaimed(WORKER, (await claimNext(WORKER, null))!)).toBe('SUCCEEDED');
    expect(await statusOf(id)).toBe('SUCCEEDED');

    // The ordinary case. Every scheduled run would otherwise arrive in every
    // watcher's inbox every night, which teaches people to ignore the bell.
    expect(await kindsFor(monitor)).toEqual([]);
  });

  it('raises a failed scheduled run with the people who watch the queue', async () => {
    counterJob(['d1', 'd2'], 'd2');
    await queueRun('JOBNOTIFY.COUNTER', SCHEDULER);

    expect(await runClaimed(WORKER, (await claimNext(WORKER, null))!)).toBe('FAILED');

    // Nobody can be named, and a failure needs a person. This is the branch that
    // stops a scheduled job dying silently at three in the morning.
    const found = (await listInbox(tenant.client, monitor)).find((r) => r.kind === 'JOB.FAILED');
    expect(found).toBeTruthy();
    expect(found!.objectClass).toBe('job_run');
  });

  it('raises a blocked scheduled run with the people who watch the queue', async () => {
    scopedJob([{ lockObject: 'PURCHASE_ORDER', argument: 'PO-2' }]);
    await queueRun('JOBNOTIFY.SCOPED', SCHEDULER);
    await holdDocument({ lockObject: 'PURCHASE_ORDER', argument: 'PO-2' });

    expect(await runClaimed(WORKER, (await claimNext(WORKER, null))!)).toBe('BLOCKED');

    // A blocked run is not going to clear itself; somebody has to release the
    // document or stop waiting.
    expect(await kindsFor(monitor)).toContain('JOB.BLOCKED');
  });

  it('reaches the watchers and nobody else', async () => {
    counterJob(['d1', 'd2'], 'd2');
    await queueRun('JOBNOTIFY.COUNTER', SCHEDULER);
    await runClaimed(WORKER, (await claimNext(WORKER, null))!);

    // Every person in this tenant. A row addressed to SCHEDULER could never be
    // read by any of them, so what this really asserts is that the fan-out went
    // to the capability holders and did not simply spray the tenant.
    expect(await kindsFor(monitor)).toEqual(['JOB.FAILED']);
    expect(await kindsFor(submitter)).toEqual([]);
    expect(await kindsFor(holder)).toEqual([]);
  });
});
