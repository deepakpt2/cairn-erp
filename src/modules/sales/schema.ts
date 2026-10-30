/**
 * Sales orders and the condition record an order price is read from — CAIRN.md §11.2, §20.
 *
 * The order is the customer's commitment: an ordered quantity, a price a standing condition record
 * answered for, and the credit determination the save itself raised. It reserves no stock and posts
 * no accounting document, which is why nothing here refers to a period, a valuation or a movement.
 * The outbound delivery, its picking, the goods issue and the billing document are the rest of the chain:
 * the delivery carries what left the plant and the material document that moved it, the billing document
 * carries what the customer owes and the invoice that says so. Quantities a follow-on document advances are
 * held there and never copied back onto the order line, so an order and its fulfillment cannot disagree by
 * arithmetic. The pricing procedures, their steps and the access sequences are still absent — a master with
 * no reader is a table only a test would write (DI-018).
 */
import { pgTable, timestamp, varchar, char, integer, numeric, boolean, date, primaryKey, foreignKey, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { currency, unitOfMeasure } from '../../platform/tables/reference';
import { businessPartner } from '../foundation/business-partner-schema';
import { companyCode, salesArea } from '../foundation/schema';
import { material } from '../inventory/schema';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });

export const ORDER_STATUSES = ['OPEN', 'CANCELLED'] as const;
export const ORDER_LINE_STATUSES = ['OPEN', 'REJECTED'] as const;
/** The only condition type that stands today: the item price. A discount step is DI-018. */
export const CONDITION_TYPES = ['PR00'] as const;
export const SALES_ORDER_TYPE = { code: 'OR', rangeSubObject: 'OR' } as const;

/** One sales order. The order posts nothing; it states what the customer asked for and at what value. */
export const salesOrder = pgTable('sales_order', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  documentType: varchar('document_type', { length: 2 }).notNull().default('OR'),
  salesOrg: varchar('sales_org', { length: 4 }).notNull(),
  distributionChannel: varchar('distribution_channel', { length: 2 }).notNull(),
  division: varchar('division', { length: 2 }).notNull(),
  customerNumber: varchar('customer_number', { length: 40 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  orderDate: date('order_date', { mode: 'string' }).notNull(),
  requestedDate: date('requested_date', { mode: 'string' }),
  purchaseOrderReference: varchar('purchase_order_reference', { length: 20 }),
  headerText: varchar('header_text', { length: 100 }),
  status: varchar('status', { length: 16 }).notNull().default('OPEN'),
  netValue: numeric('net_value', { precision: 23, scale: 4 }).notNull().default('0'),
  taxValue: numeric('tax_value', { precision: 23, scale: 4 }).notNull().default('0'),
  grossValue: numeric('gross_value', { precision: 23, scale: 4 }).notNull().default('0'),
  version: integer('version').notNull().default(1),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber] }),
  check('sales_order_status_ck', sql`${t.status} in ('OPEN', 'CANCELLED')`),
  check('sales_order_version_ck', sql`${t.version} > 0`),
  check('sales_order_value_ck', sql`${t.netValue} >= 0 and ${t.taxValue} >= 0 and ${t.grossValue} >= 0`),
  check('sales_order_date_ck', sql`${t.requestedDate} is null or ${t.requestedDate} >= ${t.orderDate}`),
  check('sales_order_type_ck', sql`${t.documentType} ~ '^[A-Z0-9]{2}$'`),
  uniqueIndex('sales_order_request_key_uq').on(t.client, t.requestKey).where(sql`${t.requestKey} is not null`),
  foreignKey({
    name: 'sales_order_customer_fk',
    columns: [t.client, t.customerNumber],
    foreignColumns: [businessPartner.client, businessPartner.partnerNumber],
  }).onDelete('cascade'),
  foreignKey({
    name: 'sales_order_area_fk',
    columns: [t.client, t.salesOrg, t.distributionChannel, t.division],
    foreignColumns: [salesArea.client, salesArea.salesOrg, salesArea.distributionChannel, salesArea.division],
  }).onDelete('cascade'),
  foreignKey({
    name: 'sales_order_company_fk',
    columns: [t.client, t.companyCode],
    foreignColumns: [companyCode.client, companyCode.companyCode],
  }).onDelete('cascade'),
]);

/**
 * One item of an order. The base quantity is what a later goods issue reduces stock by, so the
 * conversion happens once, at entry, and is stored rather than repeated against a rate that may since
 * have changed. `condition_number` names the record the price came from.
 */
export const salesOrderLine = pgTable('sales_order_line', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  orderQuantity: numeric('order_quantity', { precision: 13, scale: 3 }).notNull(),
  quantityUnit: char('quantity_unit', { length: 6 }).notNull().references(() => unitOfMeasure.code),
  baseQuantity: numeric('base_quantity', { precision: 13, scale: 3 }).notNull(),
  netPrice: numeric('net_price', { precision: 23, scale: 4 }).notNull().default('0'),
  priceUnit: integer('price_unit').notNull().default(1),
  netAmount: numeric('net_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  taxCode: varchar('tax_code', { length: 4 }),
  taxRate: numeric('tax_rate', { precision: 7, scale: 4 }).notNull().default('0'),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  profitCenter: varchar('profit_center', { length: 20 }),
  requestedDeliveryDate: date('requested_delivery_date', { mode: 'string' }),
  conditionNumber: varchar('condition_number', { length: 18 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('OPEN'),
  rejectionReason: varchar('rejection_reason', { length: 4 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.lineNumber] }),
  check('sales_order_line_quantity_ck', sql`${t.orderQuantity} > 0 and ${t.baseQuantity} > 0`),
  check('sales_order_line_price_ck', sql`${t.netPrice} >= 0 and ${t.priceUnit} > 0 and ${t.netAmount} >= 0`),
  check('sales_order_line_tax_ck', sql`${t.taxRate} >= 0 and ${t.taxAmount} >= 0`),
  check('sales_order_line_status_ck', sql`${t.status} in ('OPEN', 'REJECTED')`),
  check('sales_order_line_rejection_ck', sql`(${t.status} = 'REJECTED' and ${t.rejectionReason} is not null) or (${t.status} = 'OPEN' and ${t.rejectionReason} is null)`),
  check('sales_order_line_number_ck', sql`${t.lineNumber} > 0`),
  foreignKey({
    name: 'sales_order_line_material_fk',
    columns: [t.client, t.materialNumber],
    foreignColumns: [material.client, material.materialNumber],
  }).onDelete('cascade'),
]);

/**
 * A condition record: the price one combination of sales area, customer and material carries for a
 * period. The empty customer or material position is the general record, which is why those positions
 * default to the empty string rather than to null — null in a unique key would let two "any customer"
 * rows stand side by side.
 */
export const salesConditionRecord = pgTable('sales_condition_record', {
  client: tenant(),
  conditionNumber: varchar('condition_number', { length: 18 }).notNull(),
  conditionType: varchar('condition_type', { length: 4 }).notNull().default('PR00'),
  salesOrg: varchar('sales_org', { length: 4 }).notNull(),
  distributionChannel: varchar('distribution_channel', { length: 2 }).notNull(),
  division: varchar('division', { length: 2 }).notNull(),
  customerNumber: varchar('customer_number', { length: 40 }).notNull().default(''),
  materialNumber: varchar('material_number', { length: 40 }).notNull().default(''),
  currency: char('currency', { length: 3 }).notNull().references(() => currency.code),
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  priceUnit: integer('price_unit').notNull().default(1),
  validityFrom: date('validity_from', { mode: 'string' }).notNull(),
  validityTo: date('validity_to', { mode: 'string' }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.conditionNumber] }),
  check('sales_condition_record_type_ck', sql`${t.conditionType} = 'PR00'`),
  check('sales_condition_record_amount_ck', sql`${t.amount} >= 0 and ${t.priceUnit} > 0`),
  check('sales_condition_record_validity_ck', sql`${t.validityTo} >= ${t.validityFrom}`),
  check('sales_condition_record_key_ck', sql`${t.customerNumber} <> '' or ${t.materialNumber} <> ''`),
  uniqueIndex('sales_condition_record_key_uq').on(
    t.client, t.conditionType, t.salesOrg, t.distributionChannel, t.division, t.customerNumber, t.materialNumber, t.validityFrom,
  ),
]);

/** The tables this module owns, named for the audit that checks each one is registered and policed. */
export const salesTableNames = ['sales_order', 'sales_order_line', 'sales_condition_record'] as const;

/**
 * The outbound delivery — LIKP. It carries the plant the goods leave, the order it was created from and,
 * once the movement has run, the material document that did it. No quantity counter of the order is kept
 * here or there: what stands delivered is read from the delivery lines that reference the order line.
 */
export const DELIVERY_STATUSES = ['OPEN', 'PICKED', 'GOODS_ISSUED', 'CANCELLED'] as const;

export const delivery = pgTable('delivery', {
  client: tenant(),
  deliveryNumber: varchar('delivery_number', { length: 20 }).notNull(),
  documentType: varchar('document_type', { length: 2 }).notNull().default('LF'),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  salesOrg: varchar('sales_org', { length: 4 }).notNull(),
  distributionChannel: varchar('distribution_channel', { length: 2 }).notNull(),
  division: varchar('division', { length: 2 }).notNull(),
  customerNumber: varchar('customer_number', { length: 40 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  deliveryDate: date('delivery_date', { mode: 'string' }).notNull(),
  goodsMovementDate: date('goods_movement_date', { mode: 'string' }),
  status: varchar('status', { length: 16 }).notNull().default('OPEN'),
  materialDocumentNumber: varchar('material_document_number', { length: 20 }),
  materialDocumentYear: integer('material_document_year'),
  headerText: varchar('header_text', { length: 100 }),
  version: integer('version').notNull().default(1),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.deliveryNumber] }),
  check('delivery_status_ck', sql`${t.status} in ('OPEN', 'PICKED', 'GOODS_ISSUED', 'CANCELLED')`),
  check('delivery_version_ck', sql`${t.version} > 0`),
  check('delivery_issued_needs_document_ck', sql`${t.status} <> 'GOODS_ISSUED' or (${t.materialDocumentNumber} is not null and ${t.materialDocumentYear} is not null)`),
  foreignKey({
    name: 'delivery_order_fk',
    columns: [t.client, t.orderNumber],
    foreignColumns: [salesOrder.client, salesOrder.orderNumber],
  }).onDelete('cascade'),
]);

/**
 * One item of a delivery — LIPS. The four order-facing quantities stay on the row so the over-delivery
 * refusal is readable from the delivery alone, and `remaining_quantity` is arithmetic the database checks
 * rather than a figure the form was trusted with.
 */
export const deliveryLine = pgTable('delivery_line', {
  client: tenant(),
  deliveryNumber: varchar('delivery_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  orderLineNumber: integer('order_line_number').notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  quantityUnit: char('quantity_unit', { length: 6 }).notNull().references(() => unitOfMeasure.code),
  orderedQuantity: numeric('ordered_quantity', { precision: 13, scale: 3 }).notNull(),
  deliveredBefore: numeric('delivered_before', { precision: 13, scale: 3 }).notNull().default('0'),
  deliveryQuantity: numeric('delivery_quantity', { precision: 13, scale: 3 }).notNull(),
  remainingQuantity: numeric('remaining_quantity', { precision: 13, scale: 3 }).notNull(),
  pickedQuantity: numeric('picked_quantity', { precision: 13, scale: 3 }).notNull().default('0'),
  goodsIssueQuantity: numeric('goods_issue_quantity', { precision: 13, scale: 3 }).notNull().default('0'),
  status: varchar('status', { length: 16 }).notNull().default('OPEN'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.deliveryNumber, t.lineNumber] }),
  check('delivery_line_status_ck', sql`${t.status} in ('OPEN', 'PICKED', 'GOODS_ISSUED')`),
  check('delivery_line_quantity_ck', sql`${t.orderedQuantity} > 0 and ${t.deliveryQuantity} > 0 and ${t.deliveredBefore} >= 0`),
  check('delivery_line_remaining_ck', sql`${t.remainingQuantity} = ${t.orderedQuantity} - ${t.deliveredBefore} - ${t.deliveryQuantity} and ${t.remainingQuantity} >= 0`),
  check('delivery_line_picked_ck', sql`${t.pickedQuantity} >= 0 and ${t.pickedQuantity} <= ${t.deliveryQuantity}`),
  check('delivery_line_issue_completeness_ck', sql`${t.status} <> 'GOODS_ISSUED' or (${t.pickedQuantity} = ${t.deliveryQuantity} and ${t.goodsIssueQuantity} = ${t.deliveryQuantity})`),
]);

/** A picking confirmation — append-only, so a wrong one is answered by a row of the opposite sign. */
export const deliveryPicking = pgTable('delivery_picking', {
  client: tenant(),
  deliveryNumber: varchar('delivery_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  pickNumber: integer('pick_number').notNull(),
  quantityDelta: numeric('quantity_delta', { precision: 13, scale: 3 }).notNull(),
  storageLocation: varchar('storage_location', { length: 10 }).notNull(),
  batchNumber: varchar('batch_number', { length: 40 }).notNull().default(''),
  reason: varchar('reason', { length: 60 }),
  requestKey: varchar('request_key', { length: 64 }),
  createdBy: varchar('created_by', { length: 60 }).notNull().default('SYSTEM'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.deliveryNumber, t.lineNumber, t.pickNumber] }),
  check('delivery_picking_delta_ck', sql`${t.quantityDelta} <> 0`),
]);

/**
 * The billing document — VBRK. It posts nothing of its own: the receivable is the accounting-invoice
 * service's work, and this row keeps the document number it returned so the link reads both ways.
 */
export const BILLING_STATUSES = ['OPEN', 'POSTED', 'CANCELLED'] as const;

export const billingDocument = pgTable('billing_document', {
  client: tenant(),
  billingNumber: varchar('billing_number', { length: 20 }).notNull(),
  documentType: varchar('document_type', { length: 2 }).notNull().default('F2'),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  deliveryNumber: varchar('delivery_number', { length: 20 }).notNull(),
  salesOrg: varchar('sales_org', { length: 4 }).notNull(),
  distributionChannel: varchar('distribution_channel', { length: 2 }).notNull(),
  division: varchar('division', { length: 2 }).notNull(),
  customerNumber: varchar('customer_number', { length: 40 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  currency: char('currency', { length: 3 }).notNull().references(() => currency.code),
  billingDate: date('billing_date', { mode: 'string' }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }),
  status: varchar('status', { length: 16 }).notNull().default('OPEN'),
  netValue: numeric('net_value', { precision: 23, scale: 4 }).notNull().default('0'),
  taxValue: numeric('tax_value', { precision: 23, scale: 4 }).notNull().default('0'),
  grossValue: numeric('gross_value', { precision: 23, scale: 4 }).notNull().default('0'),
  customerInvoiceNumber: varchar('customer_invoice_number', { length: 20 }),
  journalDocumentNumber: varchar('journal_document_number', { length: 20 }),
  referenceDocumentText: varchar('reference_document_text', { length: 100 }),
  /** Optional link to the original billing document this credit memo or replacement billing stands against. */
  creditOf: varchar('credit_of', { length: 20 }),
  version: integer('version').notNull().default(1),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.billingNumber] }),
  check('billing_document_status_ck', sql`${t.status} in ('OPEN', 'POSTED', 'CANCELLED')`),
  check('billing_document_posted_needs_invoice_ck', sql`${t.status} <> 'POSTED' or (${t.customerInvoiceNumber} is not null and ${t.journalDocumentNumber} is not null)`),
  uniqueIndex('billing_document_delivery_uq').on(t.client, t.deliveryNumber),
]);

/** One item of a billing document — VBRP. Written once, and one delivery line earns one of them, ever. */
export const billingDocumentLine = pgTable('billing_document_line', {
  client: tenant(),
  billingNumber: varchar('billing_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  deliveryNumber: varchar('delivery_number', { length: 20 }).notNull(),
  deliveryLineNumber: integer('delivery_line_number').notNull(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  orderLineNumber: integer('order_line_number').notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  billingQuantity: numeric('billing_quantity', { precision: 13, scale: 3 }).notNull(),
  netPrice: numeric('net_price', { precision: 23, scale: 4 }).notNull(),
  priceUnit: integer('price_unit').notNull().default(1),
  netAmount: numeric('net_amount', { precision: 23, scale: 4 }).notNull(),
  taxCode: varchar('tax_code', { length: 4 }),
  taxRate: numeric('tax_rate', { precision: 7, scale: 4 }).notNull().default('0'),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  conditionNumber: varchar('condition_number', { length: 18 }).notNull(),
  createdBy: varchar('created_by', { length: 60 }).notNull().default('SYSTEM'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.billingNumber, t.lineNumber] }),
  check('billing_document_line_quantity_ck', sql`${t.billingQuantity} > 0 and ${t.priceUnit} > 0`),
  check('billing_document_line_amount_math_ck', sql`abs(${t.netAmount} - (${t.billingQuantity} * ${t.netPrice} / ${t.priceUnit})) < 0.005`),
  uniqueIndex('billing_document_line_delivery_line_uq').on(t.client, t.deliveryNumber, t.deliveryLineNumber),
  foreignKey({
    name: 'billing_document_line_condition_fk',
    columns: [t.client, t.conditionNumber],
    foreignColumns: [salesConditionRecord.client, salesConditionRecord.conditionNumber],
  }).onDelete('restrict'),
]);
