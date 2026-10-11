/**
 * Partner-wide bank-record schema — CAIRN.md §9.2 / D-059.
 *
 * Account identifiers have ciphertext-only columns. This schema is not a write
 * path: the application role is SELECT-only until encryption, rotation, masking,
 * scoped lookup, and audited reveal integrations are completed.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { auditColumns, client } from '../../platform/tables/tenancy';
import { country } from '../../platform/tables/reference';
import { businessPartner } from './business-partner-schema';

export const partnerBank = pgTable(
  'partner_bank',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    partnerNumber: varchar('partner_number', { length: 40 }).notNull(),
    /** Server-generated canonical random UUIDv4; never supplied as lookup authority. */
    bankRecordId: uuid('bank_record_id').notNull(),
    accountHolder: varchar('account_holder', { length: 160 }).notNull(),
    country: char('country', { length: 2 })
      .notNull()
      .references(() => country.code),
    bankName: varchar('bank_name', { length: 160 }),
    bankCode: varchar('bank_code', { length: 20 }),
    /** AES-256-GCM envelope; authenticated-data field name remains `iban`. */
    ibanCiphertext: varchar('iban_ciphertext', { length: 5600 }),
    /** AES-256-GCM envelope; authenticated-data field name remains `localAccountNumber`. */
    localAccountNumberCiphertext: varchar('local_account_number_ciphertext', { length: 5600 }),
    bic: varchar('bic', { length: 11 }),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.bankRecordId] }),
    foreignKey({
      columns: [t.client, t.partnerNumber],
      foreignColumns: [businessPartner.client, businessPartner.partnerNumber],
    }),
    index('partner_bank_partner_valid_from_idx').on(t.client, t.partnerNumber, t.validFrom),
    check(
      'partner_bank_uuidv4',
      sql`substring(${t.bankRecordId}::text from 15 for 1) = '4'
        and substring(${t.bankRecordId}::text from 20 for 1) in ('8', '9', 'a', 'b')`,
    ),
    check('partner_bank_account_holder', sql`length(trim(${t.accountHolder})) > 0`),
    check(
      'partner_bank_one_account_identifier',
      sql`(${t.ibanCiphertext} is not null and ${t.localAccountNumberCiphertext} is null)
        or (${t.ibanCiphertext} is null and ${t.localAccountNumberCiphertext} is not null)`,
    ),
    check(
      'partner_bank_iban_envelope',
      sql`${t.ibanCiphertext} is null or (
        ${t.ibanCiphertext} ~ '^cbd1[.][A-Za-z0-9_-]{1,32}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$'
        and char_length(${t.ibanCiphertext}) <= 5540
      )`,
    ),
    check(
      'partner_bank_local_account_envelope',
      sql`${t.localAccountNumberCiphertext} is null or (
        ${t.localAccountNumberCiphertext} ~ '^cbd1[.][A-Za-z0-9_-]{1,32}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$'
        and char_length(${t.localAccountNumberCiphertext}) <= 5540
      )`,
    ),
    check('partner_bank_validity', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
    check('partner_bank_version', sql`${t.version} > 0`),
  ],
);
