/**
 * The pure half of delegation: status, liveness, and whether the chain of
 * command has authorised something.
 *
 * This file imports nothing from the authority resolver on purpose. The
 * resolver needs `isLive` to build a delegate's grants, and the delegation
 * service needs authority's scope vocabulary — so these predicates live in a
 * leaf both can import without a cycle between them.
 *
 * Nothing here touches the database. That is what makes the resolver able to
 * reuse it rather than re-deriving the rule.
 */

export type DelegationStatus =
  | 'DRAFT'
  | 'PENDING_ACCEPTANCE'
  | 'ACTIVE'
  | 'REFUSED'
  | 'EXPIRED'
  | 'CLOSED'
  | 'REVOKED';

export type ApprovalSide = 'DELEGATOR' | 'DELEGATEE';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REFUSED';

const TERMINAL: DelegationStatus[] = ['REFUSED', 'CLOSED', 'REVOKED'];

export function isTerminal(status: DelegationStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * What a delegation means on a given day, rather than what its status column
 * says.
 *
 * `EXPIRED` is derived, never written: the design's own words are that a row
 * past its end date simply stops matching. Writing it would need a job, and the
 * job would be wrong the moment somebody backdated something.
 */
export function effectiveStatus(
  row: { status: string; validFrom: string; validTo: string | null },
  on: string = today(),
): DelegationStatus {
  const status = row.status as DelegationStatus;
  if (isTerminal(status)) return status;
  if (status === 'ACTIVE' && row.validTo && row.validTo < on) return 'EXPIRED';
  return status;
}

/**
 * Whether the chain of command has authorised it.
 *
 * A side with no rows needs nothing — the reporting line ended in an org unit,
 * which has no holder. That is the apex, and the apex is self-approving.
 *
 * Within a side, any one approval will do: a person holding two positions has
 * two superiors, and the design says approval can come from either.
 */
export function approvalsSatisfied(approvals: { side: string; status: string }[]): {
  satisfied: boolean;
  outstanding: ApprovalSide[];
} {
  const sides: ApprovalSide[] = ['DELEGATOR', 'DELEGATEE'];
  const outstanding: ApprovalSide[] = [];

  for (const side of sides) {
    const rows = approvals.filter((a) => a.side === side);
    if (rows.length === 0) continue; // no approver on this side: nothing required
    const anyApproved = rows.some((a) => a.status === 'APPROVED');
    const anyRefused = rows.some((a) => a.status === 'REFUSED');
    if (!anyApproved || anyRefused) outstanding.push(side);
  }

  return { satisfied: outstanding.length === 0, outstanding };
}

/**
 * Is this delegation granting authority right now?
 *
 * The one question the authority resolver asks, and deliberately strict: both
 * parties accepted, every required side approved, today is inside the span, and
 * nobody has closed or revoked it.
 */
export function isLive(
  row: {
    status: string;
    validFrom: string;
    validTo: string | null;
    delegatorAcceptedAt: Date | string | null;
    delegateAcceptedAt: Date | string | null;
  },
  approvals: { side: string; status: string }[],
  on: string = today(),
): boolean {
  if (effectiveStatus(row, on) !== 'ACTIVE') return false;
  if (!row.delegatorAcceptedAt || !row.delegateAcceptedAt) return false;
  if (row.validFrom > on) return false;
  if (row.validTo && row.validTo < on) return false;
  return approvalsSatisfied(approvals).satisfied;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
