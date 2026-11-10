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
 * arithmetic.
 *
 * Pricing is the condition technique (DI-018, closed for the condition types delivered with the package):
 * a condition type master, a procedure of ordered steps, a determination that decides which procedure
 * answers for a sales area and a document, and the conditions every document was priced by, kept beside
 * the figures they produced. The access strategy is fixed and the execution is hardcoded — no scales, no
 * dynamic condition tables, no requirement routines — which is the line this phase drew.
 */
import { pgTable, timestamp, varchar, char, integer, numeric, boolean, date, primaryKey, foreignKey, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { currency, unitOfMeasure } from '../../platform/tables/reference';
import { bpRole, businessPartner } from '../foundation/business-partner-schema';
import { chartOfAccounts, companyCode, plant, salesArea } from '../foundation/schema';
import { material, movementType } from '../inventory/schema';
import { glAccount } from '../finance/schema';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });

export const ORDER_STATUSES = ['OPEN', 'CANCELLED'] as const;
export const ORDER_LINE_STATUSES = ['OPEN', 'REJECTED'] as const;
/**
 * A sales document type — VOV8, the delivery type and the billing type held in one table, because all
 * three are the same fact: the code a document carries, the number range its number is drawn from, and
 * whether the type may still be used. Until 9226 these were constants written into the three services,
 * which made every new commercial process a deployment instead of a configuration.
 *
 * Only what is read is stored. The cancellation billing type, the proposed follow-on types and the
 * pricing and partner procedure keys arrive with the increments that read them.
 */
export const salesDocumentType = pgTable('sales_document_type', {
  client: tenant(),
  documentType: varchar('document_type', { length: 4 }).notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  numberRangeObject: varchar('number_range_object', { length: 10 }).notNull(),
  numberRangeSubObject: varchar('number_range_sub_object', { length: 10 }).notNull(),
  /**
   * The type a document of this type cancels into — `S1` for `F2`, as VF11 uses it. Null where the type has
   * no cancellation counterpart, which is true of an order and of a delivery: nothing there is undone by a
   * second document.
   */
  cancellationDocumentType: varchar('cancellation_document_type', { length: 4 }),
  isActive: boolean('is_active').notNull().default(true),
  /**
   * The document's pricing procedure — the key the procedure determination is searched by, as SAP's
   * VOV8 carries it. It is not the procedure itself: which procedure answers for this document type in
   * this sales area for this customer is the determination's business, and the same document type can
   * answer differently for two customers.
   */
  pricingProcedure: varchar('pricing_procedure', { length: 6 }).notNull().default('A'),
  /**
   * The invoice-list type this document type is grouped into — SAP's `OVV7`, which assigns a billing
   * type to an invoice-list type (§4.6, gap G2).
   *
   * Together with the payer's schedule it is the whole of relevance: a billing document is listed only
   * where **both** the type it was raised as and the payer it was raised for say so. Blank means what
   * a blank `VBRK-FKART_RL` means — the document is released to accounting on its own, the day it is
   * billed. Which is why nothing that stands today changes: no delivered type carries one until a
   * tenant maintains it.
   */
  invoiceListType: varchar('invoice_list_type', { length: 4 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.documentType] }),
  foreignKey({
    columns: [t.client, t.cancellationDocumentType],
    foreignColumns: [t.client, t.documentType],
  }).onDelete('restrict'),
  // The list type names a document type that must stand: an invoice list is a billing document, drawn
  // from the same number ranges and carrying the same header, and a row that named a type that cannot
  // be created would be a configuration that fails as a refusal at the worst moment.
  foreignKey({
    name: 'sales_document_type_invoice_list_fk',
    columns: [t.client, t.invoiceListType],
    foreignColumns: [t.client, t.documentType],
  }).onDelete('restrict'),
]);

/**
 * Which documents the returns chain uses, and which movement the receipt posts.
 *
 * The returns chain arrived carrying `RE`, `LR`, `CR` and `G2` as constants in the services that create
 * them, and `RETURNS_RECEIPT` as the movement its receipt posts. Constants the way the order type used to
 * be a constant, and wrong in the same way: a tenant whose returns process wants its own document types —
 * a returns order that numbers apart, a complaint that a different desk works — had to ask for a
 * deployment. The types themselves became configuration in 9226; which of them the returns chain *uses*
 * becomes configuration here.
 *
 * One row per tenant, and only one: the chain is one thing, and two rows would let half a chain be
 * configured against the other half. Every column is a foreign key to a row that must stand — a document
 * type, or a movement type — so the configuration cannot name a document that cannot be created.
 */
export const salesReturnsConfiguration = pgTable('sales_returns_configuration', {
  client: tenant(),
  /** The type a returns order carries: what the customer's complaint is recorded as. */
  returnsOrderType: varchar('returns_order_type', { length: 4 }).notNull(),
  /** The type of the delivery that brings the goods back. */
  returnsDeliveryType: varchar('returns_delivery_type', { length: 4 }).notNull(),
  /** The type of the complaint document a credit is requested on, held until somebody releases it. */
  complaintType: varchar('complaint_type', { length: 4 }).notNull(),
  /** The type of the credit memo that gives the customer their money back. */
  creditMemoType: varchar('credit_memo_type', { length: 4 }).notNull(),
  /**
   * The movement the receipt posts — the 651. It must stand configured to receive into returns stock
   * carrying no value, which is what a return is: counted, and not the company's stock again until
   * somebody has inspected it. The posting re-reads those facts; the configuration refuses a movement
   * that contradicts them rather than letting the refusal arrive when the lorry is at the door.
   */
  receiptMovementType: varchar('receipt_movement_type', { length: 20 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client] }),
  foreignKey({
    columns: [t.client, t.returnsOrderType],
    foreignColumns: [salesDocumentType.client, salesDocumentType.documentType],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.returnsDeliveryType],
    foreignColumns: [salesDocumentType.client, salesDocumentType.documentType],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.complaintType],
    foreignColumns: [salesDocumentType.client, salesDocumentType.documentType],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.creditMemoType],
    foreignColumns: [salesDocumentType.client, salesDocumentType.documentType],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.receiptMovementType],
    foreignColumns: [movementType.client, movementType.movementType],
  }).onDelete('restrict'),
]);

/** One sales order. The order posts nothing; it states what the customer asked for and at what value. */
export const salesOrder = pgTable('sales_order', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  documentType: varchar('document_type', { length: 2 }).notNull().default('OR'),
  /**
   * What this order was raised against, as a type and a number: the invoice on a returns order (RE),
   * nothing on every other. The pair is what lets a return be priced from what was actually invoiced.
   */
  referenceDocumentType: varchar('reference_document_type', { length: 2 }),
  referenceDocumentNumber: varchar('reference_document_number', { length: 20 }),
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
  /**
   * Why this document is held from billing; null when it stands released. A credit memo request is
   * created held, and no credit memo is raised against it until somebody releases it.
   */
  billingBlock: varchar('billing_block', { length: 60 }),
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
  /**
   * What the availability check confirmed against this line: the promise the plant made. Null is
   * not zero — it is a line that was never checked, and a line that was never checked delivers as
   * an unchecked line always did. It is never re-derived from stock: it says what the plant
   * promised on the day, not what it happens to hold now.
   */
  confirmedQuantity: numeric('confirmed_quantity', { precision: 13, scale: 3 }),
  netPrice: numeric('net_price', { precision: 23, scale: 4 }).notNull().default('0'),
  priceUnit: integer('price_unit').notNull().default(1),
  netAmount: numeric('net_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  taxCode: varchar('tax_code', { length: 4 }),
  taxRate: numeric('tax_rate', { precision: 7, scale: 4 }).notNull().default('0'),
  taxAmount: numeric('tax_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  profitCenter: varchar('profit_center', { length: 20 }),
  requestedDeliveryDate: date('requested_delivery_date', { mode: 'string' }),
  conditionNumber: varchar('condition_number', { length: 18 }).notNull(),
  /** The billing line this item was copied from, on a returns order; null on every other item. */
  referenceBillingNumber: varchar('reference_billing_number', { length: 20 }),
  referenceBillingLineNumber: integer('reference_billing_line_number'),
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
 * A schedule line: what an order line asked for and by when, and what the availability check
 * confirmed against it (SAP VBEP).
 *
 * A confirmation is not a decision somebody makes on a screen. It is the answer the check returned,
 * written down at the moment it was asked, so a document read in a month still says what the plant
 * promised on the day. The delivery is created from the confirmed quantity and not from the ordered
 * one, so a plant that can supply six of the ten a customer ordered ships six and owes four.
 *
 * Confirmed zero is not a missing confirmation. It is a refusal made in arithmetic.
 */
export const salesOrderSchedule = pgTable('sales_order_schedule', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  orderLineNumber: integer('order_line_number').notNull(),
  scheduleNumber: integer('schedule_number').notNull(),
  requestedDate: date('requested_date', { mode: 'string' }).notNull(),
  requestedQuantity: numeric('requested_quantity', { precision: 13, scale: 3 }).notNull(),
  confirmedQuantity: numeric('confirmed_quantity', { precision: 13, scale: 3 }).notNull().default('0'),
  confirmedDate: date('confirmed_date', { mode: 'string' }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.orderLineNumber, t.scheduleNumber] }),
  foreignKey({
    name: 'sales_order_schedule_line_fk',
    columns: [t.client, t.orderNumber, t.orderLineNumber],
    foreignColumns: [salesOrderLine.client, salesOrderLine.orderNumber, salesOrderLine.lineNumber],
  }).onDelete('cascade'),
  check('sales_order_schedule_number_ck', sql`${t.scheduleNumber} > 0`),
  check('sales_order_schedule_quantity_ck', sql`${t.requestedQuantity} > 0`),
  check('sales_order_schedule_confirmed_ck', sql`${t.confirmedQuantity} >= 0 and ${t.confirmedQuantity} <= ${t.requestedQuantity}`),
]);

/**
 * What a condition type *is* — the master every pricing step names.
 *
 * The order price used to be `PR00` in a constant, and the tax was a rate read from the tax master and
 * applied in the service: two pricing facts, neither of them describable. A price, a customer discount,
 * a freight charge and an output tax are the same kind of thing seen four ways — a figure, a base it is
 * calculated on, a sign, and a key the ledger is determined by — so they are rows here and steps in a
 * procedure below. What is *not* configurable is how a figure becomes an amount: `FIXED` and `PERCENTAGE`
 * are the two calculations the engine executes, and no amount of configuration invents a third.
 */
export const salesConditionType = pgTable('sales_condition_type', {
  client: tenant(),
  conditionType: varchar('condition_type', { length: 4 }).notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  /** What the figure means on a document: a price, a discount, a freight charge, a tax, a cost. */
  conditionClass: varchar('condition_class', { length: 10 }).notNull(),
  /**
   * How the figure becomes an amount: per price unit, or a percentage of the step's base.
   *
   * `MATERIAL_COST` is the third, and the only one whose rate is not maintained: it is read from the
   * valuation of the material at the plant, which is what a cost is. A cost kept in a condition record
   * would be a price wearing a cost's name, and it would drift from the books the moment a goods
   * movement moved them.
   */
  calculationType: varchar('calculation_type', { length: 16 }).notNull(),
  /** Whether the step takes away from the value it is calculated on. A discount does; freight does not. */
  isNegative: boolean('is_negative').notNull().default(false),
  /**
   * A statistical condition is shown and never charged: the cost that makes a margin visible belongs on
   * the document and in no total and no ledger line.
   */
  isStatistical: boolean('is_statistical').notNull().default(false),
  /** What the G/L account is determined by (2.3): `ERL` revenue, `ERF` freight, `MWS` output tax. */
  accountKey: varchar('account_key', { length: 3 }),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.conditionType] }),
  // REBATE is the sixth class. It is not a price — it does not say what the customer pays — and it is
  // not a discount, which the customer never pays in the first place. It is revenue the company has
  // earned and promised to hand back: shown on the document, accrued as a provision when the document
  // is posted, and paid out later on a settlement credit memo.
  check('sales_condition_type_class_ck',
    sql`${t.conditionClass} in ('PRICE', 'DISCOUNT', 'FREIGHT', 'TAX', 'COST', 'REBATE')`),
  check('sales_condition_type_calculation_ck',
    sql`${t.calculationType} in ('FIXED', 'PERCENTAGE', 'MATERIAL_COST')`),
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
  check('sales_condition_record_amount_ck', sql`${t.amount} >= 0 and ${t.priceUnit} > 0`),
  check('sales_condition_record_validity_ck', sql`${t.validityTo} >= ${t.validityFrom}`),
  check('sales_condition_record_key_ck', sql`${t.customerNumber} <> '' or ${t.materialNumber} <> ''`),
  uniqueIndex('sales_condition_record_key_uq').on(
    t.client, t.conditionType, t.salesOrg, t.distributionChannel, t.division, t.customerNumber, t.materialNumber, t.validityFrom,
  ),
  // The type a record carries is a row in the condition type master, and no longer a literal in a check
  // constraint: what may be maintained is configuration, and a constraint cannot read a table.
  foreignKey({
    columns: [t.client, t.conditionType],
    foreignColumns: [salesConditionType.client, salesConditionType.conditionType],
  }).onDelete('restrict'),
]);

/** A pricing procedure: the ordered set of condition types a document is priced by. */
export const salesPricingProcedure = pgTable('sales_pricing_procedure', {
  client: tenant(),
  procedureCode: varchar('procedure_code', { length: 6 }).notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.procedureCode] })]);

/**
 * One step of a procedure.
 *
 * A step is a condition type, the span of steps its percentage is calculated on, and whether it is
 * required. The span is what makes a tax different from a discount: the discount is taken on the price,
 * the tax is charged on the value that survives the discount and the freight — in SAP's terms, subtotal
 * 2 rather than the gross. A step with no span is calculated on nothing, which is a configuration error
 * and refused when the step is written.
 */
export const salesPricingProcedureStep = pgTable('sales_pricing_procedure_step', {
  client: tenant(),
  procedureCode: varchar('procedure_code', { length: 6 }).notNull(),
  stepNumber: integer('step_number').notNull(),
  conditionType: varchar('condition_type', { length: 4 }).notNull(),
  /** The first step in the span this step is calculated on; null where the step needs no base. */
  fromStep: integer('from_step'),
  /** The last step in the span; null where the step needs no base. */
  toStep: integer('to_step'),
  /**
   * A step the document may go without: a discount nobody maintains a record for is not a refusal, it is
   * a sale at list price. The price step is not one of those — a document with no price is not priced.
   */
  isRequired: boolean('is_required').notNull().default(false),
  /**
   * Whether the step stands once for the document or once for every item.
   *
   * A header condition is calculated on the value of the whole document and then distributed to the
   * items in proportion to what each is worth, because the ledger is determined per line (2.3) and a
   * figure belonging to no line can be posted to no account the determination chose. What the header
   * keeps is the whole, at line 0; what the items carry is their share of it.
   */
  conditionLevel: varchar('condition_level', { length: 6 }).notNull().default('ITEM'),
  /**
   * A withdrawn step is not executed. There is no delete: a step is part of the rule a document was
   * priced by, and a document read years from now must still be able to say what priced it.
   */
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.procedureCode, t.stepNumber] }),
  foreignKey({
    columns: [t.client, t.conditionType],
    foreignColumns: [salesConditionType.client, salesConditionType.conditionType],
  }).onDelete('restrict'),
  check('sales_pricing_step_span_ck', sql`(${t.fromStep} is null) = (${t.toStep} is null)`),
  check('sales_pricing_step_span_order_ck',
    sql`${t.fromStep} is null or ${t.toStep} is null or ${t.fromStep} <= ${t.toStep}`),
  check('sales_pricing_step_level_ck', sql`${t.conditionLevel} in ('ITEM', 'HEADER')`),
]);

/**
 * Which procedure prices a document: sales area, the document's pricing procedure and the customer's —
 * SAP's OVKK. A document is never priced by a procedure it found lying around; the determination either
 * stands or the document refuses, because a price nobody can name the rule for is not a price.
 */
export const salesProcedureDetermination = pgTable('sales_procedure_determination', {
  client: tenant(),
  /** Blank means any sales area: one row serves a tenant, and a row for one area can stand beside it. */
  salesOrg: varchar('sales_org', { length: 4 }).notNull().default(''),
  distributionChannel: varchar('distribution_channel', { length: 2 }).notNull().default(''),
  division: varchar('division', { length: 2 }).notNull().default(''),
  /** The pricing procedure on the document type, as VOV8 carries it. */
  documentPricingProcedure: varchar('document_pricing_procedure', { length: 6 }).notNull(),
  /**
   * The pricing procedure on the customer's sales-area data, as XD01 carries it. `*` is any customer
   * procedure, and it is a row rather than a fallback in the engine: what the wildcard grants can be
   * read, and a tenant that wants a customer priced differently maintains a row that names them.
   */
  customerPricingProcedure: varchar('customer_pricing_procedure', { length: 6 }).notNull(),
  procedureCode: varchar('procedure_code', { length: 6 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({
    columns: [
      t.client, t.salesOrg, t.distributionChannel, t.division,
      t.documentPricingProcedure, t.customerPricingProcedure,
    ],
  }),
  foreignKey({
    columns: [t.client, t.procedureCode],
    foreignColumns: [salesPricingProcedure.client, salesPricingProcedure.procedureCode],
  }).onDelete('restrict'),
]);

/**
 * Revenue account determination — SAP's VKOA, and the reason an invoice is not posted to a revenue
 * account a service chose.
 *
 * A sale does not post to "revenue"; it posts to the account this table names. What it is determined by
 * is a key of five parts: the chart of accounts the company code keeps, the sales organisation the
 * document belongs to, the customer's account assignment group, the material's account assignment group,
 * and the account key the pricing step carried — `ERL` for the price, `ERS` for a discount, `ERF` for
 * freight, `MWS` for output tax. Blank in any of the three middle parts means "any", and the most
 * specific row that fits answers, in a fixed order.
 *
 * Where no row stands, the document is not posted at all. That refusal is the whole point: an invoice
 * posted to an account nobody chose is a number in the ledger with no rule behind it, which is exactly
 * what a determination exists to prevent.
 */
export const salesAccountDetermination = pgTable('sales_account_determination', {
  client: tenant(),
  chartOfAccounts: varchar('chart_of_accounts', { length: 4 }).notNull(),
  /** Blank means any sales organisation. */
  salesOrg: varchar('sales_org', { length: 4 }).notNull().default(''),
  /** Blank means the customer carries no account assignment group. It is matched as a value. */
  customerAccountAssignmentGroup: varchar('customer_account_assignment_group', { length: 4 }).notNull().default(''),
  /** Blank means the material carries no account assignment group. It is matched as a value. */
  materialAccountAssignmentGroup: varchar('material_account_assignment_group', { length: 4 }).notNull().default(''),
  accountKey: varchar('account_key', { length: 4 }).notNull(),
  glAccount: varchar('gl_account', { length: 10 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({
    columns: [
      t.client, t.chartOfAccounts, t.salesOrg, t.customerAccountAssignmentGroup,
      t.materialAccountAssignmentGroup, t.accountKey,
    ],
  }),
  foreignKey({
    name: 'sales_account_determination_chart_fk',
    columns: [t.client, t.chartOfAccounts],
    foreignColumns: [chartOfAccounts.client, chartOfAccounts.chartOfAccounts],
  }).onDelete('restrict'),
  foreignKey({
    name: 'sales_account_determination_account_fk',
    columns: [t.client, t.chartOfAccounts, t.glAccount],
    foreignColumns: [glAccount.client, glAccount.chartOfAccounts, glAccount.accountNumber],
  }).onDelete('restrict'),
  check('sales_account_determination_key_ck', sql`${t.accountKey} ~ '^[A-Z0-9]{2,4}$'`),
]);

/**
 * The conditions a document was priced by — SAP's KONV, and the reason a document can be read years
 * later and still explain itself.
 *
 * Every step that produced a figure is written here: the condition type, the record that answered, the
 * base, the rate and the amount. The document line carries only the totals, so without this table a
 * discounted invoice is a number with no arithmetic behind it, and a re-priced document is one nobody
 * can prove did not move.
 */
export const salesDocumentCondition = pgTable('sales_document_condition', {
  client: tenant(),
  /** Which document this row prices: an order or a billing document. */
  documentCategory: varchar('document_category', { length: 10 }).notNull(),
  documentNumber: varchar('document_number', { length: 20 }).notNull(),
  /** The line the condition belongs to; 0 for a condition carried by the header. */
  lineNumber: integer('line_number').notNull(),
  /**
   * Where the row came from. `ITEM` is a condition priced on that line. `HEADER` is the whole of a
   * header condition, kept at line 0 — the figure the printout shows. `DISTRIBUTED` is the share of a
   * header condition that fell to this line, which is what the line is worth and what the ledger is
   * made of; the distributed shares of one header condition sum to the row at line 0, to the cent.
   */
  origin: varchar('origin', { length: 11 }).notNull().default('ITEM'),
  stepNumber: integer('step_number').notNull(),
  conditionType: varchar('condition_type', { length: 4 }).notNull(),
  /** What the step was calculated on, in the document currency. */
  baseValue: numeric('base_value', { precision: 23, scale: 4 }).notNull().default('0'),
  /** The rate: the record's amount for a fixed step, the percentage for a percentage step. */
  rate: numeric('rate', { precision: 13, scale: 6 }).notNull().default('0'),
  /** The amount the step contributes, signed: a discount carries a negative amount. */
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull().default('0'),
  priceUnit: integer('price_unit').notNull().default(1),
  currency: char('currency', { length: 3 }).notNull(),
  /**
   * The condition record that answered, where a record answered. A tax step is rated by the tax master
   * and names nothing here, which is the honest difference between a price and a rate.
   */
  conditionNumber: varchar('condition_number', { length: 18 }),
  /** What the ledger account will be determined by — carried from the step, as SAP carries KOKEY. */
  accountKey: varchar('account_key', { length: 3 }),
  isStatistical: boolean('is_statistical').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({
    columns: [t.client, t.documentCategory, t.documentNumber, t.lineNumber, t.stepNumber],
  }),
  foreignKey({
    columns: [t.client, t.conditionType],
    foreignColumns: [salesConditionType.client, salesConditionType.conditionType],
  }).onDelete('restrict'),
  check('sales_document_condition_origin_ck', sql`${t.origin} in ('ITEM', 'HEADER', 'DISTRIBUTED')`),
  check('sales_document_condition_header_ck',
    sql`(${t.origin} = 'HEADER' and ${t.lineNumber} = 0) or (${t.origin} <> 'HEADER' and ${t.lineNumber} > 0)`),
  check('sales_document_condition_category_ck',
    sql`${t.documentCategory} in ('ORDER', 'BILLING')`),
]);

/** The tables this module owns, named for the audit that checks each one is registered and policed. */
export const salesTableNames = [
  'sales_order', 'sales_order_line', 'sales_condition_record', 'sales_document_type',
  'sales_condition_type', 'sales_pricing_procedure', 'sales_pricing_procedure_step',
  'sales_procedure_determination', 'sales_document_condition',
] as const;

/**
 * The outbound delivery — LIKP. It carries the plant the goods leave, the order it was created from and,
 * once the movement has run, the material document that did it. No quantity counter of the order is kept
 * here or there: what stands delivered is read from the delivery lines that reference the order line.
 */
/**
 * How a customer wants goods to reach them — SAP's VSBED, the shipping conditions of the customer
 * master's shipping view. It is a requirement of the customer and not of the material: the same
 * goods go by road for one customer and by air for another, and it is the customer's half of the
 * shipping point determination.
 *
 * Two characters, as SAP carries them. A customer maintained with none is not an omission to be
 * filled in — it is a customer who has said nothing, and the determination rows that name no
 * condition are the ones maintained for them.
 */
export const shippingCondition = pgTable('shipping_condition', {
  client: tenant(),
  shippingCondition: varchar('shipping_condition', { length: 2 }).notNull(),
  description: varchar('description', { length: 40 }).notNull().default(''),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.shippingCondition] }),
  check('shipping_condition_code_ck', sql`${t.shippingCondition} ~ '^[A-Z0-9]{1,2}$'`),
]);

/**
 * The place a delivery is loaded — SAP's VSTEL, and the table behind it TVST: a dock, a depot, a
 * gate, with its own working times and its own way of loading.
 *
 * A shipping point carries no plant of its own. Which plant it loads from is answered by every row
 * that assigns it, because the assignment is the determination: one dock may load for several
 * plants, and a plant may be served by several docks. A plant column here could only contradict
 * the rows that actually do the work.
 */
export const shippingPoint = pgTable('shipping_point', {
  client: tenant(),
  shippingPoint: varchar('shipping_point', { length: 4 }).notNull(),
  name: varchar('name', { length: 40 }).notNull().default(''),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.shippingPoint] }),
  check('shipping_point_code_ck', sql`${t.shippingPoint} ~ '^[A-Z0-9]{1,4}$'`),
]);

/**
 * Shipping condition + loading group + delivering plant to the shipping point that loads them —
 * SAP's OVL2, and the table it maintains, TVSTZ.
 *
 * It is a determination, so it is built like the others in this package: rows, blank as a value
 * that is matched, most specific first. The row naming both the condition and the group answers
 * before a row naming one of them, and the row naming neither is the plant's own answer for every
 * combination it has no opinion about. Where the condition and the group disagree and no row names
 * both, the material's loading group stands: a dock that cannot lift the goods is no answer at
 * all, whereas a customer who wants them quickly can be served from anywhere that can load them.
 *
 * There is no delete. A row here is the rule a delivery was raised under.
 */
export const shippingPointDetermination = pgTable('shipping_point_determination', {
  client: tenant(),
  deliveringPlant: varchar('delivering_plant', { length: 10 }).notNull(),
  /** Blank means the customer carries no shipping condition. It is matched as a value. */
  shippingCondition: varchar('shipping_condition', { length: 2 }).notNull().default(''),
  /** Blank means the material carries no loading group. It is matched as a value. */
  loadingGroup: varchar('loading_group', { length: 4 }).notNull().default(''),
  shippingPoint: varchar('shipping_point', { length: 4 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.deliveringPlant, t.shippingCondition, t.loadingGroup] }),
  foreignKey({
    name: 'shipping_point_determination_plant_fk',
    columns: [t.client, t.deliveringPlant],
    foreignColumns: [plant.client, plant.plant],
  }).onDelete('restrict'),
  foreignKey({
    name: 'shipping_point_determination_point_fk',
    columns: [t.client, t.shippingPoint],
    foreignColumns: [shippingPoint.client, shippingPoint.shippingPoint],
  }).onDelete('restrict'),
  check('shipping_point_determination_condition_ck',
    sql`${t.shippingCondition} = '' or ${t.shippingCondition} ~ '^[A-Z0-9]{1,2}$'`),
  check('shipping_point_determination_group_ck',
    sql`${t.loadingGroup} = '' or ${t.loadingGroup} ~ '^[A-Z0-9]{1,4}$'`),
]);

export const DELIVERY_STATUSES = ['OPEN', 'PICKED', 'GOODS_ISSUED', 'CANCELLED'] as const;

export const delivery = pgTable('delivery', {
  client: tenant(),
  deliveryNumber: varchar('delivery_number', { length: 20 }).notNull(),
  documentType: varchar('document_type', { length: 2 }).notNull().default('LF'),
  /**
   * Set only on a returns delivery: the delivery the goods went out on and are coming back against.
   * Nothing else names one, and a return names exactly one — a document that received goods from two
   * deliveries could not say which of them may still return what.
   */
  referenceDeliveryNumber: varchar('reference_delivery_number', { length: 20 }),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  salesOrg: varchar('sales_org', { length: 4 }).notNull(),
  distributionChannel: varchar('distribution_channel', { length: 2 }).notNull(),
  division: varchar('division', { length: 2 }).notNull(),
  customerNumber: varchar('customer_number', { length: 40 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  /**
   * Where the goods are loaded. Determined when the delivery was created, from the ship-to's
   * shipping condition, the material's loading group and the delivering plant — never entered
   * by the person raising the delivery, because a dock nobody chose is not a dock.
   *
   * Null on a delivery raised before the determination stood; those read as they always did.
   */
  shippingPoint: varchar('shipping_point', { length: 4 }),
  /**
   * Where the goods went, written when the delivery was created and read as the delivery's own
   * address since. A customer whose master is remade next month does not move last month's
   * goods: the address a delivery carries is the one it was raised with.
   */
  shipToName: varchar('ship_to_name', { length: 160 }).notNull().default(''),
  shipToStreet: varchar('ship_to_street', { length: 180 }),
  shipToCity: varchar('ship_to_city', { length: 100 }),
  shipToRegion: varchar('ship_to_region', { length: 80 }),
  shipToPostalCode: varchar('ship_to_postal_code', { length: 20 }),
  shipToCountry: char('ship_to_country', { length: 2 }),
  deliveryDate: date('delivery_date', { mode: 'string' }).notNull(),
  goodsMovementDate: date('goods_movement_date', { mode: 'string' }),
  status: varchar('status', { length: 16 }).notNull().default('OPEN'),
  /**
   * Whether the goods issue this delivery posted still stands: true from the moment the movement
   * posts, false when that movement is reversed. A delivery that stands GOODS_ISSUED is a delivery
   * whose goods are out, so undoing the issue undoes the status with it.
   */
  goodsIssueStands: boolean('goods_issue_stands').notNull().default(false),
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
  foreignKey({
    name: 'delivery_shipping_point_fk',
    columns: [t.client, t.shippingPoint],
    foreignColumns: [shippingPoint.client, shippingPoint.shippingPoint],
  }).onDelete('restrict'),
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
  /**
   * What the availability check had confirmed on the order line when this delivery was made. Null
   * is not zero: it is a delivery raised before a check stood. It is written down, not re-read,
   * so a delivery read in a year still says what the plant had promised when the goods went out —
   * the difference between a plant that kept a promise of six and one that shorted a customer by four.
   */
  confirmedQuantity: numeric('confirmed_quantity', { precision: 13, scale: 3 }),
  deliveredBefore: numeric('delivered_before', { precision: 13, scale: 3 }).notNull().default('0'),
  deliveryQuantity: numeric('delivery_quantity', { precision: 13, scale: 3 }).notNull(),
  remainingQuantity: numeric('remaining_quantity', { precision: 13, scale: 3 }).notNull(),
  pickedQuantity: numeric('picked_quantity', { precision: 13, scale: 3 }).notNull().default('0'),
  goodsIssueQuantity: numeric('goods_issue_quantity', { precision: 13, scale: 3 }).notNull().default('0'),
  /**
   * What has been received back from the customer against this line (movement 651). Bounded by the
   * issued quantity — `delivery_line_returned_ck` — because a return cannot invent goods the plant
   * never sent. Returns stock is not valuated, so this quantity carries no value: it becomes stock
   * again when a transfer takes it out of returns stock and into valuated stock.
   */
  returnedQuantity: numeric('returned_quantity', { precision: 13, scale: 3 }).notNull().default('0'),
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
  /**
   * The order this document was raised against, where it has exactly one.
   *
   * A collective document bills a month of deliveries and may carry several orders — every one of them
   * named on the line that was priced from it — and it names no order of its own rather than pretending
   * to one. SAP's billing header carries no order at all for the same reason: the order is a fact of the
   * item (§4.5, gap G2).
   */
  orderNumber: varchar('order_number', { length: 20 }),
  /**
   * The delivery this document bills. Null on an order-related document, which is raised against a
   * billing plan date and bills a share of an item rather than goods that went out.
   */
  deliveryNumber: varchar('delivery_number', { length: 20 }),
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
  /** The document this one stands against: a credit memo names the invoice it credits. */
  creditOf: varchar('credit_of', { length: 20 }),
  /**
   * Set only on a cancellation document: the billing document this one cancels. A cancellation names its
   * document once and never twice, which is why this is its own column and not `credit_of` — a customer may
   * legitimately hold two credit memos against one invoice.
   */
  cancellationOf: varchar('cancellation_of', { length: 20 }),
  /**
   * The advances of this order this invoice consumed, and the clearing that consumed them. A customer
   * who paid part of the order in advance has already given that money, and the document has to be
   * able to say so: billed, less the advance, is what is still owed. Zero on a down payment request,
   * which is an advance asked for and not a receivable.
   */
  downPaymentClearingNumber: varchar('down_payment_clearing_number', { length: 20 }),
  downPaymentClearedAmount: numeric('down_payment_cleared_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  /**
   * The invoice-list type this document is grouped into, and the date its list falls on — SAP's
   * `VBRK-FKART_RL` and `VBRK-FKDAT_RL` (§4.6, gap G2).
   *
   * Both are stamped at creation and neither is revised, because relevance is a fact of the day the
   * document was raised: a document that was listed does not stop being listed because the payer's
   * schedule changed underneath it, and one that was not does not become listed because a
   * configuration was amended after the fact.
   */
  invoiceListType: varchar('invoice_list_type', { length: 4 }),
  invoiceListDate: date('invoice_list_date', { mode: 'string' }),
  /**
   * Where the document stands with its list: `NOT_RELEVANT` (it posts its own receivable, the day it
   * is billed), `DUE` (it is waiting to be listed and has posted nothing) or `LISTED` (it is on a
   * list, and the list's release is what posts the receivable).
   */
  invoiceListStatus: varchar('invoice_list_status', { length: 12 }).notNull().default('NOT_RELEVANT'),
  /** The invoice list this document is on. Set the moment the list is created, and not before. */
  invoiceListNumber: varchar('invoice_list_number', { length: 20 }),
  version: integer('version').notNull().default(1),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.billingNumber] }),
  check('billing_document_status_ck', sql`${t.status} in ('OPEN', 'POSTED', 'CANCELLED')`),
  // A posted document names the accounting invoice behind it, because a document that bills posts a
  // A posted document names the accounting invoice behind it, because a document that bills posts a
  // receivable — with two exceptions. A down payment request stands and was sent, and posts nothing:
  // the noted item behind it is statistical, a drawn number and no journal. And a document that is on
  // an invoice list posts its receivable through the list rather than through itself: the release
  // posts one entry for the whole group, which is the only shape under which a list is not a second
  // receivable for money the members already owed.
  check('billing_document_posted_needs_invoice_ck', sql`${t.status} <> 'POSTED'
    or ${t.documentType} = 'DP'
    or ${t.invoiceListNumber} is not null
    or (${t.customerInvoiceNumber} is not null and ${t.journalDocumentNumber} is not null)`),
  // A document that is due for a list says when its list falls and what type of list groups it — both
  // or neither, which is SAP's rule for relevance and the whole of it.
  check('billing_document_invoice_list_relevance_ck',
    sql`(${t.invoiceListType} is null) = (${t.invoiceListDate} is null)`),
  check('billing_document_invoice_list_status_ck',
    sql`${t.invoiceListStatus} in ('NOT_RELEVANT', 'DUE', 'LISTED')`),
  // A listed document names the list it is on: a status that said LISTED with no list would be a
  // document that posts nothing and refuses its own cancellation for no reason a reader can see.
  check('billing_document_invoice_listed_ck',
    sql`${t.invoiceListStatus} <> 'LISTED' or ${t.invoiceListNumber} is not null`),
  check('billing_document_cleared_amount_ck', sql`${t.downPaymentClearedAmount} >= 0`),
  // One *live* billing document per delivery. A cancelled document no longer occupies the slot — that is what
  // makes a cancelled invoice re-billable — and neither does a document that stands against another one,
  // because the document it stands against already did. Two live documents for one delivery stay impossible.
  uniqueIndex('billing_document_delivery_live_uq').on(t.client, t.deliveryNumber)
    .where(sql`${t.deliveryNumber} is not null and ${t.status} <> 'CANCELLED'
      and ${t.creditOf} is null and ${t.cancellationOf} is null`),
  // A document is cancelled once.
  uniqueIndex('billing_document_cancellation_uq').on(t.client, t.cancellationOf)
    .where(sql`${t.cancellationOf} is not null`),
  // The list this document is on has to stand: a document listing another document that was never
  // created is a group with a hole in it, and the release would post a total nobody can prove.
  foreignKey({
    name: 'billing_document_invoice_list_fk',
    columns: [t.client, t.invoiceListNumber],
    foreignColumns: [t.client, t.billingNumber],
  }).onDelete('restrict'),
  // And the type of list it is due for has to stand, for the same reason a document type does: the
  // run draws a number from it and posts against the payer it names.
  foreignKey({
    name: 'billing_document_invoice_list_type_fk',
    columns: [t.client, t.invoiceListType],
    foreignColumns: [salesDocumentType.client, salesDocumentType.documentType],
  }).onDelete('restrict'),
]);

/** One item of a billing document — VBRP. Written once, and one delivery line earns one of them, ever. */
export const billingDocumentLine = pgTable('billing_document_line', {
  client: tenant(),
  billingNumber: varchar('billing_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  deliveryNumber: varchar('delivery_number', { length: 20 }),
  deliveryLineNumber: integer('delivery_line_number'),
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
  conditionNumber: varchar('condition_number', { length: 18 }).notNull(),  /** The invoiced line this line was priced from, on a credit memo; null on every other line. */
  referenceBillingNumber: varchar('reference_billing_number', { length: 20 }),
  referenceBillingLineNumber: integer('reference_billing_line_number'),

  createdBy: varchar('created_by', { length: 60 }).notNull().default('SYSTEM'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.billingNumber, t.lineNumber] }),
  check('billing_document_line_quantity_ck', sql`${t.billingQuantity} > 0 and ${t.priceUnit} > 0`),
  check('billing_document_line_amount_math_ck', sql`abs(${t.netAmount} - (${t.billingQuantity} * ${t.netPrice} / ${t.priceUnit})) < 0.005`),
  /**
   * One line per delivery line, of the delivery it came from, within a document.
   *
   * The header's own index is what keeps a delivered line from being billed twice: only one live billing
   * document may stand for a delivery, so only that document's lines bill its lines. Scoped to the
   * document rather than to the delivery, because a cancelled document's lines stay where they are while
   * the corrected document writes its own.
   *
   * Keyed on the delivery as well as on its line (9253). A collective document bills a month of
   * deliveries and every one of them numbers its own lines from ten: a key that named the line number
   * alone would refuse the second delivery of a run for no better reason than that it too has a line 10,
   * which is a rule about one delivery mistaken for a rule about a document.
   */
  uniqueIndex('billing_document_line_delivery_uq')
    .on(t.client, t.billingNumber, t.deliveryNumber, t.deliveryLineNumber)
    .where(sql`${t.deliveryNumber} is not null`),
  /**
   * The same rule for the document that names no delivery: what a plan-date document bills once is the
   * order item. Two plan dates of one item are two documents, as two deliveries of one order are.
   */
  uniqueIndex('billing_document_line_plan_uq')
    .on(t.client, t.billingNumber, t.orderNumber, t.orderLineNumber)
    .where(sql`${t.deliveryNumber} is null`),
  foreignKey({
    name: 'billing_document_line_condition_fk',
    columns: [t.client, t.conditionNumber],
    foreignColumns: [salesConditionRecord.client, salesConditionRecord.conditionNumber],
  }).onDelete('restrict'),
]);

/**
 * When an order item is billed (SAP FPLA) — for the sales that are never shipped.
 *
 * A delivery earns an invoice when its goods go out. A year of maintenance, a piece of work paid in
 * stages and a licence renewed every quarter are not delivered at all, and until this increment they
 * could not be billed: a billing document named a delivery, and a document that named none could not
 * stand.
 *
 * A plan hangs off the order item and is made of dates, each carrying a share of the item's value.
 * The shares of one plan total a hundred, because a plan that promises ninety has not said when the
 * last tenth is billed. A date is billed once, and only on or after the day it names.
 *
 * An item that carries a plan is billed by the plan and not by its deliveries — never by both. A
 * share of an item and the whole of it are two different answers to one question, and an order that
 * answered it twice would invoice the same value twice.
 */
/**
 * The criteria a collective billing run splits the due list by — SAP's split criteria for billing
 * documents (§4.5, gap G2).
 *
 * Three criteria always split and are not here, because they are not configuration: a billing document
 * posts **one** receivable, against one payer, in one currency, in one company code. What stands here
 * is the rest — the header fields a tenant may say "one invoice per …" about.
 *
 * Where a field is *not* a maintained criterion, its value on a collective document is the one the
 * first delivery in the group carried, which is what SAP does with the fields the criteria do not name.
 */
export const BILLING_SPLIT_CRITERIA = [
  'SALES_ORG', 'DISTRIBUTION_CHANNEL', 'DIVISION', 'SHIP_TO', 'PLANT',
] as const;
export type BillingSplitCriterion = (typeof BILLING_SPLIT_CRITERIA)[number];

/**
 * What each criterion separates, in words. Delivered with the package rather than entered, because a
 * criterion is a field of the document and not a thing a tenant invents: the catalogue is what the
 * grouping can be read against.
 */
export const DELIVERED_SPLIT_CRITERIA: ReadonlyArray<{
  criterion: BillingSplitCriterion; displayName: string; meaning: string;
}> = [
  {
    criterion: 'SALES_ORG', displayName: 'Sales organisation',
    meaning: 'One invoice per sales organisation. A group that spans two of them is billed as two documents, each carrying the sales area it was sold from.',
  },
  {
    criterion: 'DISTRIBUTION_CHANNEL', displayName: 'Distribution channel',
    meaning: 'One invoice per channel: what was sold direct is not on the same document as what went through a distributor.',
  },
  {
    criterion: 'DIVISION', displayName: 'Division',
    meaning: 'One invoice per division, for a company that bills its product lines apart.',
  },
  {
    criterion: 'SHIP_TO', displayName: 'Ship-to party',
    meaning: 'One invoice per receiving party. A payer with several sites gets a document each, which is what a customer that reconciles deliveries by site asks for.',
  },
  {
    criterion: 'PLANT', displayName: 'Plant',
    meaning: 'One invoice per shipping plant, where the plant is what the document is accounted by.',
  },
];

/**
 * A maintained split criterion. It is a row and not a constant because which of the five a tenant
 * splits by is a decision about how the customer is billed, and a decision belongs in the database.
 */
/**
 * One billing document on an invoice list — an item of SAP's `LR` document (§4.6, gap G2).
 *
 * An invoice list is a billing document whose items are **already-posted billing documents**: it carries
 * no material, no quantity and no price of its own, and nothing is priced again by it. What stands on a
 * row here is the member's number and the figures it contributes, written down at the moment the list is
 * created so a list read years later still states what it sent the customer for, from rows that have
 * moved since.
 *
 * A separate table rather than a row in `billing_document_line`, because a billing document line in this
 * package is a priced line of goods — a material at a quantity at a price, with a condition behind it —
 * and a member row is a reference to another document. One table holding both would be a schema that
 * describes half its rows wrongly.
 */
export const salesInvoiceListItem = pgTable('sales_invoice_list_item', {
  client: tenant(),
  /** The invoice list: the billing document of type LR this row belongs to. */
  invoiceListNumber: varchar('invoice_list_number', { length: 20 }).notNull(),
  /** Where the member stands on the list. */
  itemNumber: integer('item_number').notNull(),
  /** The billing document being listed. */
  billingNumber: varchar('billing_number', { length: 20 }).notNull(),
  /** What the member contributes, written at the moment it was listed. */
  netValue: numeric('net_value', { precision: 23, scale: 4 }).notNull(),
  taxValue: numeric('tax_value', { precision: 23, scale: 4 }).notNull(),
  grossValue: numeric('gross_value', { precision: 23, scale: 4 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.invoiceListNumber, t.itemNumber] }),
  foreignKey({
    name: 'sales_invoice_list_item_list_fk',
    columns: [t.client, t.invoiceListNumber],
    foreignColumns: [billingDocument.client, billingDocument.billingNumber],
  }).onDelete('cascade'),
  foreignKey({
    name: 'sales_invoice_list_item_member_fk',
    columns: [t.client, t.billingNumber],
    foreignColumns: [billingDocument.client, billingDocument.billingNumber],
  }).onDelete('restrict'),
  // A billing document stands on one list at a time, and never twice on the same one. A document on
  // two lists would be sent to the customer twice and released to accounting twice, which is the one
  // failure an invoice list must not have.
  uniqueIndex('sales_invoice_list_item_member_uq').on(t.client, t.billingNumber),
  uniqueIndex('sales_invoice_list_item_list_member_uq').on(t.client, t.invoiceListNumber, t.billingNumber),
  check('sales_invoice_list_item_number_ck', sql`${t.itemNumber} > 0`),
  index('sales_invoice_list_item_member_idx').on(t.client, t.billingNumber),
]);

export const salesBillingSplitCriterion = pgTable('sales_billing_split_criterion', {
  client: tenant(),
  criterion: varchar('criterion', { length: 24 }).notNull(),
  /** Where it stands in the group key, so a reader sees the order the split reads them in. */
  sequence: integer('sequence').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.criterion] }),
  check('sales_billing_split_criterion_code_ck',
    sql`${t.criterion} in ('SALES_ORG', 'DISTRIBUTION_CHANNEL', 'DIVISION', 'SHIP_TO', 'PLANT')`),
  check('sales_billing_split_criterion_sequence_ck', sql`${t.sequence} >= 0`),
]);

export const salesBillingPlanType = pgTable('sales_billing_plan_type', {
  client: tenant(),
  planType: varchar('plan_type', { length: 2 }).notNull(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  /** What the type is for, in words, so no screen and no report has to guess at PE and MS. */
  meaning: varchar('meaning', { length: 240 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.planType] }),
  check('sales_billing_plan_type_code_ck', sql`${t.planType} in ('PE', 'MS')`),
]);

/** The two kinds of plan, delivered with the package and not extended — see the note above. */
export const DELIVERED_BILLING_PLAN_TYPES = [
  {
    planType: 'PE', displayName: 'Periodic',
    meaning: 'Billing on a repeating schedule: dates proposed from a start date and a frequency in months, each carrying an equal share or a share the maintainer names.',
  },
  {
    planType: 'MS', displayName: 'Milestone',
    meaning: 'Billing when a piece of work is reached: dates entered one by one, each carrying the share that falls due when that stage is met.',
  },
] as const;

export const BILLING_PLAN_DATE_STATUSES = ['OPEN', 'BILLED', 'WITHDRAWN'] as const;

/**
 * What billing a date does (SAP FPLT-AFARE / the date's billing rule). A plan draws this line at the
 * date and not at the plan type, because one plan asks the customer for an advance on one date and
 * bills the whole of the item on another. `DOWN_PAYMENT` raises a request — money asked for early,
 * posted as a noted item, no revenue — and `INVOICE` bills the share that has been earned.
 */
export const BILLING_PLAN_DATE_RULES = ['DOWN_PAYMENT', 'INVOICE'] as const;
export type BillingPlanDateRule = (typeof BILLING_PLAN_DATE_RULES)[number];

export const salesBillingPlan = pgTable('sales_billing_plan', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  orderLineNumber: integer('order_line_number').notNull(),
  planType: varchar('plan_type', { length: 2 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.orderLineNumber] }),
  foreignKey({
    name: 'sales_billing_plan_item_fk',
    columns: [t.client, t.orderNumber, t.orderLineNumber],
    foreignColumns: [salesOrderLine.client, salesOrderLine.orderNumber, salesOrderLine.lineNumber],
  }).onDelete('cascade'),
  foreignKey({
    name: 'sales_billing_plan_type_fk',
    columns: [t.client, t.planType],
    foreignColumns: [salesBillingPlanType.client, salesBillingPlanType.planType],
  }).onDelete('restrict'),
  check('sales_billing_plan_version_ck', sql`${t.version} > 0`),
]);

export const salesBillingPlanDate = pgTable('sales_billing_plan_date', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  orderLineNumber: integer('order_line_number').notNull(),
  dateNumber: integer('date_number').notNull(),
  billingDate: date('billing_date', { mode: 'string' }).notNull(),
  /** The share of the item's value this date bills. The shares of one plan total a hundred. */
  percentage: numeric('percentage', { precision: 6, scale: 3 }).notNull(),
  /**
   * What this date does with that share: ask for it as an advance, or bill it. `INVOICE` is what every
   * date has always done and is the default, so every plan standing keeps its meaning. A date that
   * asks for an advance stands outside the hundred the invoice dates total: an advance is money asked
   * early, not a share of the billing schedule, and the final invoice still bills the whole.
   */
  billingRule: varchar('billing_rule', { length: 12 }).notNull().default('INVOICE'),
  /**
   * Where this date stands: open, billed by the document below, or withdrawn. A date is withdrawn
   * rather than deleted — it answers nothing from then on, and leaves behind what was once planned,
   * because a plan is part of what was agreed about this order.
   */
  status: varchar('status', { length: 16 }).notNull().default('OPEN'),
  /**
   * The document that billed this date. Null while the date stands open, and cleared again when that
   * document is cancelled: a cancelled invoice releases the date, as it releases the delivery it
   * stands against, so the corrected document can be raised.
   */
  billingNumber: varchar('billing_number', { length: 20 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.orderLineNumber, t.dateNumber] }),
  foreignKey({
    name: 'sales_billing_plan_date_plan_fk',
    columns: [t.client, t.orderNumber, t.orderLineNumber],
    foreignColumns: [salesBillingPlan.client, salesBillingPlan.orderNumber, salesBillingPlan.orderLineNumber],
  }).onDelete('cascade'),
  check('sales_billing_plan_date_status_ck', sql`${t.status} in ('OPEN', 'BILLED', 'WITHDRAWN')`),
  check('sales_billing_plan_date_number_ck', sql`${t.dateNumber} > 0`),
  check('sales_billing_plan_date_percentage_ck', sql`${t.percentage} > 0 and ${t.percentage} <= 100`),
  check('sales_billing_plan_date_rule_ck', sql`${t.billingRule} in ('DOWN_PAYMENT', 'INVOICE')`),
  // A billed date names the document that billed it, and every other date names none: the two columns
  // cannot disagree about whether the date was billed.
  check('sales_billing_plan_date_billed_ck', sql`(${t.status} = 'BILLED' and ${t.billingNumber} is not null)
      or (${t.status} <> 'BILLED' and ${t.billingNumber} is null)`),
]);

/**
 * An advance asked for on a sales order before anything was delivered (SAP F-37). The money itself is
 * accounting's: the request is a *noted item* — a drawn number, no journal, no balance — and the
 * receipt is posted under a special G/L indicator onto an alternative reconciliation account. What
 * stands here is the link, so a reader of the order can see what was asked, what arrived and what was
 * cleared without leaving the sale, and so final billing knows which advances of this order it may
 * consume.
 */
export const salesDownPaymentRequest = pgTable('sales_down_payment_request', {
  client: tenant(),
  /** The billing document that asked for it: a document of type DP, raised against a plan date. */
  billingNumber: varchar('billing_number', { length: 20 }).notNull(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  orderLineNumber: integer('order_line_number').notNull(),
  dateNumber: integer('date_number').notNull(),
  /** The accounting noted item behind it. Statistical: no journal, no balance. */
  requestNumber: varchar('request_number', { length: 20 }).notNull(),
  customerNumber: varchar('customer_number', { length: 40 }).notNull(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  /**
   * What was asked, as money: the date's share of the item's *gross* value, because what the customer
   * pays is net plus tax.
   */
  amount: numeric('amount', { precision: 23, scale: 4 }).notNull(),
  /**
   * `OPEN` while it stands, `CLEARED` once an invoice of the order has consumed it, `CANCELLED` where
   * it was withdrawn before any money arrived.
   */
  status: varchar('status', { length: 12 }).notNull().default('OPEN'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.billingNumber] }),
  foreignKey({
    name: 'sales_down_payment_request_document_fk',
    columns: [t.client, t.billingNumber],
    foreignColumns: [billingDocument.client, billingDocument.billingNumber],
  }).onDelete('cascade'),
  check('sales_down_payment_request_amount_ck', sql`${t.amount} > 0`),
  check('sales_down_payment_request_status_ck', sql`${t.status} in ('OPEN', 'CLEARED', 'CANCELLED')`),
  index('sales_down_payment_request_order_idx').on(t.client, t.orderNumber),
]);

export const DOWN_PAYMENT_REQUEST_STATUSES = ['OPEN', 'CLEARED', 'CANCELLED'] as const;
export type DownPaymentRequestStatus = (typeof DOWN_PAYMENT_REQUEST_STATUSES)[number];

/**
 * Where a rebate agreement stands (SAP's rebate agreement status). An agreement is maintained open and
 * **released**: a provision nobody authorised is worse than no provision, and the release is the act
 * that says somebody with authority over the company's money agreed to it. It settles when the final
 * settlement has been paid out, and it is closed where it is abandoned without ever having accrued.
 */
export const REBATE_AGREEMENT_STATUSES = ['OPEN', 'RELEASED', 'SETTLED', 'CLOSED'] as const;
export type RebateAgreementStatus = (typeof REBATE_AGREEMENT_STATUSES)[number];

/**
 * A rebate agreement: a promise to give a payer part of what they spend back (SAP VBO1).
 *
 * It names who it is with, the sales area it covers, the period it runs for and the rebate condition
 * type its rates are maintained under. It carries no total: what has accrued, what was reversed and
 * what was settled are read from the accrual rows, as a receivable is read from its open items.
 */
export const salesRebateAgreement = pgTable('sales_rebate_agreement', {
  client: tenant(),
  agreementNumber: varchar('agreement_number', { length: 20 }).notNull(),
  /** The payer the promise was made to: it is the payer who is paid the rebate, not the ship-to. */
  customerNumber: varchar('customer_number', { length: 40 }).notNull(),
  salesOrg: varchar('sales_org', { length: 4 }).notNull(),
  distributionChannel: varchar('distribution_channel', { length: 2 }).notNull(),
  division: varchar('division', { length: 2 }).notNull(),
  currency: char('currency', { length: 3 }).notNull().references(() => currency.code),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  /**
   * The rebate condition type the agreement's rates are maintained under. A tenant may maintain
   * several — one for a volume rebate, one for a listing fee — and the agreement says which.
   */
  conditionType: varchar('condition_type', { length: 4 }).notNull().default('BO01'),
  status: varchar('status', { length: 12 }).notNull().default('OPEN'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.agreementNumber] }),
  foreignKey({
    name: 'sales_rebate_agreement_condition_type_fk',
    columns: [t.client, t.conditionType],
    foreignColumns: [salesConditionType.client, salesConditionType.conditionType],
  }).onDelete('restrict'),
  check('sales_rebate_agreement_status_ck', sql`${t.status} in ('OPEN', 'RELEASED', 'SETTLED', 'CLOSED')`),
  check('sales_rebate_agreement_validity_ck', sql`${t.validTo} >= ${t.validFrom}`),
  index('sales_rebate_agreement_customer_idx').on(t.client, t.customerNumber, t.salesOrg),
]);

/**
 * Where one accrual stands. It is accrued when the billing document that earned it is posted, reversed
 * when that document is cancelled — a provision built on a sale that was undone is an overstatement
 * that never corrects itself — and settled when the credit memo that paid it out was posted.
 */
export const REBATE_ACCRUAL_STATUSES = ['ACCRUED', 'REVERSED', 'SETTLED'] as const;
export type RebateAccrualStatus = (typeof REBATE_ACCRUAL_STATUSES)[number];

/**
 * One rebate accrued by one line of one billing document against one agreement (SAP's rebate accrual,
 * the figure VB03 shows beside the business volume).
 *
 * Several agreements can accrue on the same sale, which is why the agreement is part of the key. The
 * rebate is computed on the line's net value — SAP's rebate basis — and it is a provision: the
 * customer still pays the whole invoice, and the rebate is given back on a document of its own.
 */
export const salesRebateAccrual = pgTable('sales_rebate_accrual', {
  client: tenant(),
  agreementNumber: varchar('agreement_number', { length: 20 }).notNull(),
  /** The billing document that earned it. */
  billingNumber: varchar('billing_number', { length: 20 }).notNull(),
  /** The line of that document it was earned by. */
  lineNumber: integer('line_number').notNull(),
  orderNumber: varchar('order_number', { length: 20 }).notNull(),
  orderLineNumber: integer('order_line_number').notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  /** What the rebate was computed on: the line's net value. */
  basisAmount: numeric('basis_amount', { precision: 23, scale: 4 }).notNull(),
  /** What was provided for. */
  rebateAmount: numeric('rebate_amount', { precision: 23, scale: 4 }).notNull(),
  /** The record that priced it, so a reader can name the rate without reading the agreement. */
  conditionNumber: varchar('condition_number', { length: 18 }).notNull(),
  /** The journal that carried the provision to the ledger. */
  journalDocumentNumber: varchar('journal_document_number', { length: 20 }),
  /** The journal that took it back when the billing document was cancelled. */
  reversalJournalDocumentNumber: varchar('reversal_journal_document_number', { length: 20 }),
  /**
   * How much of the provision has been paid out, and by which credit memo. A settlement may pay part
   * of what stands and leave the rest accruing, so the two figures are kept apart: what was provided
   * for is the provision, what was paid out of it is the history, and the difference is what is still
   * owed to the customer.
   */
  settledAmount: numeric('settled_amount', { precision: 23, scale: 4 }).notNull().default('0'),
  /** The credit memo that last paid part of it out. */
  settlementNumber: varchar('settlement_number', { length: 20 }),
  status: varchar('status', { length: 12 }).notNull().default('ACCRUED'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.agreementNumber, t.billingNumber, t.lineNumber] }),
  foreignKey({
    name: 'sales_rebate_accrual_agreement_fk',
    columns: [t.client, t.agreementNumber],
    foreignColumns: [salesRebateAgreement.client, salesRebateAgreement.agreementNumber],
  }).onDelete('cascade'),
  foreignKey({
    name: 'sales_rebate_accrual_condition_fk',
    columns: [t.client, t.conditionNumber],
    foreignColumns: [salesConditionRecord.client, salesConditionRecord.conditionNumber],
  }).onDelete('restrict'),
  check('sales_rebate_accrual_status_ck', sql`${t.status} in ('ACCRUED', 'REVERSED', 'SETTLED')`),
  check('sales_rebate_accrual_amount_ck', sql`${t.rebateAmount} >= 0`),
  // What was paid out of a provision can never be more than the provision, and can never be less than
  // nothing: a settlement that gave the customer more than the company provided for is not a partial
  // settlement of a rebate, it is money given away against nothing.
  check('sales_rebate_accrual_settled_ck',
    sql`${t.settledAmount} >= 0 and ${t.settledAmount} <= ${t.rebateAmount}`),
  index('sales_rebate_accrual_billing_idx').on(t.client, t.billingNumber),
  index('sales_rebate_accrual_agreement_idx').on(t.client, t.agreementNumber, t.status),
]);

/**
 * The four partner functions a sale is made with — SAP's PARVW, delivered with the package and not
 * extended by a tenant. What a function means is what the code does with it: the ship-to is the
 * partner the delivery is raised for and whose address it carries, and the payer is the partner the
 * receivable is posted against. A fifth function would be a row that answered nothing, so the
 * catalogue is a delivered list and the column that carries it is checked against that list.
 */
export const PARTNER_FUNCTIONS = ['SP', 'SH', 'BP', 'PY'] as const;
export type PartnerFunction = (typeof PARTNER_FUNCTIONS)[number];
/** The categories a document's partners are written for. */
export const PARTNER_DOCUMENT_CATEGORIES = ['ORDER', 'DELIVERY', 'BILLING'] as const;

export const DELIVERED_PARTNER_FUNCTIONS = [
  {
    functionCode: 'SP', displayName: 'Sold-to party',
    meaning: 'The customer the order is made with. It is the customer whose master the sale is written against, and it is never assigned to itself.',
  },
  {
    functionCode: 'SH', displayName: 'Ship-to party',
    meaning: 'Where the goods go. The delivery is raised for it and takes its address from it, and it defaults to the sold-to.',
  },
  {
    functionCode: 'BP', displayName: 'Bill-to party',
    meaning: 'Who the invoice is addressed to. It defaults to the sold-to, and the payer defaults to it.',
  },
  {
    functionCode: 'PY', displayName: 'Payer',
    meaning: 'Who owes the money. The receivable is posted against it and it is the account that is settled, so it is the customer the ageing and the open items are read for; it defaults to the bill-to.',
  },
] as const;

export const salesPartnerFunction = pgTable('sales_partner_function', {
  client: tenant(),
  functionCode: varchar('function_code', { length: 4 }).notNull(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  /** What the function is for, in words, so no screen and no report has to guess at SP and PY. */
  meaning: varchar('meaning', { length: 240 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.functionCode] }),
  check('sales_partner_function_code_ck', sql`${t.functionCode} in ('SP', 'SH', 'BP', 'PY')`),
]);

/**
 * Who plays each function for a customer — KNVP.
 *
 * Maintained for one sales area or for all of them, and read most specific first: the row naming the
 * sales organisation, the distribution channel and the division stands over the row naming none of
 * them, and blank is a value that is matched rather than an absence. A function nobody maintains
 * falls back to the one above it — the payer to the bill-to, and the ship-to and the bill-to to the
 * sold-to, which is the customer whose master this row hangs off.
 */
export const customerSalesPartner = pgTable('customer_sales_partner', {
  client: tenant(),
  partnerNumber: varchar('partner_number', { length: 40 }).notNull(),
  salesOrg: varchar('sales_org', { length: 4 }).notNull().default(''),
  distributionChannel: varchar('distribution_channel', { length: 4 }).notNull().default(''),
  division: varchar('division', { length: 4 }).notNull().default(''),
  functionCode: varchar('function_code', { length: 4 }).notNull(),
  assignedPartnerNumber: varchar('assigned_partner_number', { length: 40 }).notNull(),
  partnerRoleCode: varchar('partner_role_code', { length: 16 }).notNull().default('CUSTOMER'),
  assignedRoleCode: varchar('assigned_role_code', { length: 16 }).notNull().default('CUSTOMER'),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({
    columns: [t.client, t.partnerNumber, t.salesOrg, t.distributionChannel, t.division, t.functionCode],
  }),
  foreignKey({
    name: 'customer_sales_partner_function_fk',
    columns: [t.client, t.functionCode],
    foreignColumns: [salesPartnerFunction.client, salesPartnerFunction.functionCode],
  }).onDelete('restrict'),
  // Both sides are customers. A ship-to that is not a customer cannot receive a delivery, and a payer
  // that is not a customer has no reconciliation account for the receivable to be posted to.
  foreignKey({
    name: 'customer_sales_partner_customer_fk',
    columns: [t.client, t.partnerNumber, t.partnerRoleCode],
    foreignColumns: [bpRole.client, bpRole.partnerNumber, bpRole.roleCode],
  }).onDelete('cascade'),
  foreignKey({
    name: 'customer_sales_partner_assigned_fk',
    columns: [t.client, t.assignedPartnerNumber, t.assignedRoleCode],
    foreignColumns: [bpRole.client, bpRole.partnerNumber, bpRole.roleCode],
  }).onDelete('restrict'),
  check('customer_sales_partner_role_ck', sql`${t.partnerRoleCode} = 'CUSTOMER' and ${t.assignedRoleCode} = 'CUSTOMER'`),
  // The sold-to is not assigned: it is the customer the row hangs off, and a second answer to a
  // question the row already answers is a contradiction waiting to be read the wrong way.
  check('customer_sales_partner_function_ck', sql`${t.functionCode} <> 'SP'`),
  check('customer_sales_partner_area_ck', sql`(${t.salesOrg} = '' or ${t.salesOrg} ~ '^[A-Z0-9]{1,4}$')
    and (${t.distributionChannel} = '' or ${t.distributionChannel} ~ '^[A-Z0-9]{1,4}$')
    and (${t.division} = '' or ${t.division} ~ '^[A-Z0-9]{1,4}$')`),
  check('customer_sales_partner_version_ck', sql`${t.version} > 0`),
]);

/**
 * The partners a document was made with — VBPA.
 *
 * Written when the document is created and never re-derived: an order carries all four, the delivery
 * carries the ship-to it ships to, and the billing document carries the bill-to it is addressed to
 * and the payer whose receivable it raises. A document read in a year still names the customers it
 * was made with, which a header holding one number cannot say.
 */
export const salesDocumentPartner = pgTable('sales_document_partner', {
  client: tenant(),
  documentCategory: varchar('document_category', { length: 16 }).notNull(),
  documentNumber: varchar('document_number', { length: 20 }).notNull(),
  functionCode: varchar('function_code', { length: 4 }).notNull(),
  partnerNumber: varchar('partner_number', { length: 40 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.documentCategory, t.documentNumber, t.functionCode] }),
  foreignKey({
    name: 'sales_document_partner_function_fk',
    columns: [t.client, t.functionCode],
    foreignColumns: [salesPartnerFunction.client, salesPartnerFunction.functionCode],
  }).onDelete('restrict'),
  foreignKey({
    name: 'sales_document_partner_partner_fk',
    columns: [t.client, t.partnerNumber],
    foreignColumns: [businessPartner.client, businessPartner.partnerNumber],
  }).onDelete('restrict'),
  check('sales_document_partner_category_ck', sql`${t.documentCategory} in ('ORDER', 'DELIVERY', 'BILLING')`),
]);

/**
 * The incompletion procedure and the log of incomplete items — §5.1, SAP's OVA2, OVA0, VUA2, VUA4
 * and the table they write, VBUV.
 *
 * A document is refused today when it is wrong and saved when it is not, and there is no third
 * state. The log is the third state: the document stands, it is simply not complete, and what it
 * is missing is recorded against it field by field. That is what lets a clerk save an order with
 * the customer's purchase-order number still to come, and what stops the warehouse raising a
 * delivery for an order with no requested date.
 *
 * Two things are deliberate about the shape.
 *
 * There is **no status column beside the document**. SAP carries `VBUK-UVALL` and `VBUP` because
 * `VBUV` was expensive to ask; here the log *is* the state, and an indexed existence query answers
 * "is this order blocked for delivery" inside the transaction that would have read the column. A
 * second copy of the answer is a second thing to keep true.
 *
 * And there is **no item category**, so no `VUP2`, `VUE2` or `VUPA`. A procedure is assigned to a
 * document type, and its own group says which level it checks.
 */
export const INCOMPLETION_GROUPS = ['A', 'B', 'C', 'D', 'G', 'H'] as const;
export type IncompletionGroup = (typeof INCOMPLETION_GROUPS)[number];
/** The documents a procedure may be assigned to, and the documents the log is written for. */
export const INCOMPLETION_DOCUMENT_CATEGORIES = ['ORDER', 'DELIVERY'] as const;
export type IncompletionDocumentCategory = (typeof INCOMPLETION_DOCUMENT_CATEGORIES)[number];

/**
 * The six places a document can be incomplete, delivered with the package and not extended by a
 * tenant — the same reason the partner functions are a delivered list: what a group means is what
 * the evaluator does with it, and a seventh group would be a row that answered nothing.
 */
export const DELIVERED_INCOMPLETION_GROUPS: ReadonlyArray<{
  groupCode: IncompletionGroup; name: string; meaning: string;
}> = [
  {
    groupCode: 'A', name: 'Sales header',
    meaning: "What the order itself must carry: the customer's purchase order reference, the date the goods were asked for.",
  },
  {
    groupCode: 'B', name: 'Sales item',
    meaning: 'What each line must carry: when it is wanted, how it is taxed, and where the profit belongs.',
  },
  {
    groupCode: 'C', name: 'Sales schedule line',
    meaning: 'What each schedule line must carry: the date and the quantity of the instalment.',
  },
  {
    groupCode: 'D', name: 'Partner',
    meaning: 'Which partner functions the document must name. The field is the function code.',
  },
  {
    groupCode: 'G', name: 'Delivery header',
    meaning: 'What the delivery itself must carry: where it loads from, when it goes, and where it is going.',
  },
  {
    groupCode: 'H', name: 'Delivery item',
    meaning: 'What each delivery line must carry: the plant, the unit, and the storage location the goods were picked from.',
  },
];

export const incompletionGroup = pgTable('incompletion_group', {
  client: tenant(),
  groupCode: varchar('group_code', { length: 1 }).notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  meaning: varchar('meaning', { length: 240 }).notNull().default(''),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.groupCode] }),
  check('incompletion_group_code_ck', sql`${t.groupCode} in ('A', 'B', 'C', 'D', 'G', 'H')`),
]);

/**
 * What a missing field stops — SAP's OVA0, and TVUVS.
 *
 * A status group is the whole of the consequence. It is not that a field is important; it is that
 * a named function will not run for a document missing it. A group that blocks nothing is how a
 * tenant says *record this, stop nothing*, which is what a plain warning used to be.
 */
export const incompletionStatusGroup = pgTable('incompletion_status_group', {
  client: tenant(),
  statusGroup: varchar('status_group', { length: 2 }).notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  blocksDelivery: boolean('blocks_delivery').notNull().default(false),
  blocksGoodsIssue: boolean('blocks_goods_issue').notNull().default(false),
  blocksBilling: boolean('blocks_billing').notNull().default(false),
  blocksOutput: boolean('blocks_output').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.statusGroup] }),
  check('incompletion_status_group_code_ck', sql`${t.statusGroup} ~ '^[A-Z0-9]{1,2}$'`),
]);

/**
 * A named list of the fields a document of one group must carry — SAP's TVUV.
 *
 * It belongs to exactly one group, because a header check and an item check are not the same
 * question and are not answered from the same row. It means nothing until it is assigned.
 */
export const incompletionProcedure = pgTable('incompletion_procedure', {
  client: tenant(),
  procedureCode: varchar('procedure_code', { length: 4 }).notNull(),
  groupCode: varchar('group_code', { length: 1 }).notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.procedureCode] }),
  check('incompletion_procedure_code_ck', sql`${t.procedureCode} ~ '^[A-Z0-9]{1,4}$'`),
  foreignKey({
    name: 'incompletion_procedure_group_fk',
    columns: [t.client, t.groupCode],
    foreignColumns: [incompletionGroup.client, incompletionGroup.groupCode],
  }).onDelete('restrict'),
]);

/**
 * One field a document must carry — SAP's TVUVF.
 *
 * The table and the field name are what SAP stores, and they are validated here against the set
 * the evaluator knows how to look at: a field nothing evaluates would leave a document silently
 * never complete. The sequence is the order the fields are reported in, which is the order a clerk
 * fills them in.
 */
export const incompletionProcedureField = pgTable('incompletion_procedure_field', {
  client: tenant(),
  procedureCode: varchar('procedure_code', { length: 4 }).notNull(),
  tableName: varchar('table_name', { length: 30 }).notNull(),
  fieldName: varchar('field_name', { length: 30 }).notNull(),
  sequence: integer('sequence').notNull(),
  statusGroup: varchar('status_group', { length: 2 }).notNull(),
  isWarning: boolean('is_warning').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.procedureCode, t.tableName, t.fieldName] }),
  foreignKey({
    name: 'incompletion_procedure_field_procedure_fk',
    columns: [t.client, t.procedureCode],
    foreignColumns: [incompletionProcedure.client, incompletionProcedure.procedureCode],
  }).onDelete('cascade'),
  foreignKey({
    name: 'incompletion_procedure_field_status_fk',
    columns: [t.client, t.statusGroup],
    foreignColumns: [incompletionStatusGroup.client, incompletionStatusGroup.statusGroup],
  }).onDelete('restrict'),
  check('incompletion_procedure_field_sequence_ck', sql`${t.sequence} > 0`),
  index('incompletion_procedure_field_procedure_idx').on(t.client, t.procedureCode, t.sequence),
]);

/**
 * Which procedure answers for a document type — SAP's VUA2 and VUA4, in one table.
 *
 * A type with no row here is not checked at all, which is what keeps this inert: every document
 * written before a tenant configures anything is written exactly as it is today.
 */
export const incompletionAssignment = pgTable('incompletion_assignment', {
  client: tenant(),
  documentCategory: varchar('document_category', { length: 16 }).notNull(),
  documentType: varchar('document_type', { length: 4 }).notNull(),
  procedureCode: varchar('procedure_code', { length: 4 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.documentCategory, t.documentType, t.procedureCode] }),
  check('incompletion_assignment_category_ck',
    sql`${t.documentCategory} in ('ORDER', 'DELIVERY')`),
  foreignKey({
    name: 'incompletion_assignment_procedure_fk',
    columns: [t.client, t.procedureCode],
    foreignColumns: [incompletionProcedure.client, incompletionProcedure.procedureCode],
  }).onDelete('restrict'),
  foreignKey({
    name: 'incompletion_assignment_type_fk',
    columns: [t.client, t.documentType],
    foreignColumns: [salesDocumentType.client, salesDocumentType.documentType],
  }).onDelete('restrict'),
  index('incompletion_assignment_type_idx').on(t.client, t.documentCategory, t.documentType),
]);

/**
 * One field a document is missing — SAP's VBUV.
 *
 * Rewritten whole every time the document is evaluated: the rows that stand now, not the rows that
 * stood last time. It carries no foreign key to the procedure or the status group, because what it
 * records is what stood when the document was written, and a configuration row deleted next year
 * cannot take a document's history with it.
 *
 * The key is the whole address of a missing thing — which document, which line, which schedule
 * line, which partner function, and which field. The line number, the schedule number and the
 * partner function are zero and blank for a header entry, as they are in SAP.
 */
export const salesIncompletionLog = pgTable('sales_incompletion_log', {
  client: tenant(),
  documentCategory: varchar('document_category', { length: 16 }).notNull(),
  documentNumber: varchar('document_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull().default(0),
  scheduleNumber: integer('schedule_number').notNull().default(0),
  partnerFunction: varchar('partner_function', { length: 4 }).notNull().default(''),
  tableName: varchar('table_name', { length: 30 }).notNull(),
  fieldName: varchar('field_name', { length: 30 }).notNull(),
  procedureCode: varchar('procedure_code', { length: 4 }).notNull(),
  statusGroup: varchar('status_group', { length: 2 }).notNull(),
  isWarning: boolean('is_warning').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({
    columns: [
      t.client, t.documentCategory, t.documentNumber, t.lineNumber, t.scheduleNumber,
      t.partnerFunction, t.tableName, t.fieldName,
    ],
  }),
  check('sales_incompletion_log_category_ck',
    sql`${t.documentCategory} in ('ORDER', 'DELIVERY')`),
  check('sales_incompletion_log_line_ck', sql`${t.lineNumber} >= 0`),
  check('sales_incompletion_log_schedule_ck', sql`${t.scheduleNumber} >= 0`),
  // The question every follow-on function asks: is this document blocked, and for what.
  index('sales_incompletion_log_document_idx').on(t.client, t.documentCategory, t.documentNumber),
  index('sales_incompletion_log_blocking_idx')
    .on(t.client, t.documentCategory, t.documentNumber, t.isWarning, t.statusGroup),
]);

/**
 * Which batch a delivery item is picked from, and in what order (§5.5a).
 *
 * The empty position is the general rule, which is why those columns default to '' rather than to
 * null — null in a unique key would let two "any customer" rows stand side by side. Nothing is
 * seeded, so a tenant that maintains no rule picks exactly as it did before this table existed.
 */
export const salesBatchDeterminationRule = pgTable('sales_batch_determination_rule', {
  client: tenant(),
  ruleNumber: varchar('rule_number', { length: 10 }).notNull(),
  salesOrg: varchar('sales_org', { length: 4 }).notNull().default(''),
  distributionChannel: varchar('distribution_channel', { length: 2 }).notNull().default(''),
  customerNumber: varchar('customer_number', { length: 40 }).notNull().default(''),
  materialNumber: varchar('material_number', { length: 40 }).notNull().default(''),
  plant: varchar('plant', { length: 10 }).notNull().default(''),
  sortRule: varchar('sort_rule', { length: 12 }).notNull().default('FIFO'),
  isActive: boolean('is_active').notNull().default(true),
  validityFrom: date('validity_from', { mode: 'string' }).notNull(),
  validityTo: date('validity_to', { mode: 'string' }).notNull(),
  name: varchar('name', { length: 40 }).notNull().default(''),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.ruleNumber] }),
  check('sales_batch_determination_sort_ck',
    sql`${t.sortRule} in ('FIFO', 'LIFO', 'EXPIRY', 'BATCH_NUMBER')`),
  check('sales_batch_determination_validity_ck', sql`${t.validityTo} >= ${t.validityFrom}`),
  index('sales_batch_determination_lookup_ix')
    .on(t.client, t.materialNumber, t.customerNumber, t.plant),
]);
