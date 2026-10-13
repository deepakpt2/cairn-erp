/** Tenant-scoped Central Address Management records used by address dialogs (ADRNR/CAM). */
import { pgTable, varchar, char, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, client } from '../../platform/tables/tenancy';
import { country } from '../../platform/tables/reference';

export const centralAddress = pgTable(
  'central_address',
  {
    client: varchar('client', { length: 4 })
      .notNull()
      .references(() => client.client, { onDelete: 'cascade' }),
    /** Internal number-range ID, displayed and persisted as ten digits. */
    addressNumber: char('address_number', { length: 10 }).notNull(),
    country: char('country', { length: 2 }).notNull(),
    searchTerm1: varchar('search_term_1', { length: 20 }),
    searchTerm2: varchar('search_term_2', { length: 20 }),
    street: varchar('street', { length: 60 }),
    houseNumber: varchar('house_number', { length: 10 }),
    postalCode: varchar('postal_code', { length: 10 }),
    city: varchar('city', { length: 40 }),
    region: varchar('region', { length: 3 }),
    poBox: varchar('po_box', { length: 10 }),
    poBoxPostalCode: varchar('po_box_postal_code', { length: 10 }),
    companyPostalCode: varchar('company_postal_code', { length: 10 }),
    telephone: varchar('telephone', { length: 30 }),
    telephoneExtension: varchar('telephone_extension', { length: 10 }),
    mobilePhone: varchar('mobile_phone', { length: 30 }),
    faxNumber: varchar('fax_number', { length: 30 }),
    faxExtension: varchar('fax_extension', { length: 10 }),
    emailAddress: varchar('email_address', { length: 241 }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.addressNumber] }),
    check('central_address_number_format_ck', sql`${t.addressNumber} ~ '^[0-9]{10}$'`),
    foreignKey({ name: 'central_address_country_fk', columns: [t.country], foreignColumns: [country.code] }),
  ],
);
