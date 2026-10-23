/** Characteristics for classification — SCR-057 / R-105 (CT04). */
import { pgTable, varchar, integer, smallint, boolean, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { client, auditColumns } from '../../platform/tables/tenancy';
import { unitOfMeasure, currency } from '../../platform/tables/reference';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });

/**
 * The characteristic's name is its stable tenant business key — never
 * renamed. The lifecycle DRAFT / ACTIVE / BLOCKED is a Cairn workflow.
 * Description stands in the tenant language (B-223). Allowed values
 * are unique per characteristic under the declared case policy, which
 * the service judges (the stored key is the entered text).
 */
export const characteristic = pgTable('characteristic', {
  client: tenant(),
  characteristicName: varchar('characteristic_name', { length: 30 }).notNull(),
  description: varchar('description', { length: 30 }).notNull(),
  dataFormat: varchar('data_format', { length: 4 }).notNull(),
  valueLength: integer('value_length').notNull().default(30),
  decimalPlaces: integer('decimal_places').notNull().default(0),
  unit: varchar('unit', { length: 6 }).references(() => unitOfMeasure.code),
  currency: varchar('currency', { length: 3 }).references(() => currency.code),
  negativeValuesAllowed: boolean('negative_values_allowed').notNull().default(false),
  caseSensitive: boolean('case_sensitive').notNull().default(false),
  intervalsAllowed: boolean('intervals_allowed').notNull().default(false),
  additionalValuesAllowed: boolean('additional_values_allowed').notNull().default(false),
  valueAssignment: varchar('value_assignment', { length: 8 }).notNull().default('SINGLE'),
  requiredEntry: boolean('required_entry').notNull().default(false),
  lifecycleStatus: varchar('lifecycle_status', { length: 8 }).notNull().default('DRAFT'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.characteristicName] }),
  check('characteristic_name_ck', sql`${t.characteristicName} ~ '^[A-Z0-9_]{1,30}$'`),
  check('characteristic_format_ck', sql`${t.dataFormat} in ('CHAR', 'NUM', 'DATE', 'TIME', 'CURR')`),
  check('characteristic_length_ck', sql`${t.valueLength} > 0`),
  check('characteristic_decimals_ck', sql`${t.decimalPlaces} >= 0 and ${t.decimalPlaces} <= ${t.valueLength}`),
  check('characteristic_intervals_ck', sql`not ${t.intervalsAllowed} or ${t.dataFormat} in ('NUM', 'DATE', 'TIME')`),
  check('characteristic_assignment_ck', sql`${t.valueAssignment} in ('SINGLE', 'MULTIPLE')`),
  check('characteristic_lifecycle_ck', sql`${t.lifecycleStatus} in ('DRAFT', 'ACTIVE', 'BLOCKED')`),
]);

export const characteristicValue = pgTable('characteristic_value', {
  client: tenant(),
  characteristicName: varchar('characteristic_name', { length: 30 }).notNull(),
  valueText: varchar('value_text', { length: 30 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.characteristicName, t.valueText] }),
  foreignKey({
    columns: [t.client, t.characteristicName],
    foreignColumns: [characteristic.client, characteristic.characteristicName],
  }),
  check('characteristic_value_sort_ck', sql`${t.sortOrder} >= 0`),
]);

/**
 * Classes — SCR-058 / R-106 (CL02). The class-type catalogue is
 * delivered configuration; a class is keyed by its immutable type and
 * name, and assignments hang characteristics beneath it at unique
 * positions, each characteristic at most once per class.
 */
export const classType = pgTable('class_type', {
  client: tenant(),
  classType: varchar('class_type', { length: 20 }).notNull(),
  description: varchar('description', { length: 60 }).notNull(),
  objectCategory: varchar('object_category', { length: 20 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.classType] }),
  check('class_type_category_ck', sql`${t.objectCategory} in ('MATERIAL', 'BATCH', 'EQUIPMENT', 'VARIANT', 'PURCHASING', 'GENERAL')`),
]);

export const classificationClass = pgTable('classification_class', {
  client: tenant(),
  classType: varchar('class_type', { length: 20 }).notNull(),
  className: varchar('class_name', { length: 18 }).notNull(),
  description: varchar('description', { length: 40 }).notNull(),
  lifecycleStatus: varchar('lifecycle_status', { length: 8 }).notNull().default('DRAFT'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.classType, t.className] }),
  foreignKey({
    columns: [t.client, t.classType],
    foreignColumns: [classType.client, classType.classType],
  }),
  check('classification_class_name_ck', sql`${t.className} ~ '^[A-Z0-9_]{1,18}$'`),
  check('classification_class_lifecycle_ck', sql`${t.lifecycleStatus} in ('DRAFT', 'ACTIVE', 'BLOCKED')`),
]);

export const classAssignment = pgTable('class_assignment', {
  client: tenant(),
  classType: varchar('class_type', { length: 20 }).notNull(),
  className: varchar('class_name', { length: 18 }).notNull(),
  position: smallint('position').notNull(),
  characteristicName: varchar('characteristic_name', { length: 30 }).notNull(),
  requiredForClassification: boolean('required_for_classification').notNull().default(false),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.classType, t.className, t.position] }),
  foreignKey({
    columns: [t.client, t.classType, t.className],
    foreignColumns: [classificationClass.client, classificationClass.classType, classificationClass.className],
  }),
  foreignKey({
    columns: [t.client, t.characteristicName],
    foreignColumns: [characteristic.client, characteristic.characteristicName],
  }),
  check('class_assignment_position_ck', sql`${t.position} > 0`),
]);

/**
 * Release strategies — SCR-059 / R-107. Groups own codes; a strategy
 * binds a group to a classification class; criteria judge document
 * attributes; steps sequence the codes that must act.
 */
export const releaseGroup = pgTable('release_group', {
  client: tenant(),
  groupCode: varchar('group_code', { length: 12 }).notNull(),
  documentCategory: varchar('document_category', { length: 20 }).notNull(),
  description: varchar('description', { length: 60 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.groupCode] }),
  check('release_group_category_ck', sql`${t.documentCategory} in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'PURCHASE_CONTRACT', 'SCHED_AGREEMENT')`),
]);

export const releaseCode = pgTable('release_code', {
  client: tenant(),
  groupCode: varchar('group_code', { length: 12 }).notNull(),
  code: varchar('code', { length: 8 }).notNull(),
  description: varchar('description', { length: 60 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.groupCode, t.code] }),
  foreignKey({
    columns: [t.client, t.groupCode],
    foreignColumns: [releaseGroup.client, releaseGroup.groupCode],
  }),
]);

export const releaseStrategy = pgTable('release_strategy', {
  client: tenant(),
  groupCode: varchar('group_code', { length: 12 }).notNull(),
  strategyCode: varchar('strategy_code', { length: 12 }).notNull(),
  description: varchar('description', { length: 60 }).notNull(),
  classType: varchar('class_type', { length: 20 }).notNull(),
  className: varchar('class_name', { length: 18 }).notNull(),
  priority: integer('priority').notNull().default(100),
  lifecycleStatus: varchar('lifecycle_status', { length: 8 }).notNull().default('DRAFT'),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.groupCode, t.strategyCode] }),
  foreignKey({
    columns: [t.client, t.groupCode],
    foreignColumns: [releaseGroup.client, releaseGroup.groupCode],
  }),
  foreignKey({
    columns: [t.client, t.classType, t.className],
    foreignColumns: [classificationClass.client, classificationClass.classType, classificationClass.className],
  }),
  check('release_strategy_priority_ck', sql`${t.priority} > 0`),
  check('release_strategy_lifecycle_ck', sql`${t.lifecycleStatus} in ('DRAFT', 'ACTIVE', 'BLOCKED')`),
]);

export const releaseStrategyCriterion = pgTable('release_strategy_criterion', {
  client: tenant(),
  groupCode: varchar('group_code', { length: 12 }).notNull(),
  strategyCode: varchar('strategy_code', { length: 12 }).notNull(),
  characteristicName: varchar('characteristic_name', { length: 30 }).notNull(),
  operator: varchar('operator', { length: 8 }).notNull(),
  valueFrom: varchar('value_from', { length: 30 }).notNull(),
  valueTo: varchar('value_to', { length: 30 }),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.groupCode, t.strategyCode, t.characteristicName] }),
  foreignKey({
    columns: [t.client, t.groupCode, t.strategyCode],
    foreignColumns: [releaseStrategy.client, releaseStrategy.groupCode, releaseStrategy.strategyCode],
  }),
  foreignKey({
    columns: [t.client, t.characteristicName],
    foreignColumns: [characteristic.client, characteristic.characteristicName],
  }),
  check('release_criterion_operator_ck', sql`${t.operator} in ('EQ', 'GE', 'GT', 'LE', 'LT', 'BETWEEN')`),
]);

export const releaseStrategyStep = pgTable('release_strategy_step', {
  client: tenant(),
  groupCode: varchar('group_code', { length: 12 }).notNull(),
  strategyCode: varchar('strategy_code', { length: 12 }).notNull(),
  step: smallint('step').notNull(),
  releaseCode: varchar('release_code', { length: 8 }).notNull(),
  ...auditColumns,
}, (t) => [
  primaryKey({ columns: [t.client, t.groupCode, t.strategyCode, t.step] }),
  foreignKey({
    columns: [t.client, t.groupCode, t.strategyCode],
    foreignColumns: [releaseStrategy.client, releaseStrategy.groupCode, releaseStrategy.strategyCode],
  }),
  foreignKey({
    columns: [t.client, t.groupCode, t.releaseCode],
    foreignColumns: [releaseCode.client, releaseCode.groupCode, releaseCode.code],
  }),
  check('release_step_ck', sql`${t.step} > 0`),
]);
