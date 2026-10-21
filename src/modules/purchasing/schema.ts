/** Purchase requisitions — SCR-055 / R-103 (ME51N). Item-level documents, no header record. */
import { pgTable, varchar, char, integer, smallint, numeric, boolean, date, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { currency, unitOfMeasure } from '../../platform/tables/reference';
import { plant, purchasingGroup, purchasingOrg, storageLocation } from '../foundation/schema';
import { bpRole } from '../foundation/business-partner-schema';
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
  materialGroup: varchar('material_group', { length: 9 }),
  requisitionNumber: varchar('requisition_number', { length: 10 }),
  requisitionItem: integer('requisition_item'),
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  /** The price that qualified, when one did. The snapshot columns above remain what the order used. */
  infoRecordNumber: varchar('info_record_number', { length: 20 }),
  priceSequence: integer('price_sequence'),
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
  check('document_release_category_ck', sql`${t.documentCategory} in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER')`),
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
