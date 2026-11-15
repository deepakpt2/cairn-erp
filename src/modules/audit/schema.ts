/**
 * Auditor workspace — the grant, its scope, and the engagement's working state.
 *
 * SAP reference: GRC Emergency Access Management (the time-boxed, logged, revocable
 * grant), SAP Audit Management (findings and requests to management with status and
 * response), AIS (the read-only tree the workspace opens).
 *
 * A grant carries scope and a window, never a capability. What the holder may read
 * is still decided by the display capabilities their role holds; what the grant adds
 * is the guarantee that, while it is live, nothing they hold can write
 * (src/modules/audit/read-only.ts). Migration: drizzle/9276_audit_workspace.sql.
 */
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { auditColumns, client } from '../../platform/tables/tenancy';

const tenant = () =>
  varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });

export const AUDIT_GRANT_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'REVOKED'] as const;
export type AuditGrantStatus = (typeof AUDIT_GRANT_STATUSES)[number];

export const AUDIT_SCOPE_KINDS = ['COMPANY_CODE', 'PERIOD', 'MODULE'] as const;
export type AuditScopeKind = (typeof AUDIT_SCOPE_KINDS)[number];

/** The module codes a MODULE scope row may name. */
export const AUDIT_SCOPE_MODULES = ['FIN', 'INV', 'PROD', 'PROC', 'SALES', 'CO', 'PEOPLE'] as const;
export type AuditScopeModule = (typeof AUDIT_SCOPE_MODULES)[number];

export const AUDIT_FINDING_KINDS = ['FINDING', 'NOTE', 'BOOKMARK', 'REQUEST'] as const;
export type AuditFindingKind = (typeof AUDIT_FINDING_KINDS)[number];

export const AUDIT_FINDING_STATUSES = ['OPEN', 'ANSWERED', 'ACCEPTED', 'WITHDRAWN'] as const;
export type AuditFindingStatus = (typeof AUDIT_FINDING_STATUSES)[number];

/** The agreement: who may read, granted by whom, from when until when, and why. */
export const auditGrant = pgTable(
  'audit_grant',
  {
    client: tenant(),
    grantId: varchar('grant_id', { length: 36 }).notNull(),
    auditorUserId: varchar('auditor_user_id', { length: 36 }).notNull(),
    grantedByUserId: varchar('granted_by_user_id', { length: 36 }).notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    /**
     * Not null, deliberately stricter than delegation.valid_to: an auditor grant is
     * always time-boxed, and one that never ends is the failure this column prevents.
     */
    validTo: date('valid_to', { mode: 'string' }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('DRAFT'),
    reason: text('reason').notNull(),
    revokedByUserId: varchar('revoked_by_user_id', { length: 36 }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.grantId] }),
    index('audit_grant_auditor_idx').on(t.client, t.auditorUserId),
    index('audit_grant_status_idx').on(t.client, t.status),
    check('audit_grant_period_ck', sql`${t.validTo} > ${t.validFrom}`),
    check('audit_grant_status_ck', sql`${t.status} in ('DRAFT','ACTIVE','EXPIRED','REVOKED')`),
  ],
);

/** Where a grant applies. Modelled on `delegation_scope`. */
export const auditGrantScope = pgTable(
  'audit_grant_scope',
  {
    client: tenant(),
    grantId: varchar('grant_id', { length: 36 }).notNull(),
    /** COMPANY_CODE → the company code; PERIOD → YYYYPP; MODULE → one of AUDIT_SCOPE_MODULES. */
    scopeKind: varchar('scope_kind', { length: 20 }).notNull(),
    scopeValue: varchar('scope_value', { length: 20 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.client, t.grantId, t.scopeKind, t.scopeValue] }),
    index('audit_grant_scope_grant_idx').on(t.client, t.grantId),
    check('audit_grant_scope_kind_ck', sql`${t.scopeKind} in ('COMPANY_CODE','PERIOD','MODULE')`),
    foreignKey({
      name: 'audit_grant_scope_grant_fk',
      columns: [t.client, t.grantId],
      foreignColumns: [auditGrant.client, auditGrant.grantId],
    }).onDelete('cascade'),
  ],
);

/** Working state: findings, notes, bookmarks and requests to management. */
export const auditFinding = pgTable(
  'audit_finding',
  {
    client: tenant(),
    findingId: varchar('finding_id', { length: 36 }).notNull(),
    /** Nullable: a finding raised outside a grant still stands. */
    grantId: varchar('grant_id', { length: 36 }),
    kind: varchar('kind', { length: 20 }).notNull(),
    subject: varchar('subject', { length: 120 }).notNull(),
    body: text('body').notNull(),
    /** Set for a bookmark: what it was raised against. */
    objectClass: varchar('object_class', { length: 64 }),
    objectKey: varchar('object_key', { length: 120 }),
    status: varchar('status', { length: 20 }).notNull().default('OPEN'),
    /** Management's answer. The raiser can never write it. */
    response: text('response'),
    raisedByUserId: varchar('raised_by_user_id', { length: 36 }).notNull(),
    respondedByUserId: varchar('responded_by_user_id', { length: 36 }),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.findingId] }),
    index('audit_finding_grant_idx').on(t.client, t.grantId),
    index('audit_finding_status_idx').on(t.client, t.status),
    check('audit_finding_kind_ck', sql`${t.kind} in ('FINDING','NOTE','BOOKMARK','REQUEST')`),
    check('audit_finding_status_ck', sql`${t.status} in ('OPEN','ANSWERED','ACCEPTED','WITHDRAWN')`),
  ],
);
