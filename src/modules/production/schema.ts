/** Total planning — SCR-166 / MD01. A run is evidence. It is not stock and not a requisition. */
import { pgTable, varchar, integer, boolean, char, date, timestamp, numeric, primaryKey, foreignKey, unique, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { plant } from '../foundation/schema';
import { material } from '../inventory/schema';

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
