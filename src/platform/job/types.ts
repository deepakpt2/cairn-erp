/**
 * The job contract — CAIRN.md §21, D-022.
 *
 * ## What decides whether something is a job
 *
 * Work goes to a worker if it has **considerable load or takes considerable
 * time. One or the other, not both required.** A report over four hundred
 * thousand rows is a job even if each row is instant; a single calculation that
 * takes ninety seconds is a job even though it touches three rows.
 *
 * The practical test is `ENQUEUE_THRESHOLD_MS`: if you cannot say with
 * confidence that the work finishes inside two seconds, or it touches more
 * documents than you would happily hold locks on, make it a job.
 *
 * ## Four numbers this phase had to settle
 *
 * The plan left chunk size, the enqueue threshold, the grace period and
 * retention open. They are named constants here rather than scattered literals,
 * because each is a judgement a future reader will want to revisit, and a
 * number you can find is a number you can change:
 *
 * | constant | value | why this value |
 * |---|---|---|
 * | `ENQUEUE_THRESHOLD_MS` | 2 s | Below this, a request can just answer. Above it, the user is watching a spinner for something they cannot cancel. |
 * | `DEFAULT_CHUNK_SIZE` | 100 | Long enough that per-chunk overhead is noise, short enough that one commit releases its locks before anyone notices. |
 * | `DEFAULT_GRACE_SECONDS` | 300 | Five minutes: long enough that someone mid-edit actually sees the warning and saves, short enough that a night run is not held up by a lunch break. |
 * | `DEFAULT_RETENTION_DAYS` | 30 | A month of history covers "did the month-end run work" without the table growing forever. |
 *
 * All four are overridable per job definition. The constants are the defaults,
 * not the law.
 */

/** Anything you cannot swear finishes within two seconds belongs in a job. */
export const ENQUEUE_THRESHOLD_MS = 2_000;

/** Documents per lock-commit cycle when a definition does not say otherwise. */
export const DEFAULT_CHUNK_SIZE = 100;

/** How often a running worker advances `heartbeat_at`. */
export const HEARTBEAT_MS = 10_000;

/**
 * A `RUNNING` run whose heartbeat is older than this was orphaned — the worker
 * holding it was killed rather than finished. Six missed beats: long enough to
 * survive a long garbage-collection pause or a slow query, short enough that a
 * genuinely dead worker's job is picked up promptly.
 */
export const HEARTBEAT_TIMEOUT_MS = 60_000;

/** First retry waits this long; each subsequent retry doubles. */
export const BACKOFF_BASE_MS = 5_000;

/** Ceiling on backoff. Ten minutes is enough for a database to come back. */
export const BACKOFF_CAP_MS = 300_000;

/** How long a run blocked on a lock waits before looking again. */
export const LOCK_RETRY_DELAY_MS = 60_000;

/** How long a scheduled job warns a holder before closing their session. */
export const DEFAULT_GRACE_SECONDS = 300;

/** How long a finished run is kept. */
export const DEFAULT_RETENTION_DAYS = 30;

/** Idle poll interval. The claim is one indexed query; 2 s is cheap and responsive. */
export const POLL_INTERVAL_MS = 2_000;

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  /** Waiting on a lock. Keeps its cursor; claimable again once next_attempt_at passes. */
  | 'BLOCKED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  /** Retries exhausted. Terminal, and distinct from FAILED: this needs a human. */
  | 'DEAD_LETTER';

export type JobTrigger = 'MANUAL' | 'SCHEDULED' | 'CHAINED';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** A document a job wants exclusive use of. */
export interface LockRef {
  lockObject: string;
  argument: string;
}

/** Who is holding a document a job needs. */
export interface HeldDocument extends LockRef {
  holderUser: string;
  holderSessionId: string | null;
}

/** Opaque to the platform; the handler defines its shape. */
export type Cursor = Record<string, unknown>;

export interface JobContext {
  client: string;
  runId: string;
  jobCode: string;
  parameters: Record<string, unknown>;
  /** Null on the first chunk. Whatever the handler returned last time, verbatim. */
  cursor: Cursor | null;
  chunkSize: number;
  /** True once a user has asked to cancel. Check it between documents, not once per chunk. */
  isCancelRequested(): boolean;
  log(level: LogLevel, message: string, context?: Record<string, unknown>): Promise<void>;
}

export interface ChunkResult {
  /** Null when there is no more work. */
  cursor: Cursor | null;
  /** Documents processed in this chunk, for the progress display. */
  processed: number;
  /** Known total, when the handler can cheaply count it. Drives the percentage. */
  total?: number;
  /** Short human text shown on the status page: "plant 1000, 300 of 4 120". */
  progressText?: string;
}

/**
 * A job handler.
 *
 * `chunk` is called repeatedly until it returns `cursor: null`. It runs one
 * chunk, in its own transaction, locking per document and committing — never
 * one long lock over the whole run.
 *
 * `scope` is optional and means "every document this run will touch". Supplying
 * it lets the harness pre-flight the whole scope before the first chunk, which
 * is what stops a job running for nine minutes and *then* discovering a user
 * has one of the documents open. Omit it for jobs whose scope is too large to
 * enumerate cheaply; such a job can still throw `JobBlockedError` per chunk.
 */
export interface JobHandler {
  code: string;
  scope?(ctx: JobContext): Promise<LockRef[]>;
  chunk(ctx: JobContext): Promise<ChunkResult>;
}

/**
 * Thrown by a handler when it cannot proceed: the documents are held, and the
 * work must stop rather than skip them.
 *
 * Skipping is not an option. A job that quietly omits a locked document
 * produces a result that looks complete and is not, which is worse than a job
 * that stops and says so.
 */
export class JobBlockedError extends Error {
  readonly documents: HeldDocument[];

  constructor(documents: HeldDocument[]) {
    super(
      documents.length === 1
        ? `Blocked by ${documents[0]!.holderUser} on ${documents[0]!.lockObject} ${documents[0]!.argument}`
        : `Blocked by ${documents.length} held documents`,
    );
    this.name = 'JobBlockedError';
    this.documents = documents;
  }
}

/**
 * Backoff before the next attempt: 5 s, 10 s, 20 s… capped at ten minutes.
 *
 * Deliberately without jitter. A retry you can predict is a retry you can test.
 */
export function backoffMs(retryCount: number): number {
  if (retryCount <= 0) return 0;
  const doubled = BACKOFF_BASE_MS * 2 ** (retryCount - 1);
  return Math.min(doubled, BACKOFF_CAP_MS);
}

/** Whether work of this size belongs in a job rather than in the request. */
export function shouldEnqueue(estimateMs: number, documentCount: number): boolean {
  return estimateMs > ENQUEUE_THRESHOLD_MS || documentCount > DEFAULT_CHUNK_SIZE;
}
