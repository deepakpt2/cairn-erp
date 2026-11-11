import {
  canWith, effectiveGrants, grantMatches, loadRestrictions, SCOPE_KEYS,
} from '@/platform/auth/authority';
import type { AuthorityGrant, AuthoritySubject, Restrictions } from '@/platform/auth/authority';
import { withTenant } from '@/platform/db/client';

import { ATTENTION_SOURCES } from './sources';
import type { AttentionGroup, AttentionRow, AttentionSource } from './types';

/**
 * How many rows of one source the panel shows before "and N more".
 */
export const ATTENTION_VISIBLE = 5;

/**
 * What waits on this person, on this day.
 *
 * Three rules, in order:
 *
 * 1. **A source the person cannot act on is skipped entirely.** Not greyed out,
 *    not shown with a padlock — skipped. The panel never tells somebody about
 *    work they would only be refused.
 * 2. **Then the rows are narrowed by organisation.** A purchase manager for
 *    plant 1000 sees plant 1000's purchase orders, and a director holding the
 *    capability unrestricted sees everyone's.
 * 3. **Oldest first, capped, empty groups dropped.** The panel renders nothing
 *    at all when nothing is waiting, which is the common case and must not
 *    cost a heading.
 *
 * `asOf` is honoured all the way down: the grants are read for that day, so
 * authority that expired yesterday is gone today, and a delegation that starts
 * tomorrow is not here yet.
 */
export async function attentionFor(
  who: AuthoritySubject,
  asOf: string | Date = new Date(),
): Promise<AttentionGroup[]> {
  const day = asOf instanceof Date ? asOf.toISOString().slice(0, 10) : asOf.slice(0, 10);

  // One read of the authority, reused for every source and every row. Asking
  // `canUser` once per row would be a query per document on the home page.
  const [grants, restrictions] = await withTenant(who.client, async (tx) => Promise.all([
    effectiveGrants(tx, who.client, who.userId, day),
    loadRestrictions(tx, who.client, who.userId),
  ]));

  const reachable = ATTENTION_SOURCES.filter((source) => canWith(grants, source.code, {}, restrictions));
  if (reachable.length === 0) return [];

  const settled = await Promise.all(reachable.map(
    async (source): Promise<{ source: AttentionSource; rows: AttentionRow[] }> => {
      try {
        return { source, rows: await source.due(who, day) };
      } catch (error) {
        // One broken queue must not cost the home page. The error is logged
        // rather than swallowed, and that source simply contributes nothing.
        console.error(`attention: source ${source.code} failed`, error);
        return { source, rows: [] };
      }
    },
  ));

  const groups: AttentionGroup[] = [];
  for (const { source, rows } of settled) {
    const mine = rows.filter((row) => mayAct(grants, restrictions, source.code, row.orgs));
    if (mine.length === 0) continue;

    mine.sort(oldestFirst);
    groups.push({
      source: source.code,
      label: source.label,
      rows: mine.slice(0, ATTENTION_VISIBLE),
      total: mine.length,
      more: Math.max(0, mine.length - ATTENTION_VISIBLE),
    });
  }
  return groups;
}

/**
 * May this person do this work, in one of the places it sits?
 *
 * A row that names nowhere is the awkward case, and it fails closed: only
 * somebody whose grant names nowhere either sees it. Asking `can` with an empty
 * organisation would answer "do you hold this at all", which every scoped
 * manager also answers yes to — that is exactly the leak the multi-plant case
 * exists to prevent.
 */
export function mayAct(
  grants: readonly AuthorityGrant[],
  restrictions: Restrictions,
  capability: string,
  orgs: AttentionRow['orgs'],
): boolean {
  if (!orgs || orgs.length === 0) return unrestrictedFor(grants, restrictions, capability);
  return orgs.some((org) => canWith(grants, capability, org, restrictions));
}

/** Somebody whose grant covers this capability everywhere. */
function unrestrictedFor(
  grants: readonly AuthorityGrant[],
  restrictions: Restrictions,
  capability: string,
): boolean {
  if (!canWith(grants, capability, {}, restrictions)) return false;
  return grants.some(
    (grant) => grantMatches(grant, capability, {})
      && SCOPE_KEYS.every((key) => !grant.scope[key]?.length),
  );
}

/** Oldest first, so what has waited longest is at the top. */
function oldestFirst(a: AttentionRow, b: AttentionRow): number {
  return a.waitingSince.localeCompare(b.waitingSince);
}
