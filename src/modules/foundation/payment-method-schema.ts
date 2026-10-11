/** Tenant-scoped, country-specific Payment Methods definitions (§14.6, D-058). */
import { pgTable, varchar, char, boolean, integer, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { country as referenceCountry } from '../../platform/tables/reference';
import { auditColumns, client } from '../../platform/tables/tenancy';

export const PAYMENT_METHOD_DIRECTIONS = ['OUTGOING', 'INCOMING', 'BOTH'] as const;
export type PaymentMethodDirection = typeof PAYMENT_METHOD_DIRECTIONS[number];

/**
 * Definition catalogue only. Eligibility assignments, bank permissions and payment
 * media are separate configuration objects; this table never executes a payment.
 */
export const paymentMethod = pgTable('payment_method', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  country: char('country', { length: 2 }).notNull().references(() => referenceCountry.code),
  methodCode: varchar('method_code', { length: 2 }).notNull(),
  description: varchar('description', { length: 160 }).notNull(),
  allowedDirection: varchar('allowed_direction', { length: 8 }).$type<PaymentMethodDirection>().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.country, t.methodCode] }),
  check('payment_method_code', sql`${t.methodCode} ~ '^[A-Z0-9]{1,2}$'`),
  check('payment_method_description', sql`length(trim(${t.description})) > 0`),
  check('payment_method_direction', sql`${t.allowedDirection} in ('OUTGOING','INCOMING','BOTH')`),
  check('payment_method_version', sql`${t.version} > 0`),
]);
