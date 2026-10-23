/** Material master — CAIRN.md §8.4/§9.1, SCR-048. Own domain keys and views. */
import { pgTable, varchar, text, boolean, integer, numeric, char, date, timestamp, primaryKey, foreignKey, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { unitOfMeasure } from '../../platform/tables/reference';
import { plant, purchasingGroup } from '../foundation/schema';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });
const quantity = (name: string) => numeric(name, { precision: 23, scale: 3 });
const money = (name: string) => numeric(name, { precision: 23, scale: 4 });

export const accountCategoryReference = pgTable('account_category_reference', {
  client: tenant(), reference: varchar('reference', { length: 4 }).notNull(),
  name: varchar('name', { length: 60 }).notNull(),
  /** Inactive references cannot be newly assigned. Existing types keep the key. */
  isActive: boolean('is_active').notNull().default(true),
  /** Optimistic token. A save must send the version it opened. */
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.reference] })]);

/**
 * Industry sectors (SCR-052 / MM01; R-100).
 *
 * The one-character sector key a material is created under, maintained
 * as a tenant master in the standing shape. The standard sectors are
 * delivered per tenant; materials judge against the active rows.
 */
export const industrySector = pgTable('industry_sector', {
  client: tenant(), sector: varchar('sector', { length: 1 }).notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  isActive: boolean('is_active').notNull().default(true), ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.sector] })]);

export const materialType = pgTable('material_type', {
  client: tenant(), materialType: varchar('material_type', { length: 4 }).notNull(),
  name: varchar('name', { length: 25 }).notNull(),
  defaultProcurementType: varchar('default_procurement_type', { length: 8 }).notNull(),
  /** Reference letter stored, word shown: `S` standard price, `V` moving average price. */
  defaultPriceControl: varchar('default_price_control', { length: 1 }).notNull(),
  /** 2-char keys into the number-range engine (object MATERIAL); judged by the type service, not an FK. */
  internalNumberRange: varchar('internal_number_range', { length: 2 }),
  externalNumberRange: varchar('external_number_range', { length: 2 }),
  accountCategoryReference: varchar('account_category_reference', { length: 4 }).notNull(),
  /** Domain `0` not allowed, `1` allowed with warning, `2` allowed — stored as digit, shown as words. */
  externalPurchaseOrders: char('external_purchase_orders', { length: 1 }).notNull().default('2'),
  internalPurchaseOrders: char('internal_purchase_orders', { length: 1 }).notNull().default('1'),
  isConfigurable: boolean('is_configurable').notNull().default(false),
  /** T134-IZUST. True is X, a new batch is restricted. False is blank. OMAB sets it. An existing batch is not rewritten. */
  initialBatchRestricted: boolean('initial_batch_restricted').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true), ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialType] }),
  foreignKey({
    columns: [t.client, t.accountCategoryReference],
    foreignColumns: [accountCategoryReference.client, accountCategoryReference.reference],
  }),
]);

/** Quantity/value updating per valuation area (the plant) — the T134M shape (R-96). */
export const materialTypeValuation = pgTable('material_type_valuation', {
  client: tenant(), materialType: varchar('material_type', { length: 4 }).notNull(),
  valuationArea: varchar('valuation_area', { length: 10 }).notNull(),
  quantityUpdating: boolean('quantity_updating').notNull().default(true),
  valueUpdating: boolean('value_updating').notNull().default(true), ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialType, t.valuationArea] }),
  foreignKey({ columns: [t.client, t.materialType], foreignColumns: [materialType.client, materialType.materialType] }),
  foreignKey({ columns: [t.client, t.valuationArea], foreignColumns: [plant.client, plant.plant] }).onDelete('cascade'),
]);

export const materialGroup = pgTable('material_group', {
  client: tenant(), materialGroup: varchar('material_group', { length: 9 }).notNull(),
  name: varchar('name', { length: 20 }).notNull(),
  /** Optional long description (at most 60); the short name above is the maintained description. */
  longDescription: varchar('long_description', { length: 60 }),
  isActive: boolean('is_active').notNull().default(true), ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.materialGroup] })]);

/**
 * Material period control (SCR-054 / OMSY; R-102).
 *
 * One record per company code: the current and previous material
 * posting periods, the previous-year reference written at a
 * year-boundary shift, and the two backposting indicators kept
 * separate. Initialized once, advanced only by the shift act, never
 * deleted.
 */
export const materialPeriodControl = pgTable('material_period_control', {
  client: tenant(),
  companyCode: varchar('company_code', { length: 10 }).notNull(),
  currentFiscalYear: integer('current_fiscal_year').notNull(),
  currentPeriod: integer('current_period').notNull(),
  previousFiscalYear: integer('previous_fiscal_year').notNull(),
  previousPeriod: integer('previous_period').notNull(),
  previousYearRefYear: integer('previous_year_ref_year'),
  previousYearRefPeriod: integer('previous_year_ref_period'),
  allowBackposting: boolean('allow_backposting').notNull().default(false),
  disallowBackpostingAfterChange: boolean('disallow_backposting_after_change').notNull().default(false),
  ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.companyCode] })]);

/**
 * Material number range groups (SCR-051 / MMNR; R-99).
 *
 * A group is a named pair of MATERIALNR intervals — one internal and one
 * external range key, the pair itself the identity (TNRGT parity). The
 * description is the group's text (at most 20, one tenant language);
 * material types are assigned by carrying the same pair of keys, so
 * membership is derived and never stored twice.
 */
export const materialNumberRangeGroup = pgTable('material_number_range_group', {
  client: tenant(),
  internalRangeKey: varchar('internal_range_key', { length: 2 }).notNull(),
  externalRangeKey: varchar('external_range_key', { length: 2 }).notNull(),
  description: varchar('description', { length: 20 }).notNull(),
  ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.internalRangeKey, t.externalRangeKey] })]);

export const valuationClass = pgTable('valuation_class', {
  client: tenant(), valuationClass: varchar('valuation_class', { length: 20 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  /**
   * Optional narrowing beside the reference assignment. Empty means every
   * material type on an assigned reference may use the class. A delivered
   * class names its types, so a shared reference does not loosen them.
   */
  allowedMaterialTypes: text('allowed_material_types').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  /** Optimistic token. A save must send the version it opened. */
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.valuationClass] })]);

/**
 * Valuation class to account category reference (OMSK).
 *
 * Separate from the class master so one class may be permitted by more
 * than one reference. A material type names one reference; the class is
 * not copied onto the type, and a material's stored class is not rewritten
 * when this assignment changes.
 */
export const valuationClassReference = pgTable('valuation_class_reference', {
  client: tenant(),
  reference: varchar('reference', { length: 4 }).notNull(),
  valuationClass: varchar('valuation_class', { length: 20 }).notNull(),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.reference, t.valuationClass] }),
  foreignKey({
    columns: [t.client, t.reference],
    foreignColumns: [accountCategoryReference.client, accountCategoryReference.reference],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.valuationClass],
    foreignColumns: [valuationClass.client, valuationClass.valuationClass],
  }).onDelete('restrict'),
  index('valuation_class_reference_class_idx').on(t.client, t.valuationClass),
]);

export const mrpController = pgTable('mrp_controller', {
  client: tenant(), controller: varchar('controller', { length: 3 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(), isActive: boolean('is_active').notNull().default(true), ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.controller] })]);

export const material = pgTable('material', {
  client: tenant(), materialNumber: varchar('material_number', { length: 40 }).notNull(),
  description: varchar('description', { length: 40 }).notNull().default(''),
  materialType: varchar('material_type', { length: 12 }).notNull(),
  materialGroup: varchar('material_group', { length: 20 }),
  baseUnit: varchar('base_unit', { length: 6 }).references(() => unitOfMeasure.code),
  industrySector: varchar('industry_sector', { length: 1 }),
  barcode: varchar('barcode', { length: 32 }),
  grossWeight: quantity('gross_weight').notNull().default('0'),
  netWeight: quantity('net_weight').notNull().default('0'),
  weightUnit: varchar('weight_unit', { length: 6 }).references(() => unitOfMeasure.code),
  basicStatus: varchar('basic_status', { length: 16 }).notNull().default('INCOMPLETE'),
  isBlocked: boolean('is_blocked').notNull().default(false),
  /** Deletion flag at client level (SCR-053 / MM06): a marker, never a lock. */
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  /** MARA-XCHPF. Used when the batch level is material or client. Existing materials stay non-batch. */
  batchManaged: boolean('batch_managed').notNull().default(false),
  version: integer('version').notNull().default(1),
  lowLevelCode: integer('low_level_code').notNull().default(0), ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber] }), index('material_description_idx').on(t.client, t.description),
  foreignKey({ columns: [t.client, t.materialType], foreignColumns: [materialType.client, materialType.materialType] }),
  foreignKey({ columns: [t.client, t.materialGroup], foreignColumns: [materialGroup.client, materialGroup.materialGroup] }),
  check('material_basic_status_ck', sql`${t.basicStatus} in ('INCOMPLETE','CREATED','MAINTAINED')`),
  check('material_weight_ck', sql`${t.grossWeight} >= 0 and ${t.netWeight} >= 0 and ${t.grossWeight} >= ${t.netWeight}`),
]);

export const materialPlant = pgTable('material_plant', {
  client: tenant(), materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  purchasingGroup: varchar('purchasing_group', { length: 3 }),
  orderUnit: varchar('order_unit', { length: 6 }).references(() => unitOfMeasure.code),
  overdeliveryTolerance: numeric('overdelivery_tolerance', { precision: 5, scale: 2 }).notNull().default('0'),
  underdeliveryTolerance: numeric('underdelivery_tolerance', { precision: 5, scale: 2 }).notNull().default('0'),
  manufacturerPartNumber: varchar('manufacturer_part_number', { length: 80 }),
  purchasingStatus: varchar('purchasing_status', { length: 16 }).notNull().default('NOT_CREATED'),
  /** Deletion flag at plant level (SCR-053 / MM06): a marker, never a lock. */
  markedForDeletion: boolean('marked_for_deletion').notNull().default(false),
  /** MARC-XCHPF. Used when the batch level is plant. Existing plant views stay non-batch. */
  batchManaged: boolean('batch_managed').notNull().default(false),
  /**
   * MARC-SFCPF. The production scheduling profile for this plant.
   * Blank means no profile. The key is not forced to four-character SAP plant length.
   */
  schedulingProfile: varchar('scheduling_profile', { length: 6 }),
  mrpType: varchar('mrp_type', { length: 16 }),
  mrpController: varchar('mrp_controller', { length: 3 }),
  procurementType: varchar('procurement_type', { length: 8 }),
  lotSizing: varchar('lot_sizing', { length: 16 }),
  fixedLotSize: quantity('fixed_lot_size').notNull().default('0'),
  minimumLotSize: quantity('minimum_lot_size').notNull().default('0'),
  maximumLotSize: quantity('maximum_lot_size').notNull().default('0'),
  safetyStock: quantity('safety_stock').notNull().default('0'),
  reorderPoint: quantity('reorder_point').notNull().default('0'),
  plannedDeliveryDays: integer('planned_delivery_days').notNull().default(0),
  inHouseProductionDays: integer('in_house_production_days').notNull().default(0),
  mrpStatus: varchar('mrp_status', { length: 16 }).notNull().default('NOT_CREATED'),
  version: integer('version').notNull().default(1), ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber, t.plant] }),
  foreignKey({ columns: [t.client, t.materialNumber], foreignColumns: [material.client, material.materialNumber] }).onDelete('cascade'),
  foreignKey({ columns: [t.client, t.plant], foreignColumns: [plant.client, plant.plant] }),
  foreignKey({ columns: [t.client, t.purchasingGroup], foreignColumns: [purchasingGroup.client, purchasingGroup.purchasingGroup] }),
  foreignKey({ columns: [t.client, t.mrpController], foreignColumns: [mrpController.client, mrpController.controller] }),
  check('material_plant_codes_ck', sql`(${t.mrpType} is null or ${t.mrpType} in ('REQUIREMENTS','REORDER','NONE')) and (${t.procurementType} is null or ${t.procurementType} in ('BUY','MAKE','BOTH')) and (${t.lotSizing} is null or ${t.lotSizing} in ('EXACT','FIXED'))`),
  check('material_plant_quantities_ck', sql`${t.fixedLotSize} >= 0 and ${t.minimumLotSize} >= 0 and ${t.maximumLotSize} >= 0 and ${t.safetyStock} >= 0 and ${t.reorderPoint} >= 0 and ${t.plannedDeliveryDays} >= 0 and ${t.inHouseProductionDays} >= 0`),
  check('material_plant_tolerance_ck', sql`${t.overdeliveryTolerance} between 0 and 100 and ${t.underdeliveryTolerance} between 0 and 100`),
  check('material_plant_status_ck', sql`${t.purchasingStatus} in ('NOT_CREATED','INCOMPLETE','CREATED','MAINTAINED') and ${t.mrpStatus} in ('NOT_CREATED','INCOMPLETE','CREATED','MAINTAINED')`),
]);

export const materialValuation = pgTable('material_valuation', {
  client: tenant(), materialNumber: varchar('material_number', { length: 40 }).notNull(),
  /** Plant is the valuation area in this standard package. */
  valuationArea: varchar('valuation_area', { length: 10 }).notNull(),
  valuationClass: varchar('valuation_class', { length: 20 }),
  priceControl: varchar('price_control', { length: 16 }).notNull(),
  standardPrice: money('standard_price').notNull().default('0'),
  movingAveragePrice: money('moving_average_price').notNull().default('0'),
  priceUnit: quantity('price_unit').notNull().default('1'),
  currency: char('currency', { length: 3 }).notNull(),
  /** Book quantities/values are changed by goods movements, never master forms. */
  totalStockQuantity: quantity('total_stock_quantity').notNull().default('0'),
  stockValue: money('stock_value').notNull().default('0'),
  /** A price that does not post until it is released. */
  futurePrice: money('future_price'),
  futurePriceUnit: quantity('future_price_unit'),
  futureValidFrom: date('future_valid_from', { mode: 'string' }),
  /** The price last posted to the previous material period. The current book price is separate. */
  previousPrice: money('previous_price'),
  previousPriceUnit: quantity('previous_price_unit'),
  accountingStatus: varchar('accounting_status', { length: 16 }).notNull().default('INCOMPLETE'),
  version: integer('version').notNull().default(1), ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber, t.valuationArea] }),
  foreignKey({ columns: [t.client, t.materialNumber], foreignColumns: [material.client, material.materialNumber] }).onDelete('cascade'),
  foreignKey({ columns: [t.client, t.valuationArea], foreignColumns: [plant.client, plant.plant] }),
  foreignKey({ columns: [t.client, t.valuationClass], foreignColumns: [valuationClass.client, valuationClass.valuationClass] }),
  check('material_valuation_codes_ck', sql`${t.priceControl} in ('STANDARD','MOVING_AVERAGE') and ${t.accountingStatus} in ('INCOMPLETE','CREATED','MAINTAINED')`),
  check('material_valuation_values_ck', sql`${t.standardPrice} >= 0 and ${t.movingAveragePrice} >= 0 and ${t.priceUnit} > 0 and ${t.totalStockQuantity} >= 0 and ${t.stockValue} >= 0`),
  check('material_valuation_future_ck', sql`(${t.futurePrice} is null and ${t.futurePriceUnit} is null and ${t.futureValidFrom} is null) or (${t.futurePrice} >= 0 and ${t.futurePriceUnit} > 0 and ${t.futureValidFrom} is not null)`),
  check('material_valuation_previous_ck', sql`(${t.previousPrice} is null and ${t.previousPriceUnit} is null) or (${t.previousPrice} >= 0 and ${t.previousPriceUnit} > 0)`),
]);

export const planningFile = pgTable('planning_file', {
  client: tenant(), materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  netChange: boolean('net_change').notNull().default(true),
  reason: varchar('reason', { length: 80 }).notNull(),
  lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
  lastChangedBy: varchar('last_changed_by', { length: 60 }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber, t.plant] }),
  foreignKey({ columns: [t.client, t.materialNumber, t.plant], foreignColumns: [materialPlant.client, materialPlant.materialNumber, materialPlant.plant] }).onDelete('cascade'),
]);

/**
 * Goods movements (SCR-061 / R-109). A material document is born
 * POSTED and immutable; its lines justify `stock_quantity`, and the
 * movement types that may be posted are tenant-standing data with
 * configured semantics, never a hard-coded list.
 */
export const movementType = pgTable('movement_type', {
  client: tenant(), movementType: varchar('movement_type', { length: 20 }).notNull(),
  description: varchar('description', { length: 60 }).notNull(),
  direction: varchar('direction', { length: 10 }).notNull(),
  referenceCategory: varchar('reference_category', { length: 20 }).notNull(),
  reversalMovementType: varchar('reversal_movement_type', { length: 20 }),
  /** SCR-146: what makes a movement what it is, as data rather than as a constant array. */
  movementKind: varchar('movement_kind', { length: 20 }).notNull().default('MATERIAL'),
  sourceStockType: varchar('source_stock_type', { length: 16 }),
  destinationStockType: varchar('destination_stock_type', { length: 16 }),
  plantRule: varchar('plant_rule', { length: 12 }).notNull().default('ANY'),
  locationRule: varchar('location_rule', { length: 12 }).notNull().default('ANY'),
  isTwoStep: boolean('is_two_step').notNull().default(false),
  requiresBatch: boolean('requires_batch').notNull().default(false),
  requiresSerial: boolean('requires_serial').notNull().default(false),
  requiresSpecialStock: boolean('requires_special_stock').notNull().default(false),
  requiresValuationType: boolean('requires_valuation_type').notNull().default(false),
  negativeStockPolicy: varchar('negative_stock_policy', { length: 12 }).notNull().default('LOCATION'),
  valuationRelevant: boolean('valuation_relevant').notNull().default(true),
  /**
   * SCR-149: the account-determination events a difference movement names, and the modifier on
   * the offset. Empty on every other kind. The poster reads them; it does not contain a G/L account.
   */
  inventoryEvent: varchar('inventory_event', { length: 24 }),
  offsetEvent: varchar('offset_event', { length: 24 }),
  offsetModifier: varchar('offset_modifier', { length: 4 }),
  /** What a withdrawal under this movement must be charged to — the T156 fact (SCR-133). */
  accountAssignment: varchar('account_assignment', { length: 16 }).notNull().default('NONE'),
  /**
   * OMCV / KZCLA. Blank is no branching. 1, 2, 3, and 4 ask for classification.
   * Copying, WIP adoption, and extended CFC are not stored on this row.
   */
  batchClassification: char('batch_classification', { length: 1 }).notNull().default(' '),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.movementType] }),
  /** A transfer is a movement serving both of its lines (SCR-131); a reservation's future issue is an ISSUE (SCR-133). */
  check('movement_type_direction_ck', sql`${t.direction} in ('RECEIPT', 'REVERSAL', 'TRANSFER', 'ISSUE')`),
  // SCR-146: the rules a movement carries now carry vocabulary of their own.
  check('movement_type_plant_rule_ck', sql`${t.plantRule} in ('SAME', 'DIFFERENT', 'ANY')`),
  check('movement_type_location_rule_ck', sql`${t.locationRule} in ('SAME', 'DIFFERENT', 'ANY')`),
  check('movement_type_negative_stock_ck', sql`${t.negativeStockPolicy} in ('LOCATION', 'FORBID')`),
  check('movement_type_reference_ck', sql`${t.referenceCategory} in ('PURCHASE_ORDER', 'MATERIAL_DOCUMENT', 'RESERVATION', 'PRODUCTION_ORDER', 'PHYSICAL_INVENTORY')`),
  check('movement_type_account_assignment_ck', sql`${t.accountAssignment} in ('NONE', 'COST_CENTER', 'ORDER')`),
  check('movement_type_batch_classification_ck', sql`${t.batchClassification} in (' ', '1', '2', '3', '4')`),
  check('movement_type_inventory_event_ck', sql`${t.inventoryEvent} is null or ${t.inventoryEvent} ~ '^[A-Z][A-Z0-9_]{2,23}$'`),
  check('movement_type_offset_event_ck', sql`${t.offsetEvent} is null or ${t.offsetEvent} ~ '^[A-Z][A-Z0-9_]{2,23}$'`),
  check('movement_type_offset_modifier_ck', sql`${t.offsetModifier} is null or ${t.offsetModifier} ~ '^[A-Z0-9]{1,4}$'`),
  check('movement_type_difference_shape_ck', sql`${t.movementKind} <> 'INVENTORY_DIFFERENCE' or (${t.direction} in ('RECEIPT', 'ISSUE') and ${t.referenceCategory} = 'PHYSICAL_INVENTORY' and (not ${t.valuationRelevant} or (${t.inventoryEvent} is not null and ${t.offsetEvent} is not null and ${t.offsetModifier} is not null)))`),
]);

export const materialDocument = pgTable('material_document', {
  client: tenant(),
  materialDocumentNumber: varchar('material_document_number', { length: 20 }).notNull(),
  documentYear: integer('document_year').notNull(),
  documentDate: varchar('document_date', { length: 10 }).notNull(),
  postingDate: varchar('posting_date', { length: 10 }).notNull(),
  headerText: varchar('header_text', { length: 25 }),
  status: varchar('status', { length: 20 }).notNull().default('POSTED'),
  journalDocumentNumber: varchar('journal_document_number', { length: 40 }),
  reversalOf: varchar('reversal_of', { length: 20 }),
  reversedBy: varchar('reversed_by', { length: 20 }),
  requestKey: varchar('request_key', { length: 64 }),
  /** SCR-146 §8.1: the external document number the movement was posted against. */
  externalReference: varchar('external_reference', { length: 40 }),
  /** SCR-146 §16: a fingerprint of the posting's content, so a reused key is compared, not trusted. */
  requestFingerprint: varchar('request_fingerprint', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialDocumentNumber] }),
  check('material_document_status_ck', sql`${t.status} in ('POSTED', 'PARTIALLY_REVERSED', 'REVERSED')`),
]);

export const materialDocumentLine = pgTable('material_document_line', {
  client: tenant(),
  materialDocumentNumber: varchar('material_document_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  movementType: varchar('movement_type', { length: 20 }).notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  storageLocation: varchar('storage_location', { length: 10 }),
  stockType: varchar('stock_type', { length: 16 }).notNull().default('UNRESTRICTED'),
  /** Blank for a material that is not batch-managed. A batch must already stand. */
  batchNumber: varchar('batch_number', { length: 40 }).notNull().default(''),
  /** Which side of the document this line is: a transfer writes one ISSUE and one RECEIPT line (SCR-131). */
  lineDirection: varchar('line_direction', { length: 8 }).notNull().default('RECEIPT'),
  entryQuantity: quantity('entry_quantity').notNull(),
  entryUnit: varchar('entry_unit', { length: 10 }).notNull(),
  baseQuantity: quantity('base_quantity').notNull(),
  baseUnit: varchar('base_unit', { length: 10 }).notNull(),
  unitPrice: money('unit_price').notNull().default('0'),
  priceUnit: quantity('price_unit').notNull().default('1'),
  currency: char('currency', { length: 3 }),
  value: money('value').notNull().default('0'),
  purchaseOrderNumber: varchar('purchase_order_number', { length: 20 }),
  purchaseOrderItem: integer('purchase_order_item'),
  /** The production order a component issue consumed for (SCR-139), and its component item. */
  productionOrderNumber: varchar('production_order_number', { length: 12 }),
  productionOrderItem: integer('production_order_item'),
  reversalOfDocument: varchar('reversal_of_document', { length: 20 }),
  reversalOfLine: integer('reversal_of_line'),
  /** SCR-145: the receipt item a commercial return came from — never the reversal pair. */
  returnOfDocument: varchar('return_of_document', { length: 20 }),
  returnOfDocumentYear: integer('return_of_document_year'),
  returnOfLine: integer('return_of_line'),
  itemText: varchar('item_text', { length: 100 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialDocumentNumber, t.lineNumber] }),
  foreignKey({ columns: [t.client, t.materialDocumentNumber], foreignColumns: [materialDocument.client, materialDocument.materialDocumentNumber] }).onDelete('restrict'),
  foreignKey({ columns: [t.client, t.movementType], foreignColumns: [movementType.client, movementType.movementType] }).onDelete('restrict'),
  check('material_document_line_qty_ck', sql`${t.entryQuantity} > 0 and ${t.baseQuantity} > 0`),
  check('material_document_line_direction_ck', sql`${t.lineDirection} in ('ISSUE', 'RECEIPT')`),
  // SCR-145: a return names a whole lineage or none, and it is never also a reversal.
  check('material_document_line_return_lineage_check', sql`(${t.returnOfDocument} is null and ${t.returnOfDocumentYear} is null and ${t.returnOfLine} is null) or (${t.returnOfDocument} is not null and ${t.returnOfDocumentYear} is not null and ${t.returnOfLine} is not null)`),
  check('material_document_line_reversal_not_return_check', sql`${t.reversalOfDocument} is null or ${t.returnOfDocument} is null`),
  index('material_document_line_return_of_idx').on(t.client, t.returnOfDocument, t.returnOfDocumentYear, t.returnOfLine),
]);

export const stockQuantity = pgTable('stock_quantity', {
  client: tenant(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  storageLocation: varchar('storage_location', { length: 10 }).notNull().default(''),
  stockType: varchar('stock_type', { length: 16 }).notNull().default('UNRESTRICTED'),
  /** Blank is the balance that stood before a batch was posted. */
  batchNumber: varchar('batch_number', { length: 40 }).notNull().default(''),
  quantity: quantity('quantity').notNull().default('0'),
  ...auditColumns,
}, (t) => [
  // No table-level non-negative guard: negative stock is permitted where the storage
  // location configures it, and a row check cannot read that configuration (SCR-131).
  primaryKey({ columns: [t.client, t.materialNumber, t.plant, t.storageLocation, t.stockType, t.batchNumber] }),
]);

/**
 * Reservations — SCR-133 / MB21 (RKPF shape).
 *
 * A reservation is a demand nobody has posted: a planned withdrawal of a
 * material from a plant on a required date. The header carries the movement
 * type, the required date and the account assignment the movement type demands;
 * the items carry the material, the plant and the quantities.
 */
export const reservationHeader = pgTable('reservation_header', {
  client: tenant(),
  reservationNumber: varchar('reservation_number', { length: 20 }).notNull(),
  movementType: varchar('movement_type', { length: 20 }).notNull(),
  baseDate: varchar('base_date', { length: 10 }).notNull(),
  /** The cost centre the movement type charges, where it charges one. */
  costCenter: varchar('cost_center', { length: 10 }),
  controllingArea: varchar('controlling_area', { length: 4 }),
  /** The order the movement type charges, where it charges one. */
  orderNumber: varchar('order_number', { length: 12 }),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.reservationNumber] }),
  foreignKey({ columns: [t.client, t.movementType], foreignColumns: [movementType.client, movementType.movementType] }).onDelete('restrict'),
]);

/** Reservation items — SCR-133 (RESB shape). The plant is the item's, as SAP's is. */
export const reservationItem = pgTable('reservation_item', {
  client: tenant(),
  reservationNumber: varchar('reservation_number', { length: 20 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  storageLocation: varchar('storage_location', { length: 10 }),
  requiredQuantity: quantity('required_quantity').notNull(),
  withdrawnQuantity: quantity('withdrawn_quantity').notNull().default('0'),
  unitOfMeasure: varchar('unit_of_measure', { length: 10 }).notNull(),
  /** False blocks a withdrawal against this item, as the package's indicator does. */
  movementAllowed: boolean('movement_allowed').notNull().default(true),
  /** Set when the item is withdrawn in full or completed by hand. */
  isCompleted: boolean('is_completed').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.reservationNumber, t.itemNumber] }),
  foreignKey({ columns: [t.client, t.reservationNumber], foreignColumns: [reservationHeader.client, reservationHeader.reservationNumber] }).onDelete('cascade'),
  check('reservation_item_quantity_ck', sql`${t.requiredQuantity} > 0 and ${t.withdrawnQuantity} >= 0`),
]);

/**
 * Output determination and dispatch — SCR-135 / MB90 (NAST shape).
 *
 * `output_type` is the catalogue *and* the condition: what a slip is called, which
 * direction it applies to, and the medium and dispatch time it defaults to.
 * `output_message` is the queue and the log: one row per document, output type and
 * medium, carrying its status, its send count and its last attempt.
 *
 * The document is referenced by its own columns with a foreign key — never by a
 * concatenated key, which no database can check (§26.882). No company code is
 * stored: it is derived from the plants the document moved.
 */
export const outputType = pgTable('output_type', {
  client: tenant(),
  outputType: varchar('output_type', { length: 4 }).notNull(),
  description: varchar('description', { length: 60 }).notNull(),
  /** RECEIPT | ISSUE | ANY — the line direction a document must carry to receive it. */
  direction: varchar('direction', { length: 8 }).notNull(),
  /** PRINT | EMAIL. FAX and EDI are refused by name: no endpoint exists. */
  transmissionMedium: varchar('transmission_medium', { length: 8 }).notNull().default('PRINT'),
  /** IMMEDIATE | PERIODIC (SAP VSZTP 1 / 3). */
  dispatchTime: varchar('dispatch_time', { length: 10 }).notNull().default('IMMEDIATE'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.outputType] }),
  check('output_type_code_ck', sql`${t.outputType} ~ '^[A-Z0-9]{2,4}$'`),
  check('output_type_direction_ck', sql`${t.direction} in ('RECEIPT', 'ISSUE', 'ANY')`),
  check('output_type_medium_ck', sql`${t.transmissionMedium} in ('PRINT', 'EMAIL')`),
  check('output_type_dispatch_ck', sql`${t.dispatchTime} in ('IMMEDIATE', 'PERIODIC')`),
]);

export const outputMessage = pgTable('output_message', {
  client: tenant(),
  materialDocumentNumber: varchar('material_document_number', { length: 20 }).notNull(),
  /** Written from the header, never from input — the document owns its year. */
  documentYear: integer('document_year').notNull(),
  outputType: varchar('output_type', { length: 4 }).notNull(),
  transmissionMedium: varchar('transmission_medium', { length: 8 }).notNull(),
  dispatchTime: varchar('dispatch_time', { length: 10 }).notNull(),
  /** PENDING | PROCESSED | ERROR (SAP VSTAT 0 / 1 / 2). */
  status: varchar('status', { length: 10 }).notNull().default('PENDING'),
  sendCount: integer('send_count').notNull().default(0),
  recipient: varchar('recipient', { length: 50 }),
  printerQueue: varchar('printer_queue', { length: 30 }),
  lastProcessedAt: timestamp('last_processed_at', { withTimezone: true }),
  /** Why the last attempt failed; only an ERROR carries one. */
  errorText: varchar('error_text', { length: 200 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialDocumentNumber, t.outputType, t.transmissionMedium] }),
  foreignKey({ columns: [t.client, t.materialDocumentNumber], foreignColumns: [materialDocument.client, materialDocument.materialDocumentNumber] }).onDelete('cascade'),
  foreignKey({ columns: [t.client, t.outputType], foreignColumns: [outputType.client, outputType.outputType] }).onDelete('restrict'),
  check('output_message_medium_ck', sql`${t.transmissionMedium} in ('PRINT', 'EMAIL')`),
  check('output_message_dispatch_ck', sql`${t.dispatchTime} in ('IMMEDIATE', 'PERIODIC')`),
  check('output_message_status_ck', sql`${t.status} in ('PENDING', 'PROCESSED', 'ERROR')`),
  check('output_message_send_count_ck', sql`${t.sendCount} >= 0`),
  check('output_message_error_ck', sql`${t.status} <> 'ERROR' or ${t.errorText} is not null`),
  index('output_message_queue_idx').on(t.client, t.status, t.createdAt),
  check('output_message_recipient_ck', sql`${t.recipient} is null or length(btrim(${t.recipient})) > 0`),
]);

/**
 * Production orders — SCR-138 (CO01 / AUFK + RESB shape).
 *
 * An order is a header: what is to be produced, where, how much, and when — plus the
 * status that decides whether work may be charged to it. Its company code is not a
 * column: it stands on the plant (SCR-030), and is derived wherever it is needed,
 * exactly as MB03 derives its own.
 *
 * The component list is a **snapshot on the order**, not an explosion of a BOM: canon
 * carries no BOM master, so the components are entered and stored as stated. A later
 * issue may consume them; nothing recomputes them.
 */
export const productionOrder = pgTable('production_order', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 12 }).notNull(),
  /** What the order produces. */
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  orderQuantity: quantity('order_quantity').notNull(),
  /** A batch that already stands, or one the snapshotted profile created. Blank means the receipt must name one. */
  batchNumber: varchar('batch_number', { length: 40 }).notNull().default(''),
  /** Profile key snapshotted at create. A later profile change does not rewrite it. */
  schedulingProfile: varchar('scheduling_profile', { length: 6 }).notNull().default(''),
  /** TCO43-FLG_REL_CR snapshotted at create. X or blank. Not a boolean. */
  releaseOnCreate: char('release_on_create', { length: 1 }).notNull().default(' '),
  /** TCO43-KZBCR snapshotted at create. Blank, 1, or 2. Not a boolean. */
  batchCreation: char('batch_creation', { length: 1 }).notNull().default(' '),
  unitOfMeasure: varchar('unit_of_measure', { length: 10 }).notNull(),
  scheduledStart: varchar('scheduled_start', { length: 10 }).notNull(),
  scheduledFinish: varchar('scheduled_finish', { length: 10 }).notNull(),
  /** CREATED or RELEASED. A 261 will judge RELEASED and refuse anything else (SCR-139). */
  status: varchar('status', { length: 20 }).notNull().default('CREATED'),
  requestKey: varchar('request_key', { length: 64 }),
  releasedBy: varchar('released_by', { length: 64 }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber] }),
  foreignKey({ columns: [t.client, t.plant], foreignColumns: [plant.client, plant.plant] }).onDelete('restrict'),
  check('production_order_status_ck', sql`${t.status} in ('CREATED', 'RELEASED')`),
  check('production_order_quantity_ck', sql`${t.orderQuantity} > 0`),
  check('production_order_dates_ck', sql`${t.scheduledFinish} >= ${t.scheduledStart}`),
  check('production_order_release_on_create_ck', sql`${t.releaseOnCreate} in ('X', ' ')`),
  check('production_order_batch_creation_ck', sql`${t.batchCreation} in (' ', '1', '2')`),
]);

/**
 * OPKP — production scheduling profile. TCO43, not T399X.
 * Key is client, plant, and CO_PRODPRF. The description is the tenant language,
 * not a TCO43T row per language. Only settings this system executes are stored.
 */
export const productionSchedulingProfile = pgTable('production_scheduling_profile', {
  client: tenant(),
  plant: varchar('plant', { length: 10 }).notNull(),
  profile: varchar('profile', { length: 6 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  releaseOnCreate: char('release_on_create', { length: 1 }).notNull().default(' '),
  batchCreation: char('batch_creation', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.plant, t.profile] }),
  foreignKey({ columns: [t.client, t.plant], foreignColumns: [plant.client, plant.plant] }).onDelete('restrict'),
  check('production_scheduling_profile_key_ck', sql`char_length(${t.profile}) between 1 and 6`),
  check('production_scheduling_profile_description_ck', sql`char_length(${t.description}) between 1 and 40`),
  check('production_scheduling_profile_release_ck', sql`${t.releaseOnCreate} in ('X', ' ')`),
  check('production_scheduling_profile_batch_ck', sql`${t.batchCreation} in (' ', '1', '2')`),
  check('production_scheduling_profile_version_ck', sql`${t.version} > 0`),
]);

/** The order's components — the RESB shape its goods issue will consume (SCR-139). */
export const productionOrderComponent = pgTable('production_order_component', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 12 }).notNull(),
  itemNumber: integer('item_number').notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  storageLocation: varchar('storage_location', { length: 10 }),
  requiredQuantity: quantity('required_quantity').notNull(),
  unitOfMeasure: varchar('unit_of_measure', { length: 10 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.itemNumber] }),
  foreignKey({ columns: [t.client, t.orderNumber], foreignColumns: [productionOrder.client, productionOrder.orderNumber] })
    .onDelete('cascade'),
  check('production_order_component_quantity_ck', sql`${t.requiredQuantity} > 0`),
]);


/**
 * The physical inventory document (SCR-142 / MI01) — the count in progress.
 *
 * Unlike the issue and the receipt, which live in the material document, a count has no
 * ledger row to live in: nothing in `material_document` records "these materials are being
 * counted here". The header carries no company code (the plant's) and no `is_counted`
 * (the status is the answer).
 */
export const physicalInventoryDocument = pgTable('physical_inventory_document', {
  client: tenant(),
  inventoryDocumentNumber: varchar('inventory_document_number', { length: 24 }).notNull(),
  /** The document's own identity and the scope of its number interval. */
  fiscalYear: integer('fiscal_year').notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  storageLocation: varchar('storage_location', { length: 10 }),
  plannedCountDate: varchar('planned_count_date', { length: 10 }).notNull(),
  postingBlock: boolean('posting_block').notNull().default(false),
  /** CREATED, or CANCELLED before anything is counted. COUNTED and ADJUSTED arrive with MI04/MI07. */
  status: varchar('status', { length: 20 }).notNull().default('CREATED'),
  /** Bumped on every change, so two states of one document are distinguishable without timestamps. */
  version: integer('version').notNull().default(1),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.inventoryDocumentNumber, t.fiscalYear] }),
  foreignKey({ columns: [t.client, t.plant], foreignColumns: [plant.client, plant.plant] }).onDelete('restrict'),
  /** SCR-149: PARTIALLY_POSTED is a header with something posted and something unresolved. DIFFERENCES_REVIEWED stays in the vocabulary and is not set. */
  check('physical_inventory_document_status_ck', sql`${t.status} in ('CREATED', 'PARTIALLY_COUNTED', 'COUNTED', 'DIFFERENCES_REVIEWED', 'PARTIALLY_POSTED', 'POSTED', 'CANCELLED')`),
  index('physical_inventory_document_plant_idx').on(t.client, t.plant, t.plannedCountDate),
  /** SCR-148: plant + fiscal year, the difference list's required predicate. Measured; a plan selects it. */
  index('physical_inventory_document_plant_year_idx').on(t.client, t.plant, t.fiscalYear, t.inventoryDocumentNumber),
]);

/** The materials a count covers. One material, once, per document. */
export const physicalInventoryItem = pgTable('physical_inventory_item', {
  client: tenant(),
  inventoryDocumentNumber: varchar('inventory_document_number', { length: 24 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  itemNumber: integer('item_number').notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  /**
   * SCR-147: the stock identity the count measures. MI01 creates one item per stock type that
   * holds stock, because a difference at material level cannot be posted to the stock type MI07
   * must name — and `stockAt` reads only UNRESTRICTED, which hid quality stock entirely.
   */
  stockType: varchar('stock_type', { length: 16 }).notNull().default('UNRESTRICTED'),
  /** Blank for a material that is not batch-managed. A named batch must already stand. */
  batchNumber: varchar('batch_number', { length: 40 }).notNull().default(''),
  /** SCR-147: the count result. Nullable on purpose — null is "nobody has looked". */
  countedQuantity: quantity('counted_quantity'),
  entryUnit: varchar('entry_unit', { length: 10 }),
  countedBaseQuantity: quantity('counted_base_quantity'),
  /** Zero is a state, not a number: a person looked and found nothing. */
  zeroCountFlag: boolean('zero_count_flag').notNull().default(false),
  counterName: varchar('counter_name', { length: 35 }),
  countDate: varchar('count_date', { length: 10 }),
  /** The book quantity the variance is measured against, with the basis it was taken on. */
  bookQuantitySnapshot: quantity('book_quantity_snapshot'),
  bookQuantityUnit: varchar('book_quantity_unit', { length: 10 }),
  bookQuantityBasis: varchar('book_quantity_basis', { length: 20 }),
  differenceQuantity: quantity('difference_quantity'),
  countStatus: varchar('count_status', { length: 24 }).notNull().default('UNCOUNTED'),
  /** SCR-149: whether this item's difference has been posted. A count status is not a posting status. */
  postingStatus: varchar('posting_status', { length: 16 }).notNull().default('UNPOSTED'),
  itemText: varchar('item_text', { length: 60 }),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.inventoryDocumentNumber, t.fiscalYear, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.inventoryDocumentNumber, t.fiscalYear],
    foreignColumns: [
      physicalInventoryDocument.client,
      physicalInventoryDocument.inventoryDocumentNumber,
      physicalInventoryDocument.fiscalYear,
    ],
  }).onDelete('cascade'),
  index('physical_inventory_item_material_idx').on(t.client, t.materialNumber),
  uniqueIndex('physical_inventory_item_material_key').on(
    t.client, t.inventoryDocumentNumber, t.fiscalYear, t.materialNumber, t.stockType, t.batchNumber,
  ),
  check('physical_inventory_item_count_status_ck', sql`${t.countStatus} in ('UNCOUNTED', 'COUNTED', 'RECOUNT_REQUIRED')`),
  check('physical_inventory_item_posting_status_ck', sql`${t.postingStatus} in ('UNPOSTED', 'POSTED')`),
  check(
    'physical_inventory_item_zero_ck',
    sql`not ${t.zeroCountFlag} or ${t.countedBaseQuantity} is not distinct from 0`,
  ),
  check(
    'physical_inventory_item_count_positive_ck',
    sql`(${t.countedQuantity} is null or ${t.countedQuantity} >= 0)
      and (${t.countedBaseQuantity} is null or ${t.countedBaseQuantity} >= 0)`,
  ),
  check(
    'physical_inventory_item_count_complete_ck',
    sql`(${t.countedBaseQuantity} is null and ${t.countStatus} <> 'COUNTED')
      or (${t.countedBaseQuantity} is not null and ${t.countedQuantity} is not null
          and ${t.entryUnit} is not null and ${t.countDate} is not null)`,
  ),
  check(
    'physical_inventory_item_count_date_ck',
    sql`${t.countDate} is null or ${t.countDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
  ),
  check(
    'physical_inventory_item_book_basis_ck',
    sql`${t.bookQuantityBasis} is null or ${t.bookQuantityBasis} in ('DOCUMENT_CREATION', 'COUNT_TIME')`,
  ),
]);

/**
 * SCR-149 — which physical-inventory item a material-document line posted.
 *
 * The material document is the batch. This row is the link the line does not have. It is unique
 * on the material-document line, not on the inventory document, because one count may be posted
 * in more than one material document. The reversed quantity releases that link without deleting
 * it. The journal number is read from the material document, not stored here.
 */
export const physicalInventoryDifferenceAllocation = pgTable('physical_inventory_difference_allocation', {
  client: tenant(),
  inventoryDocumentNumber: varchar('inventory_document_number', { length: 24 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  itemNumber: integer('item_number').notNull(),
  countVersion: integer('count_version').notNull(),
  postedDifference: quantity('posted_difference').notNull(),
  materialDocumentNumber: varchar('material_document_number', { length: 20 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  reversedQuantity: quantity('reversed_quantity').notNull().default('0'),
  reversalDocumentNumber: varchar('reversal_document_number', { length: 20 }),
  reversalLine: integer('reversal_line'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialDocumentNumber, t.lineNumber] }),
  foreignKey({
    columns: [t.client, t.inventoryDocumentNumber, t.fiscalYear, t.itemNumber],
    foreignColumns: [
      physicalInventoryItem.client,
      physicalInventoryItem.inventoryDocumentNumber,
      physicalInventoryItem.fiscalYear,
      physicalInventoryItem.itemNumber,
    ],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.materialDocumentNumber, t.lineNumber],
    foreignColumns: [
      materialDocumentLine.client,
      materialDocumentLine.materialDocumentNumber,
      materialDocumentLine.lineNumber,
    ],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.reversalDocumentNumber, t.reversalLine],
    foreignColumns: [
      materialDocumentLine.client,
      materialDocumentLine.materialDocumentNumber,
      materialDocumentLine.lineNumber,
    ],
  }).onDelete('restrict'),
  check('physical_inventory_difference_allocation_version_ck', sql`${t.countVersion} > 0`),
  check('physical_inventory_difference_allocation_posted_ck', sql`${t.postedDifference} <> 0`),
  check('physical_inventory_difference_allocation_reversed_ck', sql`${t.reversedQuantity} >= 0 and ${t.reversedQuantity} <= abs(${t.postedDifference})`),
  check('physical_inventory_difference_allocation_reversal_lineage_ck', sql`(${t.reversedQuantity} = 0 and ${t.reversalDocumentNumber} is null and ${t.reversalLine} is null) or (${t.reversedQuantity} > 0 and ${t.reversalDocumentNumber} is not null and ${t.reversalLine} is not null)`),
  uniqueIndex('physical_inventory_difference_allocation_item_uq').on(
    t.client, t.inventoryDocumentNumber, t.fiscalYear, t.itemNumber, t.materialDocumentNumber,
  ),
]);

/**
 * SCR-150 — which original item a recount document was raised for.
 *
 * The pair of items is the key, so a cancelled generation stays and a later one is a new row.
 * One original item has one link that is not cancelled. One recount item has one source, and
 * that unique index is the reverse read. There is no company code: it is derived from the plant.
 */
export const physicalInventoryRecountLink = pgTable('physical_inventory_recount_link', {
  client: tenant(),
  originalDocumentNumber: varchar('original_document_number', { length: 24 }).notNull(),
  originalFiscalYear: integer('original_fiscal_year').notNull(),
  originalItemNumber: integer('original_item_number').notNull(),
  recountDocumentNumber: varchar('recount_document_number', { length: 24 }).notNull(),
  recountFiscalYear: integer('recount_fiscal_year').notNull(),
  recountItemNumber: integer('recount_item_number').notNull(),
  reason: varchar('reason', { length: 40 }).notNull(),
  headerText: varchar('header_text', { length: 40 }),
  plannedRecountDate: varchar('planned_recount_date', { length: 10 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('SCHEDULED'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [
    t.client,
    t.originalDocumentNumber, t.originalFiscalYear, t.originalItemNumber,
    t.recountDocumentNumber, t.recountFiscalYear, t.recountItemNumber,
  ] }),
  foreignKey({
    columns: [t.client, t.originalDocumentNumber, t.originalFiscalYear, t.originalItemNumber],
    foreignColumns: [
      physicalInventoryItem.client,
      physicalInventoryItem.inventoryDocumentNumber,
      physicalInventoryItem.fiscalYear,
      physicalInventoryItem.itemNumber,
    ],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.recountDocumentNumber, t.recountFiscalYear, t.recountItemNumber],
    foreignColumns: [
      physicalInventoryItem.client,
      physicalInventoryItem.inventoryDocumentNumber,
      physicalInventoryItem.fiscalYear,
      physicalInventoryItem.itemNumber,
    ],
  }).onDelete('restrict'),
  uniqueIndex('physical_inventory_recount_link_active_uq')
    .on(t.client, t.originalDocumentNumber, t.originalFiscalYear, t.originalItemNumber)
    .where(sql`${t.status} <> 'CANCELLED'`),
  uniqueIndex('physical_inventory_recount_link_recount_uq')
    .on(t.client, t.recountDocumentNumber, t.recountFiscalYear, t.recountItemNumber),
  check('physical_inventory_recount_link_status_ck', sql`${t.status} in ('SCHEDULED', 'COUNTED', 'RESOLVED', 'CANCELLED')`),
  check('physical_inventory_recount_link_reason_ck', sql`char_length(btrim(${t.reason})) between 1 and 40`),
  check('physical_inventory_recount_link_header_ck', sql`${t.headerText} is null or char_length(btrim(${t.headerText})) between 1 and 40`),
  check('physical_inventory_recount_link_date_ck', sql`${t.plannedRecountDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  check('physical_inventory_recount_link_distinct_document_ck', sql`${t.originalDocumentNumber} <> ${t.recountDocumentNumber} or ${t.originalFiscalYear} <> ${t.recountFiscalYear}`),
]);

/**
 * SCR-144 / INV.STOCK.UOM — one alternative unit per material per base unit, as an exact
 * ratio, so a conversion is rational arithmetic rather than a float multiplier.
 */
export const materialUomConversion = pgTable('material_uom_conversion', {
  client: tenant(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  alternativeUnit: varchar('alternative_unit', { length: 6 }).notNull(),
  baseUnit: varchar('base_unit', { length: 6 }).notNull(),
  numerator: integer('numerator').notNull(),
  denominator: integer('denominator').notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber, t.alternativeUnit] }),
  index('material_uom_conversion_material_idx').on(t.client, t.materialNumber),
]);

/**
 * OMCE — one batch level for the client. The stored code is the SAP character
 * 0, 1, or 2. The description is derived and is never the key.
 */
export const batchLevelConfiguration = pgTable('batch_level_configuration', {
  client: tenant(),
  batchLevel: char('batch_level', { length: 1 }).notNull(),
  version: integer('version').notNull().default(1),
  lastRequestKey: varchar('last_request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client] }),
  check('batch_level_configuration_level_ck', sql`${t.batchLevel} in ('0', '1', '2')`),
  check('batch_level_configuration_version_ck', sql`${t.version} > 0`),
]);

/** A refused or unnecessary conversion attempt. It never changes the level. */
export const batchLevelConversion = pgTable('batch_level_conversion', {
  client: tenant(),
  conversionRunId: varchar('conversion_run_id', { length: 36 }).notNull(),
  sourceLevel: char('source_level', { length: 1 }).notNull(),
  targetLevel: char('target_level', { length: 1 }).notNull(),
  sourceVersion: integer('source_version').notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  batchCount: integer('batch_count').notNull(),
  stockBatchCount: integer('stock_batch_count').notNull(),
  documentBatchCount: integer('document_batch_count').notNull(),
  stockColumnPresent: boolean('stock_column_present').notNull(),
  documentColumnPresent: boolean('document_column_present').notNull(),
  errorSummary: text('error_summary').notNull(),
  reason: varchar('reason', { length: 500 }).notNull(),
  startedBy: varchar('started_by', { length: 60 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.conversionRunId] }),
  check('batch_level_conversion_status_ck', sql`${t.status} in ('BLOCKED', 'NOT_REQUIRED')`),
  check('batch_level_conversion_level_ck', sql`${t.sourceLevel} in ('0', '1', '2') and ${t.targetLevel} in ('0', '1', '2')`),
]);

/**
 * Batch identity. MSC1N is not this table's screen. Partial unique indexes
 * enforce the level that was current when the row was written.
 */
export const batch = pgTable('batch', {
  id: varchar('id', { length: 36 }).primaryKey(),
  client: tenant(),
  batchNumber: varchar('batch_number', { length: 40 }).notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }),
  batchLevelAtCreation: char('batch_level_at_creation', { length: 1 }).notNull(),
  /** ZUSTD / XFELD. Null when status management does not apply. Blank is unrestricted. X is restricted. */
  restrictedUse: char('restricted_use', { length: 1 }),
  manufactureDate: date('manufacture_date'),
  shelfLifeExpirationDate: date('shelf_life_expiration_date'),
  vendorBatch: varchar('vendor_batch', { length: 15 }),
  countryOfOrigin: char('country_of_origin', { length: 2 }),
  requestKey: varchar('request_key', { length: 64 }),
  /** Optimistic token. A change must send the version it opened. */
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  foreignKey({
    columns: [t.client, t.materialNumber],
    foreignColumns: [material.client, material.materialNumber],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }).onDelete('cascade'),
  uniqueIndex('batch_plant_level_uq')
    .on(t.client, t.materialNumber, t.plant, t.batchNumber)
    .where(sql`${t.batchLevelAtCreation} = '0'`),
  uniqueIndex('batch_material_level_uq')
    .on(t.client, t.materialNumber, t.batchNumber)
    .where(sql`${t.batchLevelAtCreation} = '1'`),
  uniqueIndex('batch_client_level_uq')
    .on(t.client, t.batchNumber)
    .where(sql`${t.batchLevelAtCreation} = '2'`),
  index('batch_client_idx').on(t.client),
  check('batch_level_ck', sql`${t.batchLevelAtCreation} in ('0', '1', '2')`),
  check('batch_identity_ck', sql`(${t.batchLevelAtCreation} = '0' and ${t.plant} is not null) or (${t.batchLevelAtCreation} in ('1', '2') and ${t.plant} is null)`),
  check('batch_restricted_use_ck', sql`${t.restrictedUse} is null or ${t.restrictedUse} in ('X', ' ')`),
  check('batch_number_length_ck', sql`char_length(${t.batchNumber}) between 1 and 40`),
  check('batch_vendor_batch_ck', sql`${t.vendorBatch} is null or char_length(${t.vendorBatch}) between 1 and 15`),
  check('batch_version_ck', sql`${t.version} > 0`),
]);

/**
 * OMCS — client indicator for batch status management. The stored code is
 * the SAP character 1, or a blank when a save turned it off. The batch level
 * stays on the OMCE row. A plant selection is not stored here.
 */
export const batchStatusManagement = pgTable('batch_status_management', {
  client: tenant(),
  statusManagement: char('status_management', { length: 1 }).notNull(),
  version: integer('version').notNull().default(1),
  lastRequestKey: varchar('last_request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client] }),
  check('batch_status_management_code_ck', sql`${t.statusManagement} in ('1', ' ')`),
  check('batch_status_management_version_ck', sql`${t.version} > 0`),
]);

/**
 * OMCU — T001W-CHAZV, domain XFELD. X means batch status management is
 * selected for the plant. Blank means it is not. Absence of a row is not
 * selected. The plant name stays on the plant master. This row does not
 * post movement 341 or 342.
 */
export const batchStatusPlant = pgTable('batch_status_plant', {
  client: tenant(),
  plant: varchar('plant', { length: 10 }).notNull(),
  statusActive: char('status_active', { length: 1 }).notNull(),
  version: integer('version').notNull().default(1),
  lastRequestKey: varchar('last_request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.plant] }),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }).onDelete('cascade'),
  check('batch_status_plant_code_ck', sql`${t.statusActive} in ('X', ' ')`),
  check('batch_status_plant_version_ck', sql`${t.version} > 0`),
]);

/** A refused plant-status conversion. It never changes the plant flag or stock. */
export const batchStatusPlantConversion = pgTable('batch_status_plant_conversion', {
  client: tenant(),
  conversionRunId: varchar('conversion_run_id', { length: 36 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  priorActive: char('prior_active', { length: 1 }).notNull(),
  requestedActive: char('requested_active', { length: 1 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  batchCount: integer('batch_count').notNull(),
  stockBatchCount: integer('stock_batch_count').notNull(),
  documentBatchCount: integer('document_batch_count').notNull(),
  errorSummary: text('error_summary').notNull(),
  reason: varchar('reason', { length: 500 }).notNull(),
  startedBy: varchar('started_by', { length: 60 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.conversionRunId] }),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }).onDelete('cascade'),
  check('batch_status_plant_conversion_status_ck', sql`${t.status} = 'BLOCKED'`),
  check('batch_status_plant_conversion_code_ck', sql`${t.priorActive} in ('X', ' ') and ${t.requestedActive} in ('X', ' ')`),
]);

/**
 * OMCZ — client activation of internal batch number assignment.
 * TCUBN-AUTBN, historically TCUCH-AUTBN. Domain CHAR1. The screen is a
 * radio: X is active, blank is not active. It is not a plant and not a
 * material type. Absence of a row is not active. This row does not create
 * a BATCH_CLT interval.
 */
export const batchNumberAssignment = pgTable('batch_number_assignment', {
  client: tenant(),
  internalAssignment: char('internal_assignment', { length: 1 }).notNull(),
  version: integer('version').notNull().default(1),
  lastRequestKey: varchar('last_request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client] }),
  check('batch_number_assignment_code_ck', sql`${t.internalAssignment} in ('X', ' ')`),
  check('batch_number_assignment_version_ck', sql`${t.version} > 0`),
]);

/**
 * OMCZ plant view — T159L-XCAUT. XFELD. X permits an internal batch number
 * on an account-assigned goods receipt. It is not the client activation,
 * and it does not create a batch for a stock receipt.
 */
export const batchAssignedReceipt = pgTable('batch_assigned_receipt', {
  client: tenant(),
  plant: varchar('plant', { length: 10 }).notNull(),
  assignedReceipt: char('assigned_receipt', { length: 1 }).notNull(),
  version: integer('version').notNull().default(1),
  lastRequestKey: varchar('last_request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.plant] }),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }).onDelete('restrict'),
  check('batch_assigned_receipt_code_ck', sql`${t.assignedReceipt} in ('X', ' ')`),
  check('batch_assigned_receipt_version_ck', sql`${t.version} > 0`),
]);

/**
 * OMA1 — Inventory Management condition table. Usage H and application ME.
 * The number is the customer key area, 501 to 999. The fields are the key.
 * No physical table is generated, and no condition record is stored.
 */
export const batchConditionTable = pgTable('batch_condition_table', {
  client: tenant(),
  usage: char('usage', { length: 1 }).notNull().default('H'),
  application: char('application', { length: 2 }).notNull().default('ME'),
  conditionTable: char('condition_table', { length: 3 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.usage, t.conditionTable] }),
  check('batch_condition_table_usage_ck', sql`${t.usage} = 'H'`),
  check('batch_condition_table_application_ck', sql`${t.application} = 'ME'`),
  check('batch_condition_table_number_ck', sql`${t.conditionTable} ~ '^(50[1-9]|5[1-9][0-9]|[6-9][0-9]{2})$'`),
  check('batch_condition_table_version_ck', sql`${t.version} > 0`),
]);

/** Key fields of one OMA1 condition table, in the order they were named. */
export const batchConditionTableField = pgTable('batch_condition_table_field', {
  client: tenant(),
  usage: char('usage', { length: 1 }).notNull().default('H'),
  conditionTable: char('condition_table', { length: 3 }).notNull(),
  position: integer('position').notNull(),
  fieldName: varchar('field_name', { length: 30 }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.client, t.usage, t.conditionTable, t.position] }),
  uniqueIndex('batch_condition_table_field_name_uk').on(t.client, t.usage, t.conditionTable, t.fieldName),
  check('batch_condition_table_field_position_ck', sql`${t.position} between 1 and 9`),
]);

/**
 * OMCX — Inventory Management access sequence. Usage H and application ME,
 * the VV_T682_ME scope. The key is KOZGF. A step names a standing condition
 * table and does not search it.
 */
export const batchAccessSequence = pgTable('batch_access_sequence', {
  client: tenant(),
  usage: char('usage', { length: 1 }).notNull().default('H'),
  application: char('application', { length: 2 }).notNull().default('ME'),
  accessSequence: varchar('access_sequence', { length: 4 }).notNull(),
  description: varchar('description', { length: 30 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.usage, t.application, t.accessSequence] }),
  check('batch_access_sequence_usage_ck', sql`${t.usage} = 'H'`),
  check('batch_access_sequence_application_ck', sql`${t.application} = 'ME'`),
  check('batch_access_sequence_key_ck', sql`${t.accessSequence} ~ '^[A-Z0-9]{1,4}$'`),
  check('batch_access_sequence_version_ck', sql`${t.version} > 0`),
]);

/** OMCX access step. The number is KOLNR, two digits. The table must stand. Exclusive access is not stored. */
export const batchAccessStep = pgTable('batch_access_step', {
  client: tenant(),
  usage: char('usage', { length: 1 }).notNull().default('H'),
  application: char('application', { length: 2 }).notNull().default('ME'),
  accessSequence: varchar('access_sequence', { length: 4 }).notNull(),
  accessNumber: char('access_number', { length: 2 }).notNull(),
  conditionTable: char('condition_table', { length: 3 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.usage, t.application, t.accessSequence, t.accessNumber] }),
  index('batch_access_step_table_idx').on(t.client, t.usage, t.conditionTable),
  check('batch_access_step_usage_ck', sql`${t.usage} = 'H'`),
  check('batch_access_step_application_ck', sql`${t.application} = 'ME'`),
  check('batch_access_step_number_ck', sql`${t.accessNumber} ~ '^[0-9]{2}$'`),
  check('batch_access_step_table_ck', sql`${t.conditionTable} ~ '^[0-9]{3}$'`),
  check('batch_access_step_version_ck', sql`${t.version} > 0`),
]);

/**
 * OMCY — Inventory Management search procedure. Usage H and application ME.
 * The key is KALSM, six characters. A step names a standing strategy type
 * and does not select a batch.
 */
export const batchSearchProcedure = pgTable('batch_search_procedure', {
  client: tenant(),
  usage: char('usage', { length: 1 }).notNull().default('H'),
  application: char('application', { length: 2 }).notNull().default('ME'),
  searchProcedure: varchar('search_procedure', { length: 6 }).notNull(),
  description: varchar('description', { length: 30 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.usage, t.application, t.searchProcedure] }),
  check('batch_search_procedure_usage_ck', sql`${t.usage} = 'H'`),
  check('batch_search_procedure_application_ck', sql`${t.application} = 'ME'`),
  check('batch_search_procedure_key_ck', sql`${t.searchProcedure} ~ '^[A-Z0-9]{1,6}$'`),
  check('batch_search_procedure_version_ck', sql`${t.version} > 0`),
]);

/** OMCY procedure step. STUNR is three digits. ZAEHK is two digits. The strategy type must stand. */
export const batchSearchProcedureStep = pgTable('batch_search_procedure_step', {
  client: tenant(),
  usage: char('usage', { length: 1 }).notNull().default('H'),
  application: char('application', { length: 2 }).notNull().default('ME'),
  searchProcedure: varchar('search_procedure', { length: 6 }).notNull(),
  stepNumber: char('step_number', { length: 3 }).notNull(),
  counter: char('counter', { length: 2 }).notNull(),
  strategyType: varchar('strategy_type', { length: 4 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.usage, t.application, t.searchProcedure, t.stepNumber, t.counter] }),
  index('batch_search_procedure_step_type_idx').on(t.client, t.usage, t.application, t.strategyType),
  check('batch_search_procedure_step_usage_ck', sql`${t.usage} = 'H'`),
  check('batch_search_procedure_step_application_ck', sql`${t.application} = 'ME'`),
  check('batch_search_procedure_step_number_ck', sql`${t.stepNumber} ~ '^[0-9]{3}$'`),
  check('batch_search_procedure_step_counter_ck', sql`${t.counter} ~ '^[0-9]{2}$'`),
  check('batch_search_procedure_step_type_ck', sql`${t.strategyType} ~ '^[A-Z0-9]{1,4}$'`),
  check('batch_search_procedure_step_version_ck', sql`${t.version} > 0`),
]);

/**
 * OMCG — allocation of an Inventory Management search procedure.
 * View V_156B_SS. The key is the movement type and the special stock.
 * Blank special stock is own stock, not a wildcard and not a plant.
 * The check indicator is stored. It does not select a batch.
 */
export const batchSearchAllocation = pgTable('batch_search_allocation', {
  client: tenant(),
  movementType: varchar('movement_type', { length: 20 }).notNull(),
  specialStock: char('special_stock', { length: 1 }).notNull().default(' '),
  usage: char('usage', { length: 1 }).notNull().default('H'),
  application: char('application', { length: 2 }).notNull().default('ME'),
  searchProcedure: varchar('search_procedure', { length: 6 }).notNull(),
  transferProcedure: varchar('transfer_procedure', { length: 6 }).notNull().default(''),
  checkBatch: char('check_batch', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.movementType, t.specialStock] }),
  index('batch_search_allocation_procedure_idx').on(t.client, t.usage, t.application, t.searchProcedure),
  index('batch_search_allocation_transfer_idx').on(t.client, t.usage, t.application, t.transferProcedure),
  foreignKey({
    columns: [t.client, t.movementType],
    foreignColumns: [movementType.client, movementType.movementType],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.usage, t.application, t.searchProcedure],
    foreignColumns: [batchSearchProcedure.client, batchSearchProcedure.usage, batchSearchProcedure.application, batchSearchProcedure.searchProcedure],
  }).onDelete('cascade'),
  check('batch_search_allocation_stock_ck', sql`${t.specialStock} = ' '`),
  check('batch_search_allocation_usage_ck', sql`${t.usage} = 'H'`),
  check('batch_search_allocation_application_ck', sql`${t.application} = 'ME'`),
  check('batch_search_allocation_procedure_ck', sql`${t.searchProcedure} ~ '^[A-Z0-9]{1,6}$'`),
  check('batch_search_allocation_transfer_ck', sql`${t.transferProcedure} = '' or ${t.transferProcedure} ~ '^[A-Z0-9]{1,6}$'`),
  check('batch_search_allocation_check_ck', sql`${t.checkBatch} in (' ', 'X')`),
  check('batch_search_allocation_version_ck', sql`${t.version} > 0`),
]);

/**
 * MBC1 — Inventory Management batch search strategy. Usage H, application ME.
 * The key combination comes from the strategy type's access sequence.
 * Validity is the business period. The record does not select a batch.
 */
export const batchSearchStrategy = pgTable('batch_search_strategy', {
  client: tenant(),
  recordNumber: char('record_number', { length: 10 }).notNull(),
  usage: char('usage', { length: 1 }).notNull().default('H'),
  application: char('application', { length: 2 }).notNull().default('ME'),
  strategyType: varchar('strategy_type', { length: 4 }).notNull(),
  conditionTable: char('condition_table', { length: 3 }).notNull(),
  keyFingerprint: varchar('key_fingerprint', { length: 500 }).notNull(),
  validFrom: varchar('valid_from', { length: 10 }).notNull(),
  validTo: varchar('valid_to', { length: 10 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.recordNumber] }),
  uniqueIndex('batch_search_strategy_key_uk').on(
    t.client, t.usage, t.application, t.strategyType, t.conditionTable, t.keyFingerprint, t.validTo,
  ),
  index('batch_search_strategy_lookup_idx').on(t.client, t.strategyType, t.conditionTable, t.keyFingerprint),
  foreignKey({
    columns: [t.client, t.usage, t.application, t.strategyType],
    foreignColumns: [batchStrategyType.client, batchStrategyType.usage, batchStrategyType.application, batchStrategyType.strategyType],
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.usage, t.conditionTable],
    foreignColumns: [batchConditionTable.client, batchConditionTable.usage, batchConditionTable.conditionTable],
  }).onDelete('cascade'),
  check('batch_search_strategy_usage_ck', sql`${t.usage} = 'H'`),
  check('batch_search_strategy_application_ck', sql`${t.application} = 'ME'`),
  check('batch_search_strategy_record_ck', sql`${t.recordNumber} ~ '^[0-9]{10}$'`),
  check('batch_search_strategy_from_ck', sql`${t.validFrom} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  check('batch_search_strategy_to_ck', sql`${t.validTo} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  check('batch_search_strategy_period_ck', sql`${t.validFrom} <= ${t.validTo}`),
  check('batch_search_strategy_version_ck', sql`${t.version} > 0`),
]);

/** Key values of one MBC1 record, in the condition-table order. */
export const batchSearchStrategyKey = pgTable('batch_search_strategy_key', {
  client: tenant(),
  recordNumber: char('record_number', { length: 10 }).notNull(),
  fieldName: varchar('field_name', { length: 30 }).notNull(),
  fieldValue: varchar('field_value', { length: 40 }).notNull(),
  position: integer('position').notNull(),
}, (t) => [
  primaryKey({ columns: [t.client, t.recordNumber, t.fieldName] }),
  foreignKey({
    columns: [t.client, t.recordNumber],
    foreignColumns: [batchSearchStrategy.client, batchSearchStrategy.recordNumber],
  }).onDelete('cascade'),
  check('batch_search_strategy_key_position_ck', sql`${t.position} between 1 and 9`),
  check('batch_search_strategy_key_value_ck', sql`length(btrim(${t.fieldValue})) >= 1`),
]);

/**
 * OMCW — Inventory Management strategy type. Usage H and application ME,
 * the VV_T685H_ME scope. The key is the condition type. A blank access
 * sequence is no reference. A non-blank value names a standing OMCX
 * sequence and does not run an access.
 */
export const batchStrategyType = pgTable('batch_strategy_type', {
  client: tenant(),
  usage: char('usage', { length: 1 }).notNull().default('H'),
  application: char('application', { length: 2 }).notNull().default('ME'),
  strategyType: varchar('strategy_type', { length: 4 }).notNull(),
  description: varchar('description', { length: 20 }).notNull(),
  accessSequence: varchar('access_sequence', { length: 4 }).notNull().default(''),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.usage, t.application, t.strategyType] }),
  check('batch_strategy_type_usage_ck', sql`${t.usage} = 'H'`),
  check('batch_strategy_type_application_ck', sql`${t.application} = 'ME'`),
  check('batch_strategy_type_key_ck', sql`${t.strategyType} ~ '^[A-Z0-9]{1,4}$'`),
  check('batch_strategy_type_access_ck', sql`${t.accessSequence} = '' or ${t.accessSequence} ~ '^[A-Z0-9]{1,4}$'`),
  check('batch_strategy_type_version_ck', sql`${t.version} > 0`),
]);

/**
 * CU70 — sort sequence. The name is the class-number domain, 18 characters.
 * Status is the class-status code: 0 in preparation, 1 released, 2 locked.
 * A criterion names a standing characteristic, or the stock exceptions
 * LOBM_LGORT and LOBM_MENGE. Direction is ascending or descending. The
 * sequence does not select a batch.
 */
export const batchSortSequence = pgTable('batch_sort_sequence', {
  client: tenant(),
  sortSequence: varchar('sort_sequence', { length: 18 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  status: char('status', { length: 1 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.sortSequence] }),
  check('batch_sort_sequence_name_ck', sql`${t.sortSequence} ~ '^[A-Z0-9_]{1,18}$'`),
  check('batch_sort_sequence_status_ck', sql`${t.status} in ('0', '1', '2')`),
  check('batch_sort_sequence_version_ck', sql`${t.version} > 0`),
]);

/** Ordered criteria of one CU70 sort sequence. A characteristic stands once. */
export const batchSortSequenceCriterion = pgTable('batch_sort_sequence_criterion', {
  client: tenant(),
  sortSequence: varchar('sort_sequence', { length: 18 }).notNull(),
  position: integer('position').notNull(),
  characteristicName: varchar('characteristic_name', { length: 30 }).notNull(),
  direction: char('direction', { length: 1 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.sortSequence, t.position] }),
  uniqueIndex('batch_sort_sequence_criterion_uk').on(t.client, t.sortSequence, t.characteristicName),
  foreignKey({
    columns: [t.client, t.sortSequence],
    foreignColumns: [batchSortSequence.client, batchSortSequence.sortSequence],
  }).onDelete('cascade'),
  check('batch_sort_sequence_criterion_position_ck', sql`${t.position} > 0`),
  check('batch_sort_sequence_criterion_direction_ck', sql`${t.direction} in ('A', 'D')`),
  check('batch_sort_sequence_criterion_name_ck', sql`${t.characteristicName} ~ '^[A-Z0-9_]{1,30}$'`),
]);

/**
 * OMCT — a conversion check. It records what a level or status change
 * would collide with. It never changes the level, the status, or a batch.
 */
export const batchConversionCheck = pgTable('batch_conversion_check', {
  client: tenant(),
  checkId: varchar('check_id', { length: 36 }).notNull(),
  proposal: varchar('proposal', { length: 12 }).notNull(),
  sourceLevel: char('source_level', { length: 1 }).notNull(),
  targetLevel: char('target_level', { length: 1 }).notNull(),
  sourceStatus: char('source_status', { length: 1 }).notNull(),
  targetStatus: char('target_status', { length: 1 }).notNull(),
  result: varchar('result', { length: 16 }).notNull(),
  batchCount: integer('batch_count').notNull(),
  stockBatchCount: integer('stock_batch_count').notNull(),
  documentBatchCount: integer('document_batch_count').notNull(),
  conflictCount: integer('conflict_count').notNull(),
  summary: text('summary').notNull(),
  reason: varchar('reason', { length: 500 }).notNull(),
  startedBy: varchar('started_by', { length: 60 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.checkId] }),
  check('batch_conversion_check_proposal_ck', sql`${t.proposal} in ('LEVEL', 'STATUS', 'BOTH')`),
  check('batch_conversion_check_level_ck', sql`${t.sourceLevel} in ('0', '1', '2') and ${t.targetLevel} in ('0', '1', '2')`),
  check('batch_conversion_check_status_ck', sql`${t.sourceStatus} in ('1', ' ') and ${t.targetStatus} in ('1', ' ')`),
  check('batch_conversion_check_result_ck', sql`${t.result} in ('BLOCKED', 'NOT_REQUIRED')`),
]);

/** Conflicts named by one OMCT check. A collision is not merged. */
export const batchConversionConflict = pgTable('batch_conversion_conflict', {
  client: tenant(),
  checkId: varchar('check_id', { length: 36 }).notNull(),
  position: integer('position').notNull(),
  conflictCode: varchar('conflict_code', { length: 32 }).notNull(),
  objectKey: varchar('object_key', { length: 80 }).notNull(),
  detail: varchar('detail', { length: 240 }).notNull(),
  blocks: boolean('blocks').notNull(),
}, (t) => [
  primaryKey({ columns: [t.client, t.checkId, t.position] }),
  foreignKey({
    columns: [t.client, t.checkId],
    foreignColumns: [batchConversionCheck.client, batchConversionCheck.checkId],
  }).onDelete('cascade'),
  check('batch_conversion_conflict_position_ck', sql`${t.position} > 0`),
]);

/**
 * ODOC — TCUCD, one row per client. KZDCD is the only business field.
 * Domain CHAR1 has no value table. X is active. Blank is not active.
 * LCHGD, LCHGT, and LCHGU are the change stamp, stored in the audit columns.
 * This row does not store a document, a file, or a batch link.
 */
export const batchDocumentManagement = pgTable('batch_document_management', {
  client: tenant(),
  documentManagement: char('document_management', { length: 1 }).notNull(),
  version: integer('version').notNull().default(1),
  lastRequestKey: varchar('last_request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client] }),
  check('batch_document_management_code_ck', sql`${t.documentManagement} in ('X', ' ')`),
  check('batch_document_management_version_ck', sql`${t.version} > 0`),
]);
