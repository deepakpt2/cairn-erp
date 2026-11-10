/**
 * Authority — what a person may do, where, and until when.
 *
 * ## Why this file exists
 *
 * Before it, "may I?" had no single answer. `hasCapability` answered *do you
 * hold the pattern*; `hasOrgAccess` answered *may you touch this value*. Nothing
 * answered both together, which is the practical reason only a handful of
 * modules ever asked the second question — the honest answer needed two calls
 * and a mental join, so most callers made one call and moved on.
 *
 * `can()` answers it once. It takes the thing being asked for and, optionally,
 * the place it is being asked about, and it is false unless some grant covers
 * both.
 *
 * ## Where authority comes from, and why it is not copied
 *
 * Three sources, unioned at read time:
 *
 *   role     -> `role_capability`      derived, unrestricted unless narrowed
 *   position -> `position_capability`  derived, scoped by the assignment
 *   direct   -> `user_capability`      stored: dated, scoped, and traceable
 *
 * An earlier plan called for copying every user's existing role capabilities
 * into `user_capability` as unrestricted grants. This does not, and the reason
 * is worth keeping on record: a copy is a second source of truth, and it drifts
 * the moment a role changes. Revoke a role and a copied grant would outlive it,
 * silently, which is the worst possible failure in an authorisation system.
 * Reading the role path live is both cheaper and correct, and nothing regresses
 * by doing it.
 *
 * `user_capability` therefore holds only what cannot be derived — which is
 * exactly what delegation needs: a grant with a date, a reason, a named granter,
 * and a scope.
 *
 * ## Where the place lives
 *
 * On the assignment, never on the capability. The same position in two plants is
 * two assignments, so "this buyer covers plant 1000" is a fact about a posting
 * and not about the authority. A grant's scope is the set of levels it names;
 * a level it does not name is one it does not restrict, and a grant with no
 * scope rows at all is unrestricted.
 *
 * Dating is a filter, never a job. An expired grant stops matching the moment
 * the date passes it; nothing sweeps the table.
 *
 * ## Two vocabularies, one mapping
 *
 * Callers name levels the way the rest of the code names things — `plant`,
 * `companyCode`. Storage names them the way `auth_org_restriction` already did —
 * `PLANT`, `COMPANY_CODE`. `LEVEL_OF_KEY` is the only place the two meet, so the
 * stored vocabulary stays exactly what the database already used and the call
 * sites stay readable.
 */

import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../db/client';
// The one pattern matcher. See `patternMatches` for why this is not reimplemented.
import { hasCapability } from './session';
import { employee, positionAssignment } from '../../modules/people/schema';
import {
  authOrgRestriction,
  positionCapability,
  role,
  roleCapability,
  userCapability,
  userCapabilityScope,
  userRole,
} from '../tables/security';

// ─────────────────────────────────────────────────────────────────────────────
// The nine organisational levels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a caller names a level, and the value it is stored under. These nine are
 * the confirmed set; the right-hand column is the vocabulary
 * `auth_org_restriction` already used, so nothing already in the database has to
 * be renumbered or rewritten.
 */
export const LEVEL_OF_KEY = {
  plant: 'PLANT',
  companyCode: 'COMPANY_CODE',
  purchasingOrg: 'PURCHASING_ORG',
  purchasingGroup: 'PURCHASING_GROUP',
  salesOrg: 'SALES_ORG',
  distributionChannel: 'DISTRIBUTION_CHANNEL',
  division: 'DIVISION',
  creditControlArea: 'CREDIT_CONTROL_AREA',
  controllingArea: 'CONTROLLING_AREA',
} as const;

/** The stored level names, in the order they are checked. */
export const ORG_LEVELS = Object.values(LEVEL_OF_KEY);

export type ScopeKey = keyof typeof LEVEL_OF_KEY;
export type OrgLevel = (typeof LEVEL_OF_KEY)[ScopeKey];

export const SCOPE_KEYS = Object.keys(LEVEL_OF_KEY) as ScopeKey[];

/** The stored level for a caller's key. Unknown keys are never silently accepted. */
export const KEY_OF_LEVEL: Record<OrgLevel, ScopeKey> = Object.fromEntries(
  (Object.entries(LEVEL_OF_KEY) as [ScopeKey, OrgLevel][]).map(([key, level]) => [level, key]),
) as Record<OrgLevel, ScopeKey>;

/** The place a question is being asked about. Only the levels you name are checked. */
export type OrgScope = Partial<Record<ScopeKey, string>>;

/** What one grant covers, per level. An absent or empty level is unrestricted. */
export type ScopeMap = Partial<Record<ScopeKey, string[]>>;

/** A user's narrowing filter, the modern reading of `auth_org_restriction`. */
export type Restrictions = Map<ScopeKey, string[]>;

// ─────────────────────────────────────────────────────────────────────────────
// Grants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One reason a person may do something.
 *
 * `scope` is empty for an unrestricted grant, which is the common case and must
 * stay cheap to answer. Dates are carried on direct grants; the derived sources
 * are dated by their own tables and report `null` here rather than pretending to
 * a span that is not theirs.
 */
export interface AuthorityGrant {
  source: 'ROLE' | 'POSITION' | 'DIRECT';
  /** A capability code, or a pattern such as `PROC.*`. */
  pattern: string;
  roleCode?: string;
  positionCode?: string;
  grantId?: string;
  /** Why it was given: DIRECT, DELEGATION or TEMPORARY. Direct grants only. */
  reason?: string;
  /** Who gave it. A delegation names the delegator, so a grant reads back to a person. */
  granter?: string;
  validFrom: string | null;
  validTo: string | null;
  scope: ScopeMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does a grant's pattern cover this capability?
 *
 * This deliberately does not implement its own matching. `hasCapability` already
 * owns that rule, and it is stricter than any second implementation is likely to
 * be, in three ways worth knowing:
 *
 *   - **Interior wildcards.** `PROC.*.CREATE` grants `PROC.PO.CREATE`. A
 *     naive "does it end in `.*`" test returns false for it.
 *   - **The length rule.** A held pattern must account for the whole required
 *     path and no more, so holding `PROC.PO.CREATE` does not grant `PROC.PO`,
 *     and it does not grant `PROC.PO.CREATE.APPROVE` either.
 *   - **Explicit-grant-only capabilities.** For a small set, patterns are not
 *     honoured at all: only an exact grant counts. Re-implementing matching
 *     here would have quietly handed out authorities that `hasCapability`
 *     refuses to this day.
 *
 * Two matchers that disagree is the difference between an authorisation check
 * and a decoration, so there is one, and it is the existing one.
 */
export function patternMatches(pattern: string, capability: string): boolean {
  return hasCapability([pattern], capability);
}

/**
 * Does the grant's scope permit this place?
 *
 * Only the levels the caller named are examined, and only the levels the grant
 * names can refuse. A grant scoped to a sales org says nothing about plants, so
 * it is not refused on a plant — that asymmetry is the whole point of keeping
 * scope as rows rather than columns.
 */
export function withinScope(scope: ScopeMap, org: OrgScope): boolean {
  for (const key of SCOPE_KEYS) {
    const wanted = org[key];
    if (wanted == null) continue;
    const allowed = scope[key];
    if (!allowed || allowed.length === 0) continue;
    if (!allowed.includes(wanted)) return false;
  }
  return true;
}

/**
 * The user-level narrowing filter.
 *
 * This is `auth_org_restriction`, which predates this file and is deliberately
 * preserved: it narrows a person across everything they hold, rather than
 * scoping one grant. An empty list means unrestricted, matching `hasOrgAccess`.
 */
export function withinRestrictions(restrictions: Restrictions, org: OrgScope): boolean {
  for (const key of SCOPE_KEYS) {
    const wanted = org[key];
    if (wanted == null) continue;
    const allowed = restrictions.get(key);
    if (!allowed || allowed.length === 0) continue;
    if (!allowed.includes(wanted)) return false;
  }
  return true;
}

/** Does this one grant answer the question? */
export function grantMatches(grant: AuthorityGrant, capability: string, org: OrgScope = {}): boolean {
  return patternMatches(grant.pattern, capability) && withinScope(grant.scope, org);
}

/**
 * The pure half of `can()`, so scope and pattern rules can be tested without a
 * database and reused by callers who already hold the grants.
 */
export function canWith(
  grants: readonly AuthorityGrant[],
  capability: string,
  org: OrgScope = {},
  restrictions: Restrictions = new Map(),
): boolean {
  if (!withinRestrictions(restrictions, org)) return false;
  return grants.some((grant) => grantMatches(grant, capability, org));
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the grants
// ─────────────────────────────────────────────────────────────────────────────

/** A `date` and a `timestamptz` both answer to a plain `YYYY-MM-DD`. */
function dayOf(asOf: string | Date): string {
  return asOf instanceof Date ? asOf.toISOString().slice(0, 10) : asOf.slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `valid_to` is null for an open grant, which is the common case. */
function openOn(column: unknown, day: string) {
  return or(isNull(column as never), gte(column as never, day));
}

/**
 * Every grant a person holds on a given day, from all three sources.
 *
 * Takes a transaction rather than opening one, because authority is almost
 * always asked in the middle of work that is already in a transaction and must
 * see what that transaction has written.
 */
export async function effectiveGrants(
  tx: Tx,
  client: string,
  userId: string,
  asOf: string | Date = todayIso(),
): Promise<AuthorityGrant[]> {
  const day = dayOf(asOf);
  const grants: AuthorityGrant[] = [];

  // ── Through a role. Unrestricted: a role's scope, if it has one, is the
  // user-level restriction filter rather than a property of the grant.
  const roleRows = await tx
    .select({ pattern: roleCapability.capabilityCode, roleCode: role.code })
    .from(userRole)
    .innerJoin(role, and(eq(role.client, userRole.client), eq(role.code, userRole.roleCode)))
    .innerJoin(
      roleCapability,
      and(eq(roleCapability.client, userRole.client), eq(roleCapability.roleCode, role.code)),
    )
    .where(
      and(
        eq(userRole.client, client),
        eq(userRole.userId, userId),
        eq(role.isActive, true),
        // Compared as dates, not instants. `user_role.valid_from` defaults to
        // `now()`, so a role granted at four in the afternoon would otherwise be
        // invisible all day: 16:00 today is not before midnight today. A grant
        // is either live on a given day or it is not.
        sql`${userRole.validFrom}::date <= ${day}::date`,
        sql`(${userRole.validTo} is null or ${userRole.validTo}::date >= ${day}::date)`,
      ),
    );

  for (const row of roleRows) {
    grants.push({
      source: 'ROLE',
      pattern: row.pattern,
      roleCode: row.roleCode,
      validFrom: null,
      validTo: null,
      scope: {},
    });
  }

  // ── Through a position. Scoped by the assignment, which is where the place lives.
  const positionRows = await tx
    .select({
      pattern: positionCapability.capabilityCode,
      positionCode: positionAssignment.positionCode,
      plant: positionAssignment.plant,
      companyCode: positionAssignment.companyCode,
      purchasingOrg: positionAssignment.purchasingOrg,
      purchasingGroup: positionAssignment.purchasingGroup,
      salesOrg: positionAssignment.salesOrg,
      distributionChannel: positionAssignment.distributionChannel,
      division: positionAssignment.division,
      creditControlArea: positionAssignment.creditControlArea,
      controllingArea: positionAssignment.controllingArea,
    })
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
        eq(employee.appUserId, userId),
        eq(positionCapability.isActive, true),
        lte(positionAssignment.validFrom, day),
        openOn(positionAssignment.validTo, day),
      ),
    );

  for (const row of positionRows) {
    grants.push({
      source: 'POSITION',
      pattern: row.pattern,
      positionCode: row.positionCode,
      validFrom: null,
      validTo: null,
      scope: scopeOf({
        plant: row.plant,
        companyCode: row.companyCode,
        purchasingOrg: row.purchasingOrg,
        purchasingGroup: row.purchasingGroup,
        salesOrg: row.salesOrg,
        distributionChannel: row.distributionChannel,
        division: row.division,
        creditControlArea: row.creditControlArea,
        controllingArea: row.controllingArea,
      }),
    });
  }

  // ── Directly, dated and scoped. This is what delegation will write.
  const directRows = await tx
    .select()
    .from(userCapability)
    .where(
      and(
        eq(userCapability.client, client),
        eq(userCapability.userId, userId),
        lte(userCapability.validFrom, day),
        openOn(userCapability.validTo, day),
      ),
    );

  let scopes: { grantId: string; scopeType: string; scopeValue: string }[] = [];
  if (directRows.length > 0) {
    scopes = await tx
      .select({
        grantId: userCapabilityScope.grantId,
        scopeType: userCapabilityScope.scopeType,
        scopeValue: userCapabilityScope.scopeValue,
      })
      .from(userCapabilityScope)
      .where(
        and(
          eq(userCapabilityScope.client, client),
          inArray(
            userCapabilityScope.grantId,
            directRows.map((row) => row.id),
          ),
        ),
      );
  }

  const byGrant = new Map<string, ScopeMap>();
  for (const row of scopes) {
    const key = KEY_OF_LEVEL[row.scopeType as OrgLevel];
    if (!key) continue;
    const map = byGrant.get(row.grantId) ?? {};
    const list = map[key] ?? [];
    list.push(row.scopeValue);
    map[key] = list;
    byGrant.set(row.grantId, map);
  }

  for (const row of directRows) {
    grants.push({
      source: 'DIRECT',
      pattern: row.capabilityCode,
      grantId: row.id,
      reason: row.reason,
      granter: row.granter,
      validFrom: row.validFrom,
      validTo: row.validTo,
      scope: byGrant.get(row.id) ?? {},
    });
  }

  return grants;
}

/** Collapse a row of nullable org columns into the levels it actually names. */
function scopeOf(values: Record<ScopeKey, string | null>): ScopeMap {
  const scope: ScopeMap = {};
  for (const key of SCOPE_KEYS) {
    const value = values[key];
    if (value) scope[key] = [value];
  }
  return scope;
}

/**
 * The user-level narrowing filter, read once.
 *
 * Empty means unrestricted. This preserves `hasOrgAccess` exactly, so the
 * handful of modules that already asked are not silently widened.
 */
export async function loadRestrictions(
  tx: Tx,
  client: string,
  userId: string,
): Promise<Restrictions> {
  const rows = await tx
    .select({
      scopeType: authOrgRestriction.scopeType,
      scopeValue: authOrgRestriction.scopeValue,
    })
    .from(authOrgRestriction)
    .where(and(eq(authOrgRestriction.client, client), eq(authOrgRestriction.userId, userId)));

  const map: Restrictions = new Map();
  for (const row of rows) {
    const key = KEY_OF_LEVEL[row.scopeType as OrgLevel];
    if (!key) continue;
    map.set(key, [...(map.get(key) ?? []), row.scopeValue]);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// The question
// ─────────────────────────────────────────────────────────────────────────────

/** The least a caller must know about the person being asked about. */
export interface AuthoritySubject {
  client: string;
  userId: string;
}

/**
 * May this person do this, here, on this day?
 *
 * The organisation is optional, and omitting it asks only "do you hold this at
 * all" — which is exactly what every existing `hasCapability` call site means,
 * so those call sites carry over unchanged. Naming a level narrows the question
 * to that place.
 */
export async function can(
  who: AuthoritySubject,
  capability: string,
  org: OrgScope = {},
  asOf: string | Date = todayIso(),
): Promise<boolean> {
  return withTenant(who.client, async (tx) => {
    const [grants, restrictions] = await Promise.all([
      effectiveGrants(tx, who.client, who.userId, asOf),
      loadRestrictions(tx, who.client, who.userId),
    ]);
    return canWith(grants, capability, org, restrictions);
  });
}

/** The same question inside a transaction the caller already owns. */
export async function canTx(
  tx: Tx,
  client: string,
  userId: string,
  capability: string,
  org: OrgScope = {},
  asOf: string | Date = todayIso(),
): Promise<boolean> {
  const [grants, restrictions] = await Promise.all([
    effectiveGrants(tx, client, userId, asOf),
    loadRestrictions(tx, client, userId),
  ]);
  return canWith(grants, capability, org, restrictions);
}
