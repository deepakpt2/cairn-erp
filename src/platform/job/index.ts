/**
 * The job runtime.
 *
 * Two halves, deliberately separated:
 *
 *   * **queue** — what the application calls: enqueue a job, ask it to stop,
 *     retry it, purge it. Runs in the caller's transaction.
 *   * **execute** — what the worker calls: claim a job across tenants and run
 *     it in chunks. Never called from a request.
 *
 * Keeping them apart is what stops a request accidentally doing a worker's job.
 * Nothing in `execute` is reachable from a screen, and nothing in `queue` needs
 * to know how a job is run.
 */

export {
  enqueue,
  requestCancel,
  retryRun,
  logLine,
  reapOrphans,
  purgeFinished,
  ensureDefinition,
  type EnqueueInput,
  type EnqueuedRun,
} from './queue';

export { claimNext, runClaimed, type ClaimedRun } from './execute';

export {
  registerJob,
  handlerFor,
  registeredJobs,
  clearJobRegistry,
} from './registry';

export {
  ENQUEUE_THRESHOLD_MS,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_GRACE_SECONDS,
  DEFAULT_RETENTION_DAYS,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  LOCK_RETRY_DELAY_MS,
  POLL_INTERVAL_MS,
  JobBlockedError,
  backoffMs,
  shouldEnqueue,
  type ChunkResult,
  type Cursor,
  type HeldDocument,
  type JobContext,
  type JobHandler,
  type JobStatus,
  type JobTrigger,
  type LockRef,
  type LogLevel,
} from './types';
