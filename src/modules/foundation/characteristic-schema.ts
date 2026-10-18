/** Characteristics for classification — SCR-057 / R-105 (CT04). */
import { pgTable, varchar, integer, boolean, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { unitOfMeasure, currency } from '../../platform/tables/reference';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });

/**
 * The characteristic's name is its stable tenant business key — never
 * renamed. The lifecycle DRAFT / ACTIVE / BLOCKED is a Cairn workflow.
 * Description stands in the tenant language (B-223). Allowed values
 * are unique per characteristic under the declared case policy, which
 * the service judges (the stored key is the entered text).
 */
export const characteristic = pgTable('characteristic', {
  client: tenant(),
  characteristicName: varchar('characteristic_name', { length: 30 }).notNull(),
  description: varchar('description', { length: 30 }).notNull(),
  dataFormat: varchar('data_format', { length: 4 }).notNull(),
  valueLength: integer('value_length').notNull().default(30),
  decimalPlaces: integer('decimal_places').notNull().default(0),
  unit: varchar('unit', { length: 6 }).references(() => unitOfMeasure.code),
  currency: varchar('currency', { length: 3 }).references(() => currency.code),
  negativeValuesAllowed: boolean('negative_values_allowed').notNull().default(false),
  caseSensitive: boolean('case_sensitive').notNull().default(false),
  intervalsAllowed: boolean('intervals_allowed').notNull().default(false),
  additionalValuesAllowed: boolean('additional_values_allowed').notNull().default(false),
  valueAssignment: varchar('value_assignment', { length: 8 }).notNull().default('SINGLE'),
  requiredEntry: boolean('required_entry').notNull().default(false),
  lifecycleStatus: varchar('lifecycle_status', { length: 8 }).notNull().default('DRAFT'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.characteristicName] }),
  check('characteristic_name_ck', sql`${t.characteristicName} ~ '^[A-Z0-9_]{1,30}$'`),
  check('characteristic_format_ck', sql`${t.dataFormat} in ('CHAR', 'NUM', 'DATE', 'TIME', 'CURR')`),
  check('characteristic_length_ck', sql`${t.valueLength} > 0`),
  check('characteristic_decimals_ck', sql`${t.decimalPlaces} >= 0 and ${t.decimalPlaces} <= ${t.valueLength}`),
  check('characteristic_intervals_ck', sql`not ${t.intervalsAllowed} or ${t.dataFormat} in ('NUM', 'DATE', 'TIME')`),
  check('characteristic_assignment_ck', sql`${t.valueAssignment} in ('SINGLE', 'MULTIPLE')`),
  check('characteristic_lifecycle_ck', sql`${t.lifecycleStatus} in ('DRAFT', 'ACTIVE', 'BLOCKED')`),
]);

export const characteristicValue = pgTable('characteristic_value', {
  client: tenant(),
  characteristicName: varchar('characteristic_name', { length: 30 }).notNull(),
  valueText: varchar('value_text', { length: 30 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.characteristicName, t.valueText] }),
  foreignKey({
    columns: [t.client, t.characteristicName],
    foreignColumns: [characteristic.client, characteristic.characteristicName],
  }),
  check('characteristic_value_sort_ck', sql`${t.sortOrder} >= 0`),
]);
