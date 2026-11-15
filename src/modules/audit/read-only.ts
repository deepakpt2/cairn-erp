/**
 * "Structurally impossible to post" — the rule a live audit grant imposes.
 *
 * While a person holds a live audit grant, everything they hold is cut down to the
 * read side of the catalogue. It is applied in two places, both central:
 *
 *   1. `effectiveGrants()` (src/platform/auth/authority.ts) — the one function every
 *      request, every sign-in, `can()`, `hasCapability()` and `loadCapabilities()`
 *      resolve authority through. A wildcard such as `FIN.*` is expanded against the
 *      catalogue and only its read-kind members survive, so a screen that asks for
 *      `FIN.JOURNAL.POST` finds it missing, whatever the auditor's role says.
 *   2. `verifyServiceAuthorityInTx()` (src/platform/auth/service-authority.ts) — the
 *      service boundary refuses a non-read capability by name, naming the grant.
 *
 * What counts as a read is taken from the seeded catalogue (`capability.action`), not
 * from a hand-written list of codes, so a capability added tomorrow is classified the
 * day it is seeded. A capability missing from the catalogue is not a read: the rule
 * fails closed.
 *
 * Nothing here — or anywhere in the audit module — writes a role_capability or
 * user_capability row. A grant carries scope, never a capability.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { patternMatches } from '../../platform/auth/pattern';

/** Catalogue actions that only read. Everything else changes something. */
export const READ_KIND_ACTIONS: readonly string[] = ['DISPLAY', 'VIEW', 'ANALYSIS', 'DOCUMENTS'];

/**
 * Non-read capabilities an auditor keeps under a grant. Exporting the evidence an
 * engagement gathered changes nothing in the business, and every export is logged.
 */
export const AUDIT_GRANT_EXCEPTIONS: readonly string[] = ['AUDIT.EVIDENCE.EXPORT'];

export interface CatalogueEntry {
  code: string;
  action: string;
}

/** Is this catalogue entry something an audit grant holder may keep? */
export function isAuditorReadable(entry: CatalogueEntry): boolean {
  return READ_KIND_ACTIONS.includes(entry.action) || AUDIT_GRANT_EXCEPTIONS.includes(entry.code);
}

function dayOf(asOf: string | Date): string {
  return typeof asOf === 'string' ? asOf.slice(0, 10) : asOf.toISOString().slice(0, 10);
}

/**
 * The grant that is live for this person on this day, if any.
 *
 * Judged on the dates and the revocation alone, not on the stored status: a grant
 * whose window has opened is live even before anything has refreshed its status
 * from DRAFT, and one whose window has closed is over even before it reads EXPIRED.
 */
export async function liveAuditGrantId(
  tx: Tx,
  client: string,
  userId: string,
  asOf: string | Date = new Date(),
): Promise<string | null> {
  const day = dayOf(asOf);
  const rows = (await tx.execute(sql`
    select grant_id
      from audit_grant
     where client = ${client}
       and auditor_user_id = ${userId}
       and status in ('DRAFT', 'ACTIVE')
       and revoked_at is null
       and valid_from <= ${day}::date
       and valid_to >= ${day}::date
     order by valid_from
     limit 1
  `)) as unknown as Array<{ grant_id: string }>;
  return rows[0]?.grant_id ?? null;
}

/** The capability catalogue, as code → action. */
export async function capabilityCatalogue(tx: Tx): Promise<CatalogueEntry[]> {
  const rows = (await tx.execute(sql`select code, action from capability order by code`)) as unknown as Array<{
    code: string;
    action: string;
  }>;
  return rows.map((row) => ({ code: String(row.code), action: String(row.action) }));
}

/**
 * Cut a set of grants down to what an auditor may keep.
 *
 * Each grant's pattern is expanded against the catalogue and replaced by the
 * read-kind codes it covers, one grant per code, keeping its source, dates and
 * scope. `patternMatches` already refuses to let a wildcard cover an explicit-grant-
 * only capability, so the expansion can never widen what was held.
 */
export function restrictToReadOnly<G extends { pattern: string }>(
  grants: readonly G[],
  catalogue: readonly CatalogueEntry[],
): G[] {
  const out: G[] = [];
  for (const grant of grants) {
    for (const entry of catalogue) {
      if (isAuditorReadable(entry) && patternMatches(grant.pattern, entry.code)) {
        out.push({ ...grant, pattern: entry.code });
      }
      // The `<code>.read` convention: a few report screens accept a read-only variant
      // of their capability (e.g. FIN.RPT.SUBLEDGER.TIE.read). It is a read by
      // definition, so it is kept wherever the holder's pattern already covered it.
      const readVariant = `${entry.code}${READ_SUFFIX}`;
      if (patternMatches(grant.pattern, readVariant)) out.push({ ...grant, pattern: readVariant });
    }
  }
  return out;
}

/** The suffix a read-only variant of a capability carries. */
export const READ_SUFFIX = '.read';

/** Is this one capability something an audit grant holder may exercise? Fails closed. */
export async function isAuditorReadableCapability(tx: Tx, capability: string): Promise<boolean> {
  if (AUDIT_GRANT_EXCEPTIONS.includes(capability)) return true;
  if (capability.endsWith(READ_SUFFIX)) return true;
  const rows = (await tx.execute(sql`
    select action from capability where code = ${capability}
  `)) as unknown as Array<{ action: string }>;
  const action = rows[0]?.action;
  return action !== undefined && READ_KIND_ACTIONS.includes(String(action));
}
