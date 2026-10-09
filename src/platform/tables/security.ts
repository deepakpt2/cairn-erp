/**
 * Identity and access — CAIRN.md §23, engine E1
 *
 * Capability-based authorisation keyed by transaction code, with organisational
 * restrictions, plus segregation-of-duties rule evaluation at role assignment.
 */
import {
  pgTable,
  char,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { auditColumns, client } from './tenancy';

/** A person who can sign in. Scoped to a client; the same person may exist in two clients. */
export const appUser = pgTable(
  'app_user',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    username: varchar('username', { length: 40 }).notNull(),
    fullName: varchar('full_name', { length: 120 }).notNull(),
    email: varchar('email', { length: 200 }),
    /** scrypt: salt:hash, hex encoded. Never a plaintext or reversible password. */
    passwordHash: text('password_hash').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    isLocked: boolean('is_locked').notNull().default(false),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: varchar('failed_login_count', { length: 8 }).notNull().default('0'),
    /** Personal preferences: locale, date format, display density — §19, R-19 */
    preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('app_user_client_username_uq').on(t.client, t.username),
    index('app_user_client_idx').on(t.client),
  ],
);

/** A role bundles capabilities. Roles are tenant-scoped. */
export const role = pgTable(
  'role',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    code: varchar('code', { length: 40 }).notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    description: text('description'),
    /** Seeds named in §7.3: ADMINISTRATOR, CONFIGURATOR, BUYER, PLANNER, ... AUDITOR */
    isSystemRole: boolean('is_system_role').notNull().default(false),
    /** AUDITOR role cannot hold a posting capability — §16.1 */
    isReadOnly: boolean('is_read_only').notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.code] }),
    index('role_client_idx').on(t.client),
  ],
);

/**
 * A single authorisable action, identified by our own transaction code grammar
 * (CAIRN.md §4.3). Capabilities are global definitions; grants are per role.
 */
export const capability = pgTable(
  'capability',
  {
    code: varchar('code', { length: 64 }).primaryKey(),
    module: varchar('module', { length: 16 }).notNull(),
    description: text('description'),
    /** CREATE | CHANGE | DISPLAY | POST | REVERSE | APPROVE | EXECUTE | CONFIGURE */
    action: varchar('action', { length: 24 }).notNull(),
    /** true when this capability can create or change financial records (§16.1) */
    isPostingRelevant: boolean('is_posting_relevant').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('capability_module_idx').on(t.module)],
);

/**
 * A capability granted to a role.
 *
 * `capabilityCode` holds a PATTERN, not necessarily a concrete capability code:
 * `PROC.*` grants every purchasing capability, `*.*.DISPLAY` grants display
 * everywhere. Patterns are resolved at authorisation time against the capability
 * catalogue, which is why there is deliberately NO foreign key here — an earlier
 * version had one, and it was wrong, because a pattern is not a row.
 *
 * The consequence to remember: adding a new capability automatically reaches
 * every role whose pattern matches it. That is the intended behaviour — a buyer
 * role should gain a new purchasing screen without a configuration change.
 */
export const roleCapability = pgTable(
  'role_capability',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    roleCode: varchar('role_code', { length: 40 }).notNull(),
    /** A capability code, or a pattern such as PROC.* or *.*.DISPLAY. */
    capabilityCode: varchar('capability_code', { length: 64 }).notNull(),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.roleCode, t.capabilityCode] }),
    index('role_capability_role_idx').on(t.client, t.roleCode),
  ],
);

export const userRole = pgTable(
  'user_role',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    roleCode: varchar('role_code', { length: 40 }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.userId, t.roleCode] }),
    index('user_role_user_idx').on(t.client, t.userId),
  ],
);

/**
 * Organisational restriction: limits what a user may touch within a capability.
 * CAIRN.md §23 — "capability plus organisation".
 */
export const authOrgRestriction = pgTable(
  'auth_org_restriction',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    /** COMPANY_CODE | PLANT | STORAGE_LOCATION | PURCHASING_ORG | SALES_ORG | COST_CENTER */
    scopeType: varchar('scope_type', { length: 32 }).notNull(),
    scopeValue: varchar('scope_value', { length: 40 }).notNull(),
    ...auditColumns,
  },
  (t) => [index('auth_org_restriction_user_idx').on(t.client, t.userId)],
);

/** Server-side sessions (D-005). The token is stored hashed, never raw. */
export const userSession = pgTable(
  'user_session',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('user_session_token_uq').on(t.tokenHash),
    index('user_session_user_idx').on(t.client, t.userId),
  ],
);

/** Every access, change, approval, export and failed authorisation attempt — §23, §16.1 */
export const auditAccessLog = pgTable(
  'audit_access_log',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    userId: varchar('user_id', { length: 36 }),
    username: varchar('username', { length: 40 }),
    /** LOGIN | LOGOUT | LOGIN_FAILED | CAPABILITY_DENIED | READ | EXPORT | CONFIG_CHANGE */
    eventType: varchar('event_type', { length: 32 }).notNull(),
    transactionCode: varchar('transaction_code', { length: 64 }),
    objectType: varchar('object_type', { length: 64 }),
    objectKey: varchar('object_key', { length: 120 }),
    detail: text('detail'),
    ipAddress: varchar('ip_address', { length: 64 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_access_log_client_time_idx').on(t.client, t.occurredAt),
    index('audit_access_log_user_idx').on(t.client, t.userId),
  ],
);

/** Segregation-of-duties rules — §16.7. A conflict is two capabilities that must not coexist. */
export const sodRule = pgTable(
  'sod_rule',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    code: varchar('code', { length: 40 }).notNull(),
    description: text('description').notNull(),
    capabilityA: varchar('capability_a', { length: 64 }).notNull(),
    capabilityB: varchar('capability_b', { length: 64 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull().default('HIGH'),
    ...auditColumns,
  },
  (t) => [primaryKey({ columns: [t.client, t.code] })],
);
