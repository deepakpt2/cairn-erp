/**
 * Term registry and the Configuration Workbench — CAIRN.md §4.4, §7
 *
 * The registry is our answer to two requirements at once: R-01 (no proprietary
 * identifiers in our own naming) and R-03 (an experienced user must be able to
 * find things). Reference identifiers live HERE as search metadata and nowhere
 * else. See the anti-imitation checklist §19.5 AI-05.
 */
import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { auditColumns, client } from './tenancy';

/**
 * One row per concept we expose. `ourCode` or `ourTable` is the real thing;
 * `externalIdentifier` is a courtesy lookup term.
 */
export const termRegistry = pgTable(
  'term_registry',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    /** Our transaction code, when the term is a screen. */
    ourCode: varchar('our_code', { length: 64 }),
    /** Our table name, when the term is a data-model entry. */
    ourTable: varchar('our_table', { length: 80 }),
    title: varchar('title', { length: 200 }).notNull(),
    /** TRANSACTION | TABLE | CONFIG_ACTIVITY | CONCEPT | REPORT */
    termType: varchar('term_type', { length: 24 }).notNull(),
    module: varchar('module', { length: 16 }).notNull(),
    description: text('description'),
    /** TIER_1_BUILT | TIER_2_CONFIGURED | TIER_3_MAPPED | REFERENCE — §3.2, §4.4 */
    coverageTier: varchar('coverage_tier', { length: 24 }).notNull().default('TIER_1_BUILT'),
    /** Route to open when the term is chosen. */
    routePath: varchar('route_path', { length: 200 }),
    /** A / B / C conformance classification — §3.2 */
    conformanceTier: varchar('conformance_tier', { length: 2 }),
    /** For Tier 3 entries: why it is deferred and what building it would take. */
    deferralNote: text('deferral_note'),
    isSearchable: boolean('is_searchable').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    // Two upsert targets, one per kind of entry. Both must be unique, and both
    // must tolerate NULL — a transaction row has no table name and vice versa.
    uniqueIndex('term_registry_our_code_uq').on(t.ourCode),
    uniqueIndex('term_registry_our_table_uq').on(t.ourTable),
    index('term_registry_type_idx').on(t.termType),
    index('term_registry_module_idx').on(t.module),
  ],
);

/**
 * Search aliases. `externalSystem` records where the term came from so we can
 * support more than one reference vocabulary later without schema change.
 */
export const termAlias = pgTable(
  'term_alias',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    termId: varchar('term_id', { length: 36 })
      .notNull()
      .references(() => termRegistry.id, { onDelete: 'cascade' }),
    /** REFERENCE_ERP | LEGACY | INTERNAL | CUSTOMER */
    externalSystem: varchar('external_system', { length: 32 }).notNull().default('REFERENCE_ERP'),
    alias: varchar('alias', { length: 80 }).notNull(),
    /** SEARCH_ONLY | DISPLAY_ALLOWED — display-allowed aliases may appear in a lookup UI. */
    usage: varchar('usage', { length: 20 }).notNull().default('SEARCH_ONLY'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('term_alias_system_alias_uq').on(t.externalSystem, t.alias),
    index('term_alias_term_idx').on(t.termId),
  ],
);

/**
 * A Configuration Workbench activity. This is how R-06 is delivered: an
 * implementation plan maps onto this tree one activity at a time.
 * §7.1 and the define/assign chain in §6.2.
 */
export const configActivity = pgTable(
  'config_activity',
  {
    code: varchar('code', { length: 80 }).notNull(),
    /** Area in the workbench tree, e.g. ENTERPRISE_STRUCTURE, FINANCIAL_ACCOUNTING. */
    area: varchar('area', { length: 64 }).notNull(),
    subArea: varchar('sub_area', { length: 64 }),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    /** DEFINE | ASSIGN — preserved deliberately from the reference model (§7.1). */
    activityKind: varchar('activity_kind', { length: 12 }).notNull(),
    /** Activities that must be completed first, comma-separated codes. */
    prerequisites: text('prerequisites').notNull().default(''),
    /** What becomes possible once this is done. */
    enables: text('enables'),
    /** 1 = first. Drives the default ordering of the workbench tree. */
    sequence: integer('sequence').notNull().default(100),
    /** ONBOARDING | STANDARD | ADVANCED — ONBOARDING steps appear in the wizard. */
    wizardStage: varchar('wizard_stage', { length: 24 }).notNull().default('STANDARD'),
    /** Route that implements the activity. */
    routePath: varchar('route_path', { length: 200 }),
    /** CONFIG_ONLY activities write configuration and are not document screens. */
    isConfigOnly: boolean('is_config_only').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.code] }),
    index('config_activity_area_idx').on(t.area, t.sequence),
  ],
);

/** Completion state per client per activity. Drives the readiness checklist (§7.1). */
export const configActivityStatus = pgTable(
  'config_activity_status',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    activityCode: varchar('activity_code', { length: 80 })
      .notNull()
      .references(() => configActivity.code, { onDelete: 'cascade' }),
    /** NOT_STARTED | COMPLETED | SKIPPED | BLOCKED */
    status: varchar('status', { length: 20 }).notNull().default('NOT_STARTED'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: varchar('completed_by', { length: 60 }),
    note: text('note'),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.activityCode] }),
    index('config_activity_status_client_idx').on(t.client, t.status),
  ],
);
