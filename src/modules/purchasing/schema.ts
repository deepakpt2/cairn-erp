/** Purchase requisitions — SCR-055 / R-103 (ME51N). Item-level documents, no header record. */
import { pgTable, varchar, char, integer, bigint, smallint, numeric, boolean, date, timestamp, primaryKey, foreignKey, unique, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { currency, unitOfMeasure } from '../../platform/tables/reference';
import { plant, purchasingGroup, purchasingOrg, storageLocation } from '../foundation/schema';
import { bpRole } from '../foundation/business-partner-schema';
import { supplierPurchasing } from '../foundation/supplier-purchasing-schema';
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
  /** Set when total planning created the item. A buyer's requisition leaves this empty and is not rewritten. */
  planningRunNumber: varchar('planning_run_number', { length: 12 }),
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
  uniqueIndex('pr_item_planning_origin_uq').on(t.client, t.planningRunNumber, t.materialNumber, t.plant).where(sql`${t.planningRunNumber} is not null`),
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
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
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

/**
 * Purchasing info record — SCR-151. A default, not an order.
 *
 * The general row is the supplier and the material. The segment is the
 * purchasing organisation and, when named, the plant. A blank plant is
 * null. The price row is the only price; the segment does not carry one.
 * The unique index that treats a null plant as a value lives in migration
 * 9093, because this drizzle version cannot say NULLS NOT DISTINCT.
 */
export const purchasingInfoRecord = pgTable('purchasing_info_record', {
  client: tenant(),
  infoRecordNumber: varchar('info_record_number', { length: 20 }).notNull(),
  partnerNumber: varchar('partner_number', { length: 40 }).notNull(),
  roleCode: varchar('role_code', { length: 16 }).notNull().default('SUPPLIER'),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  category: varchar('category', { length: 16 }).notNull().default('STANDARD'),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.infoRecordNumber] }),
  foreignKey({
    columns: [t.client, t.partnerNumber, t.roleCode],
    foreignColumns: [bpRole.client, bpRole.partnerNumber, bpRole.roleCode],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.materialNumber],
    foreignColumns: [material.client, material.materialNumber],
  }).onDelete('restrict'),
  check('purchasing_info_record_role_ck', sql`${t.roleCode} = 'SUPPLIER'`),
  check('purchasing_info_record_category_ck', sql`${t.category} = 'STANDARD'`),
  check('purchasing_info_record_version_ck', sql`${t.version} > 0`),
]);

export const purchasingInfoRecordOrg = pgTable('purchasing_info_record_org', {
  client: tenant(),
  infoRecordNumber: varchar('info_record_number', { length: 20 }).notNull(),
  segmentNumber: integer('segment_number').notNull(),
  purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
  plant: varchar('plant', { length: 10 }),
  plannedDeliveryDays: integer('planned_delivery_days'),
  minimumOrderQuantity: numeric('minimum_order_quantity', { precision: 13, scale: 3 }),
  minimumOrderUnit: varchar('minimum_order_unit', { length: 6 }),
  orderUnit: varchar('order_unit', { length: 6 }),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.infoRecordNumber, t.segmentNumber] }),
  foreignKey({
    columns: [t.client, t.infoRecordNumber],
    foreignColumns: [purchasingInfoRecord.client, purchasingInfoRecord.infoRecordNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.purchasingOrg],
    foreignColumns: [purchasingOrg.client, purchasingOrg.purchasingOrg],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.minimumOrderUnit],
    foreignColumns: [unitOfMeasure.code],
  }),
  foreignKey({
    columns: [t.orderUnit],
    foreignColumns: [unitOfMeasure.code],
  }),
  check('purchasing_info_record_org_segment_ck', sql`${t.segmentNumber} > 0`),
  check('purchasing_info_record_org_version_ck', sql`${t.version} > 0`),
  check('purchasing_info_record_org_lead_ck', sql`${t.plannedDeliveryDays} is null or ${t.plannedDeliveryDays} >= 0`),
  check('purchasing_info_record_org_minimum_ck', sql`${t.minimumOrderQuantity} is null or ${t.minimumOrderQuantity} >= 0`),
  check('purchasing_info_record_org_minimum_pair_ck', sql`(${t.minimumOrderQuantity} is null) = (${t.minimumOrderUnit} is null)`),
]);

export const purchasingInfoRecordPrice = pgTable('purchasing_info_record_price', {
  client: tenant(),
  infoRecordNumber: varchar('info_record_number', { length: 20 }).notNull(),
  priceSequence: integer('price_sequence').notNull(),
  segmentNumber: integer('segment_number').notNull(),
  conditionType: varchar('condition_type', { length: 16 }).notNull().default('NET_PRICE'),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  priceUnit: numeric('price_unit', { precision: 5, scale: 0 }).notNull(),
  priceUnitOfMeasure: varchar('price_unit_of_measure', { length: 6 }).notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.infoRecordNumber, t.priceSequence] }),
  foreignKey({
    columns: [t.client, t.infoRecordNumber, t.segmentNumber],
    foreignColumns: [purchasingInfoRecordOrg.client, purchasingInfoRecordOrg.infoRecordNumber, purchasingInfoRecordOrg.segmentNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.currency],
    foreignColumns: [currency.code],
  }),
  foreignKey({
    columns: [t.priceUnitOfMeasure],
    foreignColumns: [unitOfMeasure.code],
  }),
  check('purchasing_info_record_price_sequence_ck', sql`${t.priceSequence} > 0`),
  check('purchasing_info_record_price_type_ck', sql`${t.conditionType} = 'NET_PRICE'`),
  check('purchasing_info_record_price_amount_ck', sql`${t.amount} >= 0`),
  check('purchasing_info_record_price_unit_ck', sql`${t.priceUnit} > 0`),
  check('purchasing_info_record_price_validity_ck', sql`${t.validTo} >= ${t.validFrom}`),
]);

/**
 * Purchasing source list — SCR-153. Who may supply a material at a plant.
 *
 * The header is one list. The requirement flag defaults off. An entry is one
 * supplier in one purchasing organisation for an inclusive validity. The unique
 * start index lives in migration 9094. Overlap of a different start is refused
 * by the locked service, not by an exclusion constraint.
 *
 * The order's lookup was measured on 20,000 entries, five per material. A hit
 * used the list primary key, then the start index: 0.045 ms and 6 buffers. A
 * miss used the list primary key and stopped: 0.017 ms and 2 buffers. No
 * further index was added.
 */
export const purchasingSourceList = pgTable('purchasing_source_list', {
  client: tenant(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  sourceListRequired: boolean('source_list_required').notNull().default(false),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber, t.plant] }),
  foreignKey({
    columns: [t.client, t.materialNumber],
    foreignColumns: [material.client, material.materialNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }).onDelete('restrict'),
  check('purchasing_source_list_version_ck', sql`${t.version} > 0`),
]);

export const purchasingSourceListEntry = pgTable('purchasing_source_list_entry', {
  client: tenant(),
  sourceNumber: varchar('source_number', { length: 20 }).notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  partnerNumber: varchar('partner_number', { length: 40 }).notNull(),
  roleCode: varchar('role_code', { length: 16 }).notNull().default('SUPPLIER'),
  purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  fixedSource: boolean('fixed_source').notNull().default(false),
  blockedSource: boolean('blocked_source').notNull().default(false),
  mrpRelevant: boolean('mrp_relevant').notNull().default(false),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.sourceNumber] }),
  foreignKey({
    columns: [t.client, t.materialNumber, t.plant],
    foreignColumns: [purchasingSourceList.client, purchasingSourceList.materialNumber, purchasingSourceList.plant],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.partnerNumber, t.roleCode],
    foreignColumns: [bpRole.client, bpRole.partnerNumber, bpRole.roleCode],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.purchasingOrg],
    foreignColumns: [purchasingOrg.client, purchasingOrg.purchasingOrg],
  }).onDelete('restrict'),
  check('purchasing_source_list_entry_role_ck', sql`${t.roleCode} = 'SUPPLIER'`),
  check('purchasing_source_list_entry_version_ck', sql`${t.version} > 0`),
  check('purchasing_source_list_entry_validity_ck', sql`${t.validTo} >= ${t.validFrom}`),
]);

/**
 * Purchasing quota arrangement — SCR-154. Who shares a requirement for one
 * material at one plant, by relative weight, over an inclusive validity.
 *
 * The header key is the drawn number. The lookup index is the material and the
 * plant. A standing arrangement holds its start; a different start may overlap
 * in the database, and the locked service refuses that. Deactivation does not
 * delete the row and does not hold the start. There is no allocated quantity,
 * no minimum split, no maximum lot, no supplying plant, and no status. The
 * order adds to the quota base when the vendor stands in it.
 */
export const purchasingQuotaArrangement = pgTable('purchasing_quota_arrangement', {
  client: tenant(),
  quotaNumber: varchar('quota_number', { length: 20 }).notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.quotaNumber] }),
  foreignKey({
    columns: [t.client, t.materialNumber],
    foreignColumns: [material.client, material.materialNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }).onDelete('restrict'),
  check('purchasing_quota_arrangement_version_ck', sql`${t.version} > 0`),
  check('purchasing_quota_arrangement_validity_ck', sql`${t.validTo} >= ${t.validFrom}`),
]);

export const purchasingQuotaArrangementItem = pgTable('purchasing_quota_arrangement_item', {
  client: tenant(),
  quotaNumber: varchar('quota_number', { length: 20 }).notNull(),
  itemNumber: varchar('item_number', { length: 3 }).notNull(),
  partnerNumber: varchar('partner_number', { length: 40 }).notNull(),
  roleCode: varchar('role_code', { length: 16 }).notNull().default('SUPPLIER'),
  purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
  quota: integer('quota').notNull(),
  quotaBaseQuantity: numeric('quota_base_quantity', { precision: 23, scale: 3 }).notNull().default('0'),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.quotaNumber, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.quotaNumber],
    foreignColumns: [purchasingQuotaArrangement.client, purchasingQuotaArrangement.quotaNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.partnerNumber, t.roleCode],
    foreignColumns: [bpRole.client, bpRole.partnerNumber, bpRole.roleCode],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.purchasingOrg],
    foreignColumns: [purchasingOrg.client, purchasingOrg.purchasingOrg],
  }).onDelete('restrict'),
  check('purchasing_quota_arrangement_item_role_ck', sql`${t.roleCode} = 'SUPPLIER'`),
  check('purchasing_quota_arrangement_item_number_ck', sql`${t.itemNumber} ~ '^[0-9]{3}$'`),
  check('purchasing_quota_arrangement_item_quota_ck', sql`${t.quota} > 0`),
  check('purchasing_quota_arrangement_item_base_ck', sql`${t.quotaBaseQuantity} >= 0`),
]);

export const purchaseOrderItem = pgTable('purchase_order_item', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
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
  /** A batch that already stands. Blank means the receipt must name one. */
  batchNumber: varchar('batch_number', { length: 40 }).notNull().default(''),
  materialGroup: varchar('material_group', { length: 9 }),
  requisitionNumber: varchar('requisition_number', { length: 10 }),
  requisitionItem: integer('requisition_item'),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  /** The price that qualified, when one did. The snapshot columns above remain what the order used. */
  infoRecordNumber: varchar('info_record_number', { length: 20 }),
  priceSequence: integer('price_sequence'),
  /** The source that qualified, when one did. The supplier on the order remains what it used. */
  sourceNumber: varchar('source_number', { length: 20 }),
  /** The quotation this item was saved from. The order must not exceed what that quotation still has open. */
  quotationNumber: varchar('quotation_number', { length: 20 }),
  quotationItem: integer('quotation_item'),
  /** Copied from the quotation. The info record is written on this save only when it is set. */
  infoUpdate: boolean('info_update').notNull().default(false),
  /** The quota item whose base this save increased. Empty when the vendor was not in the quota. */
  quotaNumber: varchar('quota_number', { length: 20 }),
  quotaItem: varchar('quota_item', { length: 3 }),
  /** A saved purchase order is the call-off. These columns do not post stock. */
  contractNumber: varchar('contract_number', { length: 20 }),
  contractItem: integer('contract_item'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.infoRecordNumber, t.priceSequence],
    foreignColumns: [purchasingInfoRecordPrice.client, purchasingInfoRecordPrice.infoRecordNumber, purchasingInfoRecordPrice.priceSequence],
  }).onDelete('restrict'),
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
  check('purchase_order_item_info_record_pair_ck', sql`(${t.infoRecordNumber} is null) = (${t.priceSequence} is null)`),
  check('purchase_order_item_quotation_pair_ck', sql`(${t.quotationNumber} is null) = (${t.quotationItem} is null)`),
  check('purchase_order_item_quota_pair_ck', sql`(${t.quotaNumber} is null) = (${t.quotaItem} is null)`),
  foreignKey({
    columns: [t.client, t.quotaNumber, t.quotaItem],
    foreignColumns: [purchasingQuotaArrangementItem.client, purchasingQuotaArrangementItem.quotaNumber, purchasingQuotaArrangementItem.itemNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.sourceNumber],
    foreignColumns: [purchasingSourceListEntry.client, purchasingSourceListEntry.sourceNumber],
  }).onDelete('restrict'),
]);

export const purchaseOrderScheduleLine = pgTable('purchase_order_schedule_line', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
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
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
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

/**
 * Document release state — SCR-060 / R-108. One row per judged
 * document: its strategy, the step it stands on, and its status.
 * Events live in the documents' change history, not here.
 */
export const documentRelease = pgTable('document_release', {
  client: tenant(),
  documentCategory: varchar('document_category', { length: 20 }).notNull(),
  documentNumber: varchar('document_number', { length: 20 }).notNull(),
  groupCode: varchar('group_code', { length: 12 }).notNull(),
  strategyCode: varchar('strategy_code', { length: 12 }).notNull(),
  currentStep: smallint('current_step').notNull().default(0),
  status: varchar('status', { length: 10 }).notNull().default('PENDING'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.documentCategory, t.documentNumber] }),
  check('document_release_category_ck', sql`${t.documentCategory} in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'PURCHASE_CONTRACT', 'SCHED_AGREEMENT')`),
  check('document_release_status_ck', sql`${t.status} in ('PENDING', 'RELEASED')`),
  check('document_release_step_ck', sql`${t.currentStep} >= 0`),
]);

/**
 * Invoice verification (SCR-062 / R-110). A posted supplier invoice
 * is immutable; cancellation is a linked mirror document. Amounts
 * are tax-exclusive at item level; the header gross is judged.
 */
export const supplierInvoice = pgTable('supplier_invoice', {
  client: tenant(),
  invoiceNumber: varchar('invoice_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  category: varchar('category', { length: 20 }).notNull().default('INVOICE'),
  supplierNumber: varchar('supplier_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  purchaseOrderNumber: varchar('purchase_order_number', { length: 20 }).notNull(),
  invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  supplierReference: varchar('supplier_reference', { length: 16 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  grossAmount: numeric('gross_amount', { precision: 23, scale: 4 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  paymentTerms: varchar('payment_terms', { length: 12 }),
  baselineDate: date('baseline_date', { mode: 'string' }),
  dueDate: date('due_date', { mode: 'string' }),
  headerText: varchar('header_text', { length: 100 }),
  status: varchar('status', { length: 12 }).notNull().default('POSTED'),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }),
  cancelledBy: varchar('cancelled_by', { length: 20 }),
  cancellationOf: varchar('cancellation_of', { length: 20 }),
  creditOf: varchar('credit_of', { length: 20 }),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.invoiceNumber] }),
  check('supplier_invoice_category_ck', sql`${t.category} in ('INVOICE', 'CREDIT_MEMO', 'SUBSEQUENT_DEBIT', 'SUBSEQUENT_CREDIT')`),
  check('supplier_invoice_status_ck', sql`${t.status} in ('POSTED', 'CANCELLED')`),
]);

export const supplierInvoiceItem = pgTable('supplier_invoice_item', {
  client: tenant(),
  invoiceNumber: varchar('invoice_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  purchaseOrderNumber: varchar('purchase_order_number', { length: 20 }).notNull(),
  purchaseOrderItem: integer('purchase_order_item').notNull(),
  materialNumber: varchar('material_number', { length: 40 }),
  plant: varchar('plant', { length: 10 }),
  quantity: numeric('quantity', { precision: 23, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 10 }).notNull(),
  netAmount: numeric('net_amount', { precision: 23, scale: 4 }).notNull(),
  expectedAmount: numeric('expected_amount', { precision: 23, scale: 4 }).notNull(),
  varianceAmount: numeric('variance_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  taxCode: varchar('tax_code', { length: 4 }),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.invoiceNumber, t.lineNumber] }),
  foreignKey({ columns: [t.client, t.invoiceNumber], foreignColumns: [supplierInvoice.client, supplierInvoice.invoiceNumber] }).onDelete('restrict'),
  check('supplier_invoice_item_qty_ck', sql`${t.quantity} > 0`),
]);

export const customerInvoice = pgTable('customer_invoice', {
  client: tenant(),
  invoiceNumber: varchar('invoice_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  category: varchar('category', { length: 20 }).notNull().default('INVOICE'),
  customerNumber: varchar('customer_number', { length: 20 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  documentDate: date('document_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  reference: varchar('reference', { length: 16 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  grossAmount: numeric('gross_amount', { precision: 23, scale: 4 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  paymentTerms: varchar('payment_terms', { length: 12 }),
  baselineDate: date('baseline_date', { mode: 'string' }),
  dueDate: date('due_date', { mode: 'string' }),
  headerText: varchar('header_text', { length: 100 }),
  status: varchar('status', { length: 12 }).notNull().default('POSTED'),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }),
  cancelledBy: varchar('cancelled_by', { length: 20 }),
  cancellationOf: varchar('cancellation_of', { length: 20 }),
  creditOf: varchar('credit_of', { length: 20 }),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.invoiceNumber] }),
  check('customer_invoice_category_ck', sql`${t.category} in ('INVOICE', 'CREDIT_MEMO')`),
  check('customer_invoice_status_ck', sql`${t.status} in ('POSTED', 'CANCELLED')`),
]);

export const customerInvoiceLine = pgTable('customer_invoice_line', {
  client: tenant(),
  invoiceNumber: varchar('invoice_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  glAccount: varchar('gl_account', { length: 10 }).notNull(),
  netAmount: numeric('net_amount', { precision: 23, scale: 4 }).notNull(),
  taxCode: varchar('tax_code', { length: 4 }),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  profitCenter: varchar('profit_center', { length: 20 }),
  lineText: varchar('line_text', { length: 100 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.invoiceNumber, t.lineNumber] }),
  foreignKey({ columns: [t.client, t.invoiceNumber], foreignColumns: [customerInvoice.client, customerInvoice.invoiceNumber] }).onDelete('restrict'),
  check('customer_invoice_line_amount_ck', sql`${t.netAmount} > 0`),
]);

/**
 * Request for quotation — SCR-155. One event groups the requirement. Each
 * invited supplier receives a separate request, and that request copies the
 * lines. The drawn numbers are the keys. A collective number is a label, not
 * the key. There is no status, no price, and no company code. A quotation is
 * a later document. It is not a column here. The order is not given a request
 * column.
 */
export const purchasingRfqEvent = pgTable('purchasing_rfq_event', {
  client: tenant(),
  eventNumber: varchar('event_number', { length: 20 }).notNull(),
  documentType: varchar('document_type', { length: 20 }).notNull().default('STANDARD'),
  purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
  purchasingGroup: varchar('purchasing_group', { length: 3 }).notNull(),
  rfqDate: date('rfq_date', { mode: 'string' }).notNull(),
  quotationDeadline: date('quotation_deadline', { mode: 'string' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  collectiveNumber: varchar('collective_number', { length: 10 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.eventNumber] }),
  foreignKey({
    columns: [t.client, t.purchasingOrg],
    foreignColumns: [purchasingOrg.client, purchasingOrg.purchasingOrg],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.purchasingGroup],
    foreignColumns: [purchasingGroup.client, purchasingGroup.purchasingGroup],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.currency],
    foreignColumns: [currency.code],
  }).onDelete('restrict'),
  check('purchasing_rfq_event_type_ck', sql`${t.documentType} = 'STANDARD'`),
  check('purchasing_rfq_event_deadline_ck', sql`${t.quotationDeadline} >= ${t.rfqDate}`),
  check('purchasing_rfq_event_currency_ck', sql`btrim(${t.currency}) ~ '^[A-Z]{3}$'`),
  check('purchasing_rfq_event_collective_ck', sql`${t.collectiveNumber} is null or char_length(btrim(${t.collectiveNumber})) between 1 and 10`),
]);

export const purchasingRfqEventItem = pgTable('purchasing_rfq_event_item', {
  client: tenant(),
  eventNumber: varchar('event_number', { length: 20 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  shortText: varchar('short_text', { length: 40 }).notNull(),
  materialNumber: varchar('material_number', { length: 40 }),
  quantity: numeric('quantity', { precision: 13, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 6 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  storageLocation: varchar('storage_location', { length: 10 }),
  deliveryDate: date('delivery_date', { mode: 'string' }).notNull(),
  /** Copied from a requisition. The request does not consume that quantity. */
  requisitionNumber: varchar('requisition_number', { length: 10 }),
  requisitionItem: integer('requisition_item'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.eventNumber, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.eventNumber],
    foreignColumns: [purchasingRfqEvent.client, purchasingRfqEvent.eventNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.materialNumber],
    foreignColumns: [material.client, material.materialNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.plant, t.storageLocation],
    foreignColumns: [storageLocation.client, storageLocation.plant, storageLocation.storageLocation],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.unit],
    foreignColumns: [unitOfMeasure.code],
  }).onDelete('restrict'),
  check('purchasing_rfq_event_item_number_ck', sql`${t.itemNumber} > 0 and ${t.itemNumber} % 10 = 0`),
  check('purchasing_rfq_event_item_qty_ck', sql`${t.quantity} > 0`),
  check('purchasing_rfq_event_item_text_ck', sql`char_length(btrim(${t.shortText})) between 1 and 40`),
  check('purchasing_rfq_event_item_requisition_pair_ck', sql`(${t.requisitionNumber} is null) = (${t.requisitionItem} is null)`),
  foreignKey({
    columns: [t.client, t.requisitionNumber, t.requisitionItem],
    foreignColumns: [purchaseRequisitionItem.client, purchaseRequisitionItem.requisitionNumber, purchaseRequisitionItem.itemNumber],
  }).onDelete('restrict'),
]);

export const purchasingRfq = pgTable('purchasing_rfq', {
  client: tenant(),
  rfqNumber: varchar('rfq_number', { length: 20 }).notNull(),
  eventNumber: varchar('event_number', { length: 20 }).notNull(),
  partnerNumber: varchar('partner_number', { length: 40 }).notNull(),
  roleCode: varchar('role_code', { length: 16 }).notNull().default('SUPPLIER'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.rfqNumber] }),
  unique('purchasing_rfq_event_number_uq').on(t.client, t.rfqNumber, t.eventNumber),
  unique('purchasing_rfq_supplier_uq').on(t.client, t.eventNumber, t.partnerNumber),
  foreignKey({
    columns: [t.client, t.eventNumber],
    foreignColumns: [purchasingRfqEvent.client, purchasingRfqEvent.eventNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.partnerNumber, t.roleCode],
    foreignColumns: [bpRole.client, bpRole.partnerNumber, bpRole.roleCode],
  }).onDelete('restrict'),
  check('purchasing_rfq_role_ck', sql`${t.roleCode} = 'SUPPLIER'`),
]);

export const purchasingRfqItem = pgTable('purchasing_rfq_item', {
  client: tenant(),
  rfqNumber: varchar('rfq_number', { length: 20 }).notNull(),
  eventNumber: varchar('event_number', { length: 20 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  shortText: varchar('short_text', { length: 40 }).notNull(),
  materialNumber: varchar('material_number', { length: 40 }),
  quantity: numeric('quantity', { precision: 13, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 6 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  storageLocation: varchar('storage_location', { length: 10 }),
  deliveryDate: date('delivery_date', { mode: 'string' }).notNull(),
  requisitionNumber: varchar('requisition_number', { length: 10 }),
  requisitionItem: integer('requisition_item'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.rfqNumber, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.rfqNumber, t.eventNumber],
    foreignColumns: [purchasingRfq.client, purchasingRfq.rfqNumber, purchasingRfq.eventNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.eventNumber, t.itemNumber],
    foreignColumns: [purchasingRfqEventItem.client, purchasingRfqEventItem.eventNumber, purchasingRfqEventItem.itemNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.materialNumber],
    foreignColumns: [material.client, material.materialNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.plant, t.storageLocation],
    foreignColumns: [storageLocation.client, storageLocation.plant, storageLocation.storageLocation],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.unit],
    foreignColumns: [unitOfMeasure.code],
  }).onDelete('restrict'),
  check('purchasing_rfq_item_number_ck', sql`${t.itemNumber} > 0 and ${t.itemNumber} % 10 = 0`),
  check('purchasing_rfq_item_qty_ck', sql`${t.quantity} > 0`),
  check('purchasing_rfq_item_text_ck', sql`char_length(btrim(${t.shortText})) between 1 and 40`),
  check('purchasing_rfq_item_requisition_pair_ck', sql`(${t.requisitionNumber} is null) = (${t.requisitionItem} is null)`),
  foreignKey({
    columns: [t.client, t.requisitionNumber, t.requisitionItem],
    foreignColumns: [purchaseRequisitionItem.client, purchaseRequisitionItem.requisitionNumber, purchaseRequisitionItem.itemNumber],
  }).onDelete('restrict'),
]);

/**
 * Quotation — SCR-157. One quotation prices one standing request. The drawn
 * number is the key. The request number is the link. The supplier and the
 * currency are not stored again. There is no status, no revision, and no
 * condition. The order stores the quotation it was saved from.
 */
export const purchasingQuotation = pgTable('purchasing_quotation', {
  client: tenant(),
  quotationNumber: varchar('quotation_number', { length: 20 }).notNull(),
  rfqNumber: varchar('rfq_number', { length: 20 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.quotationNumber] }),
  unique('purchasing_quotation_request_uq').on(t.client, t.rfqNumber),
  unique('purchasing_quotation_request_pair_uq').on(t.client, t.quotationNumber, t.rfqNumber),
  foreignKey({
    columns: [t.client, t.rfqNumber],
    foreignColumns: [purchasingRfq.client, purchasingRfq.rfqNumber],
  }).onDelete('restrict'),
  check('purchasing_quotation_number_ck', sql`char_length(btrim(${t.quotationNumber})) between 1 and 20`),
]);

export const purchasingQuotationItem = pgTable('purchasing_quotation_item', {
  client: tenant(),
  quotationNumber: varchar('quotation_number', { length: 20 }).notNull(),
  rfqNumber: varchar('rfq_number', { length: 20 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  quantity: numeric('quantity', { precision: 13, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 6 }).notNull(),
  netPrice: numeric('net_price', { precision: 23, scale: 4 }).notNull(),
  priceUnit: numeric('price_unit', { precision: 5, scale: 0 }).notNull(),
  deliveryDate: date('delivery_date', { mode: 'string' }).notNull(),
  remark: varchar('remark', { length: 80 }),
  /** Set on the quotation. The info record is written when the order is saved, not here. */
  infoUpdate: boolean('info_update').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.quotationNumber, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.quotationNumber, t.rfqNumber],
    foreignColumns: [purchasingQuotation.client, purchasingQuotation.quotationNumber, purchasingQuotation.rfqNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.rfqNumber, t.itemNumber],
    foreignColumns: [purchasingRfqItem.client, purchasingRfqItem.rfqNumber, purchasingRfqItem.itemNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.unit],
    foreignColumns: [unitOfMeasure.code],
  }).onDelete('restrict'),
  check('purchasing_quotation_item_qty_ck', sql`${t.quantity} > 0`),
  check('purchasing_quotation_item_price_ck', sql`${t.netPrice} >= 0`),
  check('purchasing_quotation_item_price_unit_ck', sql`${t.priceUnit} > 0`),
  check('purchasing_quotation_item_remark_ck', sql`${t.remark} is null or char_length(btrim(${t.remark})) between 1 and 80`),
]);

/**
 * Parked supplier invoice — SCR-160. Not a posted invoice.
 *
 * The row is the park. There is no status. The order is named and is not
 * consumed. The number is not a vendor invoice number. A later post writes
 * supplier_invoice; this table does not become one.
 */
export const parkedSupplierInvoice = pgTable('parked_supplier_invoice', {
  client: tenant(),
  parkedNumber: varchar('parked_number', { length: 20 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  supplierNumber: varchar('supplier_number', { length: 40 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  purchaseOrderNumber: varchar('purchase_order_number', { length: 20 }).notNull(),
  invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  supplierReference: varchar('supplier_reference', { length: 16 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  grossAmount: numeric('gross_amount', { precision: 23, scale: 4 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  paymentTerms: varchar('payment_terms', { length: 12 }),
  baselineDate: date('baseline_date', { mode: 'string' }),
  dueDate: date('due_date', { mode: 'string' }),
  headerText: varchar('header_text', { length: 100 }),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.parkedNumber] }),
  unique('parked_supplier_invoice_order_pair_uq').on(t.client, t.parkedNumber, t.purchaseOrderNumber),
  unique('parked_supplier_invoice_request_uq').on(t.client, t.requestKey),
  unique('parked_supplier_invoice_reference_uq').on(t.client, t.companyCode, t.supplierNumber, t.supplierReference),
  foreignKey({
    columns: [t.client, t.purchaseOrderNumber],
    foreignColumns: [purchaseOrder.client, purchaseOrder.orderNumber],
  }).onDelete('restrict'),
  check('parked_supplier_invoice_year_ck', sql`${t.fiscalYear} between 1000 and 9999`),
  check('parked_supplier_invoice_amounts_ck', sql`${t.grossAmount} >= 0 and ${t.taxAmount} >= 0`),
]);

/** One parked line. The line number is the order item. It does not add an item. */
export const parkedSupplierInvoiceItem = pgTable('parked_supplier_invoice_item', {
  client: tenant(),
  parkedNumber: varchar('parked_number', { length: 20 }).notNull(),
  purchaseOrderNumber: varchar('purchase_order_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  purchaseOrderItem: integer('purchase_order_item').notNull(),
  materialNumber: varchar('material_number', { length: 40 }),
  plant: varchar('plant', { length: 10 }),
  quantity: numeric('quantity', { precision: 23, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 10 }).notNull(),
  netAmount: numeric('net_amount', { precision: 23, scale: 4 }).notNull(),
  expectedAmount: numeric('expected_amount', { precision: 23, scale: 4 }).notNull(),
  varianceAmount: numeric('variance_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  taxCode: varchar('tax_code', { length: 4 }),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.parkedNumber, t.lineNumber] }),
  foreignKey({
    columns: [t.client, t.parkedNumber, t.purchaseOrderNumber],
    foreignColumns: [parkedSupplierInvoice.client, parkedSupplierInvoice.parkedNumber, parkedSupplierInvoice.purchaseOrderNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.purchaseOrderNumber, t.purchaseOrderItem],
    foreignColumns: [purchaseOrderItem.client, purchaseOrderItem.orderNumber, purchaseOrderItem.itemNumber],
  }).onDelete('restrict'),
  check('parked_supplier_invoice_item_line_ck', sql`${t.lineNumber} = ${t.purchaseOrderItem}`),
  check('parked_supplier_invoice_item_qty_ck', sql`${t.quantity} > 0`),
  check('parked_supplier_invoice_item_amounts_ck', sql`${t.netAmount} >= 0 and ${t.expectedAmount} >= 0 and ${t.taxAmount} >= 0`),
]);

/**
 * A manual payment hold on a posted supplier invoice. The open item remains
 * the journal line. This row is not a second payable.
 */
export const supplierInvoicePaymentBlock = pgTable('supplier_invoice_payment_block', {
  client: tenant(),
  invoiceNumber: varchar('invoice_number', { length: 20 }).notNull(),
  reason: varchar('reason', { length: 16 }).notNull(),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }).notNull(),
  active: boolean('active').notNull(),
  comment: varchar('comment', { length: 100 }).notNull(),
  version: integer('version').notNull().default(1),
  clearedBy: varchar('cleared_by', { length: 60 }),
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.invoiceNumber, t.reason] }),
  foreignKey({
    columns: [t.client, t.invoiceNumber],
    foreignColumns: [supplierInvoice.client, supplierInvoice.invoiceNumber],
  }).onDelete('restrict'),
  check('supplier_invoice_payment_block_reason_ck', sql`${t.reason} = 'MANUAL'`),
]);

/** Append-only. A release does not update or delete an event. */
export const supplierInvoicePaymentBlockEvent = pgTable('supplier_invoice_payment_block_event', {
  client: tenant(),
  eventId: bigint('event_id', { mode: 'number' }).generatedAlwaysAsIdentity(),
  invoiceNumber: varchar('invoice_number', { length: 20 }).notNull(),
  reason: varchar('reason', { length: 16 }).notNull(),
  action: varchar('action', { length: 16 }).notNull(),
  outcome: varchar('outcome', { length: 16 }).notNull(),
  actor: varchar('actor', { length: 60 }).notNull(),
  comment: varchar('comment', { length: 100 }).notNull(),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  previousActive: boolean('previous_active').notNull(),
  resultingActive: boolean('resulting_active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.eventId] }),
  unique('supplier_invoice_payment_block_event_request_uq').on(t.client, t.requestKey),
  foreignKey({
    columns: [t.client, t.invoiceNumber, t.reason],
    foreignColumns: [supplierInvoicePaymentBlock.client, supplierInvoicePaymentBlock.invoiceNumber, supplierInvoicePaymentBlock.reason],
  }).onDelete('restrict'),
]);

/**
 * A posted GR/IR maintenance document for one purchase-order item.
 * The journal is the accounting document. This row is the link.
 * A reversal sets reversed_by. It does not delete the journal.
 */
export const grIrMaintenanceLink = pgTable('gr_ir_maintenance_link', {
  client: tenant(),
  documentNumber: varchar('document_number', { length: 40 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  keyDate: date('key_date', { mode: 'string' }).notNull(),
  surplus: varchar('surplus', { length: 16 }).notNull(),
  allocatedAmount: numeric('allocated_amount', { precision: 23, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  allocatedQuantity: numeric('allocated_quantity', { precision: 13, scale: 3 }).notNull(),
  quantityUnit: varchar('quantity_unit', { length: 6 }).notNull(),
  grIrAccount: varchar('gr_ir_account', { length: 10 }).notNull(),
  offsetAccount: varchar('offset_account', { length: 10 }).notNull(),
  fingerprint: varchar('fingerprint', { length: 80 }).notNull(),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  comment: varchar('comment', { length: 100 }).notNull(),
  reversedBy: varchar('reversed_by', { length: 40 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.documentNumber, t.fiscalYear] }),
  unique('gr_ir_maintenance_link_request_uq').on(t.client, t.requestKey),
  foreignKey({
    columns: [t.client, t.orderNumber, t.itemNumber],
    foreignColumns: [purchaseOrderItem.client, purchaseOrderItem.orderNumber, purchaseOrderItem.itemNumber],
  }).onDelete('restrict'),
  check('gr_ir_maintenance_link_surplus_ck', sql`${t.surplus} in ('DELIVERY', 'INVOICE')`),
  check('gr_ir_maintenance_link_amount_ck', sql`${t.allocatedAmount} <> 0`),
]);

/**
 * Vendor evaluation — SCR-165. Configuration and a manual score.
 * An automatic score is not a row. The overall score is not a column.
 */
export const vendorEvaluationCriterion = pgTable('vendor_evaluation_criterion', {
  client: tenant(),
  criterionCode: varchar('criterion_code', { length: 16 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  method: varchar('method', { length: 12 }).notNull(),
  evidence: varchar('evidence', { length: 16 }).notNull(),
  scoreMin: numeric('score_min', { precision: 5, scale: 2 }).notNull(),
  scoreMax: numeric('score_max', { precision: 5, scale: 2 }).notNull(),
  weight: numeric('weight', { precision: 5, scale: 2 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.criterionCode] }),
  check('vendor_evaluation_criterion_method_ck', sql`${t.method} in ('MANUAL', 'AUTOMATIC')`),
  check('vendor_evaluation_criterion_evidence_ck', sql`${t.evidence} in ('NONE', 'PRICE', 'DELIVERY')`),
  check('vendor_evaluation_criterion_pair_ck', sql`(${t.method} = 'MANUAL') = (${t.evidence} = 'NONE')`),
  check('vendor_evaluation_criterion_scale_ck', sql`${t.scoreMin} >= 0 and ${t.scoreMax} <= 100 and ${t.scoreMin} < ${t.scoreMax}`),
  check('vendor_evaluation_criterion_weight_ck', sql`${t.weight} > 0 and ${t.weight} <= 100`),
]);

export const vendorEvaluationAssessment = pgTable('vendor_evaluation_assessment', {
  client: tenant(),
  supplierNumber: varchar('supplier_number', { length: 40 }).notNull(),
  purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
  periodFrom: date('period_from', { mode: 'string' }).notNull(),
  periodTo: date('period_to', { mode: 'string' }).notNull(),
  criterionCode: varchar('criterion_code', { length: 16 }).notNull(),
  score: numeric('score', { precision: 5, scale: 2 }).notNull(),
  reason: varchar('reason', { length: 100 }).notNull(),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.supplierNumber, t.purchasingOrg, t.periodFrom, t.periodTo, t.criterionCode] }),
  unique('vendor_evaluation_assessment_request_uq').on(t.client, t.requestKey),
  foreignKey({
    columns: [t.client, t.criterionCode],
    foreignColumns: [vendorEvaluationCriterion.client, vendorEvaluationCriterion.criterionCode],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.supplierNumber, t.purchasingOrg],
    foreignColumns: [supplierPurchasing.client, supplierPurchasing.partnerNumber, supplierPurchasing.purchasingOrg],
  }).onDelete('restrict'),
  check('vendor_evaluation_assessment_score_ck', sql`${t.score} >= 0 and ${t.score} <= 100`),
  check('vendor_evaluation_assessment_period_ck', sql`${t.periodFrom} <= ${t.periodTo}`),
  check('vendor_evaluation_assessment_version_ck', sql`${t.version} > 0`),
]);

/**
 * Configured purchase-contract types. The service reads this table.
 * MK and WK are seeded names for existing tenants, not hardcoded meanings.
 */
export const purchasingContractType = pgTable('purchasing_contract_type', {
  client: tenant(),
  documentType: varchar('document_type', { length: 4 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  category: varchar('category', { length: 10 }).notNull(),
  numberRangeSubObject: varchar('number_range_sub_object', { length: 10 }).notNull().default('*'),
  itemInterval: integer('item_interval').notNull().default(10),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.documentType] }),
  check('purchasing_contract_type_category_ck', sql`${t.category} in ('QUANTITY', 'VALUE')`),
]);

/** Outline agreement. Creation does not change stock, goods receipts, or accounting. */
export const purchaseContract = pgTable('purchase_contract', {
  client: tenant(),
  contractNumber: varchar('contract_number', { length: 20 }).notNull(),
  documentType: varchar('document_type', { length: 4 }).notNull(),
  category: varchar('category', { length: 10 }).notNull(),
  supplierNumber: varchar('supplier_number', { length: 40 }).notNull(),
  purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
  purchasingGroup: varchar('purchasing_group', { length: 3 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  agreementDate: date('agreement_date', { mode: 'string' }).notNull(),
  validityStart: date('validity_start', { mode: 'string' }).notNull(),
  validityEnd: date('validity_end', { mode: 'string' }).notNull(),
  targetValue: numeric('target_value', { precision: 15, scale: 2 }),
  paymentTermsCode: varchar('payment_terms_code', { length: 12 }),
  incotermsCode: varchar('incoterms_code', { length: 3 }),
  incotermsLocation: varchar('incoterms_location', { length: 160 }),
  yourReference: varchar('your_reference', { length: 12 }),
  ourReference: varchar('our_reference', { length: 12 }),
  languageCode: varchar('language_code', { length: 2 }),
  sourceContractNumber: varchar('source_contract_number', { length: 20 }),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.contractNumber] }),
  check('purchase_contract_category_ck', sql`${t.category} in ('QUANTITY', 'VALUE')`),
  check('purchase_contract_validity_ck', sql`${t.validityEnd} >= ${t.validityStart}`),
]);

export const purchaseContractItem = pgTable('purchase_contract_item', {
  client: tenant(),
  contractNumber: varchar('contract_number', { length: 20 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  itemCategory: varchar('item_category', { length: 16 }).notNull().default('STANDARD'),
  accountAssignmentCategory: varchar('account_assignment_category', { length: 16 }),
  materialNumber: varchar('material_number', { length: 40 }),
  shortText: varchar('short_text', { length: 40 }).notNull(),
  targetQuantity: numeric('target_quantity', { precision: 13, scale: 3 }),
  unit: varchar('unit', { length: 6 }),
  netPrice: numeric('net_price', { precision: 11, scale: 2 }).notNull().default('0'),
  priceUnit: numeric('price_unit', { precision: 5, scale: 0 }).notNull().default('1'),
  netValue: numeric('net_value', { precision: 15, scale: 2 }).notNull().default('0'),
  plant: varchar('plant', { length: 10 }),
  storageLocation: varchar('storage_location', { length: 10 }),
  materialGroup: varchar('material_group', { length: 9 }),
  costCenter: varchar('cost_center', { length: 10 }),
  glAccount: varchar('gl_account', { length: 10 }),
  requisitionNumber: varchar('requisition_number', { length: 10 }),
  requisitionItem: integer('requisition_item'),
  rfqNumber: varchar('rfq_number', { length: 20 }),
  rfqItem: integer('rfq_item'),
  quotationNumber: varchar('quotation_number', { length: 20 }),
  quotationItem: integer('quotation_item'),
  infoRecordNumber: varchar('info_record_number', { length: 20 }),
  priceSequence: integer('price_sequence'),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.contractNumber, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.contractNumber],
    foreignColumns: [purchaseContract.client, purchaseContract.contractNumber],
  }),
  check('purchase_contract_item_category_ck', sql`${t.itemCategory} = 'STANDARD'`),
  check('purchase_contract_item_assignment_ck', sql`${t.accountAssignmentCategory} is null or ${t.accountAssignmentCategory} = 'COST_CENTER'`),
]);

/**
 * Scheduling-agreement types. LP is a seeded name, not a meaning in the service.
 * This is not a purchase-contract type.
 */
export const schedulingAgreementType = pgTable('scheduling_agreement_type', {
  client: tenant(),
  documentType: varchar('document_type', { length: 4 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  category: varchar('category', { length: 12 }).notNull(),
  numberRangeSubObject: varchar('number_range_sub_object', { length: 10 }).notNull().default('*'),
  itemInterval: integer('item_interval').notNull().default(10),
  /** When false, ME84 does not create a supplier release. LP stays false. The code is not the rule. */
  releaseDocumentation: boolean('release_documentation').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.documentType] }),
  check('scheduling_agreement_type_category_ck', sql`${t.category} = 'SCHEDULING'`),
]);

/** Scheduling agreement. Creation does not create a schedule line, a purchase order, or a goods receipt. */
export const schedulingAgreement = pgTable('scheduling_agreement', {
  client: tenant(),
  agreementNumber: varchar('agreement_number', { length: 20 }).notNull(),
  documentType: varchar('document_type', { length: 4 }).notNull(),
  supplierNumber: varchar('supplier_number', { length: 40 }).notNull(),
  purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
  purchasingGroup: varchar('purchasing_group', { length: 3 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  agreementDate: date('agreement_date', { mode: 'string' }).notNull(),
  validityStart: date('validity_start', { mode: 'string' }).notNull(),
  validityEnd: date('validity_end', { mode: 'string' }).notNull(),
  paymentTermsCode: varchar('payment_terms_code', { length: 12 }),
  incotermsCode: varchar('incoterms_code', { length: 3 }),
  incotermsLocation: varchar('incoterms_location', { length: 160 }),
  yourReference: varchar('your_reference', { length: 12 }),
  ourReference: varchar('our_reference', { length: 12 }),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.agreementNumber] }),
  check('scheduling_agreement_validity_ck', sql`${t.validityEnd} >= ${t.validityStart}`),
]);

export const schedulingAgreementItem = pgTable('scheduling_agreement_item', {
  client: tenant(),
  agreementNumber: varchar('agreement_number', { length: 20 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  itemCategory: varchar('item_category', { length: 16 }).notNull().default('STANDARD'),
  accountAssignmentCategory: varchar('account_assignment_category', { length: 16 }),
  materialNumber: varchar('material_number', { length: 40 }),
  shortText: varchar('short_text', { length: 40 }).notNull(),
  targetQuantity: numeric('target_quantity', { precision: 13, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 6 }).notNull(),
  netPrice: numeric('net_price', { precision: 11, scale: 2 }).notNull(),
  priceUnit: numeric('price_unit', { precision: 5, scale: 0 }).notNull().default('1'),
  netValue: numeric('net_value', { precision: 15, scale: 2 }).notNull(),
  plant: varchar('plant', { length: 10 }),
  storageLocation: varchar('storage_location', { length: 10 }),
  costCenter: varchar('cost_center', { length: 10 }),
  glAccount: varchar('gl_account', { length: 10 }),
  requisitionNumber: varchar('requisition_number', { length: 10 }),
  requisitionItem: integer('requisition_item'),
  infoRecordNumber: varchar('info_record_number', { length: 20 }),
  priceSequence: integer('price_sequence'),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  /** JIT delivery schedule. Existing items stay off. Forecast does not use this flag. */
  jitEnabled: boolean('jit_enabled').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.agreementNumber, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.agreementNumber],
    foreignColumns: [schedulingAgreement.client, schedulingAgreement.agreementNumber],
  }),
  check('scheduling_agreement_item_category_ck', sql`${t.itemCategory} = 'STANDARD'`),
  check('scheduling_agreement_item_assignment_ck', sql`${t.accountAssignmentCategory} is null or ${t.accountAssignmentCategory} = 'COST_CENTER'`),
]);

/** Delivery schedule lines. ME38 maintains them. ME31L does not insert them. */
export const schedulingAgreementScheduleLine = pgTable('scheduling_agreement_schedule_line', {
  client: tenant(),
  agreementNumber: varchar('agreement_number', { length: 20 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  lineNumber: integer('line_number').notNull(),
  deliveryDate: date('delivery_date', { mode: 'string' }).notNull(),
  quantity: numeric('quantity', { precision: 13, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 6 }),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.agreementNumber, t.itemNumber, t.lineNumber] }),
  foreignKey({
    columns: [t.client, t.agreementNumber, t.itemNumber],
    foreignColumns: [schedulingAgreementItem.client, schedulingAgreementItem.agreementNumber, schedulingAgreementItem.itemNumber],
  }),
]);

/** Release creation profile. No horizon or tolerance is assumed when this row is absent. */
export const schedulingReleaseProfile = pgTable('scheduling_release_profile', {
  client: tenant(),
  profileCode: varchar('profile_code', { length: 10 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  releaseType: varchar('release_type', { length: 3 }).notNull(),
  horizonDays: integer('horizon_days'),
  aggregation: varchar('aggregation', { length: 8 }).notNull(),
  comparisonMode: varchar('comparison_mode', { length: 8 }).notNull(),
  tolerancePercent: numeric('tolerance_percent', { precision: 5, scale: 2 }),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.profileCode] }),
  check('scheduling_release_profile_type_ck', sql`${t.releaseType} in ('FRC', 'JIT')`),
  check('scheduling_release_profile_aggregation_ck', sql`${t.aggregation} in ('NONE', 'DAY', 'WEEK', 'MONTH')`),
  check('scheduling_release_profile_comparison_ck', sql`${t.comparisonMode} in ('LINE', 'OVERALL')`),
  check('scheduling_release_profile_horizon_ck', sql`${t.horizonDays} is null or (${t.horizonDays} >= 0 and ${t.horizonDays} <= 999)`),
  check('scheduling_release_profile_tolerance_ck', sql`${t.tolerancePercent} is null or (${t.tolerancePercent} >= 0 and ${t.tolerancePercent} <= 999.99)`),
]);

/** Supplier and plant default for a release profile. A blank plant is the organisation default. */
export const schedulingReleaseProfileAssignment = pgTable('scheduling_release_profile_assignment', {
  client: tenant(),
  supplierNumber: varchar('supplier_number', { length: 40 }).notNull(),
  purchasingOrg: varchar('purchasing_org', { length: 10 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull().default(''),
  releaseType: varchar('release_type', { length: 3 }).notNull(),
  profileCode: varchar('profile_code', { length: 10 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.supplierNumber, t.purchasingOrg, t.plant, t.releaseType] }),
  check('scheduling_release_profile_assignment_type_ck', sql`${t.releaseType} in ('FRC', 'JIT')`),
]);

/** Supplier-facing release. Saving it does not post, and it does not notify the supplier. */
export const schedulingAgreementRelease = pgTable('scheduling_agreement_release', {
  client: tenant(),
  releaseNumber: varchar('release_number', { length: 20 }).notNull(),
  agreementNumber: varchar('agreement_number', { length: 20 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  releaseType: varchar('release_type', { length: 3 }).notNull(),
  profileCode: varchar('profile_code', { length: 10 }).notNull(),
  aggregation: varchar('aggregation', { length: 8 }).notNull(),
  comparisonMode: varchar('comparison_mode', { length: 8 }).notNull(),
  horizonDays: integer('horizon_days'),
  tolerancePercent: numeric('tolerance_percent', { precision: 5, scale: 2 }),
  generationDate: date('generation_date', { mode: 'string' }).notNull(),
  releasedQuantity: numeric('released_quantity', { precision: 13, scale: 3 }).notNull(),
  transmissionStatus: varchar('transmission_status', { length: 20 }).notNull().default('NOT_TRANSMITTED'),
  transmissionDetail: varchar('transmission_detail', { length: 200 }).notNull(),
  requestKey: varchar('request_key', { length: 120 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.releaseNumber] }),
  foreignKey({
    columns: [t.client, t.agreementNumber, t.itemNumber],
    foreignColumns: [schedulingAgreementItem.client, schedulingAgreementItem.agreementNumber, schedulingAgreementItem.itemNumber],
  }),
  check('scheduling_agreement_release_type_ck', sql`${t.releaseType} in ('FRC', 'JIT')`),
  check('scheduling_agreement_release_transmission_ck', sql`${t.transmissionStatus} = 'NOT_TRANSMITTED'`),
]);

export const schedulingAgreementReleaseLine = pgTable('scheduling_agreement_release_line', {
  client: tenant(),
  releaseNumber: varchar('release_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  deliveryDate: date('delivery_date', { mode: 'string' }).notNull(),
  quantity: numeric('quantity', { precision: 13, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 6 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.releaseNumber, t.lineNumber] }),
  foreignKey({
    columns: [t.client, t.releaseNumber],
    foreignColumns: [schedulingAgreementRelease.client, schedulingAgreementRelease.releaseNumber],
  }),
  check('scheduling_agreement_release_line_quantity_ck', sql`${t.quantity} > 0`),
]);
