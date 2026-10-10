/** Supplier purchasing defaults by organisation; no PO/contract/pricing document is created. */
import { pgTable,varchar,char,boolean,integer,primaryKey,foreignKey,check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client,auditColumns } from '../../platform/tables/tenancy';
import { currency } from '../../platform/tables/reference';
import { bpRole } from './business-partner-schema';
import { purchasingOrg,purchasingGroup } from './schema';
import { paymentTerms } from './payment-terms-schema';
export const supplierPurchasing=pgTable('supplier_purchasing_org',{
  client:varchar('client',{length:4}).notNull().references(()=>client.client,{onDelete:'cascade'}),partnerNumber:varchar('partner_number',{length:40}).notNull(),roleCode:varchar('role_code',{length:16}).notNull().default('SUPPLIER'),
  purchasingOrg:varchar('purchasing_org',{length:10}).notNull(),orderCurrency:char('order_currency',{length:3}).references(()=>currency.code),
  purchasingGroup:varchar('purchasing_group',{length:6}),incotermsCode:varchar('incoterms_code',{length:3}),incotermsLocation:varchar('incoterms_location',{length:160}),paymentTermsCode:varchar('payment_terms_code',{length:12}),
  purchasingStatus:varchar('purchasing_status',{length:16}).notNull().default('INCOMPLETE'),isBlocked:boolean('is_blocked').notNull().default(false),version:integer('version').notNull().default(1),...auditColumns,
},t=>[
  primaryKey({columns:[t.client,t.partnerNumber,t.purchasingOrg]}),
  foreignKey({columns:[t.client,t.partnerNumber,t.roleCode],foreignColumns:[bpRole.client,bpRole.partnerNumber,bpRole.roleCode]}).onDelete('cascade'),
  foreignKey({columns:[t.client,t.purchasingOrg],foreignColumns:[purchasingOrg.client,purchasingOrg.purchasingOrg]}),
  foreignKey({columns:[t.client,t.purchasingGroup],foreignColumns:[purchasingGroup.client,purchasingGroup.purchasingGroup]}),
  foreignKey({columns:[t.client,t.paymentTermsCode],foreignColumns:[paymentTerms.client,paymentTerms.termsCode]}),
  check('supplier_purchasing_role',sql`${t.roleCode}='SUPPLIER'`),
  check('supplier_purchasing_status',sql`${t.purchasingStatus} in ('INCOMPLETE','CREATED','MAINTAINED')`),check('supplier_purchasing_version',sql`${t.version}>0`),
  check('supplier_purchasing_delivery_term',sql`${t.incotermsCode} is null or ${t.incotermsCode} in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')`),
]);
