/**
 * Auditor workspace — AUDIT.WORKSPACE.
 *
 * A person acting as auditor is given time-boxed, scoped, read-only access to a
 * tenant; cannot post under any circumstances; has their own access logged; and keeps
 * working state — findings, notes, bookmarks and requests to management — with status
 * and response.
 *
 * SAP reference, three places together: GRC Emergency Access Management
 * ("Firefighter") for the grant — time-boxed, scoped, logged, revoked by a
 * controller; SAP Audit Management for the working state; AIS for the read-only tree
 * the workspace opens (FS10N → FAGLL03 → FB03 → ME23N / VA03 / MB03 → change documents).
 *
 * The three layers that make posting impossible:
 *   1. A grant carries scope, never a capability. Nothing in this file writes a
 *      role_capability or user_capability row.
 *   2. While a grant is live, `effectiveGrants()` cuts the holder's authority to the
 *      read side of the catalogue, and `verifyServiceAuthorityInTx()` refuses any
 *      write by name (src/modules/audit/read-only.ts).
 *   3. The auditor reads through the existing display capabilities; there are no
 *      AUDIT.*.READ shadows of business capabilities.
 *
 * Every function that decides something re-reads and re-checks inside its own
 * transaction and throws a named `AuditError` carrying a remedy.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { changeHistory, recordChange } from '../../platform/change';
import { canTx, type OrgScope } from '../../platform/auth/authority';
import { hasCapability, loadCapabilities } from '../../platform/auth/session';
import {
  verifyServiceAuthorityInTx,
  type ServiceAuthorityContext,
} from '../../platform/auth/service-authority';
import { appUser, auditAccessLog } from '../../platform/tables/security';
import {
  AUDIT_FINDING_KINDS,
  AUDIT_SCOPE_KINDS,
  AUDIT_SCOPE_MODULES,
  auditFinding,
  auditGrant,
  auditGrantScope,
  type AuditFindingKind,
  type AuditFindingStatus,
  type AuditGrantStatus,
  type AuditScopeKind,
} from './schema';

// ── Constants ───────────────────────────────────────────────────────────────

export const AUDIT_WORKSPACE_CAPABILITY = 'AUDIT.WORKSPACE';
export const AUDIT_TRAIL_CAPABILITY = 'AUDIT.TRAIL.VIEW';
export const AUDIT_EXPORT_CAPABILITY = 'AUDIT.EVIDENCE.EXPORT';
/** Grant and revoke. Held by a controller, never by the auditor. */
export const AUDIT_GRANT_CAPABILITY = 'AUDIT.ACCESS.GRANT';
/** Answer a finding or request. Held by management, never by the auditor. */
export const AUDIT_RESPOND_CAPABILITY = 'AUDIT.REQUEST.RESPOND';

export const AUDIT_WORKSPACE_ROUTE = '/audit/workspace';
export const AUDIT_GRANT_ROUTE = '/audit/grants';
export const AUDIT_FINDING_ROUTE = '/audit/findings';

export const AUDIT_GRANT_OBJECT_CLASS = 'audit_grant';
export const AUDIT_FINDING_OBJECT_CLASS = 'audit_finding';

const REASON_MAX = 500;
const SUBJECT_MAX = 120;

/** What a response may set a finding to. OPEN is where every finding starts. */
export const AUDIT_RESPONSE_STATUSES = ['ANSWERED', 'ACCEPTED', 'WITHDRAWN'] as const;
export type AuditResponseStatus = (typeof AUDIT_RESPONSE_STATUSES)[number];

/**
 * The read-only chain the workspace opens, each hop with the SAP transaction behind
 * it and the capability the screen itself tests (empty: the screen asks only for a
 * session). Nothing here is a new screen: every route stands. The workspace shows,
 * per link, whether the viewer's own authority opens it — under a grant the
 * close cockpit does not, because it is gated by a posting capability.
 */
export const AUDIT_DRILL_THROUGH: ReadonlyArray<{
  step: string;
  label: string;
  route: string;
  sap: string;
  capability: string;
}> = [
  { step: 'Financial statement', label: 'Balance sheet / P&L', route: '/finance/balance-sheet', sap: 'S_ALR_87012284', capability: 'FIN.RPT.BALANCESHEET' },
  { step: 'Financial statement', label: 'Consolidated statements', route: '/finance/consolidated-statements', sap: 'CX20', capability: 'FIN.RPT.CONSOLIDATE.STMT' },
  { step: 'Account balance', label: 'G/L account balances', route: '/finance/journal/balances', sap: 'FS10N', capability: 'FIN.GL.BALANCE' },
  { step: 'Line items', label: 'G/L line items', route: '/finance/journal', sap: 'FAGLL03', capability: '' },
  { step: 'Journal entry', label: 'Display accounting document', route: '/finance/journal/document', sap: 'FB03', capability: 'FIN.JOURNAL.DISPLAY' },
  { step: 'Source document', label: 'Purchase orders', route: '/purchasing/purchase-order-list', sap: 'ME23N', capability: 'PROC.PO.LIST' },
  { step: 'Source document', label: 'Sales documents and document flow', route: '/sales/documents', sap: 'VA03', capability: '' },
  { step: 'Source document', label: 'Material documents', route: '/inventory/material-document-list', sap: 'MB03', capability: 'INV.MATERIALDOC.LIST' },
  { step: 'Reconciliation', label: 'Subledger tie-out', route: '/finance/subledger-tie-out', sap: 'FAGLF03', capability: 'FIN.RPT.SUBLEDGER.TIE.read' },
  { step: 'Period end', label: 'Close cockpit', route: '/finance/close-cockpit', sap: 'FCCX', capability: 'FIN.CLOSE.COCKPIT' },
  { step: 'Platform', label: 'Lock entries', route: '/platform/locks', sap: 'SM12', capability: 'PLT.LOCK.DISPLAY' },
  { step: 'Platform', label: 'Job monitor', route: '/platform/jobs', sap: 'SM37', capability: 'PLT.JOB.DISPLAY' },
  { step: 'Platform', label: 'Notifications', route: '/platform/notifications', sap: 'SBWP', capability: 'PLT.NOTIFY.DISPLAY' },
];

// ── Errors ──────────────────────────────────────────────────────────────────

export class AuditError extends Error {
  remedy?: string;
  /** A stable code a test or a caller can branch on. The message is for people. */
  readonly code: string;
  constructor(message: string, remedy?: string, code = 'AUDIT') {
    super(message);
    this.name = 'AuditError';
    this.remedy = remedy;
    this.code = code;
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export type GrantStatus = AuditGrantStatus;

export interface AuditScope {
  COMPANY_CODE: string[];
  PERIOD: string[];
  MODULE: string[];
}

export interface AuditGrantView {
  grantId: string;
  auditorUserId: string;
  auditorUsername: string | null;
  grantedByUserId: string;
  grantedByUsername: string | null;
  validFrom: string;
  validTo: string;
  /** What the dates and the revocation say today — never stale. */
  status: GrantStatus;
  /** What the row says. Differs from `status` until something refreshes it. */
  storedStatus: GrantStatus;
  reason: string;
  revokedByUserId: string | null;
  revokedByUsername: string | null;
  revokedAt: string | null;
  scope: AuditScope;
}

/** What a read asks to see. Only the levels named are judged. */
export interface ScopeProbe {
  companyCode?: string;
  /** YYYYPP */
  period?: string;
  module?: string;
}

/** The person acting, as a page or test knows them. */
export interface AuditActor {
  client: string;
  userId: string;
  username: string;
}

export interface CreateAuditGrantInput {
  client: string;
  /** The controller granting, with their live session. */
  authorization: ServiceAuthorityContext;
  auditorUserId: string;
  validFrom: string;
  validTo?: string | null;
  scope: ReadonlyArray<{ kind: string; value: string }>;
  reason: string;
  /** Idempotency key. When it is a UUID it becomes the grant id, so a resubmission finds its own grant. */
  requestKey?: string;
}

export interface RevokeAuditGrantInput {
  client: string;
  authorization: ServiceAuthorityContext;
  grantId: string;
  reason: string;
}

export interface FindingInput {
  actor: AuditActor;
  grantId?: string | null;
  kind: string;
  subject: string;
  body: string;
  objectClass?: string | null;
  objectKey?: string | null;
}

export interface RespondInput {
  client: string;
  authorization: ServiceAuthorityContext;
  findingId: string;
  response: string;
  status: string;
}

export interface FindingView {
  findingId: string;
  grantId: string | null;
  kind: AuditFindingKind;
  subject: string;
  body: string;
  objectClass: string | null;
  objectKey: string | null;
  status: AuditFindingStatus;
  response: string | null;
  raisedByUserId: string;
  raisedByUsername: string | null;
  respondedByUserId: string | null;
  respondedByUsername: string | null;
  raisedAt: string;
  respondedAt: string | null;
}

export interface AccessLogEntry {
  client: string;
  userId: string;
  username?: string | null;
  eventType: 'READ' | 'EXPORT' | 'CONFIG_CHANGE' | 'CAPABILITY_DENIED';
  /** The route the access came through. */
  route: string;
  transactionCode?: string | null;
  objectKey?: string | null;
  /** The filter, the search terms, or why it was refused. */
  detail?: string | null;
  grantId?: string | null;
}

export interface WorkspaceView {
  /** The grant live today, if there is one. */
  grant: AuditGrantView | null;
  /** The most recent grant that is not live, so the banner can say why there is none. */
  lastGrant: AuditGrantView | null;
  /** Why there is no live grant, in words, and who to ask. Null when there is one. */
  noGrantReason: string | null;
  findings: FindingView[];
  drillThrough: typeof AUDIT_DRILL_THROUGH;
}

// ── Small helpers ───────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function emptyScope(): AuditScope {
  return { COMPANY_CODE: [], PERIOD: [], MODULE: [] };
}

const SCOPE_LABEL: Record<AuditScopeKind, string> = {
  COMPANY_CODE: 'company code',
  PERIOD: 'period',
  MODULE: 'module',
};

/** What the dates and the revocation make of a grant today. Pure. */
export function effectiveGrantStatus(
  grant: { validFrom: string; validTo: string; revokedAt: unknown; status: string },
  day: string = today(),
): GrantStatus {
  if (grant.revokedAt || grant.status === 'REVOKED') return 'REVOKED';
  if (day > grant.validTo) return 'EXPIRED';
  if (day >= grant.validFrom) return 'ACTIVE';
  return 'DRAFT';
}

/**
 * Which level of the probe falls outside the grant, if any.
 *
 * Only levels the grant names can refuse, and only levels the probe names are
 * examined — the same asymmetry as delegation scope. A grant limited to company 1000
 * says nothing about modules, so it is not refused on a module.
 */
export function scopeGap(
  grant: Pick<AuditGrantView, 'scope'>,
  probe: ScopeProbe,
): { kind: AuditScopeKind; value: string } | null {
  const checks: Array<[AuditScopeKind, string | undefined]> = [
    ['COMPANY_CODE', probe.companyCode],
    ['PERIOD', probe.period],
    ['MODULE', probe.module],
  ];
  for (const [kind, value] of checks) {
    if (value === undefined || value === '') continue;
    const allowed = grant.scope[kind];
    if (allowed.length > 0 && !allowed.includes(value)) return { kind, value };
  }
  return null;
}

/** Does the grant cover what the probe asks to see? */
export function grantCovers(grant: AuditGrantView, probe: ScopeProbe): boolean {
  return scopeGap(grant, probe) === null;
}

async function usernames(tx: Tx, client: string, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ id: appUser.id, username: appUser.username })
    .from(appUser)
    .where(and(eq(appUser.client, client), inArray(appUser.id, wanted)));
  return new Map(rows.map((row) => [row.id, row.username]));
}

async function loadGrantViews(tx: Tx, client: string, grantIds?: string[]): Promise<AuditGrantView[]> {
  if (grantIds && grantIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(auditGrant)
    .where(
      grantIds
        ? and(eq(auditGrant.client, client), inArray(auditGrant.grantId, grantIds))
        : eq(auditGrant.client, client),
    )
    .orderBy(desc(auditGrant.validFrom), desc(auditGrant.createdAt));
  if (rows.length === 0) return [];
  const scopes = await tx
    .select()
    .from(auditGrantScope)
    .where(and(eq(auditGrantScope.client, client), inArray(auditGrantScope.grantId, rows.map((r) => r.grantId))));
  const names = await usernames(
    tx,
    client,
    rows.flatMap((r) => [r.auditorUserId, r.grantedByUserId, r.revokedByUserId]),
  );
  const day = today();
  return rows.map((row) => {
    const scope = emptyScope();
    for (const s of scopes) {
      if (s.grantId !== row.grantId) continue;
      const kind = s.scopeKind as AuditScopeKind;
      if (scope[kind]) scope[kind].push(s.scopeValue);
    }
    for (const kind of AUDIT_SCOPE_KINDS) scope[kind].sort();
    return {
      grantId: row.grantId,
      auditorUserId: row.auditorUserId,
      auditorUsername: names.get(row.auditorUserId) ?? null,
      grantedByUserId: row.grantedByUserId,
      grantedByUsername: names.get(row.grantedByUserId) ?? null,
      validFrom: row.validFrom,
      validTo: row.validTo,
      status: effectiveGrantStatus(row, day),
      storedStatus: row.status as GrantStatus,
      reason: row.reason,
      revokedByUserId: row.revokedByUserId,
      revokedByUsername: row.revokedByUserId ? names.get(row.revokedByUserId) ?? null : null,
      revokedAt: iso(row.revokedAt),
      scope,
    };
  });
}

async function requireAuthority(
  tx: Tx,
  client: string,
  authorization: ServiceAuthorityContext,
  capability: string,
): Promise<string> {
  const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, capability, { requirePlantScope: false });
  if (!verdict.ok) throw new AuditError(verdict.refusal.message, verdict.refusal.remedy, 'AUDIT_AUTHORITY');
  return verdict.username;
}

async function requireCapability(tx: Tx, client: string, userId: string, capability: string): Promise<void> {
  const held = await loadCapabilities(tx, client, userId);
  if (!hasCapability(held, capability)) {
    throw new AuditError(
      `You do not hold the authority ${capability}.`,
      `Ask an administrator to assign ${capability} to one of your roles.`,
      'AUDIT_AUTHORITY',
    );
  }
}

// ── The audited auditor ─────────────────────────────────────────────────────

/**
 * Write one row to the existing access log. Append-only: this module exposes no
 * update or delete of `audit_access_log`, and the runtime role holds INSERT and
 * SELECT on it and nothing else.
 */
export async function logAuditAccess(tx: Tx, entry: AccessLogEntry): Promise<void> {
  await tx.insert(auditAccessLog).values({
    id: randomUUID(),
    client: entry.client,
    userId: entry.userId,
    username: entry.username ?? null,
    eventType: entry.eventType,
    transactionCode: entry.transactionCode ?? AUDIT_WORKSPACE_CAPABILITY,
    objectType: entry.route,
    objectKey: entry.objectKey ?? null,
    detail: entry.detail ?? null,
    grantId: entry.grantId ?? null,
  });
}

// ── Grants ──────────────────────────────────────────────────────────────────

/**
 * Bring a grant's stored status in line with its dates. Writes only when they
 * differ, so it is safe to call on every read.
 */
export async function refreshGrantStatus(tx: Tx, client: string, grantId: string): Promise<GrantStatus> {
  const rows = await tx
    .select()
    .from(auditGrant)
    .where(and(eq(auditGrant.client, client), eq(auditGrant.grantId, grantId)));
  const row = rows[0];
  if (!row) throw new AuditError(`Audit grant ${grantId} does not exist.`, 'Check the grant id.', 'AUDIT_GRANT_NOT_FOUND');
  const status = effectiveGrantStatus(row);
  if (status !== row.status) {
    await tx
      .update(auditGrant)
      .set({ status, changedBy: 'AUDIT_REFRESH', changedAt: new Date() })
      .where(and(eq(auditGrant.client, client), eq(auditGrant.grantId, grantId)));
  }
  return status;
}

/** The grant live for this person today, refreshed, or null. */
export async function activeGrantFor(tx: Tx, client: string, userId: string): Promise<AuditGrantView | null> {
  const open = await tx
    .select({ grantId: auditGrant.grantId })
    .from(auditGrant)
    .where(
      and(
        eq(auditGrant.client, client),
        eq(auditGrant.auditorUserId, userId),
        inArray(auditGrant.status, ['DRAFT', 'ACTIVE']),
      ),
    );
  let live: string | null = null;
  for (const { grantId } of open) {
    const status = await refreshGrantStatus(tx, client, grantId);
    if (status === 'ACTIVE' && !live) live = grantId;
  }
  if (!live) return null;
  return (await loadGrantViews(tx, client, [live]))[0] ?? null;
}

/** Validate the scope rows against the tenant's own masters. Throws by name. */
async function validateScope(
  tx: Tx,
  client: string,
  scope: ReadonlyArray<{ kind: string; value: string }>,
): Promise<Array<{ kind: AuditScopeKind; value: string }>> {
  const rows = scope
    .map((row) => ({ kind: row.kind.trim().toUpperCase(), value: row.value.trim().toUpperCase() }))
    .filter((row) => row.kind !== '' || row.value !== '');

  if (rows.length === 0) {
    throw new AuditError(
      'An auditor grant must be limited to at least one company code, period or module. No audit_grant_scope row was given.',
      'Add at least one scope row: a company code, a period (YYYYPP) or a module.',
      'AUDIT_GRANT_NO_SCOPE',
    );
  }

  const out: Array<{ kind: AuditScopeKind; value: string }> = [];
  for (const row of rows) {
    if (!(AUDIT_SCOPE_KINDS as readonly string[]).includes(row.kind)) {
      throw new AuditError(
        `Scope kind "${row.kind}" is not one of ${AUDIT_SCOPE_KINDS.join(', ')}.`,
        'Choose a company code, a period or a module.',
        'AUDIT_GRANT_SCOPE_KIND',
      );
    }
    if (row.value === '') {
      throw new AuditError(`A ${SCOPE_LABEL[row.kind as AuditScopeKind]} scope row has no value.`, 'Enter a value or remove the row.', 'AUDIT_GRANT_SCOPE_VALUE');
    }
    out.push({ kind: row.kind as AuditScopeKind, value: row.value });
  }

  const companies = out.filter((r) => r.kind === 'COMPANY_CODE').map((r) => r.value);
  if (companies.length > 0) {
    const found = (await tx.execute(sql`
      select company_code from company_code
       where client = ${client} and company_code in (${sql.join(companies.map((c) => sql`${c}`), sql`, `)})
    `)) as unknown as Array<{ company_code: string }>;
    const known = new Set(found.map((r) => String(r.company_code)));
    const missing = companies.find((c) => !known.has(c));
    if (missing) {
      throw new AuditError(`Company code ${missing} does not exist in this tenant.`, 'Choose a company code that is defined.', 'AUDIT_GRANT_COMPANY');
    }
  }

  for (const row of out.filter((r) => r.kind === 'MODULE')) {
    if (!(AUDIT_SCOPE_MODULES as readonly string[]).includes(row.value)) {
      throw new AuditError(
        `Module ${row.value} is not one an audit grant can name.`,
        `Choose one of ${AUDIT_SCOPE_MODULES.join(', ')}.`,
        'AUDIT_GRANT_MODULE',
      );
    }
  }

  // A period is YYYYPP and must be a period the fiscal year variant of the scoped
  // company codes (or, with none named, of any company code) defines. Open or closed
  // does not matter: auditors read closed years.
  for (const row of out.filter((r) => r.kind === 'PERIOD')) {
    if (!/^\d{6}$/.test(row.value)) {
      throw new AuditError(`Period ${row.value} is not in the form YYYYPP.`, 'Enter the fiscal year and period, for example 202610.', 'AUDIT_GRANT_PERIOD_FORMAT');
    }
    const year = Number(row.value.slice(0, 4));
    const period = Number(row.value.slice(4));
    const companyFilter = companies.length > 0
      ? sql`and c.company_code in (${sql.join(companies.map((c) => sql`${c}`), sql`, `)})`
      : sql.empty();
    const defined = (await tx.execute(sql`
      select 1
        from fiscal_year_period p
        join company_code c on c.client = p.client and c.fiscal_year_variant = p.variant
       where p.client = ${client}
         and p.period = ${period}
         and (p.calendar_year = 0 or p.calendar_year = ${year})
         ${companyFilter}
       limit 1
    `)) as unknown as unknown[];
    if (defined.length === 0) {
      throw new AuditError(
        `Period ${row.value} is not a period of any fiscal year variant ${companies.length ? `of company code ${companies.join(', ')}` : 'in this tenant'}.`,
        'Name a period the fiscal year variant defines.',
        'AUDIT_GRANT_PERIOD_UNKNOWN',
      );
    }
  }

  return out;
}

/** Grant time-boxed, scoped, read-only access. Controller only (AUDIT.ACCESS.GRANT). */
export async function createAuditGrant(input: CreateAuditGrantInput): Promise<AuditGrantView> {
  const reason = (input.reason ?? '').trim();
  if (reason.length === 0) {
    throw new AuditError('An auditor grant needs a reason.', 'Say which engagement this access is for.', 'AUDIT_GRANT_REASON');
  }
  if (reason.length > REASON_MAX) {
    throw new AuditError(`The reason is longer than ${REASON_MAX} characters.`, 'Shorten it.', 'AUDIT_GRANT_REASON');
  }
  if (!input.validFrom || !isValidDate(input.validFrom)) {
    throw new AuditError('The grant needs a start date (YYYY-MM-DD).', 'Enter the first day the auditor may read.', 'AUDIT_GRANT_FROM');
  }
  if (!input.validTo) {
    throw new AuditError(
      'An auditor grant is always time-boxed: it needs an end date.',
      'Enter the last day the auditor may read. An open-ended grant is not allowed.',
      'AUDIT_GRANT_UNBOXED',
    );
  }
  if (!isValidDate(input.validTo)) {
    throw new AuditError('The end date is not a date (YYYY-MM-DD).', 'Enter the last day the auditor may read.', 'AUDIT_GRANT_UNBOXED');
  }
  if (input.validTo <= input.validFrom) {
    throw new AuditError(
      `The grant must end after it starts: ${input.validTo} is not after ${input.validFrom}.`,
      'Choose an end date later than the start date.',
      'AUDIT_GRANT_PERIOD',
    );
  }
  if (!input.auditorUserId?.trim()) {
    throw new AuditError('Name the person who is to receive read access.', 'Choose the auditor.', 'AUDIT_GRANT_AUDITOR');
  }

  const grantId = input.requestKey && UUID.test(input.requestKey) ? input.requestKey.toLowerCase() : randomUUID();

  return withTenant(input.client, async (tx) => {
    const username = await requireAuthority(tx, input.client, input.authorization, AUDIT_GRANT_CAPABILITY);

    // A resubmitted form finds its own grant instead of making a second one.
    const existing = await loadGrantViews(tx, input.client, [grantId]);
    if (existing[0]) return existing[0];

    const scope = await validateScope(tx, input.client, input.scope);

    const auditorRows = await tx
      .select({ id: appUser.id, username: appUser.username, isActive: appUser.isActive })
      .from(appUser)
      .where(and(eq(appUser.client, input.client), eq(appUser.id, input.auditorUserId.trim())));
    const auditor = auditorRows[0];
    if (!auditor || !auditor.isActive) {
      throw new AuditError('That auditor is not an active user of this tenant.', 'Choose an active user.', 'AUDIT_GRANT_AUDITOR');
    }
    if (auditor.id === input.authorization.userId) {
      throw new AuditError(
        'You cannot grant audit access to yourself.',
        'A grant is given by a controller to somebody else.',
        'AUDIT_GRANT_SELF',
      );
    }
    const auditorCaps = await loadCapabilities(tx, input.client, auditor.id);
    if (!hasCapability(auditorCaps, AUDIT_WORKSPACE_CAPABILITY)) {
      throw new AuditError(
        `${auditor.username} does not hold ${AUDIT_WORKSPACE_CAPABILITY}, so they could not open the workspace.`,
        `Assign a role carrying ${AUDIT_WORKSPACE_CAPABILITY} and the display authorities they need, then grant access.`,
        'AUDIT_GRANT_NO_WORKSPACE',
      );
    }

    // One standing grant per auditor per tenant — otherwise "what may they read" has two answers.
    const standing = await tx
      .select({ grantId: auditGrant.grantId })
      .from(auditGrant)
      .where(
        and(
          eq(auditGrant.client, input.client),
          eq(auditGrant.auditorUserId, auditor.id),
          inArray(auditGrant.status, ['DRAFT', 'ACTIVE']),
        ),
      );
    for (const row of standing) {
      const status = await refreshGrantStatus(tx, input.client, row.grantId);
      if (status === 'DRAFT' || status === 'ACTIVE') {
        throw new AuditError(
          `${auditor.username} already holds audit grant ${row.grantId} (${status}). One standing grant per auditor.`,
          'Revoke that grant first, or wait for it to end.',
          'AUDIT_GRANT_DUPLICATE',
        );
      }
    }

    const status = effectiveGrantStatus({ validFrom: input.validFrom, validTo: input.validTo!, revokedAt: null, status: 'DRAFT' });
    await tx.insert(auditGrant).values({
      client: input.client,
      grantId,
      auditorUserId: auditor.id,
      grantedByUserId: input.authorization.userId,
      validFrom: input.validFrom,
      validTo: input.validTo!,
      status,
      reason,
      createdBy: username,
    });
    for (const row of scope) {
      await tx
        .insert(auditGrantScope)
        .values({ client: input.client, grantId, scopeKind: row.kind, scopeValue: row.value })
        .onConflictDoNothing();
    }

    await recordChange(tx, {
      client: input.client,
      objectClass: AUDIT_GRANT_OBJECT_CLASS,
      objectKey: grantId,
      changeType: 'CREATE',
      changedBy: username,
      transactionCode: AUDIT_GRANT_CAPABILITY,
      reason,
      after: {
        auditor: auditor.username,
        validFrom: input.validFrom,
        validTo: input.validTo,
        status,
        scope: scope.map((r) => `${r.kind}:${r.value}`).join(' '),
      },
      securityRelevantFields: ['auditor', 'validFrom', 'validTo', 'scope'],
    });
    await logAuditAccess(tx, {
      client: input.client,
      userId: input.authorization.userId,
      username,
      eventType: 'CONFIG_CHANGE',
      route: AUDIT_GRANT_ROUTE,
      transactionCode: AUDIT_GRANT_CAPABILITY,
      objectKey: grantId,
      detail: `Audit grant to ${auditor.username} ${input.validFrom}..${input.validTo}: ${scope.map((r) => `${r.kind}=${r.value}`).join(', ')}`,
      grantId,
    });

    return (await loadGrantViews(tx, input.client, [grantId]))[0]!;
  });
}

/** Revoke a grant. Controller only. The auditor's next read is refused. */
export async function revokeAuditGrant(input: RevokeAuditGrantInput): Promise<AuditGrantView> {
  const reason = (input.reason ?? '').trim();
  if (!reason) {
    throw new AuditError('Revoking a grant needs a reason.', 'Say why access is being withdrawn.', 'AUDIT_REVOKE_REASON');
  }
  return withTenant(input.client, async (tx) => {
    const username = await requireAuthority(tx, input.client, input.authorization, AUDIT_GRANT_CAPABILITY);
    const status = await refreshGrantStatus(tx, input.client, input.grantId);
    if (status === 'REVOKED' || status === 'EXPIRED') {
      throw new AuditError(
        `Audit grant ${input.grantId} is already ${status}.`,
        'There is nothing to revoke.',
        'AUDIT_GRANT_CLOSED',
      );
    }
    const now = new Date();
    await tx
      .update(auditGrant)
      .set({
        status: 'REVOKED',
        revokedByUserId: input.authorization.userId,
        revokedAt: now,
        changedBy: username,
        changedAt: now,
      })
      .where(and(eq(auditGrant.client, input.client), eq(auditGrant.grantId, input.grantId)));
    await recordChange(tx, {
      client: input.client,
      objectClass: AUDIT_GRANT_OBJECT_CLASS,
      objectKey: input.grantId,
      changeType: 'CHANGE',
      changedBy: username,
      transactionCode: AUDIT_GRANT_CAPABILITY,
      reason,
      before: { status },
      after: { status: 'REVOKED' },
      securityRelevantFields: ['status'],
    });
    await logAuditAccess(tx, {
      client: input.client,
      userId: input.authorization.userId,
      username,
      eventType: 'CONFIG_CHANGE',
      route: AUDIT_GRANT_ROUTE,
      transactionCode: AUDIT_GRANT_CAPABILITY,
      objectKey: input.grantId,
      detail: `Audit grant revoked: ${reason}`,
      grantId: input.grantId,
    });
    return (await loadGrantViews(tx, input.client, [input.grantId]))[0]!;
  });
}

/** Every grant in the tenant, newest first, with its effective status. */
export async function listGrants(client: string): Promise<AuditGrantView[]> {
  return withTenant(client, (tx) => loadGrantViews(tx, client));
}

/** The users a grant could be given to, for the grant form's picker. */
export async function listGrantableUsers(client: string): Promise<Array<{ userId: string; username: string; fullName: string }>> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ userId: appUser.id, username: appUser.username, fullName: appUser.fullName })
      .from(appUser)
      .where(and(eq(appUser.client, client), eq(appUser.isActive, true)))
      .orderBy(appUser.username);
    const out = [];
    for (const row of rows) {
      if (hasCapability(await loadCapabilities(tx, client, row.userId), AUDIT_WORKSPACE_CAPABILITY)) out.push(row);
    }
    return out;
  });
}

// ── Reads under a grant ─────────────────────────────────────────────────────

/**
 * Judge one read under the reader's grant, log it, and commit before answering.
 *
 * The refusal is thrown only after the transaction has committed, because two of its
 * effects must survive it: a grant whose window has closed is set EXPIRED, and the
 * refused attempt is itself logged — the auditor's failed reads are part of what the
 * auditor did.
 */
async function enforceAuditRead(
  actor: AuditActor,
  capability: string,
  probe: ScopeProbe,
  access: { route: string; eventType: 'READ' | 'EXPORT'; detail: string; objectKey?: string },
): Promise<AuditGrantView> {
  return enforceAuditAccess(actor, { capabilities: [capability], probe }, access);
}

/** What a gated access must satisfy. Every part is judged by the server, now, on every call. */
export interface AuditAccessRequest {
  /** Every capability the access needs (e.g. AUDIT.WORKSPACE + AUDIT.PERIOD.EVIDENCE + AUDIT.EVIDENCE.EXPORT). */
  capabilities: readonly string[];
  /** The scope levels actually provided; only these are judged against the grant. */
  probe: ScopeProbe;
  /** Organisational reach checked by the ordinary authority engine for each capability (e.g. the company code). */
  org?: OrgScope;
  /** Require exactly this grant: it must belong to the actor and be live today. Without it, the actor's live grant is used. */
  grantId?: string;
  /** Default true. False when the caller logs its own success inside the transaction that does the work. */
  logSuccess?: boolean;
}

/**
 * `enforceAuditRead` generalised to several capabilities, an organisational reach and an exact grant.
 *
 * Judges, in order: each capability (with the actor's current organisational restrictions), a live grant
 * (the named one, or the actor's own), then the scope probe. Every refusal is logged as CAPABILITY_DENIED and
 * the transaction COMMITS before the error is thrown, so a denied attempt is never rolled back with its own
 * log row. A success is logged with the event type the caller names.
 */
export async function enforceAuditAccess(
  actor: AuditActor,
  request: AuditAccessRequest,
  access: { route: string; eventType: 'READ' | 'EXPORT'; detail: string; objectKey?: string; transactionCode?: string },
): Promise<AuditGrantView> {
  const verdict = await withTenant(actor.client, async (tx) => {
    const deny = async (why: string, grantId: string | null, error: AuditError) => {
      await logAuditAccess(tx, {
        client: actor.client, userId: actor.userId, username: actor.username,
        eventType: 'CAPABILITY_DENIED', route: access.route, objectKey: access.objectKey,
        transactionCode: access.transactionCode, detail: `Refused ${access.eventType} (${access.detail}): ${why}`.slice(0, 500), grantId,
      });
      return { error };
    };
    for (const capability of request.capabilities) {
      if (!(await canTx(tx, actor.client, actor.userId, capability, request.org ?? {}))) {
        return deny(
          `the authority ${capability} is not held${request.org?.companyCode ? ` for company code ${request.org.companyCode}` : ''}`, null,
          new AuditError(
            `You do not hold the authority ${capability}${request.org?.companyCode ? ` for company code ${request.org.companyCode}` : ''}.`,
            `Ask an administrator to assign ${capability} to one of your roles.`,
            'AUDIT_AUTHORITY',
          ),
        );
      }
    }
    let grant: AuditGrantView | null;
    if (request.grantId) {
      const named = (await loadGrantViews(tx, actor.client, [request.grantId]))[0] ?? null;
      grant = named && named.auditorUserId === actor.userId && named.status === 'ACTIVE' ? named : null;
      if (named && named.auditorUserId !== actor.userId) {
        return deny('the grant does not belong to the requester', named.grantId, new AuditError('This item was requested under a grant that is not yours.', undefined, 'AUDIT_NO_GRANT'));
      }
      if (!grant) {
        const why = !named ? 'the original audit grant no longer exists'
          : named.status === 'EXPIRED' ? `the original audit grant ${named.grantId} ended on ${named.validTo}`
            : named.status === 'REVOKED' ? `the original audit grant ${named.grantId} was revoked`
              : `the original audit grant ${named.grantId} is not live`;
        return deny(why, named?.grantId ?? request.grantId, new AuditError(
          `${why.charAt(0).toUpperCase()}${why.slice(1)}. Nothing can be read under it.`,
          'Ask the controller who grants audit access for a new, time-boxed grant.',
          named?.status === 'EXPIRED' ? 'AUDIT_GRANT_EXPIRED' : named?.status === 'REVOKED' ? 'AUDIT_GRANT_REVOKED' : 'AUDIT_NO_GRANT',
        ));
      }
    } else {
      grant = await activeGrantFor(tx, actor.client, actor.userId);
    }
    if (!grant) {
      const last = (await loadGrantViews(tx, actor.client)).find((g) => g.auditorUserId === actor.userId) ?? null;
      const why = last?.status === 'EXPIRED'
        ? `Your audit grant ${last.grantId} ended on ${last.validTo}; it is now EXPIRED.`
        : last?.status === 'REVOKED'
          ? `Your audit grant ${last.grantId} was revoked.`
          : last?.status === 'DRAFT'
            ? `Your audit grant ${last.grantId} starts on ${last.validFrom}.`
            : 'You hold no audit grant in this tenant.';
      return deny(why, last?.grantId ?? null, new AuditError(
        `${why} Nothing can be read under it.`,
        'Ask the controller who grants audit access for a new, time-boxed grant.',
        last?.status === 'EXPIRED' ? 'AUDIT_GRANT_EXPIRED' : last?.status === 'REVOKED' ? 'AUDIT_GRANT_REVOKED' : 'AUDIT_NO_GRANT',
      ));
    }
    const gap = scopeGap(grant, request.probe);
    if (gap) {
      return deny(`${SCOPE_LABEL[gap.kind]} ${gap.value} is outside the grant`, grant.grantId, new AuditError(
        `The ${SCOPE_LABEL[gap.kind]} ${gap.value} is outside your audit grant ${grant.grantId}, which covers ${SCOPE_LABEL[gap.kind]} ${grant.scope[gap.kind].join(', ')}.`,
        'Ask the controller to widen the grant, or stay within it.',
        'AUDIT_OUT_OF_SCOPE',
      ));
    }
    if (request.logSuccess !== false) {
      await logAuditAccess(tx, {
        client: actor.client, userId: actor.userId, username: actor.username,
        eventType: access.eventType, route: access.route, objectKey: access.objectKey,
        transactionCode: access.transactionCode, detail: access.detail, grantId: grant.grantId,
      });
    }
    return { grant };
  });
  if ('error' in verdict) throw verdict.error;
  return verdict.grant;
}

/**
 * Is this exact grant still live, the requester's own, and does it cover the probe? No writes, no logging:
 * the caller (a background job re-judging its submitter) decides what to record. Judged on the dates and the
 * revocation, never on a stored status.
 */
export async function grantStillCovers(
  tx: Tx,
  client: string,
  grantId: string,
  userId: string,
  probe: ScopeProbe,
): Promise<{ ok: true; grant: AuditGrantView } | { ok: false; code: string; why: string }> {
  const grant = (await loadGrantViews(tx, client, [grantId]))[0] ?? null;
  if (!grant) return { ok: false, code: 'GRANT_MISSING', why: 'the original audit grant no longer exists' };
  if (grant.auditorUserId !== userId) return { ok: false, code: 'GRANT_REASSIGNED', why: 'the audit grant no longer belongs to the requester' };
  if (grant.status === 'REVOKED') return { ok: false, code: 'GRANT_REVOKED', why: `the audit grant ${grantId} was revoked` };
  if (grant.status === 'EXPIRED') return { ok: false, code: 'GRANT_EXPIRED', why: `the audit grant ${grantId} has expired` };
  if (grant.status !== 'ACTIVE') return { ok: false, code: 'GRANT_NOT_LIVE', why: `the audit grant ${grantId} is not live` };
  const gap = scopeGap(grant, probe);
  if (gap) return { ok: false, code: 'OUT_OF_SCOPE', why: `${SCOPE_LABEL[gap.kind]} ${gap.value} is outside the grant` };
  return { ok: true, grant };
}

/**
 * A read of the business under the grant: refused outside scope, refused after the
 * window (which expires the grant), logged either way. The read-only chain screens
 * use their own display capabilities; this is the gate the workspace's own reads pass.
 */
export async function assertAuditRead(
  actor: AuditActor,
  probe: ScopeProbe,
  access: { route: string; detail: string; objectKey?: string },
): Promise<AuditGrantView> {
  return enforceAuditRead(actor, AUDIT_WORKSPACE_CAPABILITY, probe, { ...access, eventType: 'READ' });
}

/**
 * Log one view of an audit screen. Called from a client island through a server
 * action, never during render. Never refuses: a person with no grant may open the
 * workspace to read why, and that look is logged too.
 */
export async function recordAuditView(actor: AuditActor, route: string, detail: string): Promise<void> {
  await withTenant(actor.client, async (tx) => {
    const grant = await activeGrantFor(tx, actor.client, actor.userId);
    await logAuditAccess(tx, {
      client: actor.client, userId: actor.userId, username: actor.username,
      eventType: 'READ', route, detail, grantId: grant?.grantId ?? null,
    });
  });
}

/**
 * Change history of one object — master data as it stood when a document was posted
 * (SM20 / SCU3). AUDIT.TRAIL.VIEW, inside the grant's module (and company code, when
 * one is named). The search terms are logged.
 */
export async function searchChangeHistory(
  actor: AuditActor,
  input: { objectClass: string; objectKey: string; module: string; companyCode?: string },
) {
  const objectClass = input.objectClass.trim();
  const objectKey = input.objectKey.trim();
  const module = input.module.trim().toUpperCase();
  if (!objectClass || !objectKey) {
    throw new AuditError('Name the object class and the object key to search.', 'For example gl_account and 1000/400000.', 'AUDIT_SEARCH_TERMS');
  }
  if (!(AUDIT_SCOPE_MODULES as readonly string[]).includes(module)) {
    throw new AuditError(`Module ${module || '(none)'} is not one the workspace searches.`, `Choose one of ${AUDIT_SCOPE_MODULES.join(', ')}.`, 'AUDIT_SEARCH_MODULE');
  }
  const companyCode = input.companyCode?.trim().toUpperCase() || undefined;
  await enforceAuditRead(actor, AUDIT_TRAIL_CAPABILITY, { module, companyCode }, {
    route: AUDIT_WORKSPACE_ROUTE,
    eventType: 'READ',
    detail: `search change history ${objectClass} ${objectKey} module=${module}${companyCode ? ` company=${companyCode}` : ''}`,
    objectKey: `${objectClass}:${objectKey}`.slice(0, 120),
  });
  return withTenant(actor.client, (tx) => changeHistory(tx, actor.client, objectClass, objectKey));
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Export the evidence pack of the live grant: its findings, notes, bookmarks and
 * requests with status and response. AUDIT.EVIDENCE.EXPORT. Logged as EXPORT.
 */
export async function exportEvidence(actor: AuditActor): Promise<{ filename: string; csv: string; rows: number }> {
  const grant = await enforceAuditRead(actor, AUDIT_EXPORT_CAPABILITY, {}, {
    route: AUDIT_FINDING_ROUTE,
    eventType: 'EXPORT',
    detail: 'evidence pack: findings, notes, bookmarks and requests of the live grant',
  });
  const findings = await listFindings(actor.client, grant.grantId);
  const header = ['finding_id', 'kind', 'status', 'subject', 'body', 'object_class', 'object_key', 'raised_by', 'raised_at', 'response', 'responded_by', 'responded_at'];
  const lines = [header.join(',')];
  for (const f of findings) {
    lines.push([
      f.findingId, f.kind, f.status, f.subject, f.body, f.objectClass, f.objectKey,
      f.raisedByUsername ?? f.raisedByUserId, f.raisedAt, f.response, f.respondedByUsername ?? f.respondedByUserId, f.respondedAt,
    ].map(csvCell).join(','));
  }
  return { filename: `audit-evidence-${grant.grantId}.csv`, csv: `${lines.join('\n')}\n`, rows: findings.length };
}

// ── Working state ───────────────────────────────────────────────────────────

async function loadFindings(tx: Tx, client: string, filter: { grantId?: string; raisedBy?: string; findingId?: string }) {
  const conditions = [eq(auditFinding.client, client)];
  if (filter.grantId) conditions.push(eq(auditFinding.grantId, filter.grantId));
  if (filter.raisedBy) conditions.push(eq(auditFinding.raisedByUserId, filter.raisedBy));
  if (filter.findingId) conditions.push(eq(auditFinding.findingId, filter.findingId));
  const rows = await tx.select().from(auditFinding).where(and(...conditions)).orderBy(desc(auditFinding.raisedAt));
  const names = await usernames(tx, client, rows.flatMap((r) => [r.raisedByUserId, r.respondedByUserId]));
  return rows.map((row): FindingView => ({
    findingId: row.findingId,
    grantId: row.grantId,
    kind: row.kind as AuditFindingKind,
    subject: row.subject,
    body: row.body,
    objectClass: row.objectClass,
    objectKey: row.objectKey,
    status: row.status as AuditFindingStatus,
    response: row.response,
    raisedByUserId: row.raisedByUserId,
    raisedByUsername: names.get(row.raisedByUserId) ?? null,
    respondedByUserId: row.respondedByUserId,
    respondedByUsername: row.respondedByUserId ? names.get(row.respondedByUserId) ?? null : null,
    raisedAt: iso(row.raisedAt)!,
    respondedAt: iso(row.respondedAt),
  }));
}

/** Findings, newest first: all of them, or one grant's. */
export async function listFindings(client: string, grantId?: string): Promise<FindingView[]> {
  return withTenant(client, (tx) => loadFindings(tx, client, { grantId }));
}

/** The findings one person raised. */
export async function listFindingsRaisedBy(client: string, userId: string): Promise<FindingView[]> {
  return withTenant(client, (tx) => loadFindings(tx, client, { raisedBy: userId }));
}

/**
 * Raise a finding, note, bookmark or request to management. The auditor's own
 * working state — the one thing they write — so it needs AUDIT.WORKSPACE and nothing
 * more. Raised under the live grant when there is one.
 */
export async function raiseFinding(input: FindingInput): Promise<FindingView> {
  const kind = input.kind.trim().toUpperCase();
  if (!(AUDIT_FINDING_KINDS as readonly string[]).includes(kind)) {
    throw new AuditError(`Kind "${input.kind}" is not one of ${AUDIT_FINDING_KINDS.join(', ')}.`, 'Choose a finding, note, bookmark or request.', 'AUDIT_FINDING_KIND');
  }
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject || subject.length > SUBJECT_MAX) {
    throw new AuditError(`The subject is required and at most ${SUBJECT_MAX} characters.`, 'Give it a short subject.', 'AUDIT_FINDING_SUBJECT');
  }
  if (!body) {
    throw new AuditError('The body is required.', 'Say what was found or asked.', 'AUDIT_FINDING_BODY');
  }
  const objectClass = input.objectClass?.trim() || null;
  const objectKey = input.objectKey?.trim() || null;
  if (kind === 'BOOKMARK' && (!objectClass || !objectKey)) {
    throw new AuditError('A bookmark names what it marks.', 'Raise it from the object, which fills in its class and key.', 'AUDIT_FINDING_BOOKMARK');
  }
  const { actor } = input;

  return withTenant(actor.client, async (tx) => {
    await requireCapability(tx, actor.client, actor.userId, AUDIT_WORKSPACE_CAPABILITY);
    const live = await activeGrantFor(tx, actor.client, actor.userId);
    let grantId: string | null = live?.grantId ?? null;
    if (input.grantId) {
      if (!live || live.grantId !== input.grantId) {
        throw new AuditError(
          `Audit grant ${input.grantId} is not your live grant.`,
          'Raise it under your own live grant, or without one.',
          'AUDIT_FINDING_GRANT',
        );
      }
      grantId = input.grantId;
    }
    const findingId = randomUUID();
    await tx.insert(auditFinding).values({
      client: actor.client,
      findingId,
      grantId,
      kind,
      subject,
      body,
      objectClass,
      objectKey,
      status: 'OPEN',
      raisedByUserId: actor.userId,
      createdBy: actor.username,
    });
    await recordChange(tx, {
      client: actor.client,
      objectClass: AUDIT_FINDING_OBJECT_CLASS,
      objectKey: findingId,
      changeType: 'CREATE',
      changedBy: actor.username,
      transactionCode: AUDIT_WORKSPACE_CAPABILITY,
      after: { kind, subject, status: 'OPEN', grantId },
    });
    return (await loadFindings(tx, actor.client, { findingId }))[0]!;
  });
}

/**
 * Management's answer: a response and a status. AUDIT.REQUEST.RESPOND, and never by
 * the person who raised it — a request to management is answered by management.
 */
export async function respondToFinding(input: RespondInput): Promise<FindingView> {
  const response = (input.response ?? '').trim();
  const status = (input.status ?? '').trim().toUpperCase();
  if (!response) {
    throw new AuditError('A response needs text.', 'Write the answer.', 'AUDIT_RESPONSE_TEXT');
  }
  if (!(AUDIT_RESPONSE_STATUSES as readonly string[]).includes(status)) {
    throw new AuditError(`Status "${input.status}" is not one of ${AUDIT_RESPONSE_STATUSES.join(', ')}.`, 'Choose answered, accepted or withdrawn.', 'AUDIT_RESPONSE_STATUS');
  }
  return withTenant(input.client, async (tx) => {
    const username = await requireAuthority(tx, input.client, input.authorization, AUDIT_RESPOND_CAPABILITY);
    const rows = await tx
      .select()
      .from(auditFinding)
      .where(and(eq(auditFinding.client, input.client), eq(auditFinding.findingId, input.findingId)))
      .for('update');
    const finding = rows[0];
    if (!finding) throw new AuditError(`Finding ${input.findingId} does not exist.`, 'Check the finding.', 'AUDIT_FINDING_NOT_FOUND');
    if (finding.raisedByUserId === input.authorization.userId) {
      throw new AuditError(
        'You raised this yourself. A request to management is answered by management, not by its raiser.',
        'Ask somebody in management who holds AUDIT.REQUEST.RESPOND to answer it.',
        'AUDIT_FINDING_OWN',
      );
    }
    if (finding.status === 'ACCEPTED' || finding.status === 'WITHDRAWN') {
      throw new AuditError(
        `Finding ${input.findingId} is already ${finding.status} and closed.`,
        'Raise a new finding if there is more to say.',
        'AUDIT_FINDING_CLOSED',
      );
    }
    const now = new Date();
    await tx
      .update(auditFinding)
      .set({
        status,
        response,
        respondedByUserId: input.authorization.userId,
        respondedAt: now,
        changedBy: username,
        changedAt: now,
      })
      .where(and(eq(auditFinding.client, input.client), eq(auditFinding.findingId, input.findingId)));
    await recordChange(tx, {
      client: input.client,
      objectClass: AUDIT_FINDING_OBJECT_CLASS,
      objectKey: input.findingId,
      changeType: 'CHANGE',
      changedBy: username,
      transactionCode: AUDIT_RESPOND_CAPABILITY,
      before: { status: finding.status, response: finding.response },
      after: { status, response },
    });
    return (await loadFindings(tx, input.client, { findingId: input.findingId }))[0]!;
  });
}

// ── The workspace ───────────────────────────────────────────────────────────

/**
 * What the workspace shows. Read-only: it writes nothing — not even a status
 * refresh — so the page can render it safely. The view is logged separately, from a
 * client island through `recordAuditView`.
 */
export async function auditWorkspaceView(client: string, userId: string): Promise<WorkspaceView> {
  return withTenant(client, async (tx) => {
    const mine = (await loadGrantViews(tx, client)).filter((g) => g.auditorUserId === userId);
    const grant = mine.find((g) => g.status === 'ACTIVE') ?? null;
    const lastGrant = grant ? null : mine[0] ?? null;
    let noGrantReason: string | null = null;
    if (!grant) {
      noGrantReason = !lastGrant
        ? 'You hold no audit grant in this tenant. Audit access is granted, time-boxed and scoped, by a controller who holds AUDIT.ACCESS.GRANT.'
        : lastGrant.status === 'EXPIRED'
          ? `Your audit grant ended on ${lastGrant.validTo}. Ask ${lastGrant.grantedByUsername ?? 'the controller who granted it'} for a new one.`
          : lastGrant.status === 'REVOKED'
            ? `Your audit grant was revoked${lastGrant.revokedByUsername ? ` by ${lastGrant.revokedByUsername}` : ''}. Ask the controller who grants audit access.`
            : `Your audit grant starts on ${lastGrant.validFrom}. Until then nothing can be read under it.`;
    }
    const findings = await loadFindings(tx, client, { raisedBy: userId });
    return { grant, lastGrant, noGrantReason, findings, drillThrough: AUDIT_DRILL_THROUGH };
  });
}
