/**
 * Reference data — global, not tenant-scoped.
 *
 * Countries, currencies and units of measure are the same for every tenant, so
 * they sit outside the tenant partition. They are read-only through the
 * application and maintained by migration/seed.
 */
import {
  pgTable,
  char,
  varchar,
  integer,
  boolean,
  timestamp,
  index,
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

/** ISO 4217 currencies — CAIRN.md §8.2 */
export const currency = pgTable(
  'currency',
  {
    code: char('code', { length: 3 }).primaryKey(),
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
