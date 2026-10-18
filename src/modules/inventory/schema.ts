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
