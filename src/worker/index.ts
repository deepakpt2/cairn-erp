/**
 * The worker — CAIRN.md §21, D-022.
 *
 * A long-lived process that claims jobs and runs them. It holds no state of its
 * own: every fact about a run lives in `job_run`, so a worker can be killed and
 * replaced at any moment and the worst case is one chunk of lost work, picked
 * up again by whoever claims the run next.
 *
 * ## What it cannot see, and how it copes
 *
 * The worker runs as `cairn_app`, which has no BYPASSRLS, while `job_run` and
 * `client` both carry FORCE ROW LEVEL SECURITY. It therefore cannot scan for
 * work, and cannot even enumerate the tenants to scan them one at a time.
 *
 * Discovery goes through two SECURITY DEFINER functions instead —
 * `job_claim_next` and `job_orphan_clients` — each returning a couple of
 * columns and nothing else. Once a run is claimed, all real work happens
 * through `withTenant`, and the worker is as scoped as any web request.
 *
 * Concurrency beyond one process is just more containers running this loop:
 * `SKIP LOCKED` in the claim hands each of them different work.
 */

// Side effect: registers every job handler this worker can run. Imported for
// that purpose only — see the file for why the list lives there and not here.
import './jobs';

import { claimNext, runClaimed } from '../platform/job/execute';
import { reapOrphans } from '../platform/job/queue';
import { HEARTBEAT_TIMEOUT_MS, POLL_INTERVAL_MS } from '../platform/job/types';
import { db, withTenant } from '../platform/db/client';
import { sql } from 'drizzle-orm';

export interface WorkerOptions {
  /** Only claim jobs on these queues. Null means every queue. */
  queues?: string[] | null;
  /** Idle poll interval in ms. The claim is one indexed query. */
  pollIntervalMs?: number;
  /** Stop after this many runs. Omit for a long-lived worker. */
  maxRuns?: number;
  /** Called after each run, for tests and logging. */
  onResult?: (result: RunOutcome) => void;
  /** Injectable clock and sleep, so tests do not wait on real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Who is claiming, written to `job_run.claimed_by`. The container sets this
   * from the environment so that two workers are two rows in the log rather
   * than two processes both answering to the same name.
   */
  workerId?: string;
}

export interface RunOutcome {
  runId: string;
  client: string;
  jobCode: string;
  status: string;
}

const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Run the worker loop.
 *
 * Two exits from the loop: `maxRuns` is reached, or `stop()` was called — which
 * is how a SIGTERM from the container ends things. In both cases the current
 * chunk is finished rather than abandoned, because stopping mid-chunk would
 * leave a run in a state the next worker has to reason about.
 */
export async function runWorker(options: WorkerOptions = {}): Promise<{ runs: number; stopped: boolean }> {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const queues = options.queues ?? null;
  const me = options.workerId ?? workerId;

  // A fresh run of the loop starts fresh. Without this, a worker that had been
  // asked to stop stays stopped for good — invisible in production, where the
  // process then exits, but fatal to a test and to any host that reuses it.
  stopping = false;

  let runs = 0;
  let reapedAt = 0;

  while (!stopping) {
    if (options.maxRuns !== undefined && runs >= options.maxRuns) break;

    const claimed = await claimNext(me, queues);

    if (!claimed) {
      // Nothing to do. Reap orphans on the way past: a worker that died holding
      // a job leaves it RUNNING until someone notices, and the worker is the
      // only process in a position to notice.
      if (Date.now() - reapedAt > HEARTBEAT_TIMEOUT_MS) {
        await reapOrphanedRuns(me);
        reapedAt = Date.now();
      }
      await sleep(pollIntervalMs);
      continue;
    }

    let status: string;
    try {
      status = await runClaimed(me, claimed);
    } catch (error) {
      // The harness records job failures itself; reaching here means the worker
      // could not even record the outcome. Log and keep going — a worker that
      // dies on one bad job stops every other job too.
      console.error(`[${me}] run ${claimed.runId} could not be completed:`, error);
      status = 'UNKNOWN';
    }

    runs += 1;
    options.onResult?.({ runId: claimed.runId, client: claimed.client, jobCode: claimed.jobCode, status });
  }

  return { runs, stopped: stopping };
}

/**
 * Put orphaned runs back on the queue.
 *
 * Needs the tenant list, which the worker cannot read — so a definer function
 * names the tenants that have stale runs, and each is then reaped through the
 * ordinary scoped path.
 */
async function reapOrphanedRuns(id: string): Promise<void> {
  const rows = (await db().execute(
    sql`select distinct client from job_orphan_clients(${Math.floor(HEARTBEAT_TIMEOUT_MS / 1000)})`,
  )) as unknown as Array<{ client: string }>;

  for (const { client } of rows) {
    try {
      const ids = await withTenant(client, (tx) => reapOrphans(tx, client, HEARTBEAT_TIMEOUT_MS));
      if (ids.length > 0) {
        console.warn(`[${id}] reaped ${ids.length} orphaned run(s) in ${client}: ${ids.join(', ')}`);
      }
    } catch (error) {
      console.error(`[${id}] could not reap orphans in ${client}:`, error);
    }
  }
}

let stopping = false;

/** Ask the loop to stop after the current chunk. Safe to call more than once. */
export function stopWorker(): void {
  stopping = true;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Entrypoint when run as a process (`npm run worker`).
 *
 * SIGTERM and SIGINT are handled rather than left to the default, so a
 * container stop finishes the chunk in flight instead of killing it mid-write.
 */
function envWorkerId(): string {
  const id = process.env.CAIRN_WORKER_ID?.trim();
  return id && id.length > 0 ? id : workerId;
}

function envPollMs(): number {
  const raw = process.env.CAIRN_WORKER_POLL_MS ?? process.env.CAIRN_JOB_POLL_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : POLL_INTERVAL_MS;
}

export async function main(): Promise<void> {
  const me = envWorkerId();
  const pollMs = envPollMs();
  const queues = (process.env.CAIRN_WORKER_QUEUES ?? process.env.CAIRN_JOB_QUEUES)
    ?.split(',')
    .map((q) => q.trim())
    .filter(Boolean);

  process.on('SIGTERM', () => {
    console.log(`[${me}] SIGTERM received; finishing the current chunk.`);
    stopWorker();
  });
  process.on('SIGINT', () => {
    console.log(`[${me}] SIGINT received; finishing the current chunk.`);
    stopWorker();
  });

  console.log(`[${me}] started; queues=${queues?.join(',') ?? 'all'} poll=${pollMs}ms`);

  const { runs } = await runWorker({ workerId: me, queues: queues ?? null, pollIntervalMs: pollMs });
  console.log(`[${me}] stopped after ${runs} run(s).`);
}

// Run only when executed directly, so importing this file in a test does not
// start a worker by accident.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
