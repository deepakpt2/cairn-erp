/** Material master — CAIRN.md §8.4/§9.1, SCR-048. Own domain keys and views. */
import { pgTable, varchar, text, boolean, integer, numeric, char, timestamp, primaryKey, foreignKey, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { unitOfMeasure } from '../../platform/tables/reference';
import { plant, purchasingGroup } from '../foundation/schema';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });
const quantity = (name: string) => numeric(name, { precision: 23, scale: 3 });
const money = (name: string) => numeric(name, { precision: 23, scale: 4 });

export const accountCategoryReference = pgTable('account_category_reference', {
  client: tenant(), reference: varchar('reference', { length: 4 }).notNull(),
  name: varchar('name', { length: 40 }).notNull(), ...auditColumns,
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
  /** Comma-separated allowed material type keys, not external identifiers. */
  allowedMaterialTypes: text('allowed_material_types').notNull(),
  isActive: boolean('is_active').notNull().default(true), ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.valuationClass] })]);

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
  accountingStatus: varchar('accounting_status', { length: 16 }).notNull().default('INCOMPLETE'),
  version: integer('version').notNull().default(1), ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber, t.valuationArea] }),
  foreignKey({ columns: [t.client, t.materialNumber], foreignColumns: [material.client, material.materialNumber] }).onDelete('cascade'),
  foreignKey({ columns: [t.client, t.valuationArea], foreignColumns: [plant.client, plant.plant] }),
  foreignKey({ columns: [t.client, t.valuationClass], foreignColumns: [valuationClass.client, valuationClass.valuationClass] }),
  check('material_valuation_codes_ck', sql`${t.priceControl} in ('STANDARD','MOVING_AVERAGE') and ${t.accountingStatus} in ('INCOMPLETE','CREATED','MAINTAINED')`),
  check('material_valuation_values_ck', sql`${t.standardPrice} >= 0 and ${t.movingAveragePrice} >= 0 and ${t.priceUnit} > 0 and ${t.totalStockQuantity} >= 0 and ${t.stockValue} >= 0`),
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
  /** What a withdrawal under this movement must be charged to — the T156 fact (SCR-133). */
  accountAssignment: varchar('account_assignment', { length: 16 }).notNull().default('NONE'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.movementType] }),
  /** A transfer is a movement serving both of its lines (SCR-131); a reservation's future issue is an ISSUE (SCR-133). */
  check('movement_type_direction_ck', sql`${t.direction} in ('RECEIPT', 'REVERSAL', 'TRANSFER', 'ISSUE')`),
  // SCR-146: the rules a movement carries now carry vocabulary of their own.
  check('movement_type_plant_rule_ck', sql`${t.plantRule} in ('SAME', 'DIFFERENT', 'ANY')`),
  check('movement_type_location_rule_ck', sql`${t.locationRule} in ('SAME', 'DIFFERENT', 'ANY')`),
  check('movement_type_negative_stock_ck', sql`${t.negativeStockPolicy} in ('LOCATION', 'FORBID')`),
  check('movement_type_reference_ck', sql`${t.referenceCategory} in ('PURCHASE_ORDER', 'MATERIAL_DOCUMENT', 'RESERVATION', 'PRODUCTION_ORDER')`),
  check('movement_type_account_assignment_ck', sql`${t.accountAssignment} in ('NONE', 'COST_CENTER', 'ORDER')`),
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
  quantity: quantity('quantity').notNull().default('0'),
  ...auditColumns,
}, (t) => [
  // No table-level non-negative guard: negative stock is permitted where the storage
  // location configures it, and a row check cannot read that configuration (SCR-131).
  primaryKey({ columns: [t.client, t.materialNumber, t.plant, t.storageLocation, t.stockType] }),
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
  /** SCR-147: the count's progress. POSTED belongs to MI07 and DIFFERENCES_REVIEWED to MI20. */
  check('physical_inventory_document_status_ck', sql`${t.status} in ('CREATED', 'PARTIALLY_COUNTED', 'COUNTED', 'DIFFERENCES_REVIEWED', 'POSTED', 'CANCELLED')`),
  index('physical_inventory_document_plant_idx').on(t.client, t.plant, t.plannedCountDate),
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
  check('physical_inventory_item_count_status_ck', sql`${t.countStatus} in ('UNCOUNTED', 'COUNTED', 'RECOUNT_REQUIRED')`),
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
