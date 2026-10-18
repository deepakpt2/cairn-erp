/** Purchase requisitions — SCR-055 / R-103 (ME51N). Item-level documents, no header record. */
import { pgTable, varchar, integer, smallint, numeric, boolean, date, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { plant, purchasingGroup, storageLocation } from '../foundation/schema';
import { material, materialGroup } from '../inventory/schema';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });

/**
 * One row per requisition item. The document type stands on the item
 * (there is no header record); item numbers step by ten and never
 * rename. Deletion is a mark, never physical deletion. Cost-centre and
 * G/L references on the assignment rows are judged by the service —
 * their masters are validity- and chart-scoped, so no plain FK stands.
 */
export const purchaseRequisitionItem = pgTable('purchase_requisition_item', {
  client: tenant(),
  requisitionNumber: varchar('requisition_number', { length: 10 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  documentType: varchar('document_type', { length: 20 }).notNull().default('STANDARD'),
  itemCategory: varchar('item_category', { length: 16 }).notNull().default('STANDARD'),
  accountAssignmentCategory: varchar('account_assignment_category', { length: 16 }),
  materialNumber: varchar('material_number', { length: 40 }),
  shortText: varchar('short_text', { length: 40 }).notNull(),
  quantity: numeric('quantity', { precision: 13, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 6 }).notNull(),
  requisitionDate: date('requisition_date', { mode: 'string' }).notNull(),
  deliveryDate: date('delivery_date', { mode: 'string' }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  storageLocation: varchar('storage_location', { length: 10 }),
  purchasingGroup: varchar('purchasing_group', { length: 3 }).notNull(),
  materialGroup: varchar('material_group', { length: 9 }),
  estimatedPrice: numeric('estimated_price', { precision: 11, scale: 2 }),
  priceUnit: numeric('price_unit', { precision: 5, scale: 0 }).notNull().default('1'),
  currency: varchar('currency', { length: 5 }),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  creationSource: varchar('creation_source', { length: 16 }).notNull().default('MANUAL'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.requisitionNumber, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }),
  foreignKey({
    columns: [t.client, t.materialNumber],
    foreignColumns: [material.client, material.materialNumber],
  }),
  foreignKey({
    columns: [t.client, t.purchasingGroup],
    foreignColumns: [purchasingGroup.client, purchasingGroup.purchasingGroup],
  }),
  foreignKey({
    columns: [t.client, t.plant, t.storageLocation],
    foreignColumns: [storageLocation.client, storageLocation.plant, storageLocation.storageLocation],
  }),
  foreignKey({
    columns: [t.client, t.materialGroup],
    foreignColumns: [materialGroup.client, materialGroup.materialGroup],
  }),
  check('pr_item_quantity_ck', sql`${t.quantity} > 0`),
  check('pr_item_price_unit_ck', sql`${t.priceUnit} > 0`),
  check('pr_item_number_ck', sql`${t.itemNumber} > 0`),
  check('pr_item_category_ck', sql`${t.itemCategory} in ('STANDARD')`),
  check('pr_item_assignment_category_ck', sql`${t.accountAssignmentCategory} is null or ${t.accountAssignmentCategory} in ('COST_CENTER')`),
  check('pr_item_source_ck', sql`${t.creationSource} in ('MANUAL')`),
]);

export const purchaseRequisitionAssignment = pgTable('purchase_requisition_assignment', {
  client: tenant(),
  requisitionNumber: varchar('requisition_number', { length: 10 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  lineNumber: smallint('line_number').notNull(),
  glAccount: varchar('gl_account', { length: 10 }).notNull(),
  costCenter: varchar('cost_center', { length: 10 }).notNull(),
  distributionPercentage: numeric('distribution_percentage', { precision: 5, scale: 2 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.requisitionNumber, t.itemNumber, t.lineNumber] }),
  foreignKey({
    columns: [t.client, t.requisitionNumber, t.itemNumber],
    foreignColumns: [purchaseRequisitionItem.client, purchaseRequisitionItem.requisitionNumber, purchaseRequisitionItem.itemNumber],
  }),
  check('pr_assignment_percentage_ck', sql`${t.distributionPercentage} > 0 and ${t.distributionPercentage} <= 100`),
  check('pr_assignment_line_ck', sql`${t.lineNumber} > 0`),
]);

/**
 * Purchase orders — SCR-056 / R-104 (ME21N). Unlike the requisition,
 * the order has a true header: supplier, purchasing organization and
 * group, company code, currency, and the release status the later
 * release round will move. The item net value is a calculated figure
 * with stated baseline semantics; conditions are a later round.
 */
export const purchaseOrder = pgTable('purchase_order', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 10 }).notNull(),
  documentType: varchar('document_type', { length: 20 }).notNull().default('STANDARD'),
  supplierNumber: varchar('supplier_number', { length: 40 }).notNull(),
  purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
  purchasingGroup: varchar('purchasing_group', { length: 3 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  currency: varchar('currency', { length: 5 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  releaseStatus: varchar('release_status', { length: 16 }).notNull().default('UNRELEASED'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber] }),
  check('po_release_status_ck', sql`${t.releaseStatus} in ('UNRELEASED', 'RELEASED')`),
]);

export const purchaseOrderItem = pgTable('purchase_order_item', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 10 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  itemCategory: varchar('item_category', { length: 16 }).notNull().default('STANDARD'),
  accountAssignmentCategory: varchar('account_assignment_category', { length: 16 }),
  materialNumber: varchar('material_number', { length: 40 }),
  shortText: varchar('short_text', { length: 40 }).notNull(),
  quantity: numeric('quantity', { precision: 13, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 6 }).notNull(),
  netPrice: numeric('net_price', { precision: 11, scale: 2 }).notNull(),
  priceUnit: numeric('price_unit', { precision: 5, scale: 0 }).notNull().default('1'),
  netValue: numeric('net_value', { precision: 13, scale: 2 }).notNull(),
  taxCode: varchar('tax_code', { length: 4 }),
  plant: varchar('plant', { length: 10 }).notNull(),
  storageLocation: varchar('storage_location', { length: 10 }),
  materialGroup: varchar('material_group', { length: 9 }),
  requisitionNumber: varchar('requisition_number', { length: 10 }),
  requisitionItem: integer('requisition_item'),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.orderNumber],
    foreignColumns: [purchaseOrder.client, purchaseOrder.orderNumber],
  }),
  foreignKey({
    columns: [t.client, t.requisitionNumber, t.requisitionItem],
    foreignColumns: [purchaseRequisitionItem.client, purchaseRequisitionItem.requisitionNumber, purchaseRequisitionItem.itemNumber],
  }),
  check('po_item_quantity_ck', sql`${t.quantity} > 0`),
  check('po_item_price_ck', sql`${t.netPrice} >= 0`),
  check('po_item_price_unit_ck', sql`${t.priceUnit} > 0`),
  check('po_item_number_ck', sql`${t.itemNumber} > 0`),
  check('po_item_category_ck', sql`${t.itemCategory} in ('STANDARD')`),
  check('po_item_assignment_category_ck', sql`${t.accountAssignmentCategory} is null or ${t.accountAssignmentCategory} in ('COST_CENTER')`),
  check('po_item_requisition_pair_ck', sql`(${t.requisitionNumber} is null) = (${t.requisitionItem} is null)`),
]);

export const purchaseOrderScheduleLine = pgTable('purchase_order_schedule_line', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 10 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  lineNumber: smallint('line_number').notNull(),
  deliveryDate: date('delivery_date', { mode: 'string' }).notNull(),
  quantity: numeric('quantity', { precision: 13, scale: 3 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.itemNumber, t.lineNumber] }),
  foreignKey({
    columns: [t.client, t.orderNumber, t.itemNumber],
    foreignColumns: [purchaseOrderItem.client, purchaseOrderItem.orderNumber, purchaseOrderItem.itemNumber],
  }),
  check('po_schedule_quantity_ck', sql`${t.quantity} > 0`),
  check('po_schedule_line_ck', sql`${t.lineNumber} > 0`),
]);

export const purchaseOrderAssignment = pgTable('purchase_order_assignment', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 10 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  lineNumber: smallint('line_number').notNull(),
  glAccount: varchar('gl_account', { length: 10 }).notNull(),
  costCenter: varchar('cost_center', { length: 10 }).notNull(),
  distributionPercentage: numeric('distribution_percentage', { precision: 5, scale: 2 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.itemNumber, t.lineNumber] }),
  foreignKey({
    columns: [t.client, t.orderNumber, t.itemNumber],
    foreignColumns: [purchaseOrderItem.client, purchaseOrderItem.orderNumber, purchaseOrderItem.itemNumber],
  }),
  check('po_assignment_percentage_ck', sql`${t.distributionPercentage} > 0 and ${t.distributionPercentage} <= 100`),
  check('po_assignment_line_ck', sql`${t.lineNumber} > 0`),
]);
