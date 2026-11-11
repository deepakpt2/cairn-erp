/**
 * Running a job — the half with the concurrency in it. CAIRN.md §21, D-022;
 * lock behaviour from development-operations.md §2.
 *
 * ## The transaction boundaries, and why they are where they are
 *
 * Three separate transactions per chunk, on purpose:
 *
 *   1. **The handler's own transaction** — the work. Locks each document,
 *      writes, commits, releases. The harness never holds it open.
 *   2. **A short transaction to persist the cursor and progress** — committed
 *      before the next chunk starts, so a crash costs at most one chunk.
 *   3. **A short transaction for the heartbeat** — so an observer can tell a
 *      slow job from a dead worker.
 *
 * Why not one transaction around the whole run? Because a job that locks its
 * entire scope for nine minutes is not a background job, it is an outage that
 * happens to be running in the background. §2 is explicit: lock per chunk,
 * commit, release, repeat.
 *
 * ## What happens when a document is locked
 *
 * Stop and warn. Never skip. A job that quietly omits a locked document
 * produces a result that looks complete and is not — which is worse than a job
 * that stops and says which document, and who has it.
 *
 * The run keeps its cursor and becomes claimable again once `next_attempt_at`
 * passes, so it **resumes from the chunk it stopped at, never from zero**.
 *
 * A scheduled critical job may instead clear the lock, but only in this order:
 * warn with a grace period, and only then revoke the holder's session. Most
 * conflicts resolve at the warning; nobody should lose unsaved work to a job
 * that could have waited five minutes.
 */

import { and, eq, sql } from 'drizzle-orm';

import { db, withTenant, type Tx } from '../db/client';
import { jobDefinition, jobRun, type BlockedOn } from '../tables/system';
import { appUser, userSession } from '../tables/security';
import { notifyAll, notifyOn } from '../notification/notify';
import { resolveRecipients } from '../notification/recipients';
import { enqueueEntry } from '../tables/lock';
import { listEnqueue, type EnqueueRow } from '../lock/enqueue';
import { revokeSessionById } from '../auth/session';
import { logLine } from './queue';
import { handlerFor } from './registry';
import {
  DEFAULT_CHUNK_SIZE,
  HEARTBEAT_MS,
  LOCK_RETRY_DELAY_MS,
  backoffMs,
  type ChunkResult,
  type Cursor,
  type HeldDocument,
  type JobContext,
  type JobHandler,
  type JobStatus,
  type LockRef,
} from './types';

export interface ClaimedRun {
  runId: string;
  client: string;
  jobCode: string;
}

/**
 * Claim the next runnable job, across all tenants.
 *
 * This is the one call that crosses tenants, and it does so through
 * `job_claim_next` — a SECURITY DEFINER function returning three columns. See
 * the migration for why nothing else can work: `job_run` and `client` both
 * carry FORCE ROW LEVEL SECURITY, so a worker cannot see, or even enumerate,
 * the tenants it is meant to serve.
 *
 * `SKIP LOCKED` inside the function means any number of worker containers can
 * call this concurrently and each gets a different run.
 */
export async function claimNext(
  workerId: string,
  queues: string[] | null = null,
): Promise<ClaimedRun | null> {
  const rows = (await db().execute(
    sql`select run_id, run_client, run_job_code from job_claim_next(${workerId}, ${queues})`,
  )) as unknown as Array<{ run_id: string; run_client: string; run_job_code: string }>;

  const row = rows[0];
  if (!row) return null;
  return { runId: row.run_id, client: row.run_client, jobCode: row.run_job_code };
}

interface RunShape {
  id: string;
  parameters: Record<string, unknown>;
  cursor: Cursor | null;
  chunksDone: number;
  chunksTotal: number | null;
  retryCount: number;
  triggerType: string;
  triggeredBy: string;
  cancelRequestedAt: Date | null;
  warnedAt: Date | null;
}

interface DefinitionShape {
  code: string;
  maxRetries: number;
  timeoutSeconds: number;
  chunkSize: number | null;
  gracePeriodSeconds: number | null;
  mayTerminateSessions: boolean;
}

/**
 * Run one claimed job to completion, or to a deliberate stop.
 *
 * This never throws for a job's own failure: a failure is recorded on the run
 * and the run is retried or dead-lettered. Only an inability to *record* the
 * outcome throws, because at that point the worker cannot know what happened
 * and should stop taking work.
 */
export async function runClaimed(workerId: string, claimed: ClaimedRun): Promise<JobStatus> {
  const handler = handlerFor(claimed.jobCode);

  const setup = await withTenant(claimed.client, async (tx) => loadRun(tx, claimed.runId));
  if (!setup) return 'FAILED';

  const { run, definition } = setup;

  if (!handler) {
    await finish(claimed, 'FAILED', {
      errorText: `No handler is registered for ${claimed.jobCode}. A job code must identify exactly one handler; register it where the job is defined.`,
    });
    return 'FAILED';
  }

  // A cancel that arrived while the run sat queued is honoured before any work.
  if (run.cancelRequestedAt) {
    await markCancelled(claimed);
    return 'CANCELLED';
  }

  const deadline = Date.now() + definition.timeoutSeconds * 1000;
  let cursor = run.cursor;
  let chunksDone = run.chunksDone;
  let processedTotal = 0;
  let heartbeatAt = 0;

  const ctx: JobContext = {
    client: claimed.client,
    runId: claimed.runId,
    jobCode: claimed.jobCode,
    parameters: run.parameters,
    cursor,
    chunkSize: definition.chunkSize ?? DEFAULT_CHUNK_SIZE,
    isCancelRequested: () => cancelFlag,
    log: (level, message, context) =>
      withTenant(claimed.client, (tx) => logLine(tx, claimed.client, claimed.runId, level, message, context)),
  };

  let cancelFlag = Boolean(run.cancelRequestedAt);

  try {
    // ── Pre-flight the whole scope before starting ─────────────────────────
    // Discovering a held document after nine minutes of work is the failure
    // this exists to prevent. Jobs too large to enumerate their scope omit
    // `scope` and rely on throwing JobBlockedError per chunk instead.
    //
    // This runs on a resume too, not only on a first start. A lock can appear
    // while a run sits blocked or backed off, and a run that resumed without
    // looking would walk straight into it.
    if (handler.scope) {
      const scope = await handler.scope(ctx);
      const blocked = await preflight(workerId, claimed, scope, definition, run);
      if (blocked) return blocked;
    }

    for (;;) {
      if (Date.now() > deadline) {
        return await fail(claimed, run, definition, `Timed out after ${definition.timeoutSeconds}s.`);
      }

      // Re-read the cancel flag between chunks rather than trusting the one
      // loaded at claim time: a user may have asked to stop since.
      cancelFlag = await withTenant(claimed.client, async (tx) => {
        const [fresh] = await tx
          .select({ cancelRequestedAt: jobRun.cancelRequestedAt })
          .from(jobRun)
          .where(eq(jobRun.id, claimed.runId))
          .limit(1);
        return Boolean(fresh?.cancelRequestedAt);
      });
      if (cancelFlag) {
        await markCancelled(claimed);
        return 'CANCELLED';
      }

      if (Date.now() - heartbeatAt >= HEARTBEAT_MS) {
        await beat(claimed);
        heartbeatAt = Date.now();
      }

      let result: ChunkResult;
      try {
        result = await handler.chunk({ ...ctx, cursor });
      } catch (error) {
        if (isJobBlocked(error)) {
          return await block(workerId, claimed, run, definition, error.documents);
        }
        return await fail(claimed, run, definition, describeError(error));
      }

      processedTotal += result.processed;
      chunksDone += 1;
      cursor = result.cursor;

      // Persist progress before starting the next chunk, so a crash costs one
      // chunk and not the run.
      await withTenant(claimed.client, (tx) =>
        saveProgress(
          tx,
          claimed.runId,
          cursor,
          chunksDone,
          result.total ?? null,
          result.progressText ?? null,
          definition.chunkSize ?? DEFAULT_CHUNK_SIZE,
        ),
      );

      if (cursor === null) {
        await finish(claimed, 'SUCCEEDED', {
          resultSummary: summarise(processedTotal, chunksDone),
          chunksDone,
        });
        return 'SUCCEEDED';
      }
    }
  } catch (error) {
    // Reaching here means the harness itself could not proceed — not that the
    // job failed. Record it as a failure and let the normal retry path apply.
    return await fail(claimed, run, definition, `Harness error: ${describeError(error)}`);
  }
}

/**
 * Recognise a JobBlockedError by name rather than by `instanceof`.
 *
 * The worker may load handlers through more than one copy of the module graph
 * (tsx, the built bundle), and `instanceof` fails across those boundaries while
 * the name does not. Duck-typing the payload keeps a handler's throw working
 * regardless of how it was loaded.
 */
function isJobBlocked(error: unknown): error is { documents: HeldDocument[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'JobBlockedError' &&
    Array.isArray((error as { documents?: unknown }).documents)
  );
}

/**
 * Check every document the run intends to touch.
 *
 * Stale locks are purged first — an abandoned tab would otherwise halt every
 * job in its scope, which is the single most likely way for this machinery to
 * look broken in ordinary use.
 */
async function preflight(
  workerId: string,
  claimed: ClaimedRun,
  scope: LockRef[],
  definition: DefinitionShape,
  run: RunShape,
): Promise<JobStatus | null> {
  if (scope.length === 0) return null;
  const held = await heldDocuments(claimed.client, scope);
  if (held.length === 0) return null;
  return await block(workerId, claimed, run, definition, held);
}

/**
 * Which of these documents are currently held, and by whom.
 *
 * `listEnqueue` purges stale entries before reading, which is exactly the
 * pre-flight purge §2 asks for. The whole tenant enqueue table is read and
 * matched in memory: it contains only documents somebody currently has open for
 * change, so it is small by construction, and this avoids assembling an
 * interpolated `IN` list of tuples.
 */
async function heldDocuments(client: string, scope: LockRef[]): Promise<HeldDocument[]> {
  const rows: EnqueueRow[] = await listEnqueue(client);
  const wanted = new Set(scope.map((ref) => `${ref.lockObject}/${ref.argument}`));
  return rows
    .filter((row) => wanted.has(`${row.lockObject}/${row.argument}`))
    .map((row) => ({
      lockObject: row.lockObject,
      argument: row.argument,
      holderUser: row.ownerUser,
      holderSessionId: row.ownerSessionId ?? null,
    }));
}

/**
 * Stop the run because documents are held.
 *
 * The run keeps its cursor, so when it is claimed again it resumes from the
 * chunk it stopped at. It is never restarted from zero — that would redo work
 * the user has already waited for, and for a non-idempotent job would do it twice.
 */
async function block(
  workerId: string,
  claimed: ClaimedRun,
  run: RunShape,
  definition: DefinitionShape,
  documents: HeldDocument[],
): Promise<JobStatus> {
  const canTerminate =
    definition.mayTerminateSessions && run.triggerType === 'SCHEDULED' && documents.length > 0;

  const graceSeconds = definition.gracePeriodSeconds ?? 300;

  if (canTerminate && !run.warnedAt) {
    // First contact. Warn, and come back when the grace period expires.
    await withTenant(claimed.client, async (tx) => {
      await logLine(
        tx,
        claimed.client,
        claimed.runId,
        'WARN',
        `Waiting for ${documents.length} document(s) held by ${namesOf(documents)}; their sessions will be closed in ${graceSeconds}s.`,
        { kind: 'JOB.WARNING', documents },
      );
      await tx
        .update(jobRun)
        .set({
          status: 'BLOCKED',
          warnedAt: sql`now()`,
          blockedAt: sql`now()`,
          blockedOn: { documents, willTerminateAt: new Date(Date.now() + graceSeconds * 1000).toISOString() },
          nextAttemptAt: sql`now() + ${graceSeconds} * interval '1 second'`,
          workerId: null,
          claimedAt: null,
          heartbeatAt: null,
        })
        .where(eq(jobRun.id, claimed.runId));

        await notifyRunOutcome(tx, claimed, 'JOB.BLOCKED');
    });
    return 'BLOCKED';
  }

  if (canTerminate && run.warnedAt) {
    // Grace period elapsed and the locks survived. Revoke the sessions, which
    // releases their enqueue entries, and carry on with this run.
    const revoked = await terminateHolders(claimed, documents);
    if (revoked > 0) {
      await withTenant(claimed.client, async (tx) => {
        await logLine(
          tx,
          claimed.client,
          claimed.runId,
          'WARN',
          `Closed ${revoked} session(s) to release ${documents.length} document(s) after a ${graceSeconds}s warning. Any unsaved work in those screens is lost.`,
          { kind: 'JOB.TERMINATED', documents, revoked },
        );
        await tx
          .update(jobRun)
          .set({
            status: 'RUNNING',
            warnedAt: null,
            blockedAt: null,
            blockedOn: null,
            nextAttemptAt: sql`now()`,
          })
          .where(eq(jobRun.id, claimed.runId));
      });
      return await runClaimed(workerId, claimed);
    }
  }

  // No authority to terminate, or nothing could be revoked: stop and wait.
  const payload: BlockedOn = { documents };
  await withTenant(claimed.client, async (tx) => {
    await logLine(
      tx,
      claimed.client,
      claimed.runId,
      'WARN',
      `Stopped: ${documents.length} document(s) held by ${namesOf(documents)}. Resuming from chunk ${run.chunksDone}.`,
      { kind: 'JOB.BLOCKED', documents },
    );
    await tx
      .update(jobRun)
      .set({
        status: 'BLOCKED',
        blockedAt: sql`now()`,
        blockedOn: payload,
        nextAttemptAt: sql`now() + ${Math.floor(LOCK_RETRY_DELAY_MS / 1000)} * interval '1 second'`,
        workerId: null,
        claimedAt: null,
        heartbeatAt: null,
      })
      .where(eq(jobRun.id, claimed.runId));

    await notifyRunOutcome(tx, claimed, 'JOB.BLOCKED');
  });
  return 'BLOCKED';
}

/** Revoke the sessions holding these documents. Returns how many were closed. */
async function terminateHolders(claimed: ClaimedRun, documents: HeldDocument[]): Promise<number> {
  return withTenant(claimed.client, async (tx) => {
    const sessionIds = await sessionIdsFor(tx, claimed.client, documents);
    let closed = 0;
    for (const sessionId of sessionIds) {
      // The owner is read before the session goes. The session row is what
      // names the person, and once it is revoked there is nothing left to ask
      // who it belonged to.
      const [owner] = await tx
        .select({ userId: userSession.userId })
        .from(userSession)
        .where(and(eq(userSession.client, claimed.client), eq(userSession.id, sessionId)))
        .limit(1);

      const did = await revokeSessionById(tx, {
        client: claimed.client,
        sessionId,
        reason: `Scheduled job ${claimed.jobCode} needs documents this session holds`,
      });
      if (did) closed += 1;

      // Closing a session under somebody is the one thing the platform does to
      // a user that they cannot see coming, and it destroys the work they had
      // open. They are owed the reason, and owed it durably: by the time they
      // could look at a screen, the session that would have shown it is gone.
      // Addressed to the person whose session it was, so the recipient term of
      // the policy keeps it from anyone else.
      if (did && owner?.userId) {
        await notifyOn(tx, {
          client: claimed.client,
          recipient: owner.userId,
          kind: 'SESSION.CLOSED',
          objectClass: 'user_session',
          objectKey: sessionId,
          messageKey: 'notification.kind.SESSION.CLOSED',
          messageParams: { job: claimed.jobCode },
        });
      }
    }
    return closed;
  });
}

/**
 * The sessions holding these documents.
 *
 * Read with the query builder rather than an interpolated tuple list: the enqueue
 * table is keyed by (lock_object, argument), and assembling that as a string is
 * both awkward and the kind of thing that becomes an injection later.
 */
async function sessionIdsFor(tx: Tx, client: string, documents: HeldDocument[]): Promise<string[]> {
  if (documents.length === 0) return [];
  const rows = await tx
    .select({ lockObject: enqueueEntry.lockObject, argument: enqueueEntry.argument, sessionId: enqueueEntry.ownerSessionId })
    .from(enqueueEntry)
    .where(eq(enqueueEntry.client, client));
  const wanted = new Set(documents.map((d) => `${d.lockObject}/${d.argument}`));
  return [
    ...new Set(
      rows
        .filter((row) => wanted.has(`${row.lockObject}/${row.argument}`))
        .map((row) => row.sessionId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
}

async function fail(
  claimed: ClaimedRun,
  run: RunShape,
  definition: DefinitionShape,
  message: string,
): Promise<JobStatus> {
  const attempts = run.retryCount + 1;
  const exhausted = attempts > definition.maxRetries;
  // DEAD_LETTER means "retries were configured and every one was consumed", so
  // it needs a human. A job nobody asked to retry is simply FAILED: it did not
  // exhaust an allowance, it never had one.
  const status: JobStatus = exhausted ? (definition.maxRetries > 0 ? 'DEAD_LETTER' : 'FAILED') : 'QUEUED';
  const waitMs = backoffMs(attempts);

  await withTenant(claimed.client, async (tx) => {
    await logLine(tx, claimed.client, claimed.runId, 'ERROR', message, {
      attempt: attempts,
      maxRetries: definition.maxRetries,
    });
    await tx
      .update(jobRun)
      .set({
        status,
        retryCount: attempts,
        errorText: message,
        deadLetteredAt: exhausted ? sql`now()` : null,
        // A retry resumes; this is why the cursor survives a failure.
        nextAttemptAt: exhausted ? sql`now()` : sql`now() + ${Math.floor(waitMs / 1000)} * interval '1 second'`,
        finishedAt: exhausted ? sql`now()` : null,
        workerId: null,
        claimedAt: null,
        heartbeatAt: null,
      })
      .where(eq(jobRun.id, claimed.runId));

    // A run that still has retries left has not ended: it is going back on the
    // queue to be tried again. Calling that a failure would be a lie, and would
    // contradict the retry the runtime is about to perform. Only once the
    // allowance is spent is there an ending worth reporting.
    if (exhausted) {
      await notifyRunOutcome(tx, claimed, 'JOB.FAILED');
    }
  });
  return status;
}

async function markCancelled(claimed: ClaimedRun): Promise<void> {
  await withTenant(claimed.client, async (tx) => {
    await logLine(tx, claimed.client, claimed.runId, 'INFO', 'Cancelled at a chunk boundary.');
    await tx
      .update(jobRun)
      .set({ status: 'CANCELLED', finishedAt: sql`now()`, workerId: null, claimedAt: null, heartbeatAt: null })
      .where(eq(jobRun.id, claimed.runId));
  });
}

const JOB_MONITOR_CAPABILITY = 'PLT.JOB.DISPLAY';

/**
 * Tell someone that this run reached a terminal state.
 *
 * The person who asked for the run is the natural recipient, and `job_run.triggered_by`
 * holds them — but it holds 'SCHEDULER' just as happily, which is not a person. The
 * recipient term of the row policy means only SCHEDULER could ever read a row addressed
 * to it, so writing one would fill the table with messages nobody can see. The same check
 * quietly covers a user deleted since the run was queued.
 *
 * A run nobody asked for in particular still has to be accounted for when it ends badly.
 * Failure and blockage both need a person to act, so those fall back to everyone who can
 * open the jobs screen. Success does not: a scheduled run finishing is the ordinary case,
 * and the jobs screen is already the record of it. Announcing every one of those to every
 * monitor would be noise dressed up as diligence.
 *
 * Emitted inside the same transaction as the status change, so a run whose ending rolls
 * back does not leave behind an announcement of that ending.
 */
async function notifyRunOutcome(
  tx: Tx,
  claimed: ClaimedRun,
  kind: 'JOB.COMPLETED' | 'JOB.FAILED' | 'JOB.BLOCKED',
): Promise<void> {
  const [row] = await tx
    .select({ triggeredBy: jobRun.triggeredBy })
    .from(jobRun)
    .where(eq(jobRun.id, claimed.runId))
    .limit(1);

  const who = row?.triggeredBy;
  if (!who) return;

  const [user] = await tx
    .select({ id: appUser.id })
    .from(appUser)
    .where(and(eq(appUser.client, claimed.client), eq(appUser.id, who)))
    .limit(1);

  const shared = {
    kind,
    objectClass: 'job_run',
    objectKey: claimed.runId,
    messageKey: `notification.kind.${kind}`,
    messageParams: { job: claimed.jobCode },
  } as const;

  // A named submitter hears about their own run whatever the outcome.
  if (user) {
    await notifyOn(tx, { ...shared, client: claimed.client, recipient: who });
    return;
  }

  // Nobody can be named. Only the endings that need a pair of hands are worth
  // raising with the people who watch the queue.
  if (kind === 'JOB.COMPLETED') return;

  const monitors = await resolveRecipients(tx, claimed.client, JOB_MONITOR_CAPABILITY);
  await notifyAll(tx, claimed.client, monitors, shared);
}

async function finish(
  claimed: ClaimedRun,
  status: JobStatus,
  patch: { resultSummary?: string; errorText?: string; chunksDone?: number },
): Promise<void> {
  await withTenant(claimed.client, async (tx) => {
    await tx
      .update(jobRun)
      .set({
        status,
        finishedAt: sql`now()`,
        resultSummary: patch.resultSummary ?? null,
        errorText: patch.errorText ?? null,
        chunksDone: patch.chunksDone ?? undefined,
        progressPercent: 100,
        workerId: null,
        claimedAt: null,
        heartbeatAt: null,
      })
      .where(eq(jobRun.id, claimed.runId));

    // Cancelled tells nobody: they asked for it. Everything else names the
    // ending, because a run that finished while you were on another screen is
    // the case the whole worker exists for.
    const kind =
      status === 'SUCCEEDED'
        ? 'JOB.COMPLETED'
        : status === 'FAILED' || status === 'DEAD_LETTER'
          ? 'JOB.FAILED'
          : null;
    if (kind) await notifyRunOutcome(tx, claimed, kind);
  });
}

async function beat(claimed: ClaimedRun): Promise<void> {
  await withTenant(claimed.client, async (tx) => {
    await tx
      .update(jobRun)
      .set({ heartbeatAt: sql`now()` })
      .where(and(eq(jobRun.id, claimed.runId), eq(jobRun.status, 'RUNNING')));
  });
}

async function saveProgress(
  tx: Tx,
  runId: string,
  cursor: Cursor | null,
  chunksDone: number,
  total: number | null,
  progressText: string | null,
  chunkSize: number,
): Promise<void> {
  const patch: Record<string, unknown> = { cursor, chunksDone };
  if (total !== null) {
    patch.chunksTotal = total;
    const chunks = Math.ceil(total / chunkSize);
    patch.progressPercent = chunks > 0 ? Math.min(100, Math.round((chunksDone / chunks) * 100)) : 0;
  }
  if (progressText !== null) patch.progressText = progressText;

  await tx.update(jobRun).set(patch).where(eq(jobRun.id, runId));
}

async function loadRun(
  tx: Tx,
  runId: string,
): Promise<{ run: RunShape; definition: DefinitionShape } | null> {
  const [row] = await tx
    .select({
      id: jobRun.id,
      parameters: jobRun.parameters,
      cursor: jobRun.cursor,
      chunksDone: jobRun.chunksDone,
      chunksTotal: jobRun.chunksTotal,
      retryCount: jobRun.retryCount,
      triggerType: jobRun.triggerType,
      triggeredBy: jobRun.triggeredBy,
      cancelRequestedAt: jobRun.cancelRequestedAt,
      warnedAt: jobRun.warnedAt,
      defCode: jobDefinition.code,
      defMaxRetries: jobDefinition.maxRetries,
      defTimeout: jobDefinition.timeoutSeconds,
      defChunkSize: jobDefinition.chunkSize,
      defGrace: jobDefinition.gracePeriodSeconds,
      defMayTerminate: jobDefinition.mayTerminateSessions,
    })
    .from(jobRun)
    .innerJoin(jobDefinition, eq(jobDefinition.code, jobRun.jobCode))
    .where(eq(jobRun.id, runId))
    .limit(1);

  if (!row) return null;

  return {
    run: {
      id: row.id,
      parameters: (row.parameters ?? {}) as Record<string, unknown>,
      cursor: (row.cursor ?? null) as Cursor | null,
      chunksDone: row.chunksDone,
      chunksTotal: row.chunksTotal,
      retryCount: row.retryCount,
      triggerType: row.triggerType,
      triggeredBy: row.triggeredBy,
      cancelRequestedAt: row.cancelRequestedAt,
      warnedAt: row.warnedAt,
    },
    definition: {
      code: row.defCode,
      maxRetries: row.defMaxRetries,
      timeoutSeconds: row.defTimeout,
      chunkSize: row.defChunkSize,
      gracePeriodSeconds: row.defGrace,
      mayTerminateSessions: row.defMayTerminate,
    },
  };
}

function namesOf(documents: HeldDocument[]): string {
  const holders = [...new Set(documents.map((d) => d.holderUser))];
  return holders.slice(0, 3).join(', ') + (holders.length > 3 ? ` and ${holders.length - 3} more` : '');
}

function summarise(processed: number, chunks: number): string {
  return `${processed} document(s) in ${chunks} chunk${chunks === 1 ? '' : 's'}.`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
