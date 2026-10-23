/** Total planning — SCR-166 / MD01. A run is evidence. It is not stock and not a requisition. */
import { pgTable, varchar, integer, boolean, char, date, timestamp, numeric, primaryKey, foreignKey, unique, uniqueIndex, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { unitOfMeasure } from '../../platform/tables/reference';
import { factoryCalendar, plant } from '../foundation/schema';
import { material, materialPlant } from '../inventory/schema';

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
  check('planned_order_origin_ck', sql`${t.origin} in ('MRP')`),
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
