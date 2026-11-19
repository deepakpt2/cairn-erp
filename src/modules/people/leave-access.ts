/**
 * Who may call a leave service, judged by the service itself — never by a screen's `can()`.
 *
 * Every leave service takes a `LeaveAccess`:
 * - `{ authorization }` — a live session (or a job lease acting for the user who submitted the run).
 *   `verifyServiceAuthorityInTx` re-reads the session, the account, the capability and the Company Code
 *   scope inside the service's own transaction. A session with no Company Code scope fails closed.
 * - a capability list — the in-process form for trusted callers with no session (the demo provisioner,
 *   service tests). It is judged for the capability only and carries no Company Code limit. It cannot
 *   be reached from a browser: server actions only ever build the `authorization` form.
 *
 * Employee reach (employee-reach.ts): every dated position assignment overlapping the range must be inside the
 * caller's Company Code scope and, when the caller holds Plant scope, inside that plant too (a plant clerk sees
 * their plant; a company-level officer, with no Plant scope, sees the company). An employee with no assignment
 * in range, or one whose company or plant cannot be resolved, is NOT reachable by a scoped caller (fail closed);
 * an in-process caller reaches everyone.
 *
 * Capabilities (none is granted to a role by 9311 except APPROVE, copied from PEOPLE.TIME.ENTER holders):
 *   PEOPLE.LEAVE.CONFIGURE  time types, policies, versions
 *   PEOPLE.LEAVE.ASSIGN     groups, membership, policy assignment
 *   PEOPLE.TIME.ENTER       request absence, record time (unchanged)
 *   PEOPLE.LEAVE.APPROVE    approve / reject / cancel absence
 *   PEOPLE.LEAVE.ADJUST     quota adjustment, legacy conversion
 *   PEOPLE.LEAVE.VIEW       balance view (unchanged name)
 *   PEOPLE.LEAVE.EXPORT     balance CSV
 *   PEOPLE.LEAVE.ACCRUE     manual / backfill accrual run and its status
 */
import { hasCapability, type OrgRestriction } from '../../platform/auth/session';
import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import type { Tx } from '../../platform/db/client';
import { assignmentScopes, companyPlantsOf, scopeReaches } from './employee-reach';

export const LEAVE_CONFIGURE = 'PEOPLE.LEAVE.CONFIGURE';
export const LEAVE_ASSIGN = 'PEOPLE.LEAVE.ASSIGN';
export const LEAVE_ENTER = 'PEOPLE.TIME.ENTER';
export const LEAVE_APPROVE = 'PEOPLE.LEAVE.APPROVE';
export const LEAVE_ADJUST = 'PEOPLE.LEAVE.ADJUST';
export const LEAVE_VIEW = 'PEOPLE.LEAVE.VIEW';
export const LEAVE_EXPORT = 'PEOPLE.LEAVE.EXPORT';
export const LEAVE_ACCRUE = 'PEOPLE.LEAVE.ACCRUE';

export type LeaveAccess = readonly string[] | { authorization: ServiceAuthorityContext | undefined };

export class LeaveError extends Error {
  readonly code: string;
  readonly remedy: string;
  constructor(code: string, message: string, remedy: string) {
    super(message);
    this.name = 'LeaveError';
    this.code = code;
    this.remedy = remedy;
  }
}
export function isLeaveError(error: unknown): error is LeaveError {
  return error instanceof LeaveError;
}
export function refuse(code: string, message: string, remedy = 'Correct the input and try again.'): never {
  throw new LeaveError(code, message, remedy);
}

export interface LeaveGrant {
  /** The caller's Company Code scope, or null for a trusted in-process caller (no limit). */
  restrictions: OrgRestriction[] | null;
  /** The verified username for a session caller; null for an in-process caller (it supplies its own). */
  username: string | null;
  capability: string;
}

/** Judge the caller for any one of `capabilities`, inside the caller's transaction. */
export async function judgeLeave(
  tx: Tx,
  client: string,
  access: LeaveAccess | undefined,
  capabilities: readonly string[],
): Promise<LeaveGrant> {
  const named = capabilities.join(' or ');
  if (access === undefined) {
    refuse('LEAVE_AUTHORITY', `This leave service needs a signed-in user holding ${named}.`, `Sign in and ask an administrator for ${named}.`);
  }
  if (Array.isArray(access)) {
    const held = capabilities.find((c) => hasCapability([...access], c));
    if (!held) refuse('LEAVE_AUTHORITY', `You do not hold ${named}.`, `Ask an administrator for ${named}.`);
    return { restrictions: null, username: null, capability: held };
  }
  const { authorization } = access as { authorization: ServiceAuthorityContext | undefined };
  let first: { message: string; remedy: string } | null = null;
  for (const capability of capabilities) {
    const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, capability, { requirePlantScope: false });
    if (verdict.ok) return { restrictions: verdict.restrictions, username: verdict.username, capability };
    first ??= verdict.refusal;
  }
  if (first!.message.startsWith('You do not hold the authority')) {
    refuse('LEAVE_AUTHORITY', `You do not hold ${named}.`, `Ask an administrator for ${named}. Leave authority is granted to no role by default.`);
  }
  refuse('LEAVE_AUTHORITY', first!.message, first!.remedy);
}

/** The name a write is recorded under: the verified user, else the in-process caller's own label. */
export function actorOf(grant: LeaveGrant, supplied: string | undefined): string {
  return grant.username ?? (supplied?.trim() ? supplied.trim().slice(0, 60) : 'SYSTEM');
}

/** Does the grant reach the employee over [from, to]? Company always; plant too for a plant-level caller. Fails closed. */
export async function reachesEmployee(
  tx: Tx, client: string, grant: LeaveGrant, personnelNumber: string, from: string, to: string,
): Promise<boolean> {
  if (grant.restrictions === null) return true;
  return scopeReaches(grant.restrictions, await assignmentScopes(tx, client, personnelNumber, from, to), await companyPlantsOf(tx, client, grant));
}

export async function assertReachesEmployee(
  tx: Tx, client: string, grant: LeaveGrant, personnelNumber: string, from: string, to: string,
): Promise<void> {
  if (!(await reachesEmployee(tx, client, grant, personnelNumber, from, to))) {
    // One message for "does not exist", "no company" and "outside scope": it must not confirm anything.
    refuse(
      'EMPLOYEE_OUT_OF_SCOPE',
      `Employee ${personnelNumber} is not available to you for ${from} to ${to}.`,
      'Check the personnel number. If it is right, the employee has no company or plant on a position assignment for those dates, or lies outside your Company Code or Plant scope.',
    );
  }
}

/** The personnel numbers among `numbers` that the grant reaches over [from, to]. */
export async function reachableEmployees(
  tx: Tx, client: string, grant: LeaveGrant, numbers: readonly string[], from: string, to: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const n of numbers) if (await reachesEmployee(tx, client, grant, n, from, to)) out.push(n);
  return out;
}
