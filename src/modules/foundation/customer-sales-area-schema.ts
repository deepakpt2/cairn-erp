/** Customer sales-area defaults (pricing/delivery master only). No order, delivery or billing data lives here. */
import { pgTable,varchar,boolean,integer,smallint,primaryKey,foreignKey,check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client,auditColumns } from '../../platform/tables/tenancy';
import { salesArea,plant } from './schema';
import { bpRole } from './business-partner-schema';
export const customerSalesArea=pgTable('customer_sales_area',{
  client:varchar('client',{length:4}).notNull().references(()=>client.client,{onDelete:'cascade'}),
  partnerNumber:varchar('partner_number',{length:40}).notNull(),roleCode:varchar('role_code',{length:16}).notNull().default('CUSTOMER'),
  salesOrg:varchar('sales_org',{length:4}).notNull(),distributionChannel:varchar('distribution_channel',{length:4}).notNull(),division:varchar('division',{length:4}).notNull(),
  salesDistrict:varchar('sales_district',{length:6}),deliveringPlant:varchar('delivering_plant',{length:10}),pricingProcedure:varchar('pricing_procedure',{length:6}),
  /**
   * The customer's account assignment group — the customer half of revenue determination. Blank is a
   * group of its own and is matched as one, never as a missing value: a customer with no group is
   * determined by the rows that name none, which is the answer a tenant that has not refined its
   * revenue accounts yet expects.
   */
  accountAssignmentGroup:varchar('account_assignment_group',{length:4}),
  /**
   * KNVV-VSBED. How this customer wants goods to reach them, and the customer half of shipping
   * point determination: with the material's loading group and the delivering plant it names the
   * dock a delivery loads from.
   *
   * Null is a customer who has said nothing, and it is matched as a value — those are answered
   * by the determination rows that name no condition, never by a condition invented for them.
   * The database holds the foreign key to the shipping condition master; it is not repeated
   * here because that table is declared by the sales schema, which this file reaches through
   * the foundation schema that re-exports it.
   */
  shippingCondition:varchar('shipping_condition',{length:2}),
  completeDelivery:boolean('complete_delivery').notNull().default(false),orderCombination:boolean('order_combination').notNull().default(false),
  /**
   * KNVV-KZTLF. How much of an item may go out at once: blank leaves it free to travel in pieces,
   * 'C' says an item is delivered complete or not at all. It is a rule about the item, where the
   * complete-delivery flag beside it is a rule about the order — and it is the one a warehouse
   * feels, because two boxes today and three on Thursday is not the same work as one pallet on
   * Friday.
   */
  partialDeliveryIndicator:varchar('partial_delivery_indicator',{length:1}).notNull().default(''),
  /**
   * KNVV-ANTLF. How many times an item may be split across deliveries before the rest has to
   * travel together. Zero is a customer who has said nothing about it, and it is read as no limit:
   * a limit of zero would be a customer who can never be served, which is what indicator 'C' is
   * for.
   */
  maxPartialDeliveries:smallint('max_partial_deliveries').notNull().default(0),
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
  check('customer_sales_account_group',sql`${t.accountAssignmentGroup} is null or ${t.accountAssignmentGroup} ~ '^[A-Z0-9]{1,4}$'`),
  check('customer_sales_shipping_condition',sql`${t.shippingCondition} is null or ${t.shippingCondition} ~ '^[A-Z0-9]{1,2}$'`),
  check('customer_sales_partial_delivery',sql`${t.partialDeliveryIndicator} in ('','C')`),
  check('customer_sales_max_partial',sql`${t.maxPartialDeliveries} between 0 and 9`),
]);
