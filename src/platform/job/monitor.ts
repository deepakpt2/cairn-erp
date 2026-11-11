/**
 * What the jobs status page reads — CAIRN.md §21.
 *
 * The page exists because a job is the one thing in the system that can be
 * running when nobody is looking. A user who submitted one needs to answer
 * three questions from it: *is it still going*, *did it work*, and *what do I do
 * if it did not*.
 *
 * Everything here is scoped to one tenant through `withTenant`, so a tenant
 * sees its own runs and no other's. Claiming is the only operation that crosses
 * tenants, and it is not here.
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../db/client';
import { jobDefinition, jobLog, jobRun } from '../tables/system';
import type { BlockedOn } from '../tables/system';
import type { JobStatus, JobTrigger } from './types';

export interface JobRunView {
  id: string;
  jobCode: string;
  jobName: string | null;
  status: JobStatus;
  triggerType: JobTrigger;
  triggeredBy: string;
  progressPercent: number;
  progressText: string | null;
  resultSummary: string | null;
  errorText: string | null;
  retryCount: number;
  maxRetries: number;
  chunksDone: number;
  chunksTotal: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  nextAttemptAt: string;
  blockedOn: BlockedOn | null;
  cancelRequested: boolean;
  /** True when this run can be cancelled: it has not reached a terminal state. */
  canCancel: boolean;
  /** True when it has stopped in a way that a retry would address. */
  canRetry: boolean;
}

export interface JobLogView {
  level: string;
  message: string;
  context: Record<string, unknown>;
  loggedAt: string;
}

const TERMINAL: JobStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * Runs for one tenant, newest first.
 *
 * `finishedOnly` lets the page offer a history without mixing it into the
 * current work: the thing a user wants after submitting a job is *that* job,
 * not last week's.
 */
export async function listRuns(
  client: string,
  options: { limit?: number; finishedOnly?: boolean } = {},
): Promise<JobRunView[]> {
  const limit = Math.min(options.limit ?? 100, 500);

  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        id: jobRun.id,
        jobCode: jobRun.jobCode,
        jobName: jobDefinition.name,
        status: jobRun.status,
        triggerType: jobRun.triggerType,
        triggeredBy: jobRun.triggeredBy,
        progressPercent: jobRun.progressPercent,
        progressText: jobRun.progressText,
        resultSummary: jobRun.resultSummary,
        errorText: jobRun.errorText,
        retryCount: jobRun.retryCount,
        maxRetries: jobDefinition.maxRetries,
        chunksDone: jobRun.chunksDone,
        chunksTotal: jobRun.chunksTotal,
        queuedAt: jobRun.queuedAt,
        startedAt: jobRun.startedAt,
        finishedAt: jobRun.finishedAt,
        nextAttemptAt: jobRun.nextAttemptAt,
        blockedOn: jobRun.blockedOn,
        cancelRequestedAt: jobRun.cancelRequestedAt,
      })
      .from(jobRun)
      .innerJoin(jobDefinition, eq(jobDefinition.code, jobRun.jobCode))
      .where(
        options.finishedOnly
          ? and(eq(jobRun.client, client), sql`${jobRun.status} in ('SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER')`)
          : eq(jobRun.client, client),
      )
      .orderBy(desc(jobRun.queuedAt))
      .limit(limit);

    return rows.map((row) => {
      const status = row.status as JobStatus;
      return {
        id: row.id,
        jobCode: row.jobCode,
        jobName: row.jobName ?? null,
        status,
        triggerType: row.triggerType as JobTrigger,
        triggeredBy: row.triggeredBy,
        progressPercent: row.progressPercent,
        progressText: row.progressText ?? null,
        resultSummary: row.resultSummary ?? null,
        errorText: row.errorText ?? null,
        retryCount: row.retryCount,
        maxRetries: row.maxRetries,
        chunksDone: row.chunksDone,
        chunksTotal: row.chunksTotal,
        queuedAt: row.queuedAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        nextAttemptAt: row.nextAttemptAt.toISOString(),
        blockedOn: row.blockedOn ?? null,
        cancelRequested: Boolean(row.cancelRequestedAt),
        canCancel: !isTerminal(status) && !row.cancelRequestedAt,
        canRetry: isTerminal(status) && status !== 'SUCCEEDED',
      };
    });
  });
}

/** The log for one run, oldest first — the order it happened. */
export async function listLogs(client: string, runId: string): Promise<JobLogView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        level: jobLog.level,
        message: jobLog.message,
        context: jobLog.context,
        loggedAt: jobLog.loggedAt,
      })
      .from(jobLog)
      .where(and(eq(jobLog.client, client), eq(jobLog.jobRunId, runId)))
      .orderBy(jobLog.loggedAt);

    return rows.map((row) => ({
      level: row.level,
      message: row.message,
      context: (row.context ?? {}) as Record<string, unknown>,
      loggedAt: row.loggedAt.toISOString(),
    }));
  });
}

/**
 * Reap this tenant's orphans — used by the page as well as the worker, so that
 * a tenant with no worker yet still recovers from a crash.
 */
export async function reapFor(client: string, timeoutMs: number): Promise<string[]> {
  const { reapOrphans } = await import('./queue');
  return withTenant(client, (tx: Tx) => reapOrphans(tx, client, timeoutMs));
}
