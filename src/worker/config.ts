/**
 * Worker process configuration, validated before the loop starts.
 *
 * An empty queue filter means "claim every queue" in `job_claim_next`, so an
 * unset variable on one of two workers would make both claim everything. A
 * production worker therefore refuses to start without an explicit queue list,
 * unless the operator opts into the old single-process mode on purpose.
 */

export interface WorkerConfig {
  workerId: string | null;
  /** null only in the explicit all-queues single-process mode. */
  queues: string[] | null;
  pollMs: number | null;
  /** Whether this process ticks the scheduler. */
  scheduler: boolean;
  warnings: string[];
}

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigError';
  }
}

function list(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  return raw
    .split(',')
    .map((q) => q.trim().toUpperCase())
    .filter(Boolean);
}

export function resolveWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const warnings: string[] = [];
  const next = list(env.CAIRN_WORKER_QUEUES);
  const legacy = list(env.CAIRN_JOB_QUEUES);

  if (next && next.length > 0 && legacy && legacy.length > 0) {
    const same = [...next].sort().join(',') === [...legacy].sort().join(',');
    if (!same) {
      throw new WorkerConfigError(
        `CAIRN_WORKER_QUEUES (${next.join(',')}) and the legacy CAIRN_JOB_QUEUES (${legacy.join(',')}) disagree. ` +
          'Set only CAIRN_WORKER_QUEUES and remove CAIRN_JOB_QUEUES.',
      );
    }
    warnings.push('CAIRN_JOB_QUEUES is deprecated; remove it and keep CAIRN_WORKER_QUEUES.');
  } else if (legacy && legacy.length > 0 && !(next && next.length > 0)) {
    warnings.push('CAIRN_JOB_QUEUES is deprecated and was honoured as CAIRN_WORKER_QUEUES; rename it.');
  }

  let queues = next && next.length > 0 ? next : legacy && legacy.length > 0 ? legacy : null;
  const allowAll = ['1', 'true', 'yes'].includes((env.CAIRN_WORKER_ALLOW_ALL_QUEUES ?? '').toLowerCase());

  if (queues === null) {
    if (!allowAll) {
      throw new WorkerConfigError(
        'No queue filter: an empty CAIRN_WORKER_QUEUES makes this worker claim every queue, which defeats the worker split. ' +
          'Set CAIRN_WORKER_QUEUES (regular: DEFAULT,MAIL,OUTPUT; intensive: INTENSIVE), or set CAIRN_WORKER_ALLOW_ALL_QUEUES=true for a deliberate single-process deployment.',
      );
    }
  } else if (allowAll) {
    throw new WorkerConfigError('CAIRN_WORKER_ALLOW_ALL_QUEUES=true contradicts an explicit queue list. Use one or the other.');
  }
  if (queues) queues = [...new Set(queues)];

  const idRaw = env.CAIRN_WORKER_ID?.trim();
  const pollRaw = env.CAIRN_WORKER_POLL_MS ?? env.CAIRN_JOB_POLL_MS;
  const poll = pollRaw ? Number.parseInt(pollRaw, 10) : Number.NaN;

  // Exactly one role ticks the scheduler by default; the intensive worker opts out.
  const schedulerRaw = (env.CAIRN_WORKER_SCHEDULER ?? 'true').toLowerCase();
  const scheduler = !['0', 'false', 'no', 'off'].includes(schedulerRaw);

  return {
    workerId: idRaw ? idRaw : null,
    queues,
    pollMs: Number.isFinite(poll) && poll > 0 ? poll : null,
    scheduler,
    warnings,
  };
}
