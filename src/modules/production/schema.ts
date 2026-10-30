/** Total planning — SCR-166 / MD01. A run is evidence. It is not stock and not a requisition. */
import { pgTable, varchar, integer, boolean, char, date, timestamp, numeric, smallint, primaryKey, foreignKey, unique, uniqueIndex, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { unitOfMeasure } from '../../platform/tables/reference';
import { factoryCalendar, plant, storageLocation, settlementProfile } from '../foundation/schema';
import { material, materialPlant, productionOrder } from '../inventory/schema';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });
const quantity = (name: string) => numeric(name, { precision: 23, scale: 3 }).notNull();

export const plannedOrder = pgTable('planned_order', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 12 }).notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  quantity: quantity('quantity'),
  unit: varchar('unit', { length: 6 }).notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  finishDate: date('finish_date', { mode: 'string' }).notNull(),
  firmingStatus: varchar('firming_status', { length: 8 }).notNull().default('OPEN'),
  origin: varchar('origin', { length: 8 }).notNull().default('MRP'),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber] }),
  unique('planned_order_request_uq').on(t.client, t.requestKey),
  foreignKey({ columns: [t.client, t.materialNumber], foreignColumns: [material.client, material.materialNumber] }),
  foreignKey({ columns: [t.client, t.plant], foreignColumns: [plant.client, plant.plant] }),
  check('planned_order_quantity_ck', sql`${t.quantity} > 0`),
  check('planned_order_dates_ck', sql`${t.finishDate} >= ${t.startDate}`),
  check('planned_order_firming_ck', sql`${t.firmingStatus} in ('OPEN', 'FIRMED')`),
  check('planned_order_origin_ck', sql`${t.origin} in ('MRP', 'MANUAL')`),
  index('planned_order_material_idx').on(t.client, t.materialNumber, t.plant),
]);

export const mrpRun = pgTable('mrp_run', {
  client: tenant(),
  runNumber: varchar('run_number', { length: 12 }).notNull(),
  processingKey: varchar('processing_key', { length: 8 }).notNull(),
  executionMode: varchar('execution_mode', { length: 16 }).notNull().default('FOREGROUND'),
  planningMode: varchar('planning_mode', { length: 24 }).notNull().default('ADAPT_EXISTING'),
  simulationOnly: boolean('simulation_only').notNull().default(false),
  plantFrom: varchar('plant_from', { length: 10 }).notNull(),
  plantTo: varchar('plant_to', { length: 10 }).notNull(),
  materialFrom: varchar('material_from', { length: 40 }),
  materialTo: varchar('material_to', { length: 40 }),
  mrpController: varchar('mrp_controller', { length: 3 }),
  horizonStart: date('horizon_start', { mode: 'string' }),
  horizonEnd: date('horizon_end', { mode: 'string' }),
  status: varchar('status', { length: 32 }).notNull().default('QUEUED'),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  requestedBy: varchar('requested_by', { length: 60 }).notNull(),
  materialsSelected: integer('materials_selected').notNull().default(0),
  materialsPlanned: integer('materials_planned').notNull().default(0),
  materialsSkipped: integer('materials_skipped').notNull().default(0),
  materialsFailed: integer('materials_failed').notNull().default(0),
  proposalsCreated: integer('proposals_created').notNull().default(0),
  proposalsChanged: integer('proposals_changed').notNull().default(0),
  proposalsRetained: integer('proposals_retained').notNull().default(0),
  entryPoint: varchar('entry_point', { length: 16 }).notNull().default('PLANT'),
  productionVersion: varchar('production_version', { length: 4 }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  errorSummary: varchar('error_summary', { length: 200 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.runNumber] }),
  unique('mrp_run_request_uq').on(t.client, t.requestKey),
  check('mrp_run_key_ck', sql`${t.processingKey} in ('NETCH', 'NETPL', 'NEUPL')`),
  check('mrp_run_status_ck', sql`${t.status} in ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLING', 'CANCELLED')`),
  index('mrp_run_status_idx').on(t.client, t.status, t.createdAt),
]);

/**
 * OMCWB — TCUWIPB, one row per client. WIPBATCH_ACTIVE is domain XFELD.
 * X is active. Blank is not active. Once X is saved it cannot be revoked.
 * This row is not a WIP batch and not a plant setting.
 */
export const wipBatchActivation = pgTable('wip_batch_activation', {
  client: tenant(),
  wipBatchActive: char('wip_batch_active', { length: 1 }).notNull(),
  version: integer('version').notNull().default(1),
  lastRequestKey: varchar('last_request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client] }),
  check('wip_batch_activation_code_ck', sql`${t.wipBatchActive} in ('X', ' ')`),
  check('wip_batch_activation_version_ck', sql`${t.version} > 0`),
]);

/**
 * CR01 category customizing. There is no delivered TC30 list.
 * A category is tenant data. It is not seeded as 0001.
 * The flags say which sections CR01 requires. They do not run scheduling or costing.
 */
export const workCenterCategory = pgTable('work_center_category', {
  client: tenant(),
  category: varchar('category', { length: 4 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  requireCapacity: boolean('require_capacity').notNull().default(false),
  requireScheduling: boolean('require_scheduling').notNull().default(false),
  requireCosting: boolean('require_costing').notNull().default(false),
  requireStandardValueKey: boolean('require_standard_value_key').notNull().default(false),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.category] }),
  check('work_center_category_key_ck', sql`${t.category} ~ '^[A-Z0-9]{1,4}$'`),
  check('work_center_category_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('work_center_category_version_ck', sql`${t.version} > 0`),
]);

/** CRHD-shaped header. The key is the plant and a work center of at most 8 characters. */
export const workCenter = pgTable('work_center', {
  client: tenant(),
  plant: varchar('plant', { length: 10 }).notNull(),
  workCenter: varchar('work_center', { length: 8 }).notNull(),
  category: varchar('category', { length: 4 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  personResponsible: varchar('person_responsible', { length: 3 }),
  location: varchar('location', { length: 10 }),
  usage: varchar('usage', { length: 3 }),
  standardValueKey: varchar('standard_value_key', { length: 4 }),
  controlKey: varchar('control_key', { length: 4 }),
  deletionFlag: char('deletion_flag', { length: 1 }).notNull().default(' '),
  schedulingCapacityCategory: varchar('scheduling_capacity_category', { length: 3 }),
  schedulingSetupFormula: varchar('scheduling_setup_formula', { length: 6 }),
  schedulingProcessingFormula: varchar('scheduling_processing_formula', { length: 6 }),
  schedulingTeardownFormula: varchar('scheduling_teardown_formula', { length: 6 }),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.plant, t.workCenter] }),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
  }),
  foreignKey({
    columns: [t.client, t.category],
    foreignColumns: [workCenterCategory.client, workCenterCategory.category],
  }),
  check('work_center_key_ck', sql`${t.workCenter} ~ '^[A-Z0-9-]{1,8}$'`),
  check('work_center_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('work_center_deletion_ck', sql`${t.deletionFlag} in ('X', ' ')`),
  check('work_center_version_ck', sql`${t.version} > 0`),
  index('work_center_category_idx').on(t.client, t.category),
]);

/** One capacity category once per work center. Available time is stored. It is not evaluated. */
export const workCenterCapacity = pgTable('work_center_capacity', {
  client: tenant(),
  plant: varchar('plant', { length: 10 }).notNull(),
  workCenter: varchar('work_center', { length: 8 }).notNull(),
  capacityCategory: varchar('capacity_category', { length: 3 }).notNull(),
  description: varchar('description', { length: 40 }),
  factoryCalendar: char('factory_calendar', { length: 2 }),
  baseUnit: varchar('base_unit', { length: 6 }),
  startTime: varchar('start_time', { length: 5 }),
  endTime: varchar('end_time', { length: 5 }),
  breakMinutes: integer('break_minutes').notNull().default(0),
  utilization: numeric('utilization', { precision: 5, scale: 2 }),
  individualCapacities: integer('individual_capacities'),
  finiteScheduling: char('finite_scheduling', { length: 1 }).notNull().default(' '),
  longTermPlanning: char('long_term_planning', { length: 1 }).notNull().default(' '),
  severalOperations: char('several_operations', { length: 1 }).notNull().default(' '),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.plant, t.workCenter, t.capacityCategory] }),
  foreignKey({
    columns: [t.client, t.plant, t.workCenter],
    foreignColumns: [workCenter.client, workCenter.plant, workCenter.workCenter],
    name: 'work_center_capacity_center_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.factoryCalendar],
    foreignColumns: [factoryCalendar.client, factoryCalendar.calendarId],
  }),
  foreignKey({
    columns: [t.baseUnit],
    foreignColumns: [unitOfMeasure.code],
  }),
  check('work_center_capacity_category_ck', sql`${t.capacityCategory} ~ '^[A-Z0-9]{1,3}$'`),
  check('work_center_capacity_break_ck', sql`${t.breakMinutes} >= 0`),
  check('work_center_capacity_flags_ck', sql`${t.finiteScheduling} in ('X', ' ') and ${t.longTermPlanning} in ('X', ' ') and ${t.severalOperations} in ('X', ' ')`),
]);

/** Validity-dated cost-center assignment. A formula key is stored and not calculated. */
export const workCenterCosting = pgTable('work_center_costing', {
  client: tenant(),
  plant: varchar('plant', { length: 10 }).notNull(),
  workCenter: varchar('work_center', { length: 8 }).notNull(),
  lineNumber: integer('line_number').notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  controllingArea: varchar('controlling_area', { length: 4 }).notNull(),
  costCenter: varchar('cost_center', { length: 10 }).notNull(),
  activityType: varchar('activity_type', { length: 6 }),
  formula: varchar('formula', { length: 6 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.plant, t.workCenter, t.lineNumber] }),
  foreignKey({
    columns: [t.client, t.plant, t.workCenter],
    foreignColumns: [workCenter.client, workCenter.plant, workCenter.workCenter],
    name: 'work_center_costing_center_fk',
  }).onDelete('cascade'),
  check('work_center_costing_line_ck', sql`${t.lineNumber} > 0`),
  check('work_center_costing_dates_ck', sql`${t.validTo} >= ${t.validFrom}`),
]);

/**
 * Material BOM customizing. Keys follow STLAN, STLST, and POSTP lengths.
 * No usage, status, or item category is delivered. Relevance and release
 * flags are stored. This schema does not explode a BOM or post a cost.
 */
export const bomUsage = pgTable('bom_usage', {
  client: tenant(),
  usage: char('usage', { length: 1 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  /** T416-PMPFE. + required, . optional, - not allowed. Stored, not executed. */
  productionRelevance: char('production_relevance', { length: 1 }).notNull().default('.'),
  engineeringRelevance: char('engineering_relevance', { length: 1 }).notNull().default('.'),
  costingRelevance: char('costing_relevance', { length: 1 }).notNull().default('.'),
  salesRelevance: char('sales_relevance', { length: 1 }).notNull().default('.'),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.usage] }),
  check('bom_usage_key_ck', sql`${t.usage} ~ '^[A-Z0-9]$'`),
  check('bom_usage_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('bom_usage_relevance_ck', sql`${t.productionRelevance} in ('+', '.', '-') and ${t.engineeringRelevance} in ('+', '.', '-') and ${t.costingRelevance} in ('+', '.', '-') and ${t.salesRelevance} in ('+', '.', '-')`),
  check('bom_usage_version_ck', sql`${t.version} > 0`),
]);

/** T415S shape. STLST is NUMC 2. Release flags are stored and not executed here. */
export const bomStatus = pgTable('bom_status', {
  client: tenant(),
  status: char('status', { length: 2 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  releasedForMrp: char('released_for_mrp', { length: 1 }).notNull().default(' '),
  releasedForCosting: char('released_for_costing', { length: 1 }).notNull().default(' '),
  releasedForOrders: char('released_for_orders', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.status] }),
  check('bom_status_key_ck', sql`${t.status} ~ '^[0-9]{2}$'`),
  check('bom_status_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('bom_status_release_ck', sql`${t.releasedForMrp} in ('X', ' ') and ${t.releasedForCosting} in ('X', ' ') and ${t.releasedForOrders} in ('X', ' ')`),
  check('bom_status_version_ck', sql`${t.version} > 0`),
]);

/** T418 shape. Entry rules are the SAP + / . / - customizing model. */
export const bomItemCategory = pgTable('bom_item_category', {
  client: tenant(),
  category: char('category', { length: 1 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  materialEntry: char('material_entry', { length: 1 }).notNull(),
  quantityEntry: char('quantity_entry', { length: 1 }).notNull(),
  allowFixedQuantity: char('allow_fixed_quantity', { length: 1 }).notNull().default(' '),
  allowBulk: char('allow_bulk', { length: 1 }).notNull().default(' '),
  allowPhantom: char('allow_phantom', { length: 1 }).notNull().default(' '),
  allowCoproduct: char('allow_coproduct', { length: 1 }).notNull().default(' '),
  allowFollowUp: char('allow_follow_up', { length: 1 }).notNull().default(' '),
  allowSpecialProcurement: char('allow_special_procurement', { length: 1 }).notNull().default(' '),
  allowNegativeQuantity: char('allow_negative_quantity', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.category] }),
  check('bom_item_category_key_ck', sql`${t.category} ~ '^[A-Z0-9]$'`),
  check('bom_item_category_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('bom_item_category_entry_ck', sql`${t.materialEntry} in ('+', '.', '-') and ${t.quantityEntry} in ('+', '.', '-')`),
  check('bom_item_category_flags_ck', sql`${t.allowFixedQuantity} in ('X', ' ') and ${t.allowBulk} in ('X', ' ') and ${t.allowPhantom} in ('X', ' ') and ${t.allowCoproduct} in ('X', ' ') and ${t.allowFollowUp} in ('X', ' ') and ${t.allowSpecialProcurement} in ('X', ' ') and ${t.allowNegativeQuantity} in ('X', ' ')`),
  check('bom_item_category_version_ck', sql`${t.version} > 0`),
]);

/**
 * Plant-specific material BOM. MAST plus the current STKO, not a second SAP-named table.
 * The business key is material, plant, usage, and alternative. Alternatives of that
 * key share one internal BOM number. Valid-to is stored because engineering change
 * management is absent and DATUB is derived there, not a column on STKO.
 */
export const materialBom = pgTable('material_bom', {
  client: tenant(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  usage: char('usage', { length: 1 }).notNull(),
  alternative: varchar('alternative', { length: 2 }).notNull(),
  bomNumber: char('bom_number', { length: 8 }).notNull(),
  status: char('status', { length: 2 }),
  baseQuantity: quantity('base_quantity'),
  baseUnit: varchar('base_unit', { length: 6 }).notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  headerText: varchar('header_text', { length: 40 }),
  deletionFlag: char('deletion_flag', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber, t.plant, t.usage, t.alternative] }),
  uniqueIndex('material_bom_number_alt_uq').on(t.client, t.bomNumber, t.alternative),
  uniqueIndex('material_bom_request_uq').on(t.client, t.requestKey).where(sql`${t.requestKey} is not null`),
  foreignKey({
    columns: [t.client, t.materialNumber, t.plant],
    foreignColumns: [materialPlant.client, materialPlant.materialNumber, materialPlant.plant],
    name: 'material_bom_material_plant_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.usage],
    foreignColumns: [bomUsage.client, bomUsage.usage],
    name: 'material_bom_usage_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.status],
    foreignColumns: [bomStatus.client, bomStatus.status],
    name: 'material_bom_status_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.baseUnit],
    foreignColumns: [unitOfMeasure.code],
  }),
  check('material_bom_alternative_ck', sql`${t.alternative} ~ '^[A-Z0-9]{1,2}$'`),
  check('material_bom_number_ck', sql`${t.bomNumber} ~ '^[0-9]{8}$'`),
  check('material_bom_quantity_ck', sql`${t.baseQuantity} > 0`),
  check('material_bom_dates_ck', sql`${t.validTo} >= ${t.validFrom}`),
  check('material_bom_text_ck', sql`${t.headerText} is null or char_length(btrim(${t.headerText})) between 1 and 40`),
  check('material_bom_deletion_ck', sql`${t.deletionFlag} in ('X', ' ')`),
  check('material_bom_version_ck', sql`${t.version} > 0`),
  index('material_bom_selection_idx').on(t.client, t.materialNumber, t.plant, t.usage),
]);

/** STPO shape for one current BOM. Item number is the line identity. Rows are not physically deleted. */
export const materialBomItem = pgTable('material_bom_item', {
  client: tenant(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  usage: char('usage', { length: 1 }).notNull(),
  alternative: varchar('alternative', { length: 2 }).notNull(),
  itemNumber: varchar('item_number', { length: 4 }).notNull(),
  itemCategory: char('item_category', { length: 1 }).notNull(),
  componentMaterial: varchar('component_material', { length: 40 }),
  quantity: numeric('quantity', { precision: 23, scale: 3 }),
  unit: varchar('unit', { length: 6 }),
  scrapPercent: numeric('scrap_percent', { precision: 5, scale: 2 }),
  sortString: varchar('sort_string', { length: 10 }),
  itemText: varchar('item_text', { length: 40 }),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  fixedQuantity: char('fixed_quantity', { length: 1 }).notNull().default(' '),
  bulkMaterial: char('bulk_material', { length: 1 }).notNull().default(' '),
  phantom: char('phantom', { length: 1 }).notNull().default(' '),
  coproduct: char('coproduct', { length: 1 }).notNull().default(' '),
  followUpMaterial: varchar('follow_up_material', { length: 40 }),
  specialProcurement: varchar('special_procurement', { length: 2 }),
  issuingPlant: varchar('issuing_plant', { length: 10 }),
  deletionFlag: char('deletion_flag', { length: 1 }).notNull().default(' '),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber, t.plant, t.usage, t.alternative, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.materialNumber, t.plant, t.usage, t.alternative],
    foreignColumns: [materialBom.client, materialBom.materialNumber, materialBom.plant, materialBom.usage, materialBom.alternative],
    name: 'material_bom_item_header_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.itemCategory],
    foreignColumns: [bomItemCategory.client, bomItemCategory.category],
    name: 'material_bom_item_category_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.componentMaterial],
    foreignColumns: [material.client, material.materialNumber],
    name: 'material_bom_item_component_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.followUpMaterial],
    foreignColumns: [material.client, material.materialNumber],
    name: 'material_bom_item_follow_up_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.unit],
    foreignColumns: [unitOfMeasure.code],
  }),
  foreignKey({
    columns: [t.client, t.issuingPlant],
    foreignColumns: [plant.client, plant.plant],
    name: 'material_bom_item_issuing_plant_fk',
  }).onDelete('restrict'),
  check('material_bom_item_number_ck', sql`${t.itemNumber} ~ '^[A-Z0-9]{4}$'`),
  check('material_bom_item_dates_ck', sql`${t.validTo} >= ${t.validFrom}`),
  check('material_bom_item_quantity_ck', sql`${t.quantity} is null or ${t.quantity} <> 0`),
  check('material_bom_item_unit_ck', sql`${t.quantity} is null or ${t.unit} is not null`),
  check('material_bom_item_scrap_ck', sql`${t.scrapPercent} is null or (${t.scrapPercent} >= 0 and ${t.scrapPercent} <= 999.99)`),
  check('material_bom_item_text_ck', sql`${t.itemText} is null or char_length(btrim(${t.itemText})) between 1 and 40`),
  check('material_bom_item_flags_ck', sql`${t.fixedQuantity} in ('X', ' ') and ${t.bulkMaterial} in ('X', ' ') and ${t.phantom} in ('X', ' ') and ${t.coproduct} in ('X', ' ') and ${t.deletionFlag} in ('X', ' ')`),
  index('material_bom_item_component_idx').on(t.client, t.componentMaterial),
]);

/**
 * Standard routing customizing. Lengths follow PLNTY, PLN_VERWE, PLNST, STEUS.
 * No type, usage, status, control key, or standard value key is delivered.
 * Flags are stored. This schema does not schedule, cost, or confirm.
 */
export const routingTaskListType = pgTable('routing_task_list_type', {
  client: tenant(),
  taskListType: char('task_list_type', { length: 1 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  requireControlKey: char('require_control_key', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.taskListType] }),
  check('routing_task_list_type_key_ck', sql`${t.taskListType} ~ '^[A-Z0-9]$'`),
  check('routing_task_list_type_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('routing_task_list_type_control_ck', sql`${t.requireControlKey} in ('X', ' ')`),
  check('routing_task_list_type_version_ck', sql`${t.version} > 0`),
]);

export const routingUsage = pgTable('routing_usage', {
  client: tenant(),
  usage: varchar('usage', { length: 3 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.usage] }),
  check('routing_usage_key_ck', sql`${t.usage} ~ '^[A-Z0-9]{1,3}$'`),
  check('routing_usage_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('routing_usage_version_ck', sql`${t.version} > 0`),
]);

export const routingStatus = pgTable('routing_status', {
  client: tenant(),
  status: varchar('status', { length: 3 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  releasedForScheduling: char('released_for_scheduling', { length: 1 }).notNull().default(' '),
  releasedForCosting: char('released_for_costing', { length: 1 }).notNull().default(' '),
  releasedForOrders: char('released_for_orders', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.status] }),
  check('routing_status_key_ck', sql`${t.status} ~ '^[A-Z0-9]{1,3}$'`),
  check('routing_status_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('routing_status_release_ck', sql`${t.releasedForScheduling} in ('X', ' ') and ${t.releasedForCosting} in ('X', ' ') and ${t.releasedForOrders} in ('X', ' ')`),
  check('routing_status_version_ck', sql`${t.version} > 0`),
]);

export const routingControlKey = pgTable('routing_control_key', {
  client: tenant(),
  controlKey: varchar('control_key', { length: 4 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  scheduling: char('scheduling', { length: 1 }).notNull().default(' '),
  costing: char('costing', { length: 1 }).notNull().default(' '),
  confirmation: char('confirmation', { length: 1 }).notNull().default(' '),
  externalProcessing: char('external_processing', { length: 1 }).notNull().default(' '),
  requireWorkCenter: char('require_work_center', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.controlKey] }),
  check('routing_control_key_key_ck', sql`${t.controlKey} ~ '^[A-Z0-9]{1,4}$'`),
  check('routing_control_key_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('routing_control_key_flags_ck', sql`${t.scheduling} in ('X', ' ') and ${t.costing} in ('X', ' ') and ${t.confirmation} in ('X', ' ') and ${t.externalProcessing} in ('X', ' ') and ${t.requireWorkCenter} in ('X', ' ')`),
  check('routing_control_key_version_ck', sql`${t.version} > 0`),
]);

export const routingStandardValueKey = pgTable('routing_standard_value_key', {
  client: tenant(),
  standardValueKey: varchar('standard_value_key', { length: 4 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.standardValueKey] }),
  check('routing_standard_value_key_key_ck', sql`${t.standardValueKey} ~ '^[A-Z0-9]{1,4}$'`),
  check('routing_standard_value_key_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('routing_standard_value_key_version_ck', sql`${t.version} > 0`),
]);

export const routingStandardValueParameter = pgTable('routing_standard_value_parameter', {
  client: tenant(),
  standardValueKey: varchar('standard_value_key', { length: 4 }).notNull(),
  parameter: varchar('parameter', { length: 6 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  unit: varchar('unit', { length: 6 }),
  required: char('required', { length: 1 }).notNull().default(' '),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.standardValueKey, t.parameter] }),
  foreignKey({
    columns: [t.client, t.standardValueKey],
    foreignColumns: [routingStandardValueKey.client, routingStandardValueKey.standardValueKey],
    name: 'routing_standard_value_parameter_key_fk',
  }).onDelete('cascade'),
  foreignKey({ columns: [t.unit], foreignColumns: [unitOfMeasure.code] }),
  check('routing_standard_value_parameter_key_ck', sql`${t.parameter} ~ '^[A-Z0-9]{1,6}$'`),
  check('routing_standard_value_parameter_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('routing_standard_value_parameter_required_ck', sql`${t.required} in ('X', ' ')`),
]);

/**
 * Plant-specific standard routing. PLKO identity is task list type, group, and counter.
 * Material assignment is separate, so one routing can be named by more than one material.
 * Valid-to is stored because engineering change management is absent.
 * Only sequence 000000 of type 0 is stored. Alternative and parallel sequences are refused.
 * Execution order is a separate column on the operation. It is not another sequence.
 */
export const routing = pgTable('routing', {
  client: tenant(),
  taskListType: char('task_list_type', { length: 1 }).notNull(),
  routingGroup: varchar('routing_group', { length: 8 }).notNull(),
  groupCounter: varchar('group_counter', { length: 2 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  description: varchar('description', { length: 40 }),
  usage: varchar('usage', { length: 3 }).notNull(),
  status: varchar('status', { length: 3 }),
  baseQuantity: quantity('base_quantity'),
  baseUnit: varchar('base_unit', { length: 6 }).notNull(),
  lotFrom: numeric('lot_from', { precision: 23, scale: 3 }),
  lotTo: numeric('lot_to', { precision: 23, scale: 3 }),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  deletionFlag: char('deletion_flag', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter] }),
  uniqueIndex('routing_request_uq').on(t.client, t.requestKey).where(sql`${t.requestKey} is not null`),
  foreignKey({
    columns: [t.client, t.taskListType],
    foreignColumns: [routingTaskListType.client, routingTaskListType.taskListType],
    name: 'routing_type_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
    name: 'routing_plant_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.usage],
    foreignColumns: [routingUsage.client, routingUsage.usage],
    name: 'routing_usage_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.status],
    foreignColumns: [routingStatus.client, routingStatus.status],
    name: 'routing_status_fk',
  }).onDelete('restrict'),
  foreignKey({ columns: [t.baseUnit], foreignColumns: [unitOfMeasure.code] }),
  check('routing_group_ck', sql`${t.routingGroup} ~ '^[A-Z0-9]{1,8}$'`),
  check('routing_counter_ck', sql`${t.groupCounter} ~ '^[A-Z0-9]{1,2}$'`),
  check('routing_quantity_ck', sql`${t.baseQuantity} > 0`),
  check('routing_lot_ck', sql`(${t.lotFrom} is null and ${t.lotTo} is null) or (${t.lotFrom} >= 0 and ${t.lotTo} >= ${t.lotFrom})`),
  check('routing_dates_ck', sql`${t.validTo} >= ${t.validFrom}`),
  check('routing_text_ck', sql`${t.description} is null or char_length(btrim(${t.description})) between 1 and 40`),
  check('routing_deletion_ck', sql`${t.deletionFlag} in ('X', ' ')`),
  check('routing_version_ck', sql`${t.version} > 0`),
  index('routing_plant_idx').on(t.client, t.plant, t.usage),
]);

export const routingSequence = pgTable('routing_sequence', {
  client: tenant(),
  taskListType: char('task_list_type', { length: 1 }).notNull(),
  routingGroup: varchar('routing_group', { length: 8 }).notNull(),
  groupCounter: varchar('group_counter', { length: 2 }).notNull(),
  sequence: char('sequence', { length: 6 }).notNull().default('000000'),
  sequenceType: char('sequence_type', { length: 1 }).notNull().default('0'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter, t.sequence] }),
  foreignKey({
    columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter],
    foreignColumns: [routing.client, routing.taskListType, routing.routingGroup, routing.groupCounter],
    name: 'routing_sequence_header_fk',
  }).onDelete('cascade'),
  check('routing_sequence_standard_ck', sql`${t.sequence} = '000000' and ${t.sequenceType} = '0'`),
]);

export const routingMaterialAssignment = pgTable('routing_material_assignment', {
  client: tenant(),
  taskListType: char('task_list_type', { length: 1 }).notNull(),
  routingGroup: varchar('routing_group', { length: 8 }).notNull(),
  groupCounter: varchar('group_counter', { length: 2 }).notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  deletionFlag: char('deletion_flag', { length: 1 }).notNull().default(' '),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter, t.materialNumber, t.plant] }),
  foreignKey({
    columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter],
    foreignColumns: [routing.client, routing.taskListType, routing.routingGroup, routing.groupCounter],
    name: 'routing_assignment_header_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.materialNumber, t.plant],
    foreignColumns: [materialPlant.client, materialPlant.materialNumber, materialPlant.plant],
    name: 'routing_assignment_material_fk',
  }).onDelete('restrict'),
  check('routing_assignment_dates_ck', sql`${t.validTo} >= ${t.validFrom}`),
  check('routing_assignment_deletion_ck', sql`${t.deletionFlag} in ('X', ' ')`),
  index('routing_assignment_material_idx').on(t.client, t.materialNumber, t.plant),
]);

export const routingOperation = pgTable('routing_operation', {
  client: tenant(),
  taskListType: char('task_list_type', { length: 1 }).notNull(),
  routingGroup: varchar('routing_group', { length: 8 }).notNull(),
  groupCounter: varchar('group_counter', { length: 2 }).notNull(),
  operationNumber: varchar('operation_number', { length: 4 }).notNull(),
  sequence: char('sequence', { length: 6 }).notNull().default('000000'),
  /** Display and copy order of the single standard sequence. Not the operation number. */
  executionOrder: integer('execution_order').notNull(),
  shortText: varchar('short_text', { length: 40 }),
  plant: varchar('plant', { length: 10 }).notNull(),
  workCenter: varchar('work_center', { length: 8 }),
  controlKey: varchar('control_key', { length: 4 }),
  standardValueKey: varchar('standard_value_key', { length: 4 }),
  standardTextKey: varchar('standard_text_key', { length: 7 }),
  operationQuantity: numeric('operation_quantity', { precision: 23, scale: 3 }),
  operationUnit: varchar('operation_unit', { length: 6 }),
  baseQuantity: numeric('base_quantity', { precision: 23, scale: 3 }),
  baseUnit: varchar('base_unit', { length: 6 }),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  deletionFlag: char('deletion_flag', { length: 1 }).notNull().default(' '),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter, t.operationNumber] }),
  foreignKey({
    columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter, t.sequence],
    foreignColumns: [routingSequence.client, routingSequence.taskListType, routingSequence.routingGroup, routingSequence.groupCounter, routingSequence.sequence],
    name: 'routing_operation_sequence_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.plant, t.workCenter],
    foreignColumns: [workCenter.client, workCenter.plant, workCenter.workCenter],
    name: 'routing_operation_work_center_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.controlKey],
    foreignColumns: [routingControlKey.client, routingControlKey.controlKey],
    name: 'routing_operation_control_key_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.standardValueKey],
    foreignColumns: [routingStandardValueKey.client, routingStandardValueKey.standardValueKey],
    name: 'routing_operation_value_key_fk',
  }).onDelete('restrict'),
  foreignKey({ columns: [t.operationUnit], foreignColumns: [unitOfMeasure.code] }),
  foreignKey({ columns: [t.baseUnit], foreignColumns: [unitOfMeasure.code] }),
  check('routing_operation_number_ck', sql`${t.operationNumber} ~ '^[A-Z0-9]{4}$'`),
  check('routing_operation_sequence_ck', sql`${t.sequence} = '000000'`),
  check('routing_operation_execution_order_ck', sql`${t.executionOrder} > 0`),
  uniqueIndex('routing_operation_execution_order_uq').on(t.client, t.taskListType, t.routingGroup, t.groupCounter, t.sequence, t.executionOrder),
  check('routing_operation_text_ck', sql`${t.shortText} is null or char_length(btrim(${t.shortText})) between 1 and 40`),
  check('routing_operation_text_key_ck', sql`${t.standardTextKey} is null or ${t.standardTextKey} ~ '^[A-Z0-9]{1,7}$'`),
  check('routing_operation_quantity_ck', sql`${t.operationQuantity} is null or ${t.operationQuantity} > 0`),
  check('routing_operation_base_ck', sql`${t.baseQuantity} is null or ${t.baseQuantity} > 0`),
  check('routing_operation_dates_ck', sql`${t.validTo} >= ${t.validFrom}`),
  check('routing_operation_deletion_ck', sql`${t.deletionFlag} in ('X', ' ')`),
  index('routing_operation_work_center_idx').on(t.client, t.plant, t.workCenter),
]);

export const routingOperationValue = pgTable('routing_operation_value', {
  client: tenant(),
  taskListType: char('task_list_type', { length: 1 }).notNull(),
  routingGroup: varchar('routing_group', { length: 8 }).notNull(),
  groupCounter: varchar('group_counter', { length: 2 }).notNull(),
  operationNumber: varchar('operation_number', { length: 4 }).notNull(),
  standardValueKey: varchar('standard_value_key', { length: 4 }).notNull(),
  parameter: varchar('parameter', { length: 6 }).notNull(),
  quantity: numeric('quantity', { precision: 23, scale: 3 }).notNull(),
  unit: varchar('unit', { length: 6 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter, t.operationNumber, t.parameter] }),
  foreignKey({
    columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter, t.operationNumber],
    foreignColumns: [routingOperation.client, routingOperation.taskListType, routingOperation.routingGroup, routingOperation.groupCounter, routingOperation.operationNumber],
    name: 'routing_operation_value_operation_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.standardValueKey, t.parameter],
    foreignColumns: [routingStandardValueParameter.client, routingStandardValueParameter.standardValueKey, routingStandardValueParameter.parameter],
    name: 'routing_operation_value_parameter_fk',
  }).onDelete('restrict'),
  foreignKey({ columns: [t.unit], foreignColumns: [unitOfMeasure.code] }),
  check('routing_operation_value_quantity_ck', sql`${t.quantity} > 0`),
]);

export const routingComponentAllocation = pgTable('routing_component_allocation', {
  client: tenant(),
  taskListType: char('task_list_type', { length: 1 }).notNull(),
  routingGroup: varchar('routing_group', { length: 8 }).notNull(),
  groupCounter: varchar('group_counter', { length: 2 }).notNull(),
  operationNumber: varchar('operation_number', { length: 4 }).notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  bomUsage: char('bom_usage', { length: 1 }).notNull(),
  alternative: varchar('alternative', { length: 2 }).notNull(),
  itemNumber: varchar('item_number', { length: 4 }).notNull(),
  allocatedQuantity: numeric('allocated_quantity', { precision: 23, scale: 3 }),
  deletionFlag: char('deletion_flag', { length: 1 }).notNull().default(' '),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter, t.operationNumber, t.materialNumber, t.plant, t.bomUsage, t.alternative, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter, t.operationNumber],
    foreignColumns: [routingOperation.client, routingOperation.taskListType, routingOperation.routingGroup, routingOperation.groupCounter, routingOperation.operationNumber],
    name: 'routing_allocation_operation_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.materialNumber, t.plant, t.bomUsage, t.alternative, t.itemNumber],
    foreignColumns: [materialBomItem.client, materialBomItem.materialNumber, materialBomItem.plant, materialBomItem.usage, materialBomItem.alternative, materialBomItem.itemNumber],
    name: 'routing_allocation_bom_item_fk',
  }).onDelete('restrict'),
  check('routing_allocation_quantity_ck', sql`${t.allocatedQuantity} is null or ${t.allocatedQuantity} > 0`),
  check('routing_allocation_deletion_ck', sql`${t.deletionFlag} in ('X', ' ')`),
]);

/**
 * C223 selection rule. A missing row means overlapping date and lot ranges are allowed.
 * Selection then refuses to pick the first match. This is not a delivered sample.
 */
export const productionVersionRule = pgTable('production_version_rule', {
  client: tenant(),
  refuseOverlap: char('refuse_overlap', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client] }),
  check('production_version_rule_overlap_ck', sql`${t.refuseOverlap} in ('X', ' ')`),
  check('production_version_rule_version_ck', sql`${t.version} > 0`),
]);

/**
 * Production version. MKAL identity is material, plant, and version.
 * It points at one material BOM alternative and one standard routing.
 * It does not copy either master. Engineering change management is absent.
 * Repetitive manufacturing, rate routing, and product costing are not stored.
 */
export const productionVersion = pgTable('production_version', {
  client: tenant(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  productionVersion: varchar('production_version', { length: 4 }).notNull(),
  description: varchar('description', { length: 40 }),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  lotFrom: numeric('lot_from', { precision: 23, scale: 3 }).notNull(),
  lotTo: numeric('lot_to', { precision: 23, scale: 3 }).notNull(),
  lotUnit: varchar('lot_unit', { length: 6 }).notNull(),
  bomUsage: char('bom_usage', { length: 1 }).notNull(),
  bomAlternative: varchar('bom_alternative', { length: 2 }).notNull(),
  taskListType: char('task_list_type', { length: 1 }).notNull(),
  routingGroup: varchar('routing_group', { length: 8 }).notNull(),
  groupCounter: varchar('group_counter', { length: 2 }).notNull(),
  receivingStorageLocation: varchar('receiving_storage_location', { length: 10 }),
  lockIndicator: char('lock_indicator', { length: 1 }).notNull().default(' '),
  deletionFlag: char('deletion_flag', { length: 1 }).notNull().default(' '),
  checkStatus: char('check_status', { length: 1 }).notNull().default(' '),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  checkedBy: varchar('checked_by', { length: 60 }),
  checkedBomVersion: integer('checked_bom_version'),
  checkedRoutingVersion: integer('checked_routing_version'),
  checkedPlantVersion: integer('checked_plant_version'),
  version: integer('version').notNull().default(1),
  requestKey: varchar('request_key', { length: 64 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber, t.plant, t.productionVersion] }),
  uniqueIndex('production_version_request_uq').on(t.client, t.requestKey).where(sql`${t.requestKey} is not null`),
  foreignKey({
    columns: [t.client, t.materialNumber, t.plant],
    foreignColumns: [materialPlant.client, materialPlant.materialNumber, materialPlant.plant],
    name: 'production_version_material_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.materialNumber, t.plant, t.bomUsage, t.bomAlternative],
    foreignColumns: [materialBom.client, materialBom.materialNumber, materialBom.plant, materialBom.usage, materialBom.alternative],
    name: 'production_version_bom_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.taskListType, t.routingGroup, t.groupCounter],
    foreignColumns: [routing.client, routing.taskListType, routing.routingGroup, routing.groupCounter],
    name: 'production_version_routing_fk',
  }).onDelete('restrict'),
  foreignKey({ columns: [t.lotUnit], foreignColumns: [unitOfMeasure.code] }),
  foreignKey({
    columns: [t.client, t.plant, t.receivingStorageLocation],
    foreignColumns: [storageLocation.client, storageLocation.plant, storageLocation.storageLocation],
    name: 'production_version_storage_fk',
  }).onDelete('restrict'),
  check('production_version_key_ck', sql`${t.productionVersion} ~ '^[A-Z0-9]{1,4}$'`),
  check('production_version_text_ck', sql`${t.description} is null or char_length(btrim(${t.description})) between 1 and 40`),
  check('production_version_dates_ck', sql`${t.validTo} >= ${t.validFrom}`),
  check('production_version_lot_ck', sql`${t.lotFrom} >= 0 and ${t.lotTo} >= ${t.lotFrom}`),
  check('production_version_lock_ck', sql`${t.lockIndicator} in (' ', '1')`),
  check('production_version_deletion_ck', sql`${t.deletionFlag} in ('X', ' ')`),
  check('production_version_check_ck', sql`${t.checkStatus} in (' ', '1', '2', '3')`),
  check('production_version_version_ck', sql`${t.version} > 0`),
  index('production_version_lookup_idx').on(t.client, t.plant, t.materialNumber, t.validFrom, t.validTo),
]);

export const productionVersionFinding = pgTable('production_version_finding', {
  client: tenant(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  productionVersion: varchar('production_version', { length: 4 }).notNull(),
  code: varchar('code', { length: 40 }).notNull(),
  severity: char('severity', { length: 1 }).notNull(),
  message: varchar('message', { length: 200 }).notNull(),
  fieldName: varchar('field_name', { length: 40 }),
  referencedObject: varchar('referenced_object', { length: 80 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.materialNumber, t.plant, t.productionVersion, t.code] }),
  foreignKey({
    columns: [t.client, t.materialNumber, t.plant, t.productionVersion],
    foreignColumns: [productionVersion.client, productionVersion.materialNumber, productionVersion.plant, productionVersion.productionVersion],
    name: 'production_version_finding_header_fk',
  }).onDelete('cascade'),
  check('production_version_finding_severity_ck', sql`${t.severity} in ('E', 'W')`),
  check('production_version_finding_message_ck', sql`char_length(btrim(${t.message})) between 1 and 200`),
]);

/**
 * Dependent requirement of a planned order. This is demand, not stock and not a reservation.
 * A check does not write a row. A later run adapts the quantity. It is not physically deleted.
 */
export const mrpDependentRequirement = pgTable('mrp_dependent_requirement', {
  client: tenant(),
  parentOrderNumber: varchar('parent_order_number', { length: 12 }).notNull(),
  sourceMaterial: varchar('source_material', { length: 40 }).notNull(),
  itemNumber: varchar('item_number', { length: 4 }).notNull(),
  materialNumber: varchar('material_number', { length: 40 }).notNull(),
  plant: varchar('plant', { length: 10 }).notNull(),
  quantity: quantity('quantity'),
  unit: varchar('unit', { length: 6 }).notNull(),
  requirementDate: date('requirement_date', { mode: 'string' }).notNull(),
  parentMaterial: varchar('parent_material', { length: 40 }).notNull(),
  productionVersion: varchar('production_version', { length: 4 }),
  bomUsage: char('bom_usage', { length: 1 }),
  bomAlternative: varchar('bom_alternative', { length: 2 }),
  status: varchar('status', { length: 8 }).notNull().default('OPEN'),
  runNumber: varchar('run_number', { length: 12 }),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.parentOrderNumber, t.sourceMaterial, t.itemNumber] }),
  foreignKey({
    columns: [t.client, t.parentOrderNumber],
    foreignColumns: [plannedOrder.client, plannedOrder.orderNumber],
    name: 'mrp_dependent_requirement_order_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.materialNumber],
    foreignColumns: [material.client, material.materialNumber],
    name: 'mrp_dependent_requirement_material_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
    name: 'mrp_dependent_requirement_plant_fk',
  }).onDelete('restrict'),
  check('mrp_dependent_requirement_qty_ck', sql`${t.quantity} > 0`),
  check('mrp_dependent_requirement_status_ck', sql`${t.status} in ('OPEN', 'CLOSED')`),
  check('mrp_dependent_requirement_version_ck', sql`${t.version} > 0`),
  index('mrp_dependent_requirement_demand_idx').on(t.client, t.materialNumber, t.plant, t.status),
]);

/**
 * CO11N. A posted time ticket. The production order is not given an operation
 * row: the routing operation is named here, as it stood when the ticket was entered.
 * Cancellation is not an update of this row.
 */
export const productionConfirmation = pgTable('production_confirmation', {
  client: tenant(),
  confirmationNumber: varchar('confirmation_number', { length: 12 }).notNull(),
  orderNumber: varchar('order_number', { length: 12 }).notNull(),
  operationNumber: varchar('operation_number', { length: 4 }),
  sequence: char('sequence', { length: 6 }).notNull().default('000000'),
  taskListType: char('task_list_type', { length: 1 }).notNull(),
  routingGroup: varchar('routing_group', { length: 8 }).notNull(),
  groupCounter: varchar('group_counter', { length: 2 }).notNull(),
  productionVersion: varchar('production_version', { length: 4 }).notNull(),
  workCenter: varchar('work_center', { length: 8 }),
  workCenterPlant: varchar('work_center_plant', { length: 10 }),
  controlKey: varchar('control_key', { length: 4 }),
  shortText: varchar('short_text', { length: 40 }),
  confirmationType: varchar('confirmation_type', { length: 8 }).notNull(),
  confirmationLevel: varchar('confirmation_level', { length: 12 }).notNull().default('OPERATION'),
  yieldQuantity: quantity('yield_quantity'),
  scrapQuantity: quantity('scrap_quantity'),
  reworkQuantity: quantity('rework_quantity'),
  unit: varchar('unit', { length: 10 }).notNull(),
  postingDate: date('posting_date', { mode: 'string' }).notNull(),
  executionStart: timestamp('execution_start', { mode: 'string' }),
  executionFinish: timestamp('execution_finish', { mode: 'string' }),
  note: varchar('note', { length: 200 }),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  orderVersion: integer('order_version').notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.confirmationNumber] }),
  uniqueIndex('production_confirmation_request_uq').on(t.client, t.requestKey),
  foreignKey({
    columns: [t.client, t.orderNumber],
    foreignColumns: [productionOrder.client, productionOrder.orderNumber],
    name: 'production_confirmation_order_fk',
  }).onDelete('restrict'),
  check('production_confirmation_type_ck', sql`${t.confirmationType} in ('PARTIAL', 'FINAL')`),
  check('production_confirmation_level_ck', sql`${t.confirmationLevel} in ('OPERATION', 'HEADER')`),
  check('production_confirmation_level_shape_ck', sql`(
    (${t.confirmationLevel} = 'OPERATION' and ${t.operationNumber} is not null and ${t.controlKey} is not null and ${t.workCenterPlant} is not null)
    or (${t.confirmationLevel} = 'HEADER' and ${t.operationNumber} is null)
  )`),
  check('production_confirmation_sequence_ck', sql`${t.sequence} = '000000'`),
  check('production_confirmation_quantity_ck', sql`${t.yieldQuantity} >= 0 and ${t.scrapQuantity} >= 0 and ${t.reworkQuantity} >= 0`),
  check('production_confirmation_version_ck', sql`${t.orderVersion} > 0`),
  index('production_confirmation_order_idx').on(t.client, t.orderNumber, t.operationNumber),
]);

export const productionConfirmationActivity = pgTable('production_confirmation_activity', {
  client: tenant(),
  confirmationNumber: varchar('confirmation_number', { length: 12 }).notNull(),
  parameter: varchar('parameter', { length: 6 }).notNull(),
  quantity: quantity('quantity'),
  unit: varchar('unit', { length: 6 }).notNull(),
  suggestedQuantity: numeric('suggested_quantity', { precision: 23, scale: 3 }),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.confirmationNumber, t.parameter] }),
  foreignKey({
    columns: [t.client, t.confirmationNumber],
    foreignColumns: [productionConfirmation.client, productionConfirmation.confirmationNumber],
    name: 'production_confirmation_activity_fk',
  }).onDelete('cascade'),
  check('production_confirmation_activity_qty_ck', sql`${t.quantity} >= 0`),
]);

/**
 * CO15. The effect of one header confirmation on one operation.
 * This is not a second confirmation number and not a time ticket.
 */
export const productionConfirmationOperation = pgTable('production_confirmation_operation', {
  client: tenant(),
  confirmationNumber: varchar('confirmation_number', { length: 12 }).notNull(),
  orderNumber: varchar('order_number', { length: 12 }).notNull(),
  operationNumber: varchar('operation_number', { length: 4 }).notNull(),
  confirmationType: varchar('confirmation_type', { length: 8 }).notNull(),
  yieldQuantity: quantity('yield_quantity'),
  scrapQuantity: quantity('scrap_quantity'),
  reworkQuantity: quantity('rework_quantity'),
  unit: varchar('unit', { length: 10 }).notNull(),
  workCenter: varchar('work_center', { length: 8 }),
  controlKey: varchar('control_key', { length: 4 }).notNull(),
  shortText: varchar('short_text', { length: 40 }),
  quantityBasis: varchar('quantity_basis', { length: 24 }).notNull(),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.confirmationNumber, t.operationNumber] }),
  foreignKey({
    columns: [t.client, t.confirmationNumber],
    foreignColumns: [productionConfirmation.client, productionConfirmation.confirmationNumber],
    name: 'production_confirmation_operation_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.client, t.orderNumber],
    foreignColumns: [productionOrder.client, productionOrder.orderNumber],
    name: 'production_confirmation_operation_order_fk',
  }).onDelete('restrict'),
  check('production_confirmation_operation_type_ck', sql`${t.confirmationType} in ('PARTIAL', 'FINAL')`),
  check('production_confirmation_operation_qty_ck', sql`${t.yieldQuantity} >= 0 and ${t.scrapQuantity} >= 0 and ${t.reworkQuantity} >= 0`),
  check('production_confirmation_operation_basis_ck', sql`${t.quantityBasis} in ('ORDER_QUANTITY', 'OPERATION_QUANTITY')`),
  index('production_confirmation_operation_order_idx').on(t.client, t.orderNumber, t.operationNumber),
]);


/**
 * CO13. One cancellation of one posted confirmation.
 * The original row is not updated. Active-final uniqueness is the trigger in
 * drizzle/9172, not a partial index, because the index cannot see this table.
 */
export const productionConfirmationCancellation = pgTable('production_confirmation_cancellation', {
  client: tenant(),
  cancellationNumber: varchar('cancellation_number', { length: 12 }).notNull(),
  confirmationNumber: varchar('confirmation_number', { length: 12 }).notNull(),
  orderNumber: varchar('order_number', { length: 12 }).notNull(),
  reason: varchar('reason', { length: 200 }),
  requestKey: varchar('request_key', { length: 64 }).notNull(),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.cancellationNumber] }),
  unique('production_confirmation_cancellation_original_uq').on(t.client, t.confirmationNumber),
  unique('production_confirmation_cancellation_request_uq').on(t.client, t.requestKey),
  foreignKey({
    columns: [t.client, t.confirmationNumber],
    foreignColumns: [productionConfirmation.client, productionConfirmation.confirmationNumber],
    name: 'production_confirmation_cancellation_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.orderNumber],
    foreignColumns: [productionOrder.client, productionOrder.orderNumber],
    name: 'production_confirmation_cancellation_order_fk',
  }).onDelete('restrict'),
  check('production_confirmation_cancellation_reason_ck', sql`${t.reason} is null or char_length(btrim(${t.reason})) between 1 and 200`),
  index('production_confirmation_cancellation_order_idx').on(t.client, t.orderNumber),
]);

/**
 * Operations copied onto a production order when a production version selects it.
 * A later routing edit does not update these rows. An order with no rows was
 * not given a routing snapshot. Predecessor and successor are not columns.
 * Sequence stays 000000. execution_order is the copied display order.
 */
export const productionOrderOperation = pgTable('production_order_operation', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 12 }).notNull(),
  operationNumber: varchar('operation_number', { length: 4 }).notNull(),
  sequence: char('sequence', { length: 6 }).notNull(),
  executionOrder: integer('execution_order').notNull(),
  taskListType: char('task_list_type', { length: 1 }).notNull(),
  routingGroup: varchar('routing_group', { length: 8 }).notNull(),
  groupCounter: varchar('group_counter', { length: 2 }).notNull(),
  productionVersion: varchar('production_version', { length: 4 }).notNull(),
  sourceOperationNumber: varchar('source_operation_number', { length: 4 }).notNull(),
  routingVersion: integer('routing_version').notNull(),
  workCenter: varchar('work_center', { length: 8 }),
  workCenterPlant: varchar('work_center_plant', { length: 10 }).notNull(),
  controlKey: varchar('control_key', { length: 4 }),
  shortText: varchar('short_text', { length: 40 }),
  standardValueKey: varchar('standard_value_key', { length: 4 }),
  operationQuantity: numeric('operation_quantity', { precision: 23, scale: 3 }),
  operationUnit: varchar('operation_unit', { length: 6 }),
  baseQuantity: numeric('base_quantity', { precision: 23, scale: 3 }),
  baseUnit: varchar('base_unit', { length: 6 }),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  confirmation: char('confirmation', { length: 1 }).notNull(),
  externalProcessing: char('external_processing', { length: 1 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.operationNumber] }),
  foreignKey({
    columns: [t.client, t.orderNumber],
    foreignColumns: [productionOrder.client, productionOrder.orderNumber],
    name: 'production_order_operation_order_fk',
  }).onDelete('cascade'),
  check('production_order_operation_number_ck', sql`${t.operationNumber} ~ '^[A-Z0-9]{4}$'`),
  check('production_order_operation_source_ck', sql`${t.sourceOperationNumber} ~ '^[A-Z0-9]{4}$'`),
  check('production_order_operation_sequence_ck', sql`${t.sequence} = '000000'`),
  check('production_order_operation_execution_order_ck', sql`${t.executionOrder} > 0`),
  uniqueIndex('production_order_operation_execution_order_uq').on(t.client, t.orderNumber, t.executionOrder),
  check('production_order_operation_routing_ck', sql`${t.taskListType} ~ '^[A-Z0-9]$' and ${t.routingGroup} ~ '^[A-Z0-9]{1,8}$' and ${t.groupCounter} ~ '^[A-Z0-9]{1,2}$' and ${t.productionVersion} ~ '^[A-Z0-9]{1,4}$'`),
  check('production_order_operation_version_ck', sql`${t.routingVersion} > 0`),
  check('production_order_operation_dates_ck', sql`${t.validTo} >= ${t.validFrom}`),
  check('production_order_operation_flags_ck', sql`${t.confirmation} in ('X', ' ') and ${t.externalProcessing} in ('X', ' ')`),
  check('production_order_operation_text_ck', sql`${t.shortText} is null or char_length(btrim(${t.shortText})) between 1 and 40`),
  index('production_order_operation_order_idx').on(t.client, t.orderNumber),
]);

/** Standard values copied with the operation. A later value-key edit does not rewrite them. */
export const productionOrderOperationValue = pgTable('production_order_operation_value', {
  client: tenant(),
  orderNumber: varchar('order_number', { length: 12 }).notNull(),
  operationNumber: varchar('operation_number', { length: 4 }).notNull(),
  parameter: varchar('parameter', { length: 6 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  quantity: numeric('quantity', { precision: 23, scale: 3 }),
  unit: varchar('unit', { length: 6 }).notNull(),
  required: char('required', { length: 1 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.operationNumber, t.parameter] }),
  foreignKey({
    columns: [t.client, t.orderNumber, t.operationNumber],
    foreignColumns: [productionOrderOperation.client, productionOrderOperation.orderNumber, productionOrderOperation.operationNumber],
    name: 'production_order_operation_value_fk',
  }).onDelete('cascade'),
  check('production_order_operation_value_parameter_ck', sql`${t.parameter} ~ '^[A-Z0-9]{1,6}$'`),
  check('production_order_operation_value_description_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('production_order_operation_value_quantity_ck', sql`${t.quantity} is null or ${t.quantity} > 0`),
  check('production_order_operation_value_required_ck', sql`${t.required} in ('X', ' ')`),
]);

/** COOIS. A user's field selection for one list. It does not store report rows. */
export const reportLayout = pgTable('report_layout', {
  client: tenant(),
  layoutId: varchar('layout_id', { length: 36 }).notNull(),
  owner: varchar('owner', { length: 60 }).notNull(),
  objectCategory: varchar('object_category', { length: 20 }).notNull(),
  listType: varchar('list_type', { length: 32 }).notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  description: varchar('description', { length: 80 }).notNull().default(''),
  fieldIds: varchar('field_ids', { length: 400 }).notNull(),
  sortField: varchar('sort_field', { length: 40 }).notNull(),
  sortDirection: varchar('sort_direction', { length: 4 }).notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdBy: varchar('created_by', { length: 60 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.client, t.layoutId] }),
  unique('report_layout_name_uq').on(t.client, t.owner, t.objectCategory, t.listType, t.name),
  check('report_layout_object_ck', sql`${t.objectCategory} in ('PRODUCTION_ORDER', 'PLANNED_ORDER')`),
  check('report_layout_direction_ck', sql`${t.sortDirection} in ('ASC', 'DESC')`),
  index('report_layout_owner_idx').on(t.client, t.owner, t.objectCategory, t.listType),
]);

/**
 * OVZ2 / TMVF. Client customizing for a future availability check.
 * Sales accumulation, replenishment lead time, and a material block are not stored.
 * The description is the tenant language, not a TMVFT row per language.
 */
export const availabilityCheckingGroup = pgTable('availability_checking_group', {
  client: tenant(),
  checkingGroup: varchar('checking_group', { length: 2 }).notNull(),
  description: varchar('description', { length: 20 }).notNull(),
  noCheck: char('no_check', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.checkingGroup] }),
  check('availability_checking_group_key_ck', sql`${t.checkingGroup} ~ '^[A-Z0-9]{2}$'`),
  check('availability_checking_group_text_ck', sql`char_length(btrim(${t.description})) between 1 and 20`),
  check('availability_checking_group_no_check_ck', sql`${t.noCheck} in ('X', ' ')`),
  check('availability_checking_group_version_ck', sql`${t.version} > 0`),
]);

/** OPJL / T441R. A business-context key. It is not a checking group and not a material field. */
export const availabilityCheckingRule = pgTable('availability_checking_rule', {
  client: tenant(),
  checkingRule: varchar('checking_rule', { length: 2 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.checkingRule] }),
  check('availability_checking_rule_key_ck', sql`${t.checkingRule} ~ '^[A-Z0-9]{2}$'`),
  check('availability_checking_rule_text_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('availability_checking_rule_version_ck', sql`${t.version} > 0`),
]);

/**
 * OVZ9 / T441V. The pair of one checking group and one checking rule.
 * Flags name future participation. No check reads them, and no ATP quantity is stored.
 */
export const availabilityCheckScope = pgTable('availability_check_scope', {
  client: tenant(),
  checkingGroup: varchar('checking_group', { length: 2 }).notNull(),
  checkingRule: varchar('checking_rule', { length: 2 }).notNull(),
  includeSafetyStock: char('include_safety_stock', { length: 1 }).notNull(),
  includeQualityStock: char('include_quality_stock', { length: 1 }).notNull(),
  includeBlockedStock: char('include_blocked_stock', { length: 1 }).notNull(),
  includeRestrictedUse: char('include_restricted_use', { length: 1 }).notNull(),
  purchaseOrders: char('purchase_orders', { length: 1 }).notNull(),
  purchaseRequisitions: char('purchase_requisitions', { length: 1 }).notNull(),
  plannedOrders: char('planned_orders', { length: 1 }).notNull(),
  productionOrders: char('production_orders', { length: 1 }).notNull(),
  dependentRequirements: char('dependent_requirements', { length: 1 }).notNull(),
  reservations: char('reservations', { length: 1 }).notNull(),
  receiptsInPast: char('receipts_in_past', { length: 1 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.checkingGroup, t.checkingRule] }),
  foreignKey({
    columns: [t.client, t.checkingGroup],
    foreignColumns: [availabilityCheckingGroup.client, availabilityCheckingGroup.checkingGroup],
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.checkingRule],
    foreignColumns: [availabilityCheckingRule.client, availabilityCheckingRule.checkingRule],
  }).onDelete('restrict'),
  check('availability_check_scope_xfeld_ck', sql`
    ${t.includeSafetyStock} in ('X', ' ')
    and ${t.includeQualityStock} in ('X', ' ')
    and ${t.includeBlockedStock} in ('X', ' ')
    and ${t.includeRestrictedUse} in ('X', ' ')
    and ${t.purchaseOrders} in ('X', ' ')
    and ${t.purchaseRequisitions} in ('X', ' ')
    and ${t.dependentRequirements} in ('X', ' ')
    and ${t.reservations} in ('X', ' ')
  `),
  check('availability_check_scope_planned_ck', sql`${t.plannedOrders} in ('X', 'A', ' ')`),
  check('availability_check_scope_production_ck', sql`${t.productionOrders} in ('X', 'F', ' ')`),
  check('availability_check_scope_past_ck', sql`${t.receiptsInPast} in ('B', ' ')`),
  check('availability_check_scope_version_ck', sql`${t.version} > 0`),
]);

/**
 * OPJH / T003O for production orders only. The key is the client and the order
 * type. It is not a plant key. Order category is fixed at 10. Number range,
 * settlement, status profile, and checking control are not stored.
 */
export const productionOrderType = pgTable('production_order_type', {
  client: tenant(),
  orderType: varchar('order_type', { length: 4 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  /** AUFTYP 10. Other categories are not this customizing. */
  orderCategory: char('order_category', { length: 2 }).notNull().default('10'),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderType] }),
  check('production_order_type_key_ck', sql`${t.orderType} ~ '^[A-Z0-9]{4}$'`),
  check('production_order_type_text_ck', sql`char_length(btrim(${t.description})) between 1 and 40`),
  check('production_order_type_category_ck', sql`${t.orderCategory} = '10'`),
  check('production_order_type_version_ck', sql`${t.version} > 0`),
]);

/**
 * OPL8 / T399X for production orders. The key is the client, the plant, and the
 * order type. Order category is fixed at 10. A task list type, when named, must
 * already stand. Production version selection is blank, 0, or 1. Costing,
 * settlement, and release are not stored. Checking control is a separate record.
 */
export const productionOrderTypeParameter = pgTable('production_order_type_parameter', {
  client: tenant(),
  plant: varchar('plant', { length: 10 }).notNull(),
  orderType: varchar('order_type', { length: 4 }).notNull(),
  orderCategory: char('order_category', { length: 2 }).notNull().default('10'),
  taskListType: char('task_list_type', { length: 1 }),
  productionVersionSelection: char('production_version_selection', { length: 1 }).notNull().default(' '),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.plant, t.orderType] }),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
    name: 'production_order_type_parameter_plant_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.orderType],
    foreignColumns: [productionOrderType.client, productionOrderType.orderType],
    name: 'production_order_type_parameter_type_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.taskListType],
    foreignColumns: [routingTaskListType.client, routingTaskListType.taskListType],
    name: 'production_order_type_parameter_task_list_fk',
  }).onDelete('restrict'),
  check('production_order_type_parameter_type_ck', sql`${t.orderType} ~ '^[A-Z0-9]{4}$'`),
  check('production_order_type_parameter_plant_ck', sql`char_length(${t.plant}) between 1 and 10`),
  check('production_order_type_parameter_category_ck', sql`${t.orderCategory} = '10'`),
  check('production_order_type_parameter_task_ck', sql`${t.taskListType} is null or ${t.taskListType} ~ '^[A-Z0-9]$'`),
  check('production_order_type_parameter_version_sel_ck', sql`${t.productionVersionSelection} in (' ', '0', '1')`),
  check('production_order_type_parameter_version_ck', sql`${t.version} > 0`),
]);

/**
 * OPJK / TCO11 for production orders. The key is the client, the plant, the
 * order type, and the business function. Only functions 1 and 2 are stored.
 * The no-check and check-on-save indicators have no database default: a missing
 * row is unconfigured. A checking rule, when named, must already stand.
 * Release, PRT, capacity, and creation control are not stored. No check runs.
 *
 * The indicators are varchar rather than CHAR so an omitted value is rejected
 * instead of being padded to blank.
 */
export const productionCheckingControl = pgTable('production_checking_control', {
  client: tenant(),
  plant: varchar('plant', { length: 10 }).notNull(),
  orderType: varchar('order_type', { length: 4 }).notNull(),
  businessFunction: varchar('business_function', { length: 1 }).notNull(),
  noCheck: varchar('no_check', { length: 1 }).notNull(),
  checkingRule: varchar('checking_rule', { length: 2 }),
  checkOnSave: varchar('check_on_save', { length: 1 }).notNull(),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.plant, t.orderType, t.businessFunction] }),
  foreignKey({
    columns: [t.client, t.plant],
    foreignColumns: [plant.client, plant.plant],
    name: 'production_checking_control_plant_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.orderType],
    foreignColumns: [productionOrderType.client, productionOrderType.orderType],
    name: 'production_checking_control_type_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [t.client, t.checkingRule],
    foreignColumns: [availabilityCheckingRule.client, availabilityCheckingRule.checkingRule],
    name: 'production_checking_control_rule_fk',
  }).onDelete('restrict'),
  check('production_checking_control_function_ck', sql`${t.businessFunction} in ('1', '2')`),
  check('production_checking_control_no_check_ck', sql`${t.noCheck} in ('X', ' ')`),
  check('production_checking_control_save_ck', sql`${t.checkOnSave} in ('X', ' ')`),
  check('production_checking_control_rule_ck', sql`${t.checkingRule} is null or ${t.checkingRule} ~ '^[A-Z0-9]{2}$'`),
  check('production_checking_control_type_ck', sql`${t.orderType} ~ '^[A-Z0-9]{4}$'`),
  check('production_checking_control_plant_ck', sql`char_length(${t.plant}) between 1 and 10`),
  check('production_checking_control_version_ck', sql`${t.version} > 0`),
]);

/**
 * Production order type -> settlement profile mapping. Mirrors
 * internal_order_type_settlement_profile for production orders. The profile
 * assignment, the allocation assignment and the distribution rule are one
 * condition: a settlement posts only when all three agree on where the
 * balance goes.
 */
export const productionOrderTypeSettlementProfile = pgTable('production_order_type_settlement_profile', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  orderType: varchar('order_type', { length: 4 }).notNull(),
  profileCode: varchar('profile_code', { length: 6 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderType] }),
  foreignKey({
    columns: [t.client, t.orderType],
    foreignColumns: [productionOrderType.client, productionOrderType.orderType],
    name: 'production_order_type_settlement_profile_type_fk',
  }),
  foreignKey({
    columns: [t.client, t.profileCode],
    foreignColumns: [settlementProfile.client, settlementProfile.profileCode],
    name: 'production_order_type_settlement_profile_profile_fk',
  }),
]);

/**
 * Distribution rule for one production order. A receiver is stored here,
 * never assumed. Mirrors settlement_distribution_rule but keys on
 * production_order instead of internal_order.
 */
export const productionOrderSetttlementDistributionRule = pgTable('production_order_settlement_distribution_rule', {
  client: varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' }),
  orderNumber: varchar('order_number', { length: 12 }).notNull(),
  ruleNumber: smallint('rule_number').notNull(),
  receiverCategory: varchar('receiver_category', { length: 16 }).notNull(),
  receiver: varchar('receiver', { length: 20 }).notNull(),
  percentage: numeric('percentage', { precision: 7, scale: 4 }),
  equivalence: numeric('equivalence', { precision: 10, scale: 0 }),
  amount: numeric('amount', { precision: 23, scale: 4 }),
  settlementType: varchar('settlement_type', { length: 3 }).notNull(),
  validFromYear: integer('valid_from_year').notNull(),
  validFromPeriod: smallint('valid_from_period').notNull(),
  validToYear: integer('valid_to_year').notNull(),
  validToPeriod: smallint('valid_to_period').notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.orderNumber, t.ruleNumber] }),
  foreignKey({
    columns: [t.client, t.orderNumber],
    foreignColumns: [productionOrder.client, productionOrder.orderNumber],
    name: 'production_order_settlement_distribution_rule_order_fk',
  }),
  check('production_order_settlement_distribution_rule_category_ck', sql`${t.receiverCategory} in ('COST_CENTER', 'INTERNAL_ORDER', 'GL_ACCOUNT')`),
  check('production_order_settlement_distribution_rule_type_ck', sql`${t.settlementType} in ('PER', 'FUL')`),
  check('production_order_settlement_distribution_rule_share_ck', sql`num_nonnulls(${t.percentage}, ${t.equivalence}, ${t.amount}) = 1`),
  check('production_order_settlement_distribution_rule_percentage_ck', sql`${t.percentage} is null or (${t.percentage} > 0 and ${t.percentage} <= 100)`),
  check('production_order_settlement_distribution_rule_equivalence_ck', sql`${t.equivalence} is null or ${t.equivalence} > 0`),
  check('production_order_settlement_distribution_rule_amount_ck', sql`${t.amount} is null or ${t.amount} > 0`),
]);
