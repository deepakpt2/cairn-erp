/**
 * The scheduler — Phase 7.
 *
 * Phase 4 declared `job_definition.schedule` and `is_scheduled` and nothing
 * ever read them. This reads them: once per tick it works out which scheduled
 * jobs are due, per tenant, and enqueues them.
 *
 * ## Why the tenant list needs a definer function
 *
 * `job_definition` is platform-wide — it carries no `client` column — but a run
 * belongs to a tenant, so a scheduled job has to be enqueued once per tenant.
 * Enumerating tenants is exactly what row level security exists to prevent:
 * `client` carries FORCE ROW LEVEL SECURITY and `cairn_app` has no BYPASSRLS.
 *
 * The same answer Phase 4 chose for job claiming applies here. `job_all_clients`
 * is SECURITY DEFINER owned by the migrator role and returns client codes and
 * nothing else. Everything after that runs through the ordinary scoped path.
 *
 * ## Why it cannot double-queue
 *
 * Each run is enqueued under an idempotency key built from the job code, the
 * tenant and the instant it was due. Re-running the tick enqueues nothing, and
 * a backoff or a retry cannot conjure a second copy of the same scheduled run.
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

import { db, withTenant } from '@/platform/db/client';
import { enqueue } from '@/platform/job/queue';
import { jobDefinition, jobRun } from '@/platform/tables/system';

import { nextDueAfter } from './cron';

export interface SchedulerTickResult {
  enqueued: string[];
  /** Schedules that never fire again, or that named no tenant. */
  skipped: string[];
}

/**
 * Work out what is due, and queue it.
 *
 * Safe to call as often as you like: it is the idempotency key, not the clock,
 * that decides whether a run appears.
 */
export async function tickScheduler(now: Date = new Date()): Promise<SchedulerTickResult> {
  const definitions = await db()
    .select()
    .from(jobDefinition)
    .where(and(eq(jobDefinition.isScheduled, true), eq(jobDefinition.isEnabled, true), isNotNull(jobDefinition.schedule)));

  const enqueued: string[] = [];
  const skipped: string[] = [];

  for (const definition of definitions) {
    const schedule = definition.schedule;
    if (!schedule) continue;

    let clients: string[];
    try {
      clients = await allClients();
    } catch {
      skipped.push(definition.code);
      continue;
    }
    if (clients.length === 0) {
      skipped.push(definition.code);
      continue;
    }

    for (const client of clients) {
      const lastRunAt = await latestScheduledRun(client, definition.code);
      const dueAt = nextDueAfter(schedule, lastRunAt ?? new Date(0));
      if (!dueAt) {
        skipped.push(definition.code);
        break;
      }
      // Not yet due. The last run is the anchor, so a job that runs daily and
      // was last queued yesterday is due today and not before.
      if (dueAt.getTime() > now.getTime()) continue;

      const result = await enqueueJob(client, definition.code, dueAt);
      if (result) enqueued.push(`${definition.code}@${client}`);
    }
  }

  return { enqueued, skipped };
}

/** Every tenant, through the one function allowed to list them. */
async function allClients(): Promise<string[]> {
  const result = await db().execute(sql`select client from job_all_clients()`);
  // The driver hands back either the rows directly or a result envelope,
  // depending on the statement. Take whichever it is.
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return (rows as { client: unknown }[])
    .map((row) => row.client)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
}

/** When this job was last queued for this tenant, scheduled or not. */
async function latestScheduledRun(client: string, code: string): Promise<Date | null> {
  const [row] = await db()
    .select({ queuedAt: jobRun.queuedAt })
    .from(jobRun)
    .where(and(eq(jobRun.client, client), eq(jobRun.jobCode, code)))
    .orderBy(desc(jobRun.queuedAt))
    .limit(1);
  return row?.queuedAt ?? null;
}

/**
 * Queue it, scoped to its tenant.
 *
 * The scheduler is not part of any business change, so it opens its own
 * transaction through `withTenant` like any other caller. If the enqueue
 * fails, the run simply is not queued and the next tick tries again — the
 * idempotency key is built from the due instant, so "tries again" means
 * "still produces one run for that instant", never two.
 */
async function enqueueJob(client: string, code: string, dueAt: Date): Promise<boolean> {
  const key = `${code}:${client}:${dueAt.toISOString()}`;
  try {
    await withTenant(client, async (tx) => {
      await enqueue(tx, {
        client,
        jobCode: code,
        triggeredBy: 'SCHEDULER',
        triggerType: 'SCHEDULED',
        idempotencyKey: key,
      });
    });
    return true;
  } catch {
    return false;
  }
}
