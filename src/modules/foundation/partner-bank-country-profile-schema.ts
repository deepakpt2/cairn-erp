/**
 * Global partner-bank country-profile readiness registry — CAIRN.md D-060/D-061.
 *
 * Shared across tenants because profile rules are country policy. The application
 * role has SELECT only on this table; readiness starts blocked and may change only
 * through the narrow audited activation function. This table does not store bank data.
 */
import { sql } from 'drizzle-orm';
import { char, check, integer, pgTable, primaryKey, varchar } from 'drizzle-orm/pg-core';
import { country } from '../../platform/tables/reference';
import { auditColumns } from '../../platform/tables/tenancy';

export const partnerBankCountryProfile = pgTable(
  'partner_bank_country_profile',
  {
    countryCode: char('country_code', { length: 2 })
      .notNull()
      .references(() => country.code),
    /** Owner-approved source decision defining this profile's capture rules. */
    policyRevision: varchar('policy_revision', { length: 12 }).notNull(),
    /** NOT_READY | READY. The audited database function permits only NOT_READY → READY. */
    readinessStatus: varchar('readiness_status', { length: 12 }).notNull().default('NOT_READY'),
    version: integer('version').notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.countryCode] }),
    check(
      'partner_bank_country_profile_status',
      sql`${t.readinessStatus} in ('NOT_READY', 'READY')`,
    ),
    check('partner_bank_country_profile_version', sql`${t.version} > 0`),
  ],
);
