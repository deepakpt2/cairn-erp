/** Customer sales-area defaults (pricing/delivery master only). No order, delivery or billing data lives here. */
import { pgTable,varchar,boolean,integer,primaryKey,foreignKey,check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client,auditColumns } from '../../platform/tables/tenancy';
import { salesArea,plant } from './schema';
import { bpRole } from './business-partner-schema';
export const customerSalesArea=pgTable('customer_sales_area',{
  client:varchar('client',{length:4}).notNull().references(()=>client.client,{onDelete:'cascade'}),
  partnerNumber:varchar('partner_number',{length:40}).notNull(),roleCode:varchar('role_code',{length:16}).notNull().default('CUSTOMER'),
  salesOrg:varchar('sales_org',{length:10}).notNull(),distributionChannel:varchar('distribution_channel',{length:4}).notNull(),division:varchar('division',{length:4}).notNull(),
  salesDistrict:varchar('sales_district',{length:6}),deliveringPlant:varchar('delivering_plant',{length:10}),pricingProcedure:varchar('pricing_procedure',{length:6}),
  completeDelivery:boolean('complete_delivery').notNull().default(false),orderCombination:boolean('order_combination').notNull().default(false),
  salesStatus:varchar('sales_status',{length:16}).notNull().default('INCOMPLETE'),
  isBlocked:boolean('is_blocked').notNull().default(false),version:integer('version').notNull().default(1),...auditColumns,
},t=>[
  primaryKey({columns:[t.client,t.partnerNumber,t.salesOrg,t.distributionChannel,t.division]}),
  foreignKey({columns:[t.client,t.partnerNumber,t.roleCode],foreignColumns:[bpRole.client,bpRole.partnerNumber,bpRole.roleCode]}).onDelete('cascade'),
  foreignKey({columns:[t.client,t.salesOrg,t.distributionChannel,t.division],foreignColumns:[salesArea.client,salesArea.salesOrg,salesArea.distributionChannel,salesArea.division]}),
  foreignKey({columns:[t.client,t.deliveringPlant],foreignColumns:[plant.client,plant.plant]}),
  check('customer_sales_role',sql`${t.roleCode}='CUSTOMER'`),
  check('customer_sales_status',sql`${t.salesStatus} in ('INCOMPLETE','CREATED','MAINTAINED')`),check('customer_sales_version',sql`${t.version}>0`),
  check('customer_sales_district',sql`${t.salesDistrict} is null or ${t.salesDistrict} ~ '^[A-Z0-9]{1,6}$'`),
  check('customer_sales_pricing_procedure',sql`${t.pricingProcedure} is null or ${t.pricingProcedure} ~ '^[A-Z0-9]{1,6}$'`),
]);
