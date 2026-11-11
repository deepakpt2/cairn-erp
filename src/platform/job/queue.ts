/**
 * Enqueueing and lifecycle — the half of the runtime the application touches.
 *
 * ## Enqueue happens in the caller's transaction
 *
 * `enqueue` takes a `Tx`, not a client. If the business transaction that
 * decided to run a job rolls back, the job was never queued. That is the whole
 * point of taking a transaction: the alternative — commit the work, then queue
 * the job — splits one decision into two, and the gap between them is where
 * "the document saved but the job never ran" lives.
 *
 * ## Idempotency is a unique index, not a check-then-insert
 *
 * A caller that retries a submission (a double-clicked button, a replayed
 * request) must not queue the same work twice. Checking first and inserting
 * second is a race; the unique index on (client, job_code, idempotency_key) is
 * not. On conflict the existing run is returned, so the caller gets the same
 * answer either way.
 */

import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { jobDefinition, jobLog, jobRun } from '../tables/system';
import type { JobStatus, JobTrigger, LogLevel } from './types';
import { DEFAULT_RETENTION_DAYS } from './types';

export interface EnqueueInput {
  client: string;
  jobCode: string;
  parameters?: Record<string, unknown>;
  triggeredBy: string;
  triggerType?: JobTrigger;
  /** Same key + job + tenant = one run, however many times it is submitted. */
  idempotencyKey?: string;
  /** Chain a job onto the run that spawned it, so the status page can show the link. */
  parentRunId?: string;
}

export interface EnqueuedRun {
  id: string;
  /** False when the idempotency key matched a run that was already queued. */
  created: boolean;
}

/**
 * Queue a job, inside the caller's already-open transaction.
 *
 * If the transaction rolls back, so does the job.
 */
export async function enqueue(tx: Tx, input: EnqueueInput): Promise<EnqueuedRun> {
  const id = input.idempotencyKey
    ? stableRunId(input.client, input.jobCode, input.idempotencyKey)
    : newRunId();

  const inserted = await tx
    .insert(jobRun)
    .values({
      id,
      client: input.client,
      jobCode: input.jobCode,
      status: 'QUEUED',
      triggerType: input.triggerType ?? 'MANUAL',
      triggeredBy: input.triggeredBy,
      parameters: input.parameters ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
      nextAttemptAt: sql`now()`,
      queuedAt: sql`now()`,
    })
    .onConflictDoNothing()
    .returning({ id: jobRun.id });

  if (inserted.length > 0) return { id: inserted[0]!.id, created: true };

  // The unique index already has this key, so the run exists. Report it rather
  // than inventing a second one.
  const [existing] = await tx
    .select({ id: jobRun.id })
    .from(jobRun)
    .where(
      and(
        eq(jobRun.client, input.client),
        eq(jobRun.jobCode, input.jobCode),
        eq(jobRun.idempotencyKey, input.idempotencyKey ?? ''),
      ),
    )
    .limit(1);

  return { id: existing?.id ?? id, created: false };
}

/**
 * Ask a run to stop.
 *
 * A queued run is cancelled outright, because nothing is mid-flight. A running
 * run is only *asked*: the worker notices the flag between chunks and stops
 * there, so the run ends at a chunk boundary with its cursor intact rather
 * than being killed halfway through a commit.
 *
 * This is why cancellation is a request and not a status change — a job that
 * has already written three hundred documents must stop cleanly, not be
 * abandoned in an unknown state.
 */
export async function requestCancel(tx: Tx, client: string, runId: string): Promise<boolean> {
  const updated = await tx
    .update(jobRun)
    .set({ cancelRequestedAt: sql`now()` })
    .where(and(eq(jobRun.client, client), eq(jobRun.id, runId), isNull(jobRun.cancelRequestedAt)))
    .returning({ id: jobRun.id, status: jobRun.status });

  if (updated.length === 0) return false;

  // Nothing has claimed it, so there is no worker to notice the flag.
  if (updated[0]!.status === 'QUEUED' || updated[0]!.status === 'BLOCKED') {
    await tx
      .update(jobRun)
      .set({ status: 'CANCELLED', finishedAt: sql`now()` })
      .where(and(eq(jobRun.client, client), eq(jobRun.id, runId)));
  }
  return true;
}

/**
 * Put a failed or dead-lettered run back on the queue.
 *
 * Retries from the run's cursor, not from zero — the whole reason the cursor is
 * persisted. Retrying a dead-lettered run clears its dead-letter marker and its
 * retry count, because a human has decided to try again and a fresh attempt
 * should get a fresh allowance.
 */
export async function retryRun(tx: Tx, client: string, runId: string): Promise<boolean> {
  const updated = await tx
    .update(jobRun)
    .set({
      status: 'QUEUED',
      retryCount: 0,
      nextAttemptAt: sql`now()`,
      finishedAt: null,
      errorText: null,
      deadLetteredAt: null,
      blockedAt: null,
      blockedOn: null,
      warnedAt: null,
    })
    .where(
      and(
        eq(jobRun.client, client),
        eq(jobRun.id, runId),
        inArray(jobRun.status, ['FAILED', 'DEAD_LETTER', 'CANCELLED'] as JobStatus[]),
      ),
    )
    .returning({ id: jobRun.id });
  return updated.length > 0;
}

/** Write a log line against a run. Cheap, and the only way a job explains itself. */
export async function logLine(
  tx: Tx,
  client: string,
  runId: string,
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(jobLog).values({
    id: newLogId(),
    jobRunId: runId,
    client,
    level,
    message,
    context,
  });
}

/**
 * Reset runs orphaned by a worker that died mid-run.
 *
 * The heartbeat stopped advancing, so nobody is working on these. They go back
 * to QUEUED with their cursor intact, and are retried to the same limits as any
 * other failure — a crash-looping job exhausts its retries and dead-letters
 * rather than being re-claimed forever.
 *
 * Note this runs inside a single tenant (the caller supplies the client), so it
 * needs no cross-tenant read: the reaper is handed the tenant of each run it
 * suspects. Only claiming needs to cross tenants.
 */
export async function reapOrphans(tx: Tx, client: string, timeoutMs: number): Promise<string[]> {
  const stale = await tx
    .select({ id: jobRun.id })
    .from(jobRun)
    .where(
      and(
        eq(jobRun.client, client),
        eq(jobRun.status, 'RUNNING'),
        lt(jobRun.heartbeatAt, sql`now() - ${Math.floor(timeoutMs / 1000)} * interval '1 second'`),
      ),
    );

  if (stale.length === 0) return [];

  const ids = stale.map((row) => row.id);
  await tx
    .update(jobRun)
    .set({
      status: 'QUEUED',
      nextAttemptAt: sql`now()`,
      workerId: null,
      claimedAt: null,
      heartbeatAt: null,
    })
    .where(inArray(jobRun.id, ids));

  return ids;
}

/**
 * Delete finished runs past their retention.
 *
 * `job_log` cascades. Retention is per job definition when one is set, so a
 * noisy nightly job can keep a week while an audit-relevant one keeps a year.
 */
export async function purgeFinished(tx: Tx, client: string): Promise<number> {
  const removed = await tx.execute(sql`
    delete from job_run r
     using job_definition d
     where r.job_code = d.code
       and r.client = ${client}
       and r.status in ('SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER')
       and r.finished_at < now() - (coalesce(d.retention_days, ${DEFAULT_RETENTION_DAYS}) * interval '1 day')
    returning r.id
  `);
  return (removed as unknown as unknown[]).length;
}

/** Ensure a definition exists. Jobs are declared, not discovered. */
export async function ensureDefinition(
  tx: Tx,
  input: {
    code: string;
    name: string;
    module: string;
    queue?: string;
    description?: string;
    maxRetries?: number;
    timeoutSeconds?: number;
    chunkSize?: number;
    gracePeriodSeconds?: number;
    retentionDays?: number;
    mayTerminateSessions?: boolean;
    isScheduled?: boolean;
    schedule?: string;
  },
): Promise<void> {
  await tx
    .insert(jobDefinition)
    .values({
      code: input.code,
      name: input.name,
      module: input.module,
      queue: input.queue ?? 'DEFAULT',
      description: input.description ?? null,
      maxRetries: input.maxRetries ?? 0,
      timeoutSeconds: input.timeoutSeconds ?? 600,
      chunkSize: input.chunkSize ?? undefined,
      gracePeriodSeconds: input.gracePeriodSeconds ?? undefined,
      retentionDays: input.retentionDays ?? undefined,
      mayTerminateSessions: input.mayTerminateSessions ?? false,
      isScheduled: input.isScheduled ?? false,
      schedule: input.schedule ?? null,
    })
    .onConflictDoNothing();
}

function newRunId(): string {
  return `run-${randomSuffix()}`;
}

function newLogId(): string {
  return `log-${randomSuffix()}`;
}

/**
 * A run id derived from the idempotency key.
 *
 * Deriving rather than generating means the unique index is doing real work:
 * two concurrent submissions of the same key compute the same id and collide,
 * which is exactly the guarantee we want. A generated id would need a separate
 * check.
 */
function stableRunId(client: string, jobCode: string, key: string): string {
  return `run-${hash(`${client}/${jobCode}/${key}`)}`;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic, short, and collision-resistant enough for idempotency keys. */
function hash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
