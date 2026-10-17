/**
 * Reference data — global, not tenant-scoped.
 *
 * Countries, currencies and units of measure are the same for every tenant, so
 * they sit outside the tenant partition. They are read-only through the
 * application and maintained by migration/seed. The bank master below is the
 * one exception the owner ruled (R-86): global like the rest, but maintained
 * through the application under a capability, because banks are discovered by
 * operators long after seeding.
 */
import {
  pgTable,
  char,
  varchar,
  integer,
  boolean,
  timestamp,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

/** ISO 3166 country codes — CAIRN.md §8.2 */
export const country = pgTable(
  'country',
  {
    code: char('code', { length: 2 }).primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    /** Default currency for the country, used to prefill the onboarding wizard. */
    defaultCurrency: char('default_currency', { length: 3 }).notNull(),
    /** Decimal places for the national currency, where it differs from the default. */
    isTaxRelevant: boolean('is_tax_relevant').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('country_name_idx').on(t.name)],
);

/** Currency keys (up to five characters); ISO 4217 keys are commonly three characters. */
export const currency = pgTable(
  'currency',
  {
    code: char('code', { length: 5 }).primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    /** Minor units. 2 for USD, 3 for KWD and BHD, 0 for JPY. Matters for rounding. */
    decimalPlaces: integer('decimal_places').notNull().default(2),
    symbol: varchar('symbol', { length: 8 }),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [index('currency_name_idx').on(t.name)],
);

/** Units of measure — CAIRN.md §8.2. Conversion factors arrive with the material master. */
export const unitOfMeasure = pgTable(
  'unit_of_measure',
  {
    code: varchar('code', { length: 6 }).primaryKey(),
    name: varchar('name', { length: 80 }).notNull(),
    /** ISO 80000 quantity kind: MASS, LENGTH, VOLUME, TIME, COUNT. */
    dimension: varchar('dimension', { length: 16 }).notNull().default('COUNT'),
    /** Decimal places recommended for the unit, for quantity display. */
    decimalPlaces: integer('decimal_places').notNull().default(3),
    isBaseUnit: boolean('is_base_unit').notNull().default(false),
  },
  (t) => [index('uom_dimension_idx').on(t.dimension)],
);

/**
 * The bank master (SCR-036, migration 0044). Global like the tables above —
 * a bank is the same bank in every tenant — but maintained through the
 * application under the CFG.FIN.BANK.DEFINE capability (R-86), because house
 * banks (SCR-037) refer to banks by country and key and a tenant cannot be
 * asked to wait for a seed to learn its own bank. No tenant column, so no
 * tenant policy; the audit is actor columns, since change history files per
 * tenant and a global row has none to file under.
 */
export const bankMaster = pgTable(
  'bank_master',
  {
    bankCountry: char('bank_country', { length: 2 })
      .notNull()
      .references(() => country.code),
    bankKey: varchar('bank_key', { length: 15 }).notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    city: varchar('city', { length: 35 }),
    /** SWIFT/BIC: 8 or 11 characters, enforced by check in 0044. */
    swift: varchar('swift', { length: 11 }),
    createdBy: varchar('created_by', { length: 60 }).notNull().default('SYSTEM'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    changedBy: varchar('changed_by', { length: 60 }),
    changedAt: timestamp('changed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.bankCountry, t.bankKey] }),
    index('bank_master_name_idx').on(t.name),
  ],
);
