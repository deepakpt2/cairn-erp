/** Tenant-scoped supplier purchasing partner-function rules and assignments (§9.2, B-025). */
import { pgTable, varchar, boolean, integer, primaryKey, foreignKey, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { bpRole } from './business-partner-schema';
import { supplierPurchasing } from './supplier-purchasing-schema';

/** Cairn-owned keys; partner-function labels remain ordinary product vocabulary. */
export const SUPPLIER_PARTNER_FUNCTION_CODES = ['ORDERING_PARTNER', 'DELIVERY_PARTNER', 'INVOICE_SENDER'] as const;
export type SupplierPartnerFunctionCode = typeof SUPPLIER_PARTNER_FUNCTION_CODES[number];

/** Per-tenant function configuration: unique or multi-valued, with active-state control. */
export const supplierPartnerFunction = pgTable('supplier_partner_function', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  functionCode: varchar('function_code', { length: 24 }).notNull(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  allowsMultiple: boolean('allows_multiple').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, t => [
  primaryKey({ columns: [t.client, t.functionCode] }),
  check('supplier_partner_function_code', sql`${t.functionCode} in ('ORDERING_PARTNER','DELIVERY_PARTNER','INVOICE_SENDER')`),
  check('supplier_partner_function_name', sql`length(trim(${t.displayName})) > 0`),
]);

/** One directed partner assignment within a focal supplier's purchasing-organisation segment. */
export const supplierPurchasingPartner = pgTable('supplier_purchasing_partner', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  partnerNumber: varchar('partner_number', { length: 40 }).notNull(),
  purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
  functionCode: varchar('function_code', { length: 24 }).notNull(),
  assignedPartnerNumber: varchar('assigned_partner_number', { length: 40 }).notNull(),
  assignedRoleCode: varchar('assigned_role_code', { length: 16 }).notNull().default('SUPPLIER'),
  isDefault: boolean('is_default').notNull().default(false),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, t => [
  primaryKey({ columns: [t.client, t.partnerNumber, t.purchasingOrg, t.functionCode, t.assignedPartnerNumber] }),
  foreignKey({ columns: [t.client, t.partnerNumber, t.purchasingOrg], foreignColumns: [supplierPurchasing.client, supplierPurchasing.partnerNumber, supplierPurchasing.purchasingOrg] }).onDelete('cascade'),
  foreignKey({ columns: [t.client, t.functionCode], foreignColumns: [supplierPartnerFunction.client, supplierPartnerFunction.functionCode] }),
  foreignKey({ columns: [t.client, t.assignedPartnerNumber, t.assignedRoleCode], foreignColumns: [bpRole.client, bpRole.partnerNumber, bpRole.roleCode] }).onDelete('cascade'),
  check('supplier_purchasing_partner_assigned_role', sql`${t.assignedRoleCode}='SUPPLIER'`),
  check('supplier_purchasing_partner_version', sql`${t.version}>0`),
  index('supplier_purchasing_partner_assigned_idx').on(t.client, t.assignedPartnerNumber),
  uniqueIndex('supplier_purchasing_partner_default_uq').on(t.client, t.partnerNumber, t.purchasingOrg, t.functionCode).where(sql`${t.isDefault}`),
]);
