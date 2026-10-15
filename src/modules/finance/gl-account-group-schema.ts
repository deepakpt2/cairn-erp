/**
 * Finance — G/L account master configuration (SCR-028 / FS00)
 * CAIRN.md §8.2, §14.2
 *
 * The Account Group registry decides how an account may be maintained: the number range
 * it owns, and — field by field — whether the screen suppresses a field, offers it or
 * demands it. The group-side account master is the consolidation target an operational
 * account may point at. Both are tenant-local, and the registry is chart-scoped because
 * a chart owns the account-number length (OB13 `KTKTB`) its ranges are read against.
 *
 * Migration `0036` is the source of truth for the database; these definitions mirror it
 * so queries and constraints stay in step, and a contract test compares the field
 * vocabulary here, in the migration and in the screen's `GL_ACCOUNT_FIELDS`.
 */
import {
  pgTable,
  varchar,
  boolean,
  integer,
  primaryKey,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, client } from '../../platform/tables/tenancy';
import { chartOfAccounts, groupChartOfAccounts } from '../foundation/schema';

// One vocabulary for the schema, the services and the screen — see gl-account-vocabulary.ts.
export {
  ACCOUNT_TYPES,
  FIELD_STATUSES,
  GL_ACCOUNT_FIELDS,
  GL_ACCOUNT_TYPES,
  RECONCILIATION_TYPES,
  SUPPORTED_LANGUAGE_KEYS,
} from './gl-account-vocabulary';
export type {
  AccountType,
  FieldStatus,
  GlAccountField,
  GlAccountType,
  ReconciliationType,
} from './gl-account-vocabulary';

/**
 * Account Group registry (`KTOKS`) — one row per group per chart.
 *
 * A group owns a character range of account numbers and the field status matrix that
 * the FS00 screen renders from. Groups are deactivated rather than deleted while
 * accounts still belong to them.
 */
export const glAccountGroup = pgTable(
  'gl_account_group',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    chartOfAccounts: varchar('chart_of_accounts', { length: 4 }).notNull(),
    accountGroup: varchar('account_group', { length: 4 }).notNull(),
    description: varchar('description', { length: 50 }).notNull(),
    fromAccountNumber: varchar('from_account_number', { length: 10 }).notNull(),
    toAccountNumber: varchar('to_account_number', { length: 10 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.chartOfAccounts, t.accountGroup] }),
    index('gl_account_group_active_idx').on(
      t.client,
      t.chartOfAccounts,
      t.isActive,
      t.accountGroup,
    ),
    foreignKey({
      name: 'gl_account_group_client_chart_fk',
      columns: [t.client, t.chartOfAccounts],
      foreignColumns: [chartOfAccounts.client, chartOfAccounts.chartOfAccounts],
    }),
    check('gl_account_group_key_format', sql`${t.accountGroup} ~ '^[A-Z0-9]{4}$'`),
    check(
      'gl_account_group_description_nonempty',
      sql`length(btrim(${t.description})) between 1 and 50`,
    ),
    check(
      'gl_account_group_number_format',
      sql`${t.fromAccountNumber} ~ '^[A-Za-z0-9]{1,10}$' and ${t.toAccountNumber} ~ '^[A-Za-z0-9]{1,10}$'`,
    ),
    // Right-padded, so a short range bound never swallows a longer account number.
    check(
      'gl_account_group_range_ordered',
      sql`rpad(${t.fromAccountNumber}, 10, '0') <= rpad(${t.toAccountNumber}, 10, '0')`,
    ),
  ],
);

/**
 * Field status matrix — one row per (group, field).
 *
 * The screen renders entirely from these rows; a field with no row falls back to the
 * baseline in `fieldStatus.ts`. Keeping the matrix in data means a consultant can
 * tighten a group without a release.
 */
export const glAccountGroupFieldStatus = pgTable(
  'gl_account_group_field_status',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    chartOfAccounts: varchar('chart_of_accounts', { length: 4 }).notNull(),
    accountGroup: varchar('account_group', { length: 4 }).notNull(),
    fieldKey: varchar('field_key', { length: 32 }).notNull(),
    status: varchar('status', { length: 12 }).notNull().default('OPTIONAL'),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.chartOfAccounts, t.accountGroup, t.fieldKey] }),
    foreignKey({
      name: 'gl_account_group_field_status_group_fk',
      columns: [t.client, t.chartOfAccounts, t.accountGroup],
      foreignColumns: [
        glAccountGroup.client,
        glAccountGroup.chartOfAccounts,
        glAccountGroup.accountGroup,
      ],
    }),
    check(
      'gl_account_group_field_status_status',
      sql`${t.status} in ('SUPPRESS', 'OPTIONAL', 'MANDATORY')`,
    ),
    check(
      'gl_account_group_field_status_field',
      sql`${t.fieldKey} in (
        'name', 'accountType', 'glAccountType', 'isOpenItemManaged', 'reconciliationType',
        'requiresCostObject', 'isTaxRelevant', 'groupAccountNumber', 'languageKey', 'sortKey',
        'isBlockedPosting', 'isBlockedCreation'
      )`,
    ),
  ],
);

/**
 * Group-side account master — the consolidation target of `gl_account.group_account_number`.
 *
 * Built with its foreign key to the OB13 Group CoA registry but without maintenance UI
 * (R-51/D-123), so the group account F4 legitimately starts empty until a consolidation
 * round fills it.
 */
export const groupChartAccounts = pgTable(
  'group_chart_accounts',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    groupChartOfAccounts: varchar('group_chart_of_accounts', { length: 4 }).notNull(),
    groupAccountNumber: varchar('group_account_number', { length: 10 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    accountType: varchar('account_type', { length: 16 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.groupChartOfAccounts, t.groupAccountNumber] }),
    index('group_chart_accounts_active_idx').on(
      t.client,
      t.groupChartOfAccounts,
      t.isActive,
      t.groupAccountNumber,
    ),
    foreignKey({
      name: 'group_chart_accounts_registry_fk',
      columns: [t.client, t.groupChartOfAccounts],
      foreignColumns: [
        groupChartOfAccounts.client,
        groupChartOfAccounts.groupChartOfAccounts,
      ],
    }),
    check(
      'group_chart_accounts_number_format',
      sql`${t.groupAccountNumber} ~ '^[A-Za-z0-9]{1,10}$'`,
    ),
    check('group_chart_accounts_name_nonempty', sql`length(btrim(${t.name})) between 1 and 200`),
    check(
      'group_chart_accounts_type_vocabulary',
      sql`${t.accountType} in ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')`,
    ),
  ],
);
