/**
 * The inverse of `can()`. Phase 7.
 *
 * `can()` answers "may this person do this, here". This answers "which persons
 * may do this, here" — the question a notification has to answer, because
 * "waiting for your release" is worth saying only to somebody who can actually
 * release it.
 *
 * **Both must agree.** If the resolver names somebody `can()` would refuse, the
 * inbox offers work the screen then rejects, which is worse than saying
 * nothing. So this deliberately does not implement a second matcher: it loads
 * each candidate's grants through `effectiveGrants` and tests them with the
 * same two functions `canUser` uses. Agreement is structural rather than
 * maintained by hand.
 *
 * **Scope is not optional here.** Resolving by capability alone would tell
 * every holder about every document in the tenant. A purchase manager scoped
 * to plant 1000 is not told about a plant 2000 purchase order, however broadly
 * they hold the capability.
 *
 * **Cost.** This is a fan-out, so it runs in a worker rather than on the
 * request path. The candidate set is narrowed in SQL first; only candidates are
 * then resolved individually.
 */
import { and, eq, lte, or, sql } from 'drizzle-orm';

import {
  effectiveGrants,
  grantMatches,
  loadRestrictions,
  withinRestrictions,
} from '@/platform/auth/authority';
import type { OrgScope } from '@/platform/auth/authority';
import type { Tx } from '@/platform/db/client';
import { delegation } from '@/modules/people/schema';
import { employee, positionAssignment } from '@/modules/people/schema';
import {
  positionCapability,
  role,
  roleCapability,
  userCapability,
  userRole,
} from '@/platform/tables/security';

/** A `date` and a `timestamptz` both answer to a plain `YYYY-MM-DD`. */
function dayOf(asOf: string | Date): string {
  return asOf instanceof Date ? asOf.toISOString().slice(0, 10) : asOf.slice(0, 10);
}

/**
 * Who may do this, here, on this day.
 *
 * Returns user ids. Empty when nobody can, which is the honest answer and not
 * an error: a document can sit in a queue nobody is competent to clear, and
 * telling nobody about it is correct.
 */
export async function resolveRecipients(
  tx: Tx,
  client: string,
  capability: string,
  org: OrgScope = {},
  asOf: string | Date = new Date(),
): Promise<string[]> {
  const candidates = await candidateUsers(tx, client, capability, asOf);

  const out: string[] = [];
  for (const userId of candidates) {
    const [grants, restrictions] = await Promise.all([
      effectiveGrants(tx, client, userId, asOf),
      loadRestrictions(tx, client, userId),
    ]);
    if (!withinRestrictions(restrictions, org)) continue;
    if (grants.some((grant) => grantMatches(grant, capability, org))) out.push(userId);
  }
  return out;
}

/**
 * Users who *might* hold this capability, cheaply.
 *
 * A grant is a pattern, and a pattern like `PROC.*` cannot be matched in SQL
 * without re-implementing the matcher — which is exactly what must not happen.
 * So this over-selects: anything naming the capability exactly, anything
 * carrying a wildcard, and anybody holding a live delegation. The exact answer
 * is then decided in memory by `grantMatches`.
 *
 * Over-selecting costs a little work and cannot be wrong. Under-selecting
 * would silently drop a recipient, which is a notification never sent.
 */
async function candidateUsers(
  tx: Tx,
  client: string,
  capability: string,
  asOf: string | Date,
): Promise<string[]> {
  const day = dayOf(asOf);
  const openOn = (column: unknown) => sql`(${column} is null or ${column} >= ${day})`;
  // `user_role.valid_from` is a timestamptz, so a plain date compare will not
  // type-check and would be wrong at the boundary if it did. Same rule
  // `effectiveGrants` uses: compare instants against the end of the day.
  const boundary = `${day} 23:59:59.999`;

  // ── Through a role.
  const byRole = await tx
    .select({ userId: userRole.userId })
    .from(userRole)
    .innerJoin(role, and(eq(role.client, userRole.client), eq(role.code, userRole.roleCode)))
    .innerJoin(
      roleCapability,
      and(eq(roleCapability.client, userRole.client), eq(roleCapability.roleCode, role.code)),
    )
    .where(
      and(
        eq(userRole.client, client),
        eq(role.isActive, true),
        sql`${userRole.validFrom} <= ${boundary}::timestamptz`,
        sql`(${userRole.validTo} is null or ${userRole.validTo} >= ${boundary}::timestamptz)`,
        or(
          eq(roleCapability.capabilityCode, capability),
          sql`${roleCapability.capabilityCode} like '%*%'`,
        ),
      ),
    );

  // ── Through a position.
  const byPosition = await tx
    .select({ userId: employee.appUserId })
    .from(employee)
    .innerJoin(
      positionAssignment,
      and(
        eq(positionAssignment.client, employee.client),
        eq(positionAssignment.personnelNumber, employee.personnelNumber),
      ),
    )
    .innerJoin(
      positionCapability,
      and(
        eq(positionCapability.client, positionAssignment.client),
        eq(positionCapability.positionCode, positionAssignment.positionCode),
      ),
    )
    .where(
      and(
        eq(employee.client, client),
        eq(positionCapability.isActive, true),
        lte(positionAssignment.validFrom, day),
        openOn(positionAssignment.validTo),
        or(
          eq(positionCapability.capabilityCode, capability),
          sql`${positionCapability.capabilityCode} like '%*%'`,
        ),
      ),
    );

  // ── Directly, dated and scoped.
  const byDirect = await tx
    .select({ userId: userCapability.userId })
    .from(userCapability)
    .where(
      and(
        eq(userCapability.client, client),
        lte(userCapability.validFrom, day),
        openOn(userCapability.validTo),
        or(
          eq(userCapability.capabilityCode, capability),
          sql`${userCapability.capabilityCode} like '%*%'`,
        ),
      ),
    );

  // ── Through a delegation. A delegatee holds whatever the delegator
  // currently holds, so anybody receiving a live delegation is a candidate for
  // everything and cannot be pre-filtered by capability.
  const byDelegation = await tx
    .select({ userId: delegation.delegateUserId })
    .from(delegation)
    .where(
      and(
        eq(delegation.client, client),
        lte(delegation.validFrom, day),
        openOn(delegation.validTo),
        sql`${delegation.status} not in ('REFUSED', 'CLOSED', 'REVOKED')`,
      ),
    );

  const ids = new Set<string>();
  for (const row of [...byRole, ...byPosition, ...byDirect, ...byDelegation]) {
    if (row.userId) ids.add(row.userId);
  }
  return [...ids];
}
