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
import { pgTable, timestamp, varchar, char, integer, numeric, boolean, date, primaryKey, foreignKey, uniqueIndex, check } from 'drizzle-orm/pg-core';
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
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.documentType] }),
  foreignKey({
    columns: [t.client, t.cancellationDocumentType],
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
  check('sales_condition_type_class_ck',
    sql`${t.conditionClass} in ('PRICE', 'DISCOUNT', 'FREIGHT', 'TAX', 'COST')`),
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
  /** The document this one stands against: a credit memo names the invoice it credits. */
  creditOf: varchar('credit_of', { length: 20 }),
  /**
   * Set only on a cancellation document: the billing document this one cancels. A cancellation names its
   * document once and never twice, which is why this is its own column and not `credit_of` — a customer may
   * legitimately hold two credit memos against one invoice.
   */
  cancellationOf: varchar('cancellation_of', { length: 20 }),
  version: integer('version').notNull().default(1),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.billingNumber] }),
  check('billing_document_status_ck', sql`${t.status} in ('OPEN', 'POSTED', 'CANCELLED')`),
  check('billing_document_posted_needs_invoice_ck', sql`${t.status} <> 'POSTED' or (${t.customerInvoiceNumber} is not null and ${t.journalDocumentNumber} is not null)`),
  // One *live* billing document per delivery. A cancelled document no longer occupies the slot — that is what
  // makes a cancelled invoice re-billable — and neither does a document that stands against another one,
  // because the document it stands against already did. Two live documents for one delivery stay impossible.
  uniqueIndex('billing_document_delivery_live_uq').on(t.client, t.deliveryNumber)
    .where(sql`${t.status} <> 'CANCELLED' and ${t.creditOf} is null and ${t.cancellationOf} is null`),
  // A document is cancelled once.
  uniqueIndex('billing_document_cancellation_uq').on(t.client, t.cancellationOf)
    .where(sql`${t.cancellationOf} is not null`),
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
   * One line per delivery line *within a document*. The header's own index is what keeps a delivered line
   * from being billed twice: only one live billing document may stand for a delivery, so only that
   * document's lines bill its lines. Scoped to the document rather than to the delivery, because a cancelled
   * document's lines stay where they are while the corrected document writes its own.
   */
  uniqueIndex('billing_document_line_delivery_line_uq').on(t.client, t.billingNumber, t.deliveryLineNumber),
  foreignKey({
    name: 'billing_document_line_condition_fk',
    columns: [t.client, t.conditionNumber],
    foreignColumns: [salesConditionRecord.client, salesConditionRecord.conditionNumber],
  }).onDelete('restrict'),
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
