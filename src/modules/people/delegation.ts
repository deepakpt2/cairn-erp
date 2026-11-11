/**
 * Delegation — CAIRN.md §16.6, addendum §1. Phase 5.
 *
 * A delegation is an agreement, not a grant. Nothing here copies a capability:
 * the authority is derived from the delegator at the moment of every check (see
 * `effectiveGrants` in platform/auth/authority.ts). That single decision is what
 * makes the rest honest — a delegation cannot outlive the authority it came
 * from, and revocation takes effect with no sweep.
 *
 * Three ideas are kept strictly apart, because collapsing them is what makes
 * delegation systems unanswerable later:
 *
 *   * **created_by**  — who put it in the system
 *   * **approvals**   — the chain of command authorised it
 *   * **acceptances** — the two parties agreed to it
 *
 * A delegation is ACTIVE only when both acceptances **and** every required
 * approval are present.
 *
 * The governing rule: **delegation transfers the capacity to act, never control
 * of the delegation; the delegator always retains revocation at every level.**
 */

import { and, eq, or } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { auditAccessLog } from '../../platform/tables/security';
import { LEVEL_OF_KEY, type ScopeMap } from '../../platform/auth/authority';
import { superiorOfUser, type Superior } from './chain-of-command';
import { delegation, delegationApproval, delegationScope } from './schema';
import {
  approvalsSatisfied,
  effectiveStatus,
  isLive,
  isTerminal,
  type ApprovalSide,
  type ApprovalStatus,
  type DelegationStatus,
} from './delegation-status';

// Re-exported so a caller needs one import, not two.
export {
  approvalsSatisfied,
  effectiveStatus,
  isLive,
  isTerminal,
  type ApprovalSide,
  type ApprovalStatus,
  type DelegationStatus,
} from './delegation-status';

// ── Types ──────────────────────────────────────────────────────────────────

export type InitiatorKind = 'SUPERIOR' | 'SELF';

export class DelegationError extends Error {
  readonly code: string;
  readonly remedy: string | null;

  constructor(code: string, message: string, remedy: string | null = null) {
    super(message);
    this.name = 'DelegationError';
    this.code = code;
    this.remedy = remedy;
  }
}

export interface ApprovalView {
  approvalId: string;
  side: ApprovalSide;
  approverUserId: string | null;
  approverOrgUnit: string | null;
  status: ApprovalStatus;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface DelegationView {
  delegationId: string;
  delegatorUserId: string;
  delegateUserId: string;
  positionCode: string | null;
  validFrom: string;
  validTo: string | null;
  /** The recorded status. */
  status: DelegationStatus;
  /** What it means today. EXPIRED is never written by a job. */
  effectiveStatus: DelegationStatus;
  initiatorKind: InitiatorKind;
  reason: string;
  delegatorAcceptedAt: string | null;
  delegateAcceptedAt: string | null;
  refusedBy: string | null;
  refusalReason: string | null;
  scope: ScopeMap;
  approvals: ApprovalView[];
  /** True when both acceptances and every required approval are present. */
  isLive: boolean;
}

export interface CreateDelegationInput {
  delegatorUserId: string;
  delegateUserId: string;
  positionCode?: string | null;
  validFrom: string;
  validTo?: string | null;
  reason: string;
  scope?: ScopeMap;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function loadRow(tx: Tx, client: string, delegationId: string) {
  const rows = await tx
    .select()
    .from(delegation)
    .where(and(eq(delegation.client, client), eq(delegation.delegationId, delegationId)));
  if (rows.length === 0) {
    throw new DelegationError('DELEGATION_NOT_FOUND', 'That delegation does not exist.', null);
  }
  return rows[0]!;
}

async function logDelegation(
  tx: Tx,
  client: string,
  input: { userId: string; delegationId: string; eventType: string; detail: string },
): Promise<void> {
  await tx.insert(auditAccessLog).values({
    id: newId('log'),
    client,
    userId: input.userId,
    eventType: input.eventType,
    objectType: 'DELEGATION',
    objectKey: input.delegationId,
    detail: input.detail,
    delegationId: input.delegationId,
  });
}

// ── The three creation flows ───────────────────────────────────────────────

/**
 * Work out who must authorise a delegation, before it is written.
 *
 * The rule from the design:
 *
 *     superiorOf(delegator) === superiorOf(delegatee)  ->  one approval
 *     otherwise                                        ->  both sides
 *
 * A party with no position at all is `UNATTACHED`, and that is refused rather
 * than waved through. The chain of command is what makes a delegation
 * answerable; a hole in it means nobody is competent to authorise this, and
 * guessing would leave an authorisation with no author.
 */
export async function approversFor(
  tx: Tx,
  client: string,
  delegatorUserId: string,
  delegateUserId: string,
  on?: string,
): Promise<{ side: ApprovalSide; approvers: Superior[] }[]> {
  const [delegatorSide, delegateSide] = await Promise.all([
    superiorOfUser(tx, client, delegatorUserId, on),
    superiorOfUser(tx, client, delegateUserId, on),
  ]);

  const hole = [
    { party: 'delegator', supers: delegatorSide },
    { party: 'delegatee', supers: delegateSide },
  ].find((p) => p.supers.some((s) => s.kind === 'UNATTACHED'));

  if (hole) {
    throw new DelegationError(
      'DELEGATION_CHAIN_HOLE',
      `The ${hole.party} holds no position, so the chain of command above them is unknown.`,
      'Assign them a position first. Delegation is authorised by the reporting line, and without one there is nobody to authorise it.',
    );
  }

  return [
    { side: 'DELEGATOR' as ApprovalSide, approvers: delegatorSide },
    { side: 'DELEGATEE' as ApprovalSide, approvers: delegateSide },
  ];
}

/**
 * Create a delegation.
 *
 * `initiatorKind` decides which of the three flows this is, and therefore whose
 * acceptance is already on the table:
 *
 *   * **SUPERIOR** (flow 1) — a superior in the chain creates it directly,
 *     naming both parties. Neither party has accepted yet; both must.
 *   * **SELF** (flows 2 and 3) — the delegator proposes it. Proposing is
 *     accepting, so the delegator's acceptance is recorded at once and only the
 *     delegate's is outstanding.
 *
 * How many approvals are needed falls out of `approversFor`, not of the flow:
 * one superior, or both when the parties sit under different ones.
 */
export async function createDelegation(
  tx: Tx,
  client: string,
  input: CreateDelegationInput & { initiatorKind: InitiatorKind; actorUserId: string },
): Promise<{ delegationId: string; approvals: ApprovalView[]; status: DelegationStatus }> {
  if (input.delegatorUserId === input.delegateUserId) {
    throw new DelegationError('DELEGATION_SELF', 'A person cannot delegate to themselves.', 'Name a different delegate.');
  }
  if (!input.reason || input.reason.trim().length < 3) {
    throw new DelegationError(
      'DELEGATION_REASON',
      'A delegation needs a reason.',
      'Say why the cover is being given. It is the first thing asked when the record is reviewed.',
    );
  }
  if (input.validTo && input.validTo < input.validFrom) {
    throw new DelegationError('DELEGATION_SPAN', 'A delegation cannot end before it starts.', null);
  }

  const sides = await approversFor(tx, client, input.delegatorUserId, input.delegateUserId);
  const delegationId = newId('dlg');

  // Proposing is accepting. Only the delegator can propose, so a SELF
  // delegation starts with one of its two acceptances already given.
  const delegatorAcceptedAt =
    input.initiatorKind === 'SELF' && input.actorUserId === input.delegatorUserId ? new Date() : null;

  await tx.insert(delegation).values({
    client,
    delegationId,
    delegatorUserId: input.delegatorUserId,
    delegateUserId: input.delegateUserId,
    positionCode: input.positionCode ?? null,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    status: 'PENDING_ACCEPTANCE',
    initiatorKind: input.initiatorKind,
    reason: input.reason.trim(),
    delegatorAcceptedAt,
    createdBy: input.actorUserId,
  });

  const approvals: ApprovalView[] = [];
  for (const side of sides) {
    for (const approver of side.approvers) {
      const approvalId = newId('dap');
      const approverUserId = approver.kind === 'USER' ? approver.holder.userId : null;
      const approverOrgUnit = approver.kind === 'ORG_UNIT' ? approver.orgUnitCode : null;

      // An org unit has no holder, so it cannot act. Recording it as already
      // approved is the apex rule: the top of the chain authorises itself.
      //
      // The delegator owes the same answer. When they are the superior above
      // the delegatee — the ordinary case, since people delegate to their own
      // reports — the chain of command over the delegatee *is* them, and
      // proposing was them exercising it. Asking them to approve their own
      // proposal would be a step that can only ever say yes.
      //
      // It is auto-satisfied only when they have actually accepted, which is
      // what makes the difference: a superior-created delegation (flow 1) has
      // not been accepted by the delegator yet, so their approval stays live.
      const alreadyAccepted = delegatorAcceptedAt !== null;
      const decided =
        approver.kind === 'ORG_UNIT' || (alreadyAccepted && approverUserId === input.delegatorUserId);
      const decisionNote = decided
        ? approver.kind === 'ORG_UNIT'
          ? 'The reporting line ends in an org unit, which has no holder. The apex authorises itself.'
          : 'The delegator is the superior above the delegatee. Proposing was them authorising it.'
        : null;

      await tx.insert(delegationApproval).values({
        client,
        approvalId,
        delegationId,
        side: side.side,
        approverUserId,
        approverOrgUnit,
        status: decided ? 'APPROVED' : 'PENDING',
        decidedAt: decided ? new Date() : null,
        decisionNote,
        createdBy: input.actorUserId,
      });

      approvals.push({
        approvalId,
        side: side.side,
        approverUserId,
        approverOrgUnit,
        status: decided ? 'APPROVED' : 'PENDING',
        decidedAt: null,
        decisionNote: null,
      });
    }
  }

  for (const [level, values] of Object.entries(input.scope ?? {})) {
    const scopeType = LEVEL_OF_KEY[level as keyof typeof LEVEL_OF_KEY];
    if (!scopeType) continue;
    for (const value of values ?? []) {
      await tx.insert(delegationScope).values({ client, delegationId, scopeType, scopeValue: value });
    }
  }

  await logDelegation(tx, client, {
    userId: input.actorUserId,
    delegationId,
    eventType: 'CONFIG_CHANGE',
    detail: `Delegation created (${input.initiatorKind}) ${input.delegatorUserId} → ${input.delegateUserId}: ${input.reason}`,
  });

  return { delegationId, approvals, status: await refreshStatus(tx, client, delegationId) };
}

// ── Acceptance ─────────────────────────────────────────────────────────────

/**
 * Record a party's acceptance or refusal.
 *
 * Acceptance by both parties is required in every flow. Refusal by either ends
 * it, recording who and why — a delegation that was declined is as much a fact
 * as one that was agreed.
 */
export async function respondToDelegation(
  tx: Tx,
  client: string,
  delegationId: string,
  userId: string,
  accept: boolean,
  note?: string,
): Promise<DelegationStatus> {
  const row = await loadRow(tx, client, delegationId);

  const isDelegator = row.delegatorUserId === userId;
  const isDelegate = row.delegateUserId === userId;
  if (!isDelegator && !isDelegate) {
    throw new DelegationError('DELEGATION_NOT_A_PARTY', 'Only the two parties may accept or refuse a delegation.', null);
  }

  const status = effectiveStatus(row);
  if (status !== 'PENDING_ACCEPTANCE') {
    throw new DelegationError('DELEGATION_NOT_PENDING', `This delegation is ${status}, so there is nothing to accept.`, null);
  }

  if (!accept) {
    await tx
      .update(delegation)
      .set({
        status: 'REFUSED',
        refusedAt: new Date(),
        refusedBy: userId,
        refusalReason: note?.trim() ?? null,
        changedBy: userId,
        changedAt: new Date(),
      })
      .where(and(eq(delegation.client, client), eq(delegation.delegationId, delegationId)));

    await logDelegation(tx, client, {
      userId,
      delegationId,
      eventType: 'CONFIG_CHANGE',
      detail: `${isDelegator ? 'Delegator' : 'Delegate'} refused the delegation${note ? `: ${note}` : '.'}`,
    });
    return 'REFUSED';
  }

  await tx
    .update(delegation)
    .set({
      ...(isDelegator ? { delegatorAcceptedAt: new Date() } : { delegateAcceptedAt: new Date() }),
      changedBy: userId,
      changedAt: new Date(),
    })
    .where(and(eq(delegation.client, client), eq(delegation.delegationId, delegationId)));

  await logDelegation(tx, client, {
    userId,
    delegationId,
    eventType: 'CONFIG_CHANGE',
    detail: `${isDelegator ? 'Delegator' : 'Delegate'} accepted the delegation.`,
  });

  return refreshStatus(tx, client, delegationId);
}

// ── Approval ───────────────────────────────────────────────────────────────

/**
 * Record a superior's decision.
 *
 * Deciding is per side, and a superior who appears on both sides — the ordinary
 * case when both parties report to the same person — needs only decide once.
 */
export async function decideApproval(
  tx: Tx,
  client: string,
  delegationId: string,
  approverUserId: string,
  approve: boolean,
  note?: string,
): Promise<DelegationStatus> {
  const row = await loadRow(tx, client, delegationId);
  if (effectiveStatus(row) !== 'PENDING_ACCEPTANCE') {
    throw new DelegationError('DELEGATION_NOT_PENDING', 'This delegation is no longer awaiting approval.', null);
  }

  const mine = await tx
    .select()
    .from(delegationApproval)
    .where(
      and(
        eq(delegationApproval.client, client),
        eq(delegationApproval.delegationId, delegationId),
        eq(delegationApproval.approverUserId, approverUserId),
      ),
    );

  if (mine.length === 0) {
    throw new DelegationError(
      'DELEGATION_NOT_AN_APPROVER',
      'You are not asked to approve this delegation.',
      'Approval comes from the reporting line above one of the two parties.',
    );
  }

  for (const approval of mine) {
    await tx
      .update(delegationApproval)
      .set({
        status: approve ? 'APPROVED' : 'REFUSED',
        decidedAt: new Date(),
        decisionNote: note?.trim() ?? null,
        changedBy: approverUserId,
        changedAt: new Date(),
      })
      .where(and(eq(delegationApproval.client, client), eq(delegationApproval.approvalId, approval.approvalId)));
  }

  await logDelegation(tx, client, {
    userId: approverUserId,
    delegationId,
    eventType: 'CONFIG_CHANGE',
    detail: `${approve ? 'Approved' : 'Refused'} the delegation${note ? `: ${note}` : '.'}`,
  });

  if (!approve) {
    await tx
      .update(delegation)
      .set({
        status: 'REFUSED',
        refusedAt: new Date(),
        refusedBy: approverUserId,
        refusalReason: note?.trim() ?? null,
      })
      .where(and(eq(delegation.client, client), eq(delegation.delegationId, delegationId)));
    return 'REFUSED';
  }

  return refreshStatus(tx, client, delegationId);
}

// ── Ending it ──────────────────────────────────────────────────────────────

/**
 * Revoke — the delegator's, always.
 *
 * The governing rule: delegation transfers the capacity to act, never control of
 * the delegation. Whoever delegated can take it back, at any time, for any
 * reason, and no approval is needed to do so.
 */
export async function revokeDelegation(
  tx: Tx,
  client: string,
  delegationId: string,
  actorUserId: string,
  reason: string,
): Promise<DelegationStatus> {
  const row = await loadRow(tx, client, delegationId);

  if (row.delegatorUserId !== actorUserId) {
    throw new DelegationError(
      'DELEGATION_NOT_REVOKABLE',
      'Only the delegator may revoke a delegation.',
      'The delegator keeps revocation at every level. A delegate may not end, extend or pass on what they were given.',
    );
  }
  if (isTerminal(effectiveStatus(row))) {
    throw new DelegationError('DELEGATION_ALREADY_ENDED', 'This delegation has already ended.', null);
  }

  await tx
    .update(delegation)
    .set({
      status: 'REVOKED',
      revokedAt: new Date(),
      revokedBy: actorUserId,
      revocationReason: reason?.trim() ?? null,
      changedBy: actorUserId,
      changedAt: new Date(),
    })
    .where(and(eq(delegation.client, client), eq(delegation.delegationId, delegationId)));

  await logDelegation(tx, client, {
    userId: actorUserId,
    delegationId,
    eventType: 'CONFIG_CHANGE',
    detail: `Delegation revoked${reason ? `: ${reason}` : '.'}`,
  });

  return 'REVOKED';
}

/**
 * Close — by either party, or by a superior in the chain.
 *
 * The design's requirement for open-ended delegations: they must be closable,
 * because nothing is irrevocable. Closing is how an open-ended delegation ends
 * without anyone being blamed for it.
 */
export async function closeDelegation(
  tx: Tx,
  client: string,
  delegationId: string,
  actorUserId: string,
  reason?: string,
): Promise<DelegationStatus> {
  const row = await loadRow(tx, client, delegationId);
  if (isTerminal(effectiveStatus(row))) {
    throw new DelegationError('DELEGATION_ALREADY_ENDED', 'This delegation has already ended.', null);
  }

  const isParty = row.delegatorUserId === actorUserId || row.delegateUserId === actorUserId;
  const rows = await tx
    .select({ id: delegationApproval.approvalId })
    .from(delegationApproval)
    .where(
      and(
        eq(delegationApproval.client, client),
        eq(delegationApproval.delegationId, delegationId),
        eq(delegationApproval.approverUserId, actorUserId),
      ),
    );
  if (!isParty && rows.length === 0) {
    throw new DelegationError(
      'DELEGATION_NOT_CLOSABLE',
      'Only a party to the delegation, or a superior in the chain above them, may close it.',
      null,
    );
  }

  await tx
    .update(delegation)
    .set({
      status: 'CLOSED',
      closedAt: new Date(),
      closedBy: actorUserId,
      closureReason: reason?.trim() ?? null,
      changedBy: actorUserId,
      changedAt: new Date(),
    })
    .where(and(eq(delegation.client, client), eq(delegation.delegationId, delegationId)));

  await logDelegation(tx, client, {
    userId: actorUserId,
    delegationId,
    eventType: 'CONFIG_CHANGE',
    detail: `Delegation closed${reason ? `: ${reason}` : '.'}`,
  });

  return 'CLOSED';
}

/**
 * A delegate may act under a delegation, and nothing else.
 *
 * They cannot extend it, re-delegate it, or revoke it. Those belong to the
 * delegator and to the chain that authorised it. This is the guard the
 * "capacity to act, never control of the delegation" rule reduces to in code.
 */
export function assertMayControlDelegation(isDelegator: boolean, action: string): void {
  if (isDelegator) return;
  throw new DelegationError(
    'DELEGATION_NOT_TRANSFERABLE',
    `A delegate may not ${action} a delegation.`,
    `Only the delegator may ${action}. Delegation passes the capacity to act, not control of the delegation.`,
  );
}

// ── The scope rule ─────────────────────────────────────────────────────────

/**
 * May this person authorise a delegation spanning these places?
 *
 *     permitted = authoriser's scope ⊇ (source scope ∪ target scope)
 *
 * The delegate's own scope is **not** the constraint — that is the point of
 * delegation, it is how a narrow user is temporarily given wider reach. The
 * constraint is on the person authorising it, who must themselves be competent
 * to authorise both ends.
 */
export function scopeCovers(
  authoriser: ScopeMap,
  source: ScopeMap,
  target: ScopeMap,
): { ok: boolean; uncovered: string[] } {
  const uncovered: string[] = [];

  for (const [level, values] of Object.entries({ ...source, ...target })) {
    const allowed = authoriser[level as keyof ScopeMap];
    // Nothing named on this level means the authoriser is unrestricted here.
    if (!allowed || allowed.length === 0) continue;
    for (const value of values ?? []) {
      if (!allowed.includes(value)) uncovered.push(`${level}=${value}`);
    }
  }

  return { ok: uncovered.length === 0, uncovered };
}

// ── Internal ───────────────────────────────────────────────────────────────

/**
 * Recompute the status from what is actually present.
 *
 * Nothing here trusts a caller to move the state machine correctly: ACTIVE
 * means both acceptances are in and every side that has an approver has
 * approved. It is reached the same way no matter which flow got here.
 */
export async function refreshStatus(tx: Tx, client: string, delegationId: string): Promise<DelegationStatus> {
  const row = await loadRow(tx, client, delegationId);
  if (isTerminal(effectiveStatus(row))) return effectiveStatus(row);

  const approvals = await tx
    .select({ side: delegationApproval.side, status: delegationApproval.status })
    .from(delegationApproval)
    .where(and(eq(delegationApproval.client, client), eq(delegationApproval.delegationId, delegationId)));

  const ready =
    Boolean(row.delegatorAcceptedAt) && Boolean(row.delegateAcceptedAt) && approvalsSatisfied(approvals).satisfied;

  if (ready && row.status !== 'ACTIVE') {
    await tx
      .update(delegation)
      .set({ status: 'ACTIVE', changedAt: new Date() })
      .where(and(eq(delegation.client, client), eq(delegation.delegationId, delegationId)));
    return 'ACTIVE';
  }

  return row.status as DelegationStatus;
}

// ── Reading ────────────────────────────────────────────────────────────────

/**
 * One delegation with its approvals and scope, as a screen reads it.
 */
export async function loadDelegation(tx: Tx, client: string, delegationId: string): Promise<DelegationView> {
  const row = await loadRow(tx, client, delegationId);

  const [approvals, scopes] = await Promise.all([
    tx
      .select()
      .from(delegationApproval)
      .where(and(eq(delegationApproval.client, client), eq(delegationApproval.delegationId, delegationId))),
    tx
      .select()
      .from(delegationScope)
      .where(and(eq(delegationScope.client, client), eq(delegationScope.delegationId, delegationId))),
  ]);

  const scope: ScopeMap = {};
  for (const s of scopes) {
    const key = Object.keys(LEVEL_OF_KEY).find((k) => LEVEL_OF_KEY[k as keyof typeof LEVEL_OF_KEY] === s.scopeType);
    if (!key) continue;
    const list = scope[key as keyof ScopeMap] ?? [];
    list.push(s.scopeValue);
    scope[key as keyof ScopeMap] = list;
  }

  return {
    delegationId: row.delegationId,
    delegatorUserId: row.delegatorUserId,
    delegateUserId: row.delegateUserId,
    positionCode: row.positionCode,
    validFrom: row.validFrom,
    validTo: row.validTo,
    status: row.status as DelegationStatus,
    effectiveStatus: effectiveStatus(row),
    initiatorKind: row.initiatorKind as InitiatorKind,
    reason: row.reason,
    delegatorAcceptedAt: row.delegatorAcceptedAt?.toISOString() ?? null,
    delegateAcceptedAt: row.delegateAcceptedAt?.toISOString() ?? null,
    refusedBy: row.refusedBy,
    refusalReason: row.refusalReason,
    scope,
    approvals: approvals.map((a) => ({
      approvalId: a.approvalId,
      side: a.side as ApprovalSide,
      approverUserId: a.approverUserId,
      approverOrgUnit: a.approverOrgUnit,
      status: a.status as ApprovalStatus,
      decidedAt: a.decidedAt?.toISOString() ?? null,
      decisionNote: a.decisionNote,
    })),
    isLive: isLive(row, approvals),
  };
}

/**
 * Every delegation a person is part of, newest first.
 *
 * Used by the three panels on the authority chart: what was delegated to them,
 * what they delegated away, and what is waiting on them.
 */
export async function delegationsForUser(tx: Tx, client: string, userId: string): Promise<DelegationView[]> {
  const rows = await tx
    .select()
    .from(delegation)
    .where(
      and(
        eq(delegation.client, client),
        or(eq(delegation.delegatorUserId, userId), eq(delegation.delegateUserId, userId)),
      ),
    );

  return Promise.all(rows.map((r) => loadDelegation(tx, client, r.delegationId)));
}
