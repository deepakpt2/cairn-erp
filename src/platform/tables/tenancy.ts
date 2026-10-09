/**
 * Tenancy — CAIRN.md §6.3, D-006
 *
 * The client (tenant) is the root of every partition. It is the first column on
 * every tenant-scoped table and is enforced by PostgreSQL row-level security,
 * not only by application code.
 */
import {
  pgTable,
  char,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/** Audit columns required on all tables — CAIRN.md §7.4 */
export const auditColumns = {
  createdBy: varchar('created_by', { length: 60 }).notNull().default('SYSTEM'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  changedBy: varchar('changed_by', { length: 60 }),
  changedAt: timestamp('changed_at', { withTimezone: true }),
};

/** Tenant. The root of all data partitioning. */
export const client = pgTable('client', {
  client: varchar('client', { length: 4 }).primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  legalName: varchar('legal_name', { length: 200 }),
  country: char('country', { length: 2 }).notNull().default('KW'),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  language: char('language', { length: 2 }).notNull().default('EN'),
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  /** DRAFT | ACTIVE | LOCKED */
  status: varchar('status', { length: 16 }).notNull().default('DRAFT'),
  /** Marks the agent's build/test tenant vs the product owner's tenant — §6.3, D-006 */
  isDevelopment: boolean('is_development').notNull().default(false),
  /** Set when onboarding completes (checklist in CAIRN.md §7.2) */
  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
  notes: text('notes'),
  ...auditColumns,
});

/** Per-tenant feature flags, display format and locale — §6.3 */
export const clientSettings = pgTable(
  'client_settings',
  {
    client: varchar('client', { length: 4 })
      .primaryKey()
      .references(() => client.client, { onDelete: 'cascade' }),
    /** D-030: our own readable format is the default; classic padded display is opt-in */
    numberDisplayFormat: varchar('number_display_format', { length: 24 })
      .notNull()
      .default('READABLE'),
    showReferenceAliases: boolean('show_reference_aliases').notNull().default(true),
    dateFormat: varchar('date_format', { length: 20 }).notNull().default('YYYY-MM-DD'),
    decimalSeparator: char('decimal_separator', { length: 1 }).notNull().default('.'),
    thousandsSeparator: char('thousands_separator', { length: 1 }).notNull().default(','),
    fiscalYearVariant: varchar('fiscal_year_variant', { length: 4 }),
    flags: jsonb('flags').$type<Record<string, boolean>>().notNull().default({}),
    ...auditColumns,
  },
  (t) => [index('client_settings_client_idx').on(t.client)],
);
