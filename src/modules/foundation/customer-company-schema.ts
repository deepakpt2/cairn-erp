/** Customer accounting settings scoped to one company. No open-item/payment data lives here. */
import { pgTable,varchar,boolean,integer,primaryKey,foreignKey,check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client,auditColumns } from '../../platform/tables/tenancy';
import { companyCode } from './schema';
import { bpRole } from './business-partner-schema';
import { glAccount } from '../finance/schema';
import { paymentTerms } from './payment-terms-schema';
export const customerCompany=pgTable('customer_company_code',{
  client:varchar('client',{length:4}).notNull().references(()=>client.client,{onDelete:'cascade'}),
  partnerNumber:varchar('partner_number',{length:40}).notNull(),roleCode:varchar('role_code',{length:16}).notNull().default('CUSTOMER'),
  companyCode:varchar('company_code',{length:10}).notNull(),chartOfAccounts:varchar('chart_of_accounts',{length:8}).notNull(),
  reconciliationAccount:varchar('reconciliation_account',{length:20}),paymentTermsCode:varchar('payment_terms_code',{length:12}),
  companyStatus:varchar('company_status',{length:16}).notNull().default('INCOMPLETE'),
  isBlocked:boolean('is_blocked').notNull().default(false),version:integer('version').notNull().default(1),...auditColumns,
},t=>[
  primaryKey({columns:[t.client,t.partnerNumber,t.companyCode]}),
  foreignKey({columns:[t.client,t.partnerNumber,t.roleCode],foreignColumns:[bpRole.client,bpRole.partnerNumber,bpRole.roleCode]}).onDelete('cascade'),
  foreignKey({columns:[t.client,t.companyCode],foreignColumns:[companyCode.client,companyCode.companyCode]}),
  foreignKey({columns:[t.client,t.chartOfAccounts,t.reconciliationAccount],foreignColumns:[glAccount.client,glAccount.chartOfAccounts,glAccount.accountNumber]}),
  foreignKey({columns:[t.client,t.paymentTermsCode],foreignColumns:[paymentTerms.client,paymentTerms.termsCode]}),
  check('customer_company_role',sql`${t.roleCode}='CUSTOMER'`),
  check('customer_company_status',sql`${t.companyStatus} in ('INCOMPLETE','CREATED','MAINTAINED')`),check('customer_company_version',sql`${t.version}>0`),
]);
