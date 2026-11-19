/**
 * Period-close evidence pack (`AUDIT.PERIOD.EVIDENCE`) - request, status, download, cancel, and the job.
 *
 * ## Authority, every time
 *
 * A request, a status read and a download each require a live session (the caller's), AUDIT.WORKSPACE +
 * AUDIT.PERIOD.EVIDENCE (+ AUDIT.EVIDENCE.EXPORT to create or download), the actor's current organisational
 * reach to the company code, and a LIVE audit grant that belongs to the actor and covers the company code, the
 * `YYYYPP` period AND the module FIN - all three provided explicitly. Status and download are bound to the
 * grant the pack was requested under. A refusal is logged as CAPABILITY_DENIED and committed before the error.
 *
 * ## The job
 *
 * `AUDIT.PERIOD.PACK` (INTENSIVE, on demand) carries ONLY the pack id. The worker re-judges the original
 * requester (`loadJobActor` / `assertActorCan`) and the SAME grant against all three scopes, at the start, at
 * the snapshot and again in the transaction that publishes the ZIP. It holds a lease fence (a key-share lock
 * on its run) in one transaction for the whole build, so the reaper cannot reap a live build and a worker that
 * lost the lease cannot publish. The ZIP is built from ONE repeatable-read snapshot on a second connection.
 * Publishing is one transaction: artifact, hash, COMPLETED. A crash after that commit and before the job
 * records success is harmless: a retry finds the pack COMPLETED and does nothing.
 *
 * ## What the generic job tables hold
 *
 * The pack id and fixed words. Never a selection's rows, a user's journal, or the artifact. A generic retry of
 * a job whose pack already ended is refused by the handler; a generic retry of a live one re-runs every
 * authorisation check above. A generic cancel ends the pack as CANCELLED through the job-end trigger.
 *
 * Retention: a COMPLETED pack is available `PACK_RETENTION_DAYS` days (default 30). `cleanupExpiredPeriodPacks`
 * nulls expired artifacts (the row and `audit_access_log` stay). A download after `expires_at` is refused even
 * before cleanup has run.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';

import { canTx, type OrgScope } from '../../platform/auth/authority';
import { type Tx, withTenant, withTenantSnapshot } from '../../platform/db/client';
import { assertActorCan, JobActorError, loadJobActor, type JobActor } from '../../platform/job/actor';
import { enqueue, requestCancel } from '../../platform/job/queue';
import { LeaseLostError, type ChunkResult, type JobContext } from '../../platform/job/types';
import { auditPeriodPack, type AuditPeriodPackStatus } from './schema';
import {
  AUDIT_EXPORT_CAPABILITY,
  AUDIT_WORKSPACE_CAPABILITY,
  AUDIT_WORKSPACE_ROUTE,
  AuditError,
  enforceAuditAccess,
  grantStillCovers,
  logAuditAccess,
  type AuditActor,
  type ScopeProbe,
} from './workspace';
import { collectEvidence, PeriodPackError, resolveSelection, type PackSelection } from './period-evidence-data';
import { packFilename } from './period-evidence-archive';
import { renderPack } from './period-evidence-report';

export const AUDIT_PERIOD_EVIDENCE_CAPABILITY = 'AUDIT.PERIOD.EVIDENCE';
export const AUDIT_PERIOD_PACK_JOB = 'AUDIT.PERIOD.PACK';
export const PERIOD_PACK_DOWNLOAD_PREFIX = '/api/audit/period-pack';
/** Days a finished pack stays downloadable. */
export const PACK_RETENTION_DAYS = 30;

const ROUTE = AUDIT_WORKSPACE_ROUTE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{8,80}$/;

const REQUEST_CAPS = [AUDIT_WORKSPACE_CAPABILITY, AUDIT_PERIOD_EVIDENCE_CAPABILITY, AUDIT_EXPORT_CAPABILITY] as const;
const STATUS_CAPS = [AUDIT_WORKSPACE_CAPABILITY, AUDIT_PERIOD_EVIDENCE_CAPABILITY] as const;

/** The three scope levels, always all provided: company code, `YYYYPP`, module FIN. */
export function packProbe(s: PackSelection): ScopeProbe {
  return { companyCode: s.companyCode, period: `${s.fiscalYear}${String(s.postingPeriod).padStart(2, '0')}`, module: 'FIN' };
}

export interface PeriodPackView {
  packId: string;
  status: AuditPeriodPackStatus;
  companyCode: string;
  fiscalYear: number;
  postingPeriod: number;
  progressLabel: string | null;
  errorCode: string | null;
  createdAt: string;
  snapshotAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  byteLength: number | null;
  manifestSha256: string | null;
  /** True only when a download would currently be offered (COMPLETED and not expired). The server re-checks on download. */
  downloadable: boolean;
  downloadUrl: string | null;
  limitations: string;
}

const LIMITATION_NOTE =
  'Reports what the system recorded for this selection. Whether and when the period was closed, and the authority behind any posting, are UNKNOWN / not recorded. Current rules are shown as at the snapshot, not as history. A finalised close task list does not close a period.';

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

type PackRow = typeof auditPeriodPack.$inferSelect;
const PUBLIC_COLUMNS = {
  client: auditPeriodPack.client, packId: auditPeriodPack.packId, requesterUserId: auditPeriodPack.requesterUserId,
  requesterUsername: auditPeriodPack.requesterUsername, grantId: auditPeriodPack.grantId, companyCode: auditPeriodPack.companyCode,
  fiscalYear: auditPeriodPack.fiscalYear, postingPeriod: auditPeriodPack.postingPeriod, requestKey: auditPeriodPack.requestKey,
  jobRunId: auditPeriodPack.jobRunId, status: auditPeriodPack.status, progressLabel: auditPeriodPack.progressLabel,
  errorCode: auditPeriodPack.errorCode, createdAt: auditPeriodPack.createdAt, snapshotAt: auditPeriodPack.snapshotAt,
  completedAt: auditPeriodPack.completedAt, expiresAt: auditPeriodPack.expiresAt, byteLength: auditPeriodPack.byteLength,
  manifestSha256: auditPeriodPack.manifestSha256,
};
type PublicPack = Omit<PackRow, 'artifact' | 'createdBy' | 'changedBy' | 'changedAt'>;

function viewOf(r: PublicPack, now: Date = new Date()): PeriodPackView {
  const live = r.status === 'COMPLETED' && r.expiresAt != null && r.expiresAt.getTime() > now.getTime();
  const expired = r.status === 'EXPIRED' || (r.status === 'COMPLETED' && !live);
  return {
    packId: r.packId, status: expired ? 'EXPIRED' : (r.status as AuditPeriodPackStatus),
    companyCode: r.companyCode, fiscalYear: r.fiscalYear, postingPeriod: r.postingPeriod,
    progressLabel: r.progressLabel, errorCode: r.errorCode, createdAt: iso(r.createdAt)!, snapshotAt: iso(r.snapshotAt),
    completedAt: iso(r.completedAt), expiresAt: iso(r.expiresAt), byteLength: r.byteLength, manifestSha256: r.manifestSha256,
    downloadable: live, downloadUrl: live ? `${PERIOD_PACK_DOWNLOAD_PREFIX}/${r.packId}` : null, limitations: LIMITATION_NOTE,
  };
}

async function loadOwnPack(tx: Tx, client: string, userId: string, packId: string): Promise<PublicPack> {
  if (!UUID.test(packId)) throw new AuditError('That evidence pack does not exist.', undefined, 'AUDIT_PACK_NOT_FOUND');
  const rows = await tx.select(PUBLIC_COLUMNS).from(auditPeriodPack)
    .where(and(eq(auditPeriodPack.client, client), eq(auditPeriodPack.packId, packId)));
  const row = rows[0];
  // Another person's pack answers exactly like a missing one: an id is never authority.
  if (!row || row.requesterUserId !== userId) throw new AuditError('That evidence pack does not exist.', undefined, 'AUDIT_PACK_NOT_FOUND');
  return row as unknown as PublicPack;
}

/** Null out artifacts past `expires_at`. The pack row and the access log stay. Returns how many expired. */
export async function cleanupExpiredPeriodPacks(tx: Tx, client: string): Promise<number> {
  const rows = await tx.update(auditPeriodPack)
    .set({ status: 'EXPIRED', artifact: null, changedBy: 'PACK_RETENTION', changedAt: new Date() })
    .where(and(eq(auditPeriodPack.client, client), eq(auditPeriodPack.status, 'COMPLETED'), sql`${auditPeriodPack.expiresAt} <= now()`))
    .returning({ id: auditPeriodPack.packId });
  return rows.length;
}

// ── Request ─────────────────────────────────────────────────────────────────

export interface RequestPackInput {
  companyCode: string;
  fiscalYear: string | number;
  postingPeriod: string | number;
  requestKey: string;
}

function parseSelection(input: RequestPackInput): PackSelection {
  const companyCode = String(input.companyCode ?? '').trim().toUpperCase();
  const year = String(input.fiscalYear ?? '').trim();
  const period = String(input.postingPeriod ?? '').trim();
  if (!/^[A-Z0-9]{1,10}$/.test(companyCode)) throw new PeriodPackError('UNKNOWN_COMPANY', 'Choose a company code.', 'Pick one of the company codes your grant covers.');
  if (!/^\d{4}$/.test(year)) throw new PeriodPackError('INVALID_YEAR', 'The fiscal year must be a four-digit year such as 2026.', 'Enter the fiscal year.');
  if (!/^\d{1,2}$/.test(period) || Number(period) < 1 || Number(period) > 16) {
    throw new PeriodPackError('INVALID_PERIOD', 'The posting period must be a whole number from 1 to 16.', 'Enter the stored posting period, e.g. 12 or 13.');
  }
  return { companyCode, fiscalYear: Number(year), postingPeriod: Number(period) };
}

/**
 * Request a pack. One transaction creates the pack row, enqueues the job and logs the request; a repeated
 * request key with the same selection returns the same pack, with a different selection it is refused.
 */
export async function requestPeriodPack(actor: AuditActor, input: RequestPackInput): Promise<PeriodPackView> {
  const selection = parseSelection(input);
  const requestKey = String(input.requestKey ?? '').trim();
  if (!KEY.test(requestKey)) throw new PeriodPackError('INVALID_REQUEST_KEY', 'The request key is missing or malformed.', 'Reload the page and submit again.');

  const grant = await enforceAuditAccess(actor, {
    capabilities: REQUEST_CAPS, probe: packProbe(selection), org: { companyCode: selection.companyCode }, logSuccess: false,
  }, { route: ROUTE, eventType: 'EXPORT', detail: `request period pack ${selection.companyCode} ${selection.fiscalYear}/${selection.postingPeriod}`, objectKey: requestKey, transactionCode: AUDIT_PERIOD_EVIDENCE_CAPABILITY });

  return withTenant(actor.client, async (tx) => {
    await resolveSelection(tx, actor.client, selection);
    await cleanupExpiredPeriodPacks(tx, actor.client);
    const existing = await findByKey(tx, actor.client, actor.userId, requestKey);
    if (existing) return replay(existing, selection);

    const packId = randomUUID();
    const inserted = await tx.insert(auditPeriodPack).values({
      client: actor.client, packId, requesterUserId: actor.userId, requesterUsername: actor.username, grantId: grant.grantId,
      companyCode: selection.companyCode, fiscalYear: selection.fiscalYear, postingPeriod: selection.postingPeriod,
      requestKey, status: 'QUEUED', progressLabel: 'Queued', createdBy: actor.username,
    }).onConflictDoNothing().returning({ packId: auditPeriodPack.packId });
    if (inserted.length === 0) {
      // A concurrent submit with the same key won the unique index: that pack is the answer.
      const winner = await findByKey(tx, actor.client, actor.userId, requestKey);
      if (!winner) throw new PeriodPackError('REQUEST_RACE', 'The request could not be recorded.', 'Submit again.');
      return replay(winner, selection);
    }
    const job = await enqueue(tx, {
      client: actor.client, jobCode: AUDIT_PERIOD_PACK_JOB, parameters: { packId }, triggeredBy: actor.userId,
      triggerType: 'MANUAL', idempotencyKey: `audit-period-pack:${packId}`,
    });
    await tx.update(auditPeriodPack).set({ jobRunId: job.id }).where(and(eq(auditPeriodPack.client, actor.client), eq(auditPeriodPack.packId, packId)));
    await logAuditAccess(tx, {
      client: actor.client, userId: actor.userId, username: actor.username, eventType: 'EXPORT', route: ROUTE,
      transactionCode: AUDIT_PERIOD_EVIDENCE_CAPABILITY, objectKey: packId,
      detail: `requested period pack ${selection.companyCode} ${selection.fiscalYear}/${selection.postingPeriod}`, grantId: grant.grantId,
    });
    return viewOf((await loadOwnPack(tx, actor.client, actor.userId, packId)));
  });
}

async function findByKey(tx: Tx, client: string, userId: string, requestKey: string): Promise<PublicPack | null> {
  const rows = await tx.select(PUBLIC_COLUMNS).from(auditPeriodPack).where(and(
    eq(auditPeriodPack.client, client), eq(auditPeriodPack.requesterUserId, userId), eq(auditPeriodPack.requestKey, requestKey),
  ));
  return (rows[0] as unknown as PublicPack) ?? null;
}

function replay(existing: PublicPack, selection: PackSelection): PeriodPackView {
  if (existing.companyCode !== selection.companyCode || existing.fiscalYear !== selection.fiscalYear || existing.postingPeriod !== selection.postingPeriod) {
    throw new PeriodPackError('KEY_REUSED', 'This request key was already used for a different selection.', 'Reload the page to get a fresh request key.');
  }
  return viewOf(existing);
}

// ── Status, list, cancel ────────────────────────────────────────────────────

const selectionOf = (p: PublicPack): PackSelection => ({ companyCode: p.companyCode, fiscalYear: p.fiscalYear, postingPeriod: p.postingPeriod });

/** Status read. Bound to the requester and to the grant the pack was requested under; logged as READ. */
export async function getPeriodPackStatus(actor: AuditActor, packId: string): Promise<PeriodPackView> {
  const pack = await withTenant(actor.client, (tx) => loadOwnPack(tx, actor.client, actor.userId, packId));
  await enforceAuditAccess(actor, {
    capabilities: STATUS_CAPS, probe: packProbe(selectionOf(pack)), org: { companyCode: pack.companyCode }, grantId: pack.grantId,
  }, { route: ROUTE, eventType: 'READ', detail: `status of period pack ${pack.companyCode} ${pack.fiscalYear}/${pack.postingPeriod}`, objectKey: pack.packId, transactionCode: AUDIT_PERIOD_EVIDENCE_CAPABILITY });
  return withTenant(actor.client, async (tx) => viewOf(await loadOwnPack(tx, actor.client, actor.userId, packId)));
}

/**
 * Stop a pack the requester no longer wants. Allowed with the workspace + evidence capabilities alone: stopping
 * a build discloses nothing. The job-end trigger turns the pack CANCELLED; a running build is asked to stop and
 * does so before it publishes.
 */
export async function cancelPeriodPack(actor: AuditActor, packId: string): Promise<PeriodPackView> {
  return withTenant(actor.client, async (tx) => {
    const pack = await loadOwnPack(tx, actor.client, actor.userId, packId);
    for (const cap of STATUS_CAPS) {
      if (!(await canTx(tx, actor.client, actor.userId, cap, { companyCode: pack.companyCode }))) {
        throw new AuditError(`You do not hold the authority ${cap}.`, `Ask an administrator to assign ${cap}.`, 'AUDIT_AUTHORITY');
      }
    }
    if (pack.status !== 'QUEUED' && pack.status !== 'RUNNING') throw new PeriodPackError('NOT_CANCELLABLE', `The pack is already ${pack.status.toLowerCase()}.`);
    if (pack.jobRunId) await requestCancel(tx, actor.client, pack.jobRunId);
    await logAuditAccess(tx, {
      client: actor.client, userId: actor.userId, username: actor.username, eventType: 'READ', route: ROUTE,
      transactionCode: AUDIT_PERIOD_EVIDENCE_CAPABILITY, objectKey: pack.packId, detail: 'cancelled period pack', grantId: pack.grantId,
    });
    return viewOf(await loadOwnPack(tx, actor.client, actor.userId, packId));
  });
}

// ── Download ────────────────────────────────────────────────────────────────

export interface PackDownload {
  filename: string;
  bytes: Buffer;
  manifestSha256: string;
}

/**
 * The authorised download. Judged again here, now: capabilities, the original grant (live, the requester's,
 * covering company + period + FIN), and expiry measured by the database clock. The bytes are read in the same
 * transaction that logs the EXPORT; a refusal is logged and committed.
 */
export async function downloadPeriodPack(actor: AuditActor, packId: string): Promise<PackDownload> {
  const pack = await withTenant(actor.client, (tx) => loadOwnPack(tx, actor.client, actor.userId, packId));
  const access = {
    route: ROUTE, eventType: 'EXPORT' as const, objectKey: pack.packId, transactionCode: AUDIT_PERIOD_EVIDENCE_CAPABILITY,
    detail: `download period pack ${pack.companyCode} ${pack.fiscalYear}/${pack.postingPeriod}`,
  };
  const grant = await enforceAuditAccess(actor, {
    capabilities: REQUEST_CAPS, probe: packProbe(selectionOf(pack)), org: { companyCode: pack.companyCode }, grantId: pack.grantId, logSuccess: false,
  }, access);

  const outcome = await withTenant(actor.client, async (tx) => {
    const rows = (await tx.execute(sql`
      select artifact, manifest_sha256 from audit_period_pack
       where client = ${actor.client} and pack_id = ${pack.packId} and requester_user_id = ${actor.userId}
         and status = 'COMPLETED' and artifact is not null and expires_at > now()
    `)) as unknown as Array<{ artifact: Buffer; manifest_sha256: string }>;
    const row = rows[0];
    await logAuditAccess(tx, {
      client: actor.client, userId: actor.userId, username: actor.username, route: ROUTE, objectKey: pack.packId,
      transactionCode: AUDIT_PERIOD_EVIDENCE_CAPABILITY, grantId: grant.grantId,
      eventType: row ? 'EXPORT' : 'CAPABILITY_DENIED',
      detail: row ? access.detail : `Refused EXPORT (${access.detail}): the pack is not available (not completed, expired or purged)`,
    });
    return row ? { bytes: Buffer.from(row.artifact), manifestSha256: row.manifest_sha256 } : null;
  });
  if (!outcome) throw new AuditError('This evidence pack is not available: it is not complete, has expired, or was purged.', 'Request a new pack.', 'AUDIT_PACK_UNAVAILABLE');
  return { filename: packFilename(pack.companyCode, pack.fiscalYear, pack.postingPeriod, pack.packId), ...outcome };
}

// ── The job ─────────────────────────────────────────────────────────────────

/** What the job runner records: fixed words. The reason is on the pack row as a code. */
class PackJobError extends Error {
  constructor(packId: string, code: string) {
    super(`Audit period pack ${packId} ended with ${code}.`);
    this.name = 'PackJobError';
  }
}

/** Re-judge the original requester and the SAME grant, now. Returns the actor or a coded refusal. */
async function authorizeWorker(tx: Tx, client: string, pack: PublicPack): Promise<{ ok: true; actor: JobActor } | { ok: false; code: string; why: string }> {
  let actor: JobActor;
  try {
    actor = await loadJobActor(tx, client, pack.requesterUserId);
    const org: OrgScope = { companyCode: pack.companyCode };
    for (const cap of REQUEST_CAPS) await assertActorCan(tx, client, actor, cap, org);
  } catch (error) {
    if (error instanceof JobActorError) return { ok: false, code: 'AUTHORITY_REVOKED', why: 'the requester no longer holds the required authority or is not an active user' };
    throw error;
  }
  const grant = await grantStillCovers(tx, client, pack.grantId, pack.requesterUserId, packProbe(selectionOf(pack)));
  if (!grant.ok) return { ok: false, code: grant.code, why: grant.why };
  return { ok: true, actor };
}

async function failPack(tx: Tx, client: string, pack: PublicPack, code: string, denial?: string): Promise<void> {
  await tx.update(auditPeriodPack).set({ status: 'FAILED', errorCode: code.slice(0, 40), progressLabel: null, changedBy: 'AUDIT_PACK_JOB', changedAt: new Date() })
    .where(and(eq(auditPeriodPack.client, client), eq(auditPeriodPack.packId, pack.packId), sql`${auditPeriodPack.status} in ('QUEUED','RUNNING')`));
  if (denial) {
    await logAuditAccess(tx, {
      client, userId: pack.requesterUserId, username: pack.requesterUsername, eventType: 'CAPABILITY_DENIED', route: ROUTE,
      transactionCode: AUDIT_PERIOD_EVIDENCE_CAPABILITY, objectKey: pack.packId, grantId: pack.grantId,
      detail: `Refused generation of period pack ${pack.companyCode} ${pack.fiscalYear}/${pack.postingPeriod}: ${denial}`.slice(0, 500),
    });
  }
}

async function cancelRequested(tx: Tx, client: string, runId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`select cancel_requested_at from job_run where client = ${client} and id = ${runId}`)) as unknown as Array<{ cancel_requested_at: unknown }>;
  return Boolean(rows[0]?.cancel_requested_at);
}

/** AUDIT.PERIOD.PACK: one chunk builds and publishes the whole pack, or ends it truthfully. */
export async function runPeriodPackChunk(ctx: JobContext): Promise<ChunkResult> {
  const packId = String(ctx.parameters.packId ?? '');
  if (!UUID.test(packId)) throw new PackJobError('(none)', 'NO_PACK');
  const client = ctx.client;

  // ── Stage 1: judge it and mark it RUNNING (short transaction, fenced) ─────
  type Stage1 = { kind: 'go'; pack: PublicPack } | { kind: 'done'; text: string } | { kind: 'ended'; code: string };
  const stage1 = await withTenant(client, async (tx): Promise<Stage1> => {
    await ctx.fence(tx);
    const rows = await tx.select(PUBLIC_COLUMNS).from(auditPeriodPack).where(and(eq(auditPeriodPack.client, client), eq(auditPeriodPack.packId, packId)));
    const pack = rows[0] as unknown as PublicPack | undefined;
    if (!pack || pack.jobRunId !== ctx.runId) return { kind: 'ended', code: 'NO_PACK' };
    if (pack.status === 'COMPLETED') return { kind: 'done', text: 'Already complete.' };
    if (pack.status !== 'QUEUED' && pack.status !== 'RUNNING') return { kind: 'ended', code: pack.errorCode ?? pack.status };
    if (await cancelRequested(tx, client, ctx.runId)) {
      await tx.update(auditPeriodPack).set({ status: 'CANCELLED', errorCode: 'CANCELLED', progressLabel: null, changedBy: 'AUDIT_PACK_JOB', changedAt: new Date() })
        .where(and(eq(auditPeriodPack.client, client), eq(auditPeriodPack.packId, packId)));
      return { kind: 'ended', code: 'CANCELLED' };
    }
    const auth = await authorizeWorker(tx, client, pack);
    if (!auth.ok) {
      await failPack(tx, client, pack, auth.code, auth.why);
      return { kind: 'ended', code: auth.code };
    }
    await tx.update(auditPeriodPack).set({ status: 'RUNNING', progressLabel: 'Reading snapshot and building archive', changedBy: 'AUDIT_PACK_JOB', changedAt: new Date() })
      .where(and(eq(auditPeriodPack.client, client), eq(auditPeriodPack.packId, packId)));
    return { kind: 'go', pack };
  });
  if (stage1.kind === 'done') return { cursor: null, processed: 0, progressText: stage1.text };
  if (stage1.kind === 'ended') throw new PackJobError(packId, stage1.code);
  const pack = stage1.pack;

  // ── Stage 2: the guard transaction holds the lease fence for the whole build and publishes ──
  type Stage2 = { kind: 'published'; rows: number; bytes: number } | { kind: 'ended'; code: string };
  const stage2 = await withTenant(client, async (guard): Promise<Stage2> => {
    await ctx.fence(guard);
    let built: ReturnType<typeof renderPack>;
    let snapshotAt: string;
    let totalRows: number;
    try {
      // ONE repeatable-read snapshot on a second connection; the requester and grant are judged inside it too.
      const snap = await withTenantSnapshot(client, async (tx) => {
        const auth = await authorizeWorker(tx, client, pack);
        if (!auth.ok) throw new SnapshotRefused(auth.code, auth.why);
        return collectEvidence(tx, client, selectionOf(pack));
      });
      snapshotAt = snap.snapshotAt;
      totalRows = snap.ruleChanges.length + snap.assignmentChanges.length + snap.taskLists.length + snap.tasks.length + snap.executions.length + snap.events.length + snap.journal.length;
      if (ctx.isLeaseLost()) throw new LeaseLostError();
      built = renderPack(snap, { packId, client, requestedBy: pack.requesterUsername, grantId: pack.grantId, generatedAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      if (error instanceof SnapshotRefused) { await failPack(guard, client, pack, error.code, error.why); return { kind: 'ended', code: error.code }; }
      if (error instanceof PeriodPackError) { await failPack(guard, client, pack, error.code); return { kind: 'ended', code: error.code }; }
      throw error;
    }

    // Publish: everything is judged once more against the CURRENT database, then the artifact is written.
    if (ctx.isLeaseLost()) throw new LeaseLostError();
    if (await cancelRequested(guard, client, ctx.runId)) {
      await guard.update(auditPeriodPack).set({ status: 'CANCELLED', errorCode: 'CANCELLED', progressLabel: null, changedBy: 'AUDIT_PACK_JOB', changedAt: new Date() })
        .where(and(eq(auditPeriodPack.client, client), eq(auditPeriodPack.packId, packId)));
      return { kind: 'ended', code: 'CANCELLED' };
    }
    const auth = await authorizeWorker(guard, client, pack);
    if (!auth.ok) { await failPack(guard, client, pack, auth.code, auth.why); return { kind: 'ended', code: auth.code }; }
    const published = await guard.update(auditPeriodPack).set({
      status: 'COMPLETED', artifact: built.zip, byteLength: built.zip.length, manifestSha256: built.manifestSha256, errorCode: null, progressLabel: null,
      snapshotAt: new Date(snapshotAt), completedAt: sql`now()`, expiresAt: sql`now() + make_interval(days => ${PACK_RETENTION_DAYS})`,
      changedBy: 'AUDIT_PACK_JOB', changedAt: new Date(),
    }).where(and(eq(auditPeriodPack.client, client), eq(auditPeriodPack.packId, packId), eq(auditPeriodPack.status, 'RUNNING')))
      .returning({ id: auditPeriodPack.packId });
    if (published.length === 0) return { kind: 'ended', code: 'NOT_RUNNING' };
    await logAuditAccess(guard, {
      client, userId: pack.requesterUserId, username: pack.requesterUsername, eventType: 'EXPORT', route: ROUTE,
      transactionCode: AUDIT_PERIOD_EVIDENCE_CAPABILITY, objectKey: packId, grantId: pack.grantId,
      detail: `generated period pack ${pack.companyCode} ${pack.fiscalYear}/${pack.postingPeriod}: ${totalRows} source rows, ${built.zip.length} bytes`,
    });
    return { kind: 'published', rows: totalRows, bytes: built.zip.length };
  });
  if (stage2.kind === 'ended') throw new PackJobError(packId, stage2.code);
  return { cursor: null, processed: 1, progressText: 'Evidence pack ready.' };
}

class SnapshotRefused extends Error {
  constructor(readonly code: string, readonly why: string) {
    super(code);
  }
}

/** Recent packs of the requester, newest first, without artifacts. For the workspace panel. */
export async function listPeriodPackIds(actor: AuditActor, limit = 5): Promise<string[]> {
  return withTenant(actor.client, async (tx) => {
    const rows = await tx.select({ id: auditPeriodPack.packId }).from(auditPeriodPack)
      .where(and(eq(auditPeriodPack.client, actor.client), eq(auditPeriodPack.requesterUserId, actor.userId)))
      .orderBy(desc(auditPeriodPack.createdAt)).limit(limit);
    return rows.map((r) => r.id);
  });
}
