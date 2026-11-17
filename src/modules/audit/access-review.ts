/**
 * Access review — user access recertification (ITEM-19).
 *
 * The recertification and its evidence — not another way to administer access. It freezes one item per
 * currently-effective role assignment, records a decision per item, and carries removals out through the one
 * lever that already exists (`revokeRoleFromUser`), by a different authority from the one that decided.
 *
 * Effective access is read through `loadCapabilities` (the function the platform enforces with), never
 * through role-admin's narrower `loadEffectiveCapabilities`. A restriction is not a grant: restrictions,
 * direct grants and position capabilities are shown, never itemised and never revoked here.
 * Nothing in this file grants or widens access. Migration: drizzle/9299_access_review.sql.
 */
import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { hasCapability, patternMatches } from '../../platform/auth/pattern';
import { loadCapabilities, loadOrgRestrictions, type OrgRestriction } from '../../platform/auth/session';
import { verifyServiceAuthorityInTx, type ServiceAuthorityContext } from '../../platform/auth/service-authority';
import { withTenant, type Tx } from '../../platform/db/client';
import { appUser, role, sodRule, userCapability, userRole } from '../../platform/tables/security';
import { revokeRoleFromUser, RoleAdminError, USER_ROLE_MAINTAIN_CAPABILITY } from '../platform/role-admin';
import { logAuditAccess } from './workspace';
import {
  ACCESS_REVIEW_DECISIONS, ACCESS_REVIEW_STATUSES, accessReview, accessReviewItem,
  type AccessReviewDecision, type AccessReviewStatus,
} from './schema';

export { ACCESS_REVIEW_DECISIONS, ACCESS_REVIEW_STATUSES };

export const AUDIT_ACCESS_REVIEW_CAPABILITY = 'AUDIT.ACCESS.REVIEW';
export const AUDIT_ACCESS_REVIEW_ROUTE = '/audit/access-review';
export const ACCESS_REVIEW_OBJECT_CLASS = 'access_review';

export class AccessReviewError extends Error {
  remedy?: string;
  readonly code: string;
  constructor(message: string, remedy?: string, code = 'ACCESS_REVIEW') {
    super(message);
    this.name = 'AccessReviewError';
    this.remedy = remedy;
    this.code = code;
  }
}

// ── views ───────────────────────────────────────────────────────────────────

export interface SodConflictView { code: string; description: string; severity: string; capabilityA: string; capabilityB: string }
export interface DirectGrantView { capabilityCode: string; reason: string; granter: string; validFrom: string; validTo: string | null }

/** Everything a reviewer needs to answer "is this still required?", as it stands now. */
export interface AccessPicture {
  capabilities: string[];
  restrictions: OrgRestriction[];
  directGrants: DirectGrantView[];
  sodConflicts: SodConflictView[];
}

export interface AccessReviewItemView {
  lineNumber: number;
  subjectUserId: string;
  subjectUsername: string | null;
  roleCode: string;
  roleName: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** Frozen when the review was raised. */
  effectiveCapabilities: string[];
  sodConflicts: SodConflictView[];
  decision: AccessReviewDecision;
  decidedByUserId: string | null;
  decidedByUsername: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  appliedAt: string | null;
  appliedByUserId: string | null;
  applyError: string | null;
}

export interface AccessReviewSubjectView {
  userId: string;
  username: string;
  fullName: string;
  isActive: boolean;
  isLocked: boolean;
  /** How many role assignments of this subject are items. Zero: authority held only by position or direct grant. */
  itemCount: number;
  /** Live, today — beside the frozen capabilities on each item. */
  live: AccessPicture;
}

export interface AccessReviewCounts { items: number; pending: number; certified: number; revoke: number; applied: number; failed: number }

export interface AccessReviewHeader {
  reviewId: string; code: string; name: string; reviewDate: string;
  roleFilter: string | null; capabilityFilter: string | null; userFilter: string | null;
  status: AccessReviewStatus; reason: string;
  completedByUserId: string | null; completedAt: string | null; createdBy: string; createdAt: string;
  counts: AccessReviewCounts;
}

export interface AccessReviewView extends AccessReviewHeader {
  items: AccessReviewItemView[];
  subjects: AccessReviewSubjectView[];
}

// ── helpers ─────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function requireAuthority(tx: Tx, client: string, authorization: ServiceAuthorityContext, capability: string): Promise<string> {
  const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, capability, { requirePlantScope: false });
  if (!verdict.ok) throw new AccessReviewError(verdict.refusal.message, verdict.refusal.remedy, 'ACCESS_REVIEW_AUTHORITY');
  return verdict.username;
}

/**
 * A live session holding one capability. Applying revocations is an administrator's act, and
 * `revokeRoleFromUser` judges its own, stricter authority; no Company Code reach is demanded here.
 */
async function requireLiveCapability(
  tx: Tx, client: string, authorization: ServiceAuthorityContext, capability: string,
): Promise<{ ok: true; username: string } | { ok: false }> {
  if (!authorization?.userId || !authorization.sessionId) return { ok: false };
  const rows = (await tx.execute(sql`
    select u.username from user_session s join app_user u on u.client = s.client and u.id = s.user_id
     where s.client = ${client} and s.id = ${authorization.sessionId} and s.user_id = ${authorization.userId}
       and s.revoked_at is null and s.expires_at > now() and u.is_active and not u.is_locked
  `)) as unknown as Array<{ username: string }>;
  if (!rows[0]) return { ok: false };
  const held = await loadCapabilities(tx, client, authorization.userId);
  return hasCapability(held, capability) ? { ok: true, username: rows[0].username } : { ok: false };
}

/** What the platform would let this user do today, with everything shown beside it. */
async function pictureOf(tx: Tx, client: string, userId: string, rules: SodConflictView[]): Promise<AccessPicture> {
  const capabilities = await loadCapabilities(tx, client, userId);
  const restrictions = await loadOrgRestrictions(tx, client, userId);
  const day = today();
  const grants = await tx.select().from(userCapability).where(and(
    eq(userCapability.client, client), eq(userCapability.userId, userId),
    sql`${userCapability.validFrom} <= ${day} and (${userCapability.validTo} is null or ${userCapability.validTo} >= ${day})`,
  )).orderBy(asc(userCapability.capabilityCode));
  return {
    capabilities,
    restrictions,
    directGrants: grants.map((g) => ({ capabilityCode: g.capabilityCode, reason: g.reason, granter: g.granter, validFrom: g.validFrom, validTo: g.validTo })),
    // Listed, not refused — a different question from role-admin's assertNoSodConflict, which throws on the first hit.
    sodConflicts: rules.filter((r) => hasCapability(capabilities, r.capabilityA) && hasCapability(capabilities, r.capabilityB)),
  };
}

async function loadSodRules(tx: Tx, client: string): Promise<SodConflictView[]> {
  const rows = await tx.select().from(sodRule).where(eq(sodRule.client, client)).orderBy(asc(sodRule.code));
  return rows.map((r) => ({ code: r.code, description: r.description, severity: r.severity, capabilityA: r.capabilityA, capabilityB: r.capabilityB }));
}

function parseJson<T>(text: string | null): T[] {
  if (!text) return [];
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; }
}

const emptyCounts = (): AccessReviewCounts => ({ items: 0, pending: 0, certified: 0, revoke: 0, applied: 0, failed: 0 });

async function countsFor(tx: Tx, client: string, reviewIds: string[]): Promise<Map<string, AccessReviewCounts>> {
  const out = new Map<string, AccessReviewCounts>();
  if (reviewIds.length === 0) return out;
  const rows = await tx.select().from(accessReviewItem).where(and(eq(accessReviewItem.client, client), inArray(accessReviewItem.reviewId, reviewIds)));
  for (const r of rows) {
    const c = out.get(r.reviewId) ?? emptyCounts();
    c.items += 1;
    if (r.decision === 'PENDING') c.pending += 1;
    if (r.decision === 'CERTIFIED') c.certified += 1;
    if (r.decision === 'REVOKE') c.revoke += 1;
    if (r.appliedAt) c.applied += 1;
    if (r.applyError && !r.appliedAt) c.failed += 1;
    out.set(r.reviewId, c);
  }
  return out;
}

function headerOf(r: typeof accessReview.$inferSelect, counts: AccessReviewCounts): AccessReviewHeader {
  return {
    reviewId: r.reviewId, code: r.code, name: r.name, reviewDate: r.reviewDate,
    roleFilter: r.roleFilter, capabilityFilter: r.capabilityFilter, userFilter: r.userFilter,
    status: r.status as AccessReviewStatus, reason: r.reason,
    completedByUserId: r.completedByUserId, completedAt: iso(r.completedAt), createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
    counts,
  };
}

async function loadReview(tx: Tx, client: string, reviewId: string, lock = false) {
  const q = tx.select().from(accessReview).where(and(eq(accessReview.client, client), eq(accessReview.reviewId, reviewId)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw new AccessReviewError('That access review does not exist.', 'Choose a review from the list.', 'ACCESS_REVIEW_NOT_FOUND');
  return row;
}

function requireOpen(status: string) {
  if (status !== 'OPEN') throw new AccessReviewError(`This review is ${status.toLowerCase()}, so it can no longer be changed.`, 'Raise a new review instead.', 'ACCESS_REVIEW_CLOSED');
}

// ── create ──────────────────────────────────────────────────────────────────

export interface CreateAccessReviewInput {
  client: string;
  authorization: ServiceAuthorityContext;
  code: string; name: string; reviewDate: string;
  roleFilter?: string; capabilityFilter?: string; userFilter?: string;
  reason: string;
  requestKey?: string;
}

export async function createAccessReview(input: CreateAccessReviewInput): Promise<AccessReviewView> {
  const code = input.code?.trim() ?? '';
  const name = input.name?.trim() ?? '';
  const reason = input.reason?.trim() ?? '';
  if (code.length < 1 || code.length > 40) throw new AccessReviewError('The review code is 1 to 40 characters.', 'For example UAR-2026Q4.', 'ACCESS_REVIEW_CODE');
  if (!name || name.length > 100) throw new AccessReviewError('Name the review, in up to 100 characters.', 'For example “Q4 access recertification”.', 'ACCESS_REVIEW_NAME');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reviewDate ?? '') || Number.isNaN(Date.parse(input.reviewDate))) {
    throw new AccessReviewError('The review date must be a date, YYYY-MM-DD.', 'Enter the day the review is held.', 'ACCESS_REVIEW_DATE');
  }
  if (input.reviewDate > today()) throw new AccessReviewError('The review date cannot be in the future.', 'Enter today or an earlier day.', 'ACCESS_REVIEW_DATE');
  if (!reason) throw new AccessReviewError('Say why this review is being raised.', 'A reason is part of the evidence.', 'ACCESS_REVIEW_REASON');
  const roleFilter = input.roleFilter?.trim() || null;
  const capabilityFilter = input.capabilityFilter?.trim() || null;
  const userFilter = input.userFilter?.trim() || null;
  const requestKey = input.requestKey?.trim() || null;

  const reviewId = await withTenant(input.client, async (tx) => {
    const username = await requireAuthority(tx, input.client, input.authorization, AUDIT_ACCESS_REVIEW_CAPABILITY);

    if (requestKey) {
      const [existing] = await tx.select({ id: accessReview.reviewId }).from(accessReview)
        .where(and(eq(accessReview.client, input.client), eq(accessReview.requestKey, requestKey)));
      if (existing) return existing.id; // a resubmission replays: nothing is re-run
    }

    // Population: active, unlocked users matching the filters.
    const users = await tx.select({ id: appUser.id, username: appUser.username }).from(appUser)
      .where(and(eq(appUser.client, input.client), eq(appUser.isActive, true), eq(appUser.isLocked, false), userFilter ? eq(appUser.id, userFilter) : undefined))
      .orderBy(asc(appUser.username));

    const now = new Date();
    const rules = await loadSodRules(tx, input.client);
    const lines: Array<typeof accessReviewItem.$inferInsert> = [];
    const matched: string[] = [];
    let lineNumber = 0;
    const id = randomUUID();

    for (const u of users) {
      const assignments = await tx.select({ roleCode: userRole.roleCode, roleName: role.name, validFrom: userRole.validFrom, validTo: userRole.validTo })
        .from(userRole).innerJoin(role, and(eq(role.client, userRole.client), eq(role.code, userRole.roleCode)))
        .where(and(
          eq(userRole.client, input.client), eq(userRole.userId, u.id),
          sql`${userRole.validFrom} <= ${now.toISOString()}::timestamptz and (${userRole.validTo} is null or ${userRole.validTo} >= ${now.toISOString()}::timestamptz)`,
        )).orderBy(asc(userRole.roleCode));
      if (roleFilter && !assignments.some((a) => a.roleCode === roleFilter)) continue;
      const picture = await pictureOf(tx, input.client, u.id, rules);
      if (capabilityFilter) {
        const wildcard = capabilityFilter.includes('*');
        const covered = hasCapability(picture.capabilities, capabilityFilter)
          || (wildcard && picture.capabilities.some((held) => patternMatches(capabilityFilter, held)));
        if (!covered) continue;
      }
      matched.push(u.id);
      for (const a of assignments) {
        lineNumber += 1;
        lines.push({
          client: input.client, reviewId: id, lineNumber, subjectUserId: u.id, roleCode: a.roleCode, roleName: a.roleName,
          validFrom: a.validFrom, validTo: a.validTo,
          effectiveCapabilities: JSON.stringify(picture.capabilities), sodConflicts: JSON.stringify(picture.sodConflicts),
          createdBy: username,
        });
      }
    }

    if (matched.length === 0) {
      throw new AccessReviewError('No active user matches that population.', 'Widen or clear the filters. A review of nobody is not a control.', 'ACCESS_REVIEW_EMPTY');
    }

    await tx.insert(accessReview).values({
      client: input.client, reviewId: id, code, name, reviewDate: input.reviewDate, roleFilter, capabilityFilter, userFilter,
      reason, requestKey, createdBy: username,
    });
    if (lines.length > 0) await tx.insert(accessReviewItem).values(lines);

    await recordChange(tx, {
      client: input.client, objectClass: ACCESS_REVIEW_OBJECT_CLASS, objectKey: id, changeType: 'CREATE', changedBy: username,
      transactionCode: AUDIT_ACCESS_REVIEW_CAPABILITY, reason,
      after: { code, name, reviewDate: input.reviewDate, roleFilter, capabilityFilter, userFilter, users: matched.length, items: lines.length },
    });
    return id;
  });
  return getAccessReview(input.client, reviewId);
}

// ── decide ──────────────────────────────────────────────────────────────────

export interface DecideAccessReviewItemInput {
  client: string; authorization: ServiceAuthorityContext;
  reviewId: string; lineNumber: number; decision: 'CERTIFIED' | 'REVOKE'; reason: string;
}

export async function decideAccessReviewItem(input: DecideAccessReviewItemInput): Promise<AccessReviewItemView> {
  return withTenant(input.client, async (tx) => {
    const username = await requireAuthority(tx, input.client, input.authorization, AUDIT_ACCESS_REVIEW_CAPABILITY);
    const review = await loadReview(tx, input.client, input.reviewId, true);
    requireOpen(review.status);
    const [item] = await tx.select().from(accessReviewItem).where(and(
      eq(accessReviewItem.client, input.client), eq(accessReviewItem.reviewId, input.reviewId), eq(accessReviewItem.lineNumber, input.lineNumber),
    )).for('update');
    if (!item) throw new AccessReviewError('That line does not exist in this review.', 'Choose a line from the review.', 'ACCESS_REVIEW_ITEM_NOT_FOUND');
    if (input.decision !== 'CERTIFIED' && input.decision !== 'REVOKE') throw new AccessReviewError('Decide CERTIFIED or REVOKE.', 'Choose one.', 'ACCESS_REVIEW_DECISION');

    if (item.subjectUserId === input.authorization.userId) {
      throw new AccessReviewError('You cannot decide on your own access.', 'Ask another reviewer to decide this line.', 'ACCESS_REVIEW_SELF');
    }
    const reason = input.reason?.trim() ?? '';
    if (!reason) throw new AccessReviewError('A reason is required for every decision.', 'Say why the access is, or is not, still required.', 'ACCESS_REVIEW_REASON');
    if (item.appliedAt) throw new AccessReviewError('This revocation has already been carried out.', 'It cannot be decided again.', 'ACCESS_REVIEW_APPLIED');

    const [subject] = await tx.select({ username: appUser.username, isActive: appUser.isActive, isLocked: appUser.isLocked }).from(appUser)
      .where(and(eq(appUser.client, input.client), eq(appUser.id, item.subjectUserId)));
    if (input.decision === 'CERTIFIED' && (!subject || !subject.isActive || subject.isLocked)) {
      throw new AccessReviewError(
        `User ${subject?.username ?? item.subjectUserId} is no longer active; their access cannot be certified. Revoke it instead.`,
        'Decide REVOKE for this line.', 'ACCESS_REVIEW_INACTIVE',
      );
    }

    const now = new Date();
    await tx.update(accessReviewItem).set({
      decision: input.decision, decidedByUserId: input.authorization.userId, decidedAt: now, decisionReason: reason,
      applyError: null, changedBy: username, changedAt: now,
    }).where(and(eq(accessReviewItem.client, input.client), eq(accessReviewItem.reviewId, input.reviewId), eq(accessReviewItem.lineNumber, input.lineNumber)));

    await recordChange(tx, {
      client: input.client, objectClass: ACCESS_REVIEW_OBJECT_CLASS, objectKey: `${input.reviewId}/${input.lineNumber}`, changeType: 'CHANGE',
      changedBy: username, transactionCode: AUDIT_ACCESS_REVIEW_CAPABILITY,
      before: { decision: item.decision, decisionReason: item.decisionReason },
      after: { decision: input.decision, decisionReason: reason, subject: subject?.username ?? item.subjectUserId, roleCode: item.roleCode },
      securityRelevantFields: ['decision'],
    });
    const items = await readItems(tx, input.client, input.reviewId, input.lineNumber);
    return items[0]!;
  });
}

// ── apply ───────────────────────────────────────────────────────────────────

export interface ApplyResult { applied: number; failed: Array<{ lineNumber: number; roleCode: string; reason: string }> }

/**
 * Carry out the revocations through `revokeRoleFromUser` — never a second revocation. That function opens its own
 * transaction (it locks the tenant and both users), so each item is applied there and then stamped in its own
 * transaction here; a refusal is recorded in `apply_error` and the batch goes on.
 */
export async function applyAccessReviewRevocations(input: {
  client: string; authorization: ServiceAuthorityContext; reviewId: string;
}): Promise<ApplyResult> {
  const { username, todo } = await withTenant(input.client, async (tx) => {
    const verdict = await requireLiveCapability(tx, input.client, input.authorization, USER_ROLE_MAINTAIN_CAPABILITY);
    if (!verdict.ok) {
      throw new AccessReviewError(
        `Applying revocations needs ${USER_ROLE_MAINTAIN_CAPABILITY}, which this session does not hold.`,
        'Record the decisions and ask an administrator to apply them.', 'ACCESS_REVIEW_AUTHORITY',
      );
    }
    const review = await loadReview(tx, input.client, input.reviewId);
    requireOpen(review.status);
    const rows = await tx.select().from(accessReviewItem).where(and(
      eq(accessReviewItem.client, input.client), eq(accessReviewItem.reviewId, input.reviewId),
      eq(accessReviewItem.decision, 'REVOKE'), sql`${accessReviewItem.appliedAt} is null`,
    )).orderBy(asc(accessReviewItem.lineNumber));
    return { username: verdict.username, todo: rows };
  });

  const result: ApplyResult = { applied: 0, failed: [] };
  for (const item of todo) {
    let failure: string | null = null;
    try {
      await revokeRoleFromUser({
        client: input.client, actor: { userId: input.authorization.userId, sessionId: input.authorization.sessionId },
        targetUserId: item.subjectUserId, roleCode: item.roleCode,
      });
    } catch (error) {
      if (!(error instanceof RoleAdminError)) throw error;
      failure = error.message;
    }
    await withTenant(input.client, async (tx) => {
      const now = new Date();
      await tx.update(accessReviewItem).set(failure
        ? { applyError: failure, changedBy: username, changedAt: now }
        : { appliedAt: now, appliedByUserId: input.authorization.userId, applyError: null, changedBy: username, changedAt: now },
      ).where(and(eq(accessReviewItem.client, input.client), eq(accessReviewItem.reviewId, input.reviewId), eq(accessReviewItem.lineNumber, item.lineNumber)));
    });
    if (failure) result.failed.push({ lineNumber: item.lineNumber, roleCode: item.roleCode, reason: failure });
    else result.applied += 1;
  }

  await withTenant(input.client, (tx) => recordChange(tx, {
    client: input.client, objectClass: ACCESS_REVIEW_OBJECT_CLASS, objectKey: input.reviewId, changeType: 'CHANGE', changedBy: username,
    transactionCode: USER_ROLE_MAINTAIN_CAPABILITY,
    before: { applied: 0, failed: 0 }, after: { applied: result.applied, failed: result.failed.length },
    securityRelevantFields: ['applied', 'failed'],
  }));
  return result;
}

// ── complete / cancel ───────────────────────────────────────────────────────

export async function completeAccessReview(input: {
  client: string; authorization: ServiceAuthorityContext; reviewId: string; reason?: string;
}): Promise<AccessReviewHeader> {
  return withTenant(input.client, async (tx) => {
    const username = await requireAuthority(tx, input.client, input.authorization, AUDIT_ACCESS_REVIEW_CAPABILITY);
    const review = await loadReview(tx, input.client, input.reviewId, true);
    requireOpen(review.status);
    const counts = (await countsFor(tx, input.client, [input.reviewId])).get(input.reviewId) ?? emptyCounts();
    if (counts.pending > 0) {
      throw new AccessReviewError(`${counts.pending} item${counts.pending === 1 ? ' is' : 's are'} still undecided.`, 'Decide every line before completing the review.', 'ACCESS_REVIEW_PENDING');
    }
    const unapplied = counts.revoke - counts.applied - counts.failed;
    if (unapplied > 0) {
      throw new AccessReviewError(
        `${unapplied} revocation${unapplied === 1 ? ' has' : 's have'} not been carried out.`,
        'Ask an administrator to apply the revocations first. A refused one is on the record and does not block completion.', 'ACCESS_REVIEW_UNAPPLIED',
      );
    }
    const now = new Date();
    await tx.update(accessReview).set({ status: 'COMPLETED', completedByUserId: input.authorization.userId, completedAt: now, changedBy: username, changedAt: now })
      .where(and(eq(accessReview.client, input.client), eq(accessReview.reviewId, input.reviewId)));
    await recordChange(tx, {
      client: input.client, objectClass: ACCESS_REVIEW_OBJECT_CLASS, objectKey: input.reviewId, changeType: 'CHANGE', changedBy: username,
      transactionCode: AUDIT_ACCESS_REVIEW_CAPABILITY, reason: input.reason?.trim() || undefined,
      before: { status: 'OPEN' }, after: { status: 'COMPLETED', items: counts.items, certified: counts.certified, revoked: counts.revoke, applied: counts.applied, failed: counts.failed },
      securityRelevantFields: ['status'],
    });
    return headerOf({ ...review, status: 'COMPLETED', completedByUserId: input.authorization.userId, completedAt: now }, counts);
  });
}

export async function cancelAccessReview(input: {
  client: string; authorization: ServiceAuthorityContext; reviewId: string; reason: string;
}): Promise<AccessReviewHeader> {
  const reason = input.reason?.trim() ?? '';
  if (!reason) throw new AccessReviewError('A reason is required to cancel a review.', 'Say why it is being cancelled.', 'ACCESS_REVIEW_REASON');
  return withTenant(input.client, async (tx) => {
    const username = await requireAuthority(tx, input.client, input.authorization, AUDIT_ACCESS_REVIEW_CAPABILITY);
    const review = await loadReview(tx, input.client, input.reviewId, true);
    if (review.status === 'COMPLETED') throw new AccessReviewError('A completed review is evidence and cannot be cancelled.', 'Raise a new review if one is needed.', 'ACCESS_REVIEW_CLOSED');
    requireOpen(review.status);
    const now = new Date();
    await tx.update(accessReview).set({ status: 'CANCELLED', changedBy: username, changedAt: now })
      .where(and(eq(accessReview.client, input.client), eq(accessReview.reviewId, input.reviewId)));
    await recordChange(tx, {
      client: input.client, objectClass: ACCESS_REVIEW_OBJECT_CLASS, objectKey: input.reviewId, changeType: 'CHANGE', changedBy: username,
      transactionCode: AUDIT_ACCESS_REVIEW_CAPABILITY, reason, before: { status: 'OPEN' }, after: { status: 'CANCELLED' },
      securityRelevantFields: ['status'],
    });
    const counts = (await countsFor(tx, input.client, [input.reviewId])).get(input.reviewId) ?? emptyCounts();
    return headerOf({ ...review, status: 'CANCELLED' }, counts);
  });
}

// ── reads ───────────────────────────────────────────────────────────────────

async function readItems(tx: Tx, client: string, reviewId: string, onlyLine?: number): Promise<AccessReviewItemView[]> {
  const rows = await tx.select().from(accessReviewItem).where(and(
    eq(accessReviewItem.client, client), eq(accessReviewItem.reviewId, reviewId),
    onlyLine === undefined ? undefined : eq(accessReviewItem.lineNumber, onlyLine),
  )).orderBy(asc(accessReviewItem.lineNumber));
  const ids = [...new Set(rows.flatMap((r) => [r.subjectUserId, r.decidedByUserId].filter((v): v is string => !!v)))];
  const names = new Map<string, string>();
  if (ids.length) for (const u of await tx.select({ id: appUser.id, username: appUser.username }).from(appUser).where(and(eq(appUser.client, client), inArray(appUser.id, ids)))) names.set(u.id, u.username);
  return rows.map((r) => ({
    lineNumber: r.lineNumber, subjectUserId: r.subjectUserId, subjectUsername: names.get(r.subjectUserId) ?? null,
    roleCode: r.roleCode, roleName: r.roleName, validFrom: iso(r.validFrom), validTo: iso(r.validTo),
    effectiveCapabilities: parseJson<string>(r.effectiveCapabilities), sodConflicts: parseJson<SodConflictView>(r.sodConflicts),
    decision: r.decision as AccessReviewDecision, decidedByUserId: r.decidedByUserId,
    decidedByUsername: r.decidedByUserId ? names.get(r.decidedByUserId) ?? null : null,
    decidedAt: iso(r.decidedAt), decisionReason: r.decisionReason, appliedAt: iso(r.appliedAt),
    appliedByUserId: r.appliedByUserId, applyError: r.applyError,
  }));
}

/**
 * The review, its frozen items, and for every subject the live picture beside them. Subjects are the people with
 * items plus whoever matches the stored filters today — so someone whose authority comes only from a position or a
 * direct grant is visible here with their effective capabilities, though they have no item.
 */
export async function getAccessReview(client: string, reviewId: string): Promise<AccessReviewView> {
  return withTenant(client, async (tx) => {
    const review = await loadReview(tx, client, reviewId);
    const counts = (await countsFor(tx, client, [reviewId])).get(reviewId) ?? emptyCounts();
    const items = await readItems(tx, client, reviewId);
    const rules = await loadSodRules(tx, client);

    const ids = new Set(items.map((i) => i.subjectUserId));
    const candidates = await tx.select({ id: appUser.id, username: appUser.username, fullName: appUser.fullName, isActive: appUser.isActive, isLocked: appUser.isLocked })
      .from(appUser).where(and(eq(appUser.client, client), review.userFilter ? eq(appUser.id, review.userFilter) : undefined)).orderBy(asc(appUser.username));
    const subjects: AccessReviewSubjectView[] = [];
    for (const u of candidates) {
      const hasItems = ids.has(u.id);
      if (!hasItems && (!u.isActive || u.isLocked)) continue;
      const live = await pictureOf(tx, client, u.id, rules);
      if (!hasItems) {
        if (review.roleFilter) {
          const [held] = await tx.select({ c: userRole.roleCode }).from(userRole).where(and(eq(userRole.client, client), eq(userRole.userId, u.id), eq(userRole.roleCode, review.roleFilter)));
          if (!held) continue;
        }
        if (review.capabilityFilter) {
          const f = review.capabilityFilter;
          if (!(hasCapability(live.capabilities, f) || (f.includes('*') && live.capabilities.some((h) => patternMatches(f, h))))) continue;
        }
      }
      subjects.push({ userId: u.id, username: u.username, fullName: u.fullName, isActive: u.isActive, isLocked: u.isLocked, itemCount: items.filter((i) => i.subjectUserId === u.id).length, live });
    }
    return { ...headerOf(review, counts), items, subjects };
  });
}

export async function listAccessReviews(client: string, filter: { status?: AccessReviewStatus } = {}): Promise<AccessReviewHeader[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(accessReview)
      .where(and(eq(accessReview.client, client), filter.status ? eq(accessReview.status, filter.status) : undefined))
      .orderBy(desc(accessReview.createdAt)).limit(100);
    const counts = await countsFor(tx, client, rows.map((r) => r.reviewId));
    return rows.map((r) => headerOf(r, counts.get(r.reviewId) ?? emptyCounts()));
  });
}

/** Opening the screen is itself logged, as the rest of the audit module does. */
export async function recordAccessReviewView(entry: { client: string; userId: string; username: string; reviewId?: string }): Promise<void> {
  await withTenant(entry.client, (tx) => logAuditAccess(tx, {
    client: entry.client, userId: entry.userId, username: entry.username, eventType: 'READ', route: AUDIT_ACCESS_REVIEW_ROUTE,
    transactionCode: AUDIT_ACCESS_REVIEW_CAPABILITY, objectKey: entry.reviewId ?? null,
    detail: entry.reviewId ? 'Opened an access review' : 'Opened the access review list',
  }));
}
