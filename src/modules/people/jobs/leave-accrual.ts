/**
 * LEAVE.ACCRUAL.RUN (regular worker, scheduled hourly, bounded catch-up window) and
 * LEAVE.ACCRUAL.BACKFILL (INTENSIVE queue, requested by a user, no window).
 *
 * Both use the same posting rules and source keys (leave-accrual.ts), so they are idempotent and may overlap.
 * A scheduled run (triggered_by 'SCHEDULER') acts with the accrue-only system capability; a user-triggered run acts
 * as that user with the job lease, so their current authority and Company Code scope apply.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../../platform/db/client';
import { registerJob } from '../../../platform/job/registry';
import type { ChunkResult, JobContext, JobHandler } from '../../../platform/job/types';
import {
  SYSTEM_ACCRUAL_ACCESS, accrueChunk, failAccrualRun, recordAccrualChunk, startAccrualRun,
} from '../leave-accrual';
import { isLeaveError, type LeaveAccess } from '../leave-access';

export const LEAVE_ACCRUAL_JOB = 'LEAVE.ACCRUAL.RUN';
export const LEAVE_BACKFILL_JOB = 'LEAVE.ACCRUAL.BACKFILL';

type Cursor = { runId?: string; after?: string | null };

async function trigger(ctx: JobContext): Promise<{ type: string; by: string; userId: string | null; name: string }> {
  return withTenant(ctx.client, async (tx) => {
    const rows = (await tx.execute(sql`
      select j.trigger_type as type, j.triggered_by as by, u.id as uid, u.username as name
        from job_run j left join app_user u on u.client = j.client and u.id = j.triggered_by
       where j.client = ${ctx.client} and j.id = ${ctx.runId}`)) as unknown as Array<{ type: string; by: string; uid: string | null; name: string | null }>;
    const r = rows[0];
    return { type: r?.type ?? 'MANUAL', by: r?.by ?? 'SYSTEM', userId: r?.uid ?? null, name: r?.name ?? 'SYSTEM' };
  });
}

function chunker(window: 'CATCH_UP' | 'ALL', kind: 'SCHEDULED' | 'BACKFILL') {
  return async (ctx: JobContext): Promise<ChunkResult> => {
    const cursor = (ctx.cursor ?? {}) as Cursor;
    const who = await trigger(ctx);
    // A user's run is judged as that user; anything else is the constrained scheduler identity.
    const access: LeaveAccess = who.userId
      ? { authorization: { userId: who.userId, sessionId: '', jobLease: { runId: ctx.runId, epoch: ctx.epoch } } }
      : SYSTEM_ACCRUAL_ACCESS;
    const runKind = who.userId && kind === 'SCHEDULED' ? 'MANUAL' : kind;
    let runId = cursor.runId;
    if (!runId) {
      runId = await withTenant(ctx.client, async (tx) => {
        await ctx.fence(tx);
        return startAccrualRun(tx, ctx.client, runKind, who.name, ctx.runId);
      });
    }
    try {
      const c = await accrueChunk(ctx.client, {
        access, after: cursor.after ?? null, limit: ctx.chunkSize, window,
        fence: (tx) => ctx.fence(tx), requestedBy: who.name,
      });
      await withTenant(ctx.client, async (tx) => {
        await ctx.fence(tx);
        await recordAccrualChunk(tx, ctx.client, runId!, c, c.done);
      });
      return {
        cursor: c.done ? null : { runId, after: c.afterPersonnelNumber },
        processed: c.employees,
        progressText: `${c.employees} employee(s), ${c.posted} credit(s) posted, ${c.exceptions} exception(s), ${c.backlog} backlog`,
      };
    } catch (e) {
      // A refusal (authority, time zone) is a fact about this run, not a transient fault: record it and finish cleanly.
      if (isLeaveError(e)) {
        await failAccrualRun(ctx.client, runId, `${e.code}: ${e.message}`);
        return { cursor: null, processed: 0, progressText: 'Not processed: the run was refused. See the leave accrual status.' };
      }
      throw e;
    }
  };
}

export const leaveAccrualJob: JobHandler = { code: LEAVE_ACCRUAL_JOB, chunk: chunker('CATCH_UP', 'SCHEDULED') };
export const leaveBackfillJob: JobHandler = { code: LEAVE_BACKFILL_JOB, chunk: chunker('ALL', 'BACKFILL') };

registerJob(leaveAccrualJob);
registerJob(leaveBackfillJob);
