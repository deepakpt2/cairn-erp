/** General partner identity and stable role rows; organisation segments are separate future tables. */
import { pgTable, varchar, char, boolean, integer, primaryKey, check, foreignKey, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { country } from '../../platform/tables/reference';
export const businessPartner=pgTable('business_partner',{
  client:varchar('client',{length:4}).notNull().references(()=>client.client,{onDelete:'cascade'}),
  partnerNumber:varchar('partner_number',{length:40}).notNull(),
  category:varchar('category',{length:16}).notNull().default('ORGANIZATION'),
  name:varchar('name',{length:160}).notNull().default(''),
  name2:varchar('name2',{length:160}),
  searchTerm:varchar('search_term',{length:40}),
  country:char('country',{length:2}).references(()=>country.code),
  region:varchar('region',{length:80}),street:varchar('street',{length:180}),city:varchar('city',{length:100}),postalCode:varchar('postal_code',{length:20}),
  taxNumber:varchar('tax_number',{length:40}),email:varchar('email',{length:254}),phone:varchar('phone',{length:40}),
  generalStatus:varchar('general_status',{length:16}).notNull().default('INCOMPLETE'),
  isBlocked:boolean('is_blocked').notNull().default(false),version:integer('version').notNull().default(1),...auditColumns,
},t=>[
  primaryKey({columns:[t.client,t.partnerNumber]}),index('business_partner_search_idx').on(t.client,t.searchTerm),
  check('business_partner_category',sql`${t.category} in ('ORGANIZATION','PERSON')`),
  check('business_partner_status',sql`${t.generalStatus} in ('INCOMPLETE','CREATED','MAINTAINED')`),check('business_partner_version',sql`${t.version}>0`),
]);
export const bpRole=pgTable('bp_role',{
  client:varchar('client',{length:4}).notNull().references(()=>client.client,{onDelete:'cascade'}),
  partnerNumber:varchar('partner_number',{length:40}).notNull(),roleCode:varchar('role_code',{length:16}).notNull(),
  isActive:boolean('is_active').notNull().default(true),...auditColumns,
},t=>[
  primaryKey({columns:[t.client,t.partnerNumber,t.roleCode]}),
  foreignKey({columns:[t.client,t.partnerNumber],foreignColumns:[businessPartner.client,businessPartner.partnerNumber]}).onDelete('cascade'),
  check('bp_role_code',sql`${t.roleCode} in ('SUPPLIER','CUSTOMER')`),
]);
