/** Material master — CAIRN.md §8.4/§9.1, SCR-048. Own domain keys and views. */
import { pgTable, varchar, text, boolean, integer, numeric, char, timestamp, primaryKey, foreignKey, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { unitOfMeasure } from '../../platform/tables/reference';
import { plant, purchasingGroup } from '../foundation/schema';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });
const quantity = (name: string) => numeric(name, { precision: 23, scale: 3 });
const money = (name: string) => numeric(name, { precision: 23, scale: 4 });

export const materialType = pgTable('material_type', {
  client: tenant(), materialType: varchar('material_type', { length: 12 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  defaultProcurementType: varchar('default_procurement_type', { length: 8 }).notNull(),
  defaultPriceControl: varchar('default_price_control', { length: 16 }).notNull(),
  isStocked: boolean('is_stocked').notNull().default(true),
  isValuated: boolean('is_valuated').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true), ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.materialType] })]);

export const materialGroup = pgTable('material_group', {
  client: tenant(), materialGroup: varchar('material_group', { length: 20 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(), isActive: boolean('is_active').notNull().default(true), ...auditColumns,
}, (t) => [primaryKey({ columns: [t.client, t.materialGroup] })]);

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
  description: varchar('description', { length: 200 }).notNull().default(''),
  materialType: varchar('material_type', { length: 12 }).notNull(),
  materialGroup: varchar('material_group', { length: 20 }),
  baseUnit: varchar('base_unit', { length: 6 }).references(() => unitOfMeasure.code),
  industrySector: varchar('industry_sector', { length: 20 }),
  barcode: varchar('barcode', { length: 32 }),
  grossWeight: quantity('gross_weight').notNull().default('0'),
  netWeight: quantity('net_weight').notNull().default('0'),
  weightUnit: varchar('weight_unit', { length: 6 }).references(() => unitOfMeasure.code),
  basicStatus: varchar('basic_status', { length: 16 }).notNull().default('INCOMPLETE'),
  isBlocked: boolean('is_blocked').notNull().default(false),
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
  purchasingGroup: varchar('purchasing_group', { length: 6 }),
  orderUnit: varchar('order_unit', { length: 6 }).references(() => unitOfMeasure.code),
  overdeliveryTolerance: numeric('overdelivery_tolerance', { precision: 5, scale: 2 }).notNull().default('0'),
  underdeliveryTolerance: numeric('underdelivery_tolerance', { precision: 5, scale: 2 }).notNull().default('0'),
  manufacturerPartNumber: varchar('manufacturer_part_number', { length: 80 }),
  purchasingStatus: varchar('purchasing_status', { length: 16 }).notNull().default('NOT_CREATED'),
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
