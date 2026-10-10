/** Tenant payment-term master: no historical document is recalculated on maintenance. */
import { pgTable, varchar, integer, numeric, boolean, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
export const paymentTerms = pgTable('payment_terms', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  termsCode: varchar('terms_code', { length: 12 }).notNull(),
  description: varchar('description', { length: 160 }).notNull(),
  baselineSource: varchar('baseline_source', { length: 16 }).notNull().default('DOCUMENT_DATE'),
  netDays: integer('net_days').notNull().default(0),
  discount1Days: integer('discount1_days'),
  discount1Percent: numeric('discount1_percent', { precision: 5, scale: 2 }).notNull().default('0'),
  discount2Days: integer('discount2_days'),
  discount2Percent: numeric('discount2_percent', { precision: 5, scale: 2 }).notNull().default('0'),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.termsCode] }),
  check('payment_terms_baseline', sql`${t.baselineSource} in ('DOCUMENT_DATE','POSTING_DATE','ENTRY_DATE')`),
  check('payment_terms_net_days', sql`${t.netDays} between 0 and 3650`),
  check('payment_terms_discount1', sql`(${t.discount1Days} is null and ${t.discount1Percent}=0) or (${t.discount1Days} is not null and ${t.discount1Days} between 0 and ${t.netDays} and ${t.discount1Percent}>0 and ${t.discount1Percent}<=100)`),
  check('payment_terms_discount2', sql`(${t.discount2Days} is null and ${t.discount2Percent}=0) or (${t.discount1Days} is not null and ${t.discount2Days} is not null and ${t.discount2Days} between ${t.discount1Days} and ${t.netDays} and ${t.discount2Percent}>0 and ${t.discount2Percent}<=${t.discount1Percent})`),
  check('payment_terms_version', sql`${t.version}>0`),
]);
