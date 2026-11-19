/**
 * Large leave-balance exports. The synchronous CSV (leave-report.ts) takes up to 100 employees; a bigger
 * selection is queued as LEAVE.BALANCE.EXPORT on the INTENSIVE worker, built in batches under the requester's
 * live authority, stored in `leave_export` and downloaded through a protected route.
 *
 * The job parameters carry only the export id. The worker re-judges the requester (VIEW + EXPORT + Company
 * Code scope) through the job lease, so a revoked user gets a FAILED export, not a file.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { enqueue } from '../../platform/job/queue';
import type { ChunkResult, JobContext } from '../../platform/job/types';
import { LEAVE_EXPORT, LEAVE_VIEW, judgeLeave, isLeaveError, refuse, type LeaveAccess } from './leave-access';
import { EXPORT_MAX_EMPLOYEES, buildLargeCsv, type LeaveReportInput } from './leave-report';

export const LEAVE_EXPORT_JOB = 'LEAVE.BALANCE.EXPORT';
export const LEAVE_EXPORT_RETENTION_DAYS = 7;
const KEY = /^[A-Za-z0-9_.:-]{8,80}$/;

export interface ExportView {
  exportId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  filename: string | null;
  rows: number | null;
  notes: string | null;
  errorCode: string | null;
  createdAt: string;
  expiresAt: string | null;
  downloadPath: string | null;
}
export const EXPORT_DOWNLOAD_PREFIX = '/api/leave/balances/export';

function sessionUser(access: LeaveAccess | undefined): string | undefined {
  return access && !Array.isArray(access) ? (access as { authorization?: { userId?: string } }).authorization?.userId : undefined;
}

type Row = {
  export_id: string; status: ExportView['status']; filename: string | null; row_count: number | null; notes: string | null;
  error_code: string | null; created_at: string; expires_at: string | null; run_status: string | null;
};
const COLUMNS = sql`e.export_id, e.status, e.filename, e.row_count, e.notes, e.error_code, e.created_at::text as created_at,
  e.expires_at::text as expires_at, (select j.status from job_run j where j.client = e.client and j.id = e.job_run_id) as run_status`;

function view(r: Row): ExportView {
  // A job that ended without finishing the export (reaped, cancelled in the monitor) must not look pending forever.
  const ended = r.run_status !== null && ['FAILED', 'CANCELLED', 'DEAD_LETTER'].includes(r.run_status);
  const status = (r.status === 'QUEUED' || r.status === 'RUNNING') && ended ? 'FAILED' : r.status;
  return {
    exportId: r.export_id, status, filename: r.filename, rows: r.row_count, notes: r.notes,
    errorCode: status === 'FAILED' ? (r.error_code ?? 'JOB_ENDED') : r.error_code,
    createdAt: r.created_at, expiresAt: r.expires_at,
    downloadPath: status === 'COMPLETED' ? `${EXPORT_DOWNLOAD_PREFIX}/${r.export_id}` : null,
  };
}

type Selection = { personnelNumbers: string[]; groupCode: string | null; year: number | null; asOf: string | null };
/** jsonb does not keep key order, so compare field by field. */
function sameSelection(x: Selection, y: Selection): boolean {
  return x.groupCode === y.groupCode && x.year === y.year && x.asOf === y.asOf
    && JSON.stringify([...x.personnelNumbers].sort()) === JSON.stringify([...y.personnelNumbers].sort());
}

/** Queue a large export. Needs a live session (the job acts as this user). A repeated key returns the same export. */
export async function requestLeaveExport(
  input: Omit<LeaveReportInput, 'client'> & { client: string; requestKey: string }, access?: LeaveAccess,
): Promise<ExportView> {
  const key = String(input.requestKey ?? '').trim();
  if (!KEY.test(key)) refuse('INVALID_REQUEST_KEY', 'The request key is missing or malformed.', 'Reload the page and submit again.');
  const numbers = [...new Set((input.personnelNumbers ?? []).map((n) => n.trim()).filter(Boolean))];
  if (numbers.length === 0 && !input.groupCode) refuse('NO_SELECTION', 'No employee or group was chosen.', 'Choose one or more employees, or a leave group.');
  if (numbers.length > EXPORT_MAX_EMPLOYEES) refuse('TOO_MANY_EMPLOYEES', `${numbers.length} employees were chosen; an export takes at most ${EXPORT_MAX_EMPLOYEES}.`, 'Narrow the selection.');
  const selection = { personnelNumbers: numbers, groupCode: input.groupCode ?? null, year: input.year ?? null, asOf: input.asOf ?? null };

  return withTenant(input.client, async (tx) => {
    const grant = await judgeLeave(tx, input.client, access, [LEAVE_VIEW]);
    await judgeLeave(tx, input.client, access, [LEAVE_EXPORT]);
    const userId = sessionUser(access);
    if (!userId || grant.username === null) refuse('LEAVE_AUTHORITY', 'A queued export runs with your authority: sign in to request one.', 'Sign in and try again.');

    const existing = (await tx.execute(sql`
      select ${COLUMNS}, e.selection from leave_export e
       where e.client = ${input.client} and e.requester_user_id = ${userId} and e.request_key = ${key}
    `)) as unknown as Array<Row & { selection: unknown }>;
    if (existing[0]) {
      if (!sameSelection(existing[0].selection as typeof selection, selection)) {
        refuse('KEY_REUSED', 'This request key was already used for a different selection.', 'Reload the page to get a fresh request key.');
      }
      return view(existing[0]);
    }
    const exportId = randomUUID();
    await tx.execute(sql`
      insert into leave_export (client, export_id, requester_user_id, request_key, selection, created_by)
      values (${input.client}, ${exportId}, ${userId}, ${key}, ${JSON.stringify(selection)}::jsonb, ${grant.username})
    `);
    const run = await enqueue(tx, {
      client: input.client, jobCode: LEAVE_EXPORT_JOB, parameters: { exportId }, triggeredBy: userId,
      triggerType: 'MANUAL', idempotencyKey: `leave-export:${exportId}`,
    });
    await tx.execute(sql`update leave_export set job_run_id = ${run.id} where client = ${input.client} and export_id = ${exportId}`);
    const rows = (await tx.execute(sql`select ${COLUMNS} from leave_export e where e.client = ${input.client} and e.export_id = ${exportId}`)) as unknown as Row[];
    return view(rows[0]!);
  });
}

/** The caller's own exports, newest first (never another user's). */
export async function listLeaveExports(client: string, access?: LeaveAccess, limit = 10): Promise<ExportView[]> {
  return withTenant(client, async (tx) => {
    await judgeLeave(tx, client, access, [LEAVE_EXPORT]);
    const userId = sessionUser(access);
    if (!userId) return [];
    const rows = (await tx.execute(sql`
      select ${COLUMNS} from leave_export e
       where e.client = ${client} and e.requester_user_id = ${userId} order by e.created_at desc limit ${limit}
    `)) as unknown as Row[];
    return rows.map(view);
  });
}

/** The file, for its owner only, while it has not expired — judged again now for VIEW and EXPORT and live scope. */
export async function downloadLeaveExport(client: string, exportId: string, access?: LeaveAccess): Promise<{ filename: string; body: Buffer }> {
  if (!/^[0-9a-f-]{36}$/.test(exportId)) refuse('EXPORT_NOT_FOUND', 'This export does not exist.', 'Request a new export.');
  return withTenant(client, async (tx) => {
    await judgeLeave(tx, client, access, [LEAVE_VIEW]);
    await judgeLeave(tx, client, access, [LEAVE_EXPORT]);
    const userId = sessionUser(access);
    const rows = userId ? (await tx.execute(sql`
      select filename, body, status, expires_at < now() as expired from leave_export
       where client = ${client} and export_id = ${exportId} and requester_user_id = ${userId}
    `)) as unknown as Array<{ filename: string | null; body: Buffer | null; status: string; expired: boolean | null }> : [];
    const r = rows[0];
    // Another user's export and a missing one are indistinguishable.
    if (!r) refuse('EXPORT_NOT_FOUND', 'This export does not exist.', 'Request a new export.');
    if (r.status !== 'COMPLETED' || !r.body || r.expired) {
      refuse('EXPORT_UNAVAILABLE', 'This export is not ready, failed, or has expired.', 'Check its status, or request a new export.');
    }
    return { filename: r.filename ?? 'leave-balances.csv', body: Buffer.from(r.body) };
  });
}

/** Delete bodies of expired exports. Called by the job before it starts. */
async function expireOld(client: string): Promise<void> {
  await withTenant(client, (tx) => tx.execute(sql`
    update leave_export set status = 'EXPIRED', body = null
     where client = ${client} and status = 'COMPLETED' and expires_at < now()
  `));
}

/** The job: one chunk builds and stores the whole file, or ends the export truthfully. */
export async function runLeaveExportChunk(ctx: JobContext): Promise<ChunkResult> {
  const exportId = String((ctx.parameters as { exportId?: string }).exportId ?? '');
  await expireOld(ctx.client);
  const row = await withTenant(ctx.client, async (tx) => {
    const r = (await tx.execute(sql`
      select requester_user_id as uid, selection, status from leave_export where client = ${ctx.client} and export_id = ${exportId}
    `)) as unknown as Array<{ uid: string; selection: { personnelNumbers: string[]; groupCode: string | null; year: number | null; asOf: string | null }; status: string }>;
    if (r[0]?.status === 'QUEUED') {
      await ctx.fence(tx);
      await tx.execute(sql`update leave_export set status = 'RUNNING' where client = ${ctx.client} and export_id = ${exportId}`);
    }
    return r[0];
  });
  if (!row || (row.status !== 'QUEUED' && row.status !== 'RUNNING')) {
    return { cursor: null, processed: 0, progressText: 'Not processed: the export no longer exists or already ended.' };
  }
  const access: LeaveAccess = { authorization: { userId: row.uid, sessionId: '', jobLease: { runId: ctx.runId, epoch: ctx.epoch } } };
  try {
    const built = await withTenant(ctx.client, async (tx) => {
      await ctx.fence(tx);
      const grant = await judgeLeave(tx, ctx.client, access, [LEAVE_VIEW]);
      await judgeLeave(tx, ctx.client, access, [LEAVE_EXPORT]);
      return buildLargeCsv(tx, grant, {
        client: ctx.client, personnelNumbers: row.selection.personnelNumbers, groupCode: row.selection.groupCode ?? undefined,
        year: row.selection.year ?? undefined, asOf: row.selection.asOf ?? undefined,
      }, new Date());
    });
    const bytes = Buffer.from(built.body, 'utf8');
    const note = built.truncated ? `Partial: cut at ${EXPORT_MAX_EMPLOYEES} employees.` : built.unavailable.length > 0 ? `${built.unavailable.length} number(s) not available to you.` : null;
    await withTenant(ctx.client, async (tx) => {
      await ctx.fence(tx);
      await tx.execute(sql`
        update leave_export set status = 'COMPLETED', filename = ${built.filename}, body = ${bytes}, row_count = ${built.rows},
               byte_length = ${bytes.length}, notes = ${note}, completed_at = now(),
               expires_at = now() + (${LEAVE_EXPORT_RETENTION_DAYS} * interval '1 day')
         where client = ${ctx.client} and export_id = ${exportId}`);
    });
    return { cursor: null, processed: built.rows, progressText: `${built.rows} row(s) written` };
  } catch (e) {
    if (isLeaveError(e)) {
      // A refusal is a fact about this export, not a transient fault: record it, finish cleanly, say not processed.
      await withTenant(ctx.client, (tx) => tx.execute(sql`
        update leave_export set status = 'FAILED', error_code = ${e.code.slice(0, 40)}, notes = ${e.message.slice(0, 500)}
         where client = ${ctx.client} and export_id = ${exportId} and status in ('QUEUED','RUNNING')`));
      return { cursor: null, processed: 0, progressText: `Not processed: ${e.code}.` };
    }
    throw e;
  }
}
