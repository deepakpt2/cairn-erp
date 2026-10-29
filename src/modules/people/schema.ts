/**
 * People master data: configurable record types and the employee whose knowledge lives in dated records.
 *
 * CAIRN.md §8.10 lists these tables and DV-012 explains the shape: record types are **data**, so an employee
 * has no column for anything a tenant might decide to keep. The five tables here implement exactly the pair
 * of ideas the specification states, and nothing else from §8.10:
 *
 * **A record is dated, and a change is a new record.** `employee_record` is keyed by
 * (employee, type, from-date), and no two records of one type for one person may cover the same day — the
 * refusal is in `employee-master.ts`, inside the transaction that writes the row, because Postgres has no
 * exclusion constraint here to do it for us. Ending a record writes its `valid_to` once. Nothing is deleted:
 * `9193` revokes the right, so history is beyond the application's reach by construction rather than by
 * convention. Correcting the values of the *newest open* record is the one in-place write this slice allows,
 * and it is stated in that migration as a decision for the owner to confirm, not as settled law.
 *
 * **What a record holds is configured.** `record_field` says what a type asks for and of what kind, and
 * `record_field_value` answers one field in the column its kind selects — three columns, one slot, and a
 * check that refuses two of them filled. A fourth kind (a permitted list, a unit, an input mask) is not
 * invented here because no reader in the system needs one yet: pay components, deductions and time data
 * arrive with their own decisions (docs/operational-readiness.md §4 items 4 and 5).
 *
 * The organisational block was left out of this first slice on a reading that turned out to be too narrow:
 * its note reasoned that PA0001-style assignment data is "a record of a configured type", so fixed columns
 * would fix the shape the record types exist to avoid. CAIRN.md §8.10 lists `position_assignment` as a table
 * of its own, so `9194` builds it as one — with the *span* mechanics of this file's records (validity dates,
 * an inclusive `valid_to`, a change that appends) rather than with the record-type indirection. What stayed
 * out of People, on the grounds those files record: time and leave, and every payroll *result* table.
 * The pay structure of §8.10 arrived in `9195` — what a pay component is, which account it moves, and whether
 * a cost centre carries it — and it is a definition rather than a calculation: R-11 keeps payroll simplified
 * and DV-001 refuses to ship guessed statutory rules, so nothing in People computes an amount.
 */
import { boolean, check, date, foreignKey, integer, numeric, pgTable, primaryKey, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { auditColumns, client } from '../../platform/tables/tenancy';

const tenant = () => varchar('client', { length: 4 }).notNull().references(() => client.client, { onDelete: 'cascade' });

/** The three kinds a value may be. The vocabulary is closed on purpose (see the file header). */
export const RECORD_VALUE_KINDS = ['TEXT', 'NUMBER', 'DATE'] as const;
export type RecordValueKind = (typeof RECORD_VALUE_KINDS)[number];

export const RECORD_TYPE_ROUTE = '/config/people-record-types';
export const EMPLOYEE_ROUTE = '/people/employees';
export const RECORD_TYPE_CAPABILITY = 'CFG.PEOPLE.RECORDTYPE.DEFINE';
export const EMPLOYEE_CAPABILITY = 'PEOPLE.EMPLOYEE.CREATE';
export const RECORD_CAPABILITY = 'PEOPLE.RECORD.MAINTAIN';
export const RECORD_TYPE_OBJECT_CLASS = 'record_type';
export const EMPLOYEE_OBJECT_CLASS = 'employee';
export const EMPLOYEE_RECORD_OBJECT_CLASS = 'employee_record';

/** The organisational block `9194` adds: where a person sits, and who they report to. */
export const ORG_ROUTE = '/people/organization';
export const ASSIGNMENT_ROUTE = '/people/assignments';
export const ORG_UNIT_CAPABILITY = 'PEOPLE.ORGUNIT.CREATE';
export const POSITION_CAPABILITY = 'PEOPLE.POSITION.CREATE';
export const ASSIGNMENT_CAPABILITY = 'PEOPLE.ASSIGNMENT.MAINTAIN';
export const ORG_UNIT_OBJECT_CLASS = 'org_unit';
export const JOB_OBJECT_CLASS = 'job';
export const POSITION_OBJECT_CLASS = 'position';
export const ORG_HIERARCHY_OBJECT_CLASS = 'org_hierarchy';
export const ASSIGNMENT_OBJECT_CLASS = 'position_assignment';

/** The two relations `org_hierarchy` carries: the tree, and the line §15.1 calls the reporting line. */
export const ORG_RELATIONS = ['STRUCTURE', 'REPORTS_TO'] as const;
export type OrgRelation = (typeof ORG_RELATIONS)[number];
export const ORG_NODE_KINDS = ['ORGUNIT', 'POSITION'] as const;
export type OrgNodeKind = (typeof ORG_NODE_KINDS)[number];

/**
 * How deep the structure may go. Ten is the number drizzle/0052 gave the cost centre tree, taken over rather
 * than newly invented; it counts the whole chain, so a position under a unit under a unit is three levels.
 * A structure deeper than this is a maintenance problem before it is a reporting one, and the cap is what
 * turns "the tenant drew a ring" into a refusal with a sentence attached.
 */
export const MAX_ORG_DEPTH = 10;

/** A record type: what the tenant keeps about a person. Retired by validity, never deleted. */
export const recordType = pgTable(
  'record_type',
  {
    client: tenant(),
    code: varchar('code', { length: 6 }).notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    description: varchar('description', { length: 200 }),
    isValid: boolean('is_valid').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.code] }),
    check('record_type_code_format_ck', sql`${t.code} ~ '^([A-Z][A-Z0-9]{1,5})$'`),
  ],
);

/** One field a record type asks for, with the kind of answer it accepts. */
export const recordField = pgTable(
  'record_field',
  {
    client: tenant(),
    recordType: varchar('record_type', { length: 6 }).notNull(),
    code: varchar('code', { length: 30 }).notNull(),
    label: varchar('label', { length: 60 }).notNull(),
    valueKind: varchar('value_kind', { length: 6 }).notNull(),
    isRequired: boolean('is_required').notNull().default(false),
    displayOrder: integer('display_order').notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.recordType, t.code] }),
    foreignKey({
      name: 'record_field_type_fk',
      columns: [t.client, t.recordType],
      foreignColumns: [recordType.client, recordType.code],
    }).onDelete('restrict'),
    check('record_field_code_format_ck', sql`${t.code} ~ '^([A-Z][A-Z0-9_]{1,29})$'`),
    check(
      'record_field_value_kind_ck',
      sql`${t.valueKind} in ('TEXT', 'NUMBER', 'DATE')`,
    ),
    check('record_field_order_non_negative_ck', sql`${t.displayOrder} >= 0`),
  ],
);

/** The employee: a personnel number the caller supplies, and a name. Everything else is a dated record. */
export const employee = pgTable(
  'employee',
  {
    client: tenant(),
    personnelNumber: varchar('personnel_number', { length: 20 }).notNull(),
    fullName: varchar('full_name', { length: 60 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    requestKey: varchar('request_key', { length: 64 }),
    appUserId: varchar('app_user_id', { length: 36 }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.personnelNumber] }),
    check('employee_number_format_ck', sql`${t.personnelNumber} ~ '^([A-Z0-9]{1,20})$'`),
    uniqueIndex('employee_request_key_uq')
      .on(t.client, t.requestKey)
      .where(sql`${t.requestKey} is not null`),
    uniqueIndex('employee_app_user_id_uq')
      .on(t.client, t.appUserId)
      .where(sql`${t.appUserId} is not null`),
  ],
);

/**
 * One dated record of one type for one employee. The row a change replaces keeps standing. The span is
 * inclusive at both ends (`valid_to` is the last day it applies), which is how an infotype dates a record
 * and what makes the day after the previous end the day the next one starts.
 */
export const employeeRecord = pgTable(
  'employee_record',
  {
    client: tenant(),
    personnelNumber: varchar('personnel_number', { length: 20 }).notNull(),
    recordType: varchar('record_type', { length: 6 }).notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }),
    requestKey: varchar('request_key', { length: 64 }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.personnelNumber, t.recordType, t.validFrom] }),
    foreignKey({
      name: 'employee_record_employee_fk',
      columns: [t.client, t.personnelNumber],
      foreignColumns: [employee.client, employee.personnelNumber],
    }).onDelete('restrict'),
    // History outlives the configuration that named it: a type any record cites cannot be removed.
    foreignKey({
      name: 'employee_record_type_fk',
      columns: [t.client, t.recordType],
      foreignColumns: [recordType.client, recordType.code],
    }).onDelete('restrict'),
    check('employee_record_span_ck', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
    uniqueIndex('employee_record_request_key_uq')
      .on(t.client, t.personnelNumber, t.recordType, t.requestKey)
      .where(sql`${t.requestKey} is not null`),
  ],
);

/** The answers one record holds: one row per field, in the column its kind selects. */
export const recordFieldValue = pgTable(
  'record_field_value',
  {
    client: tenant(),
    personnelNumber: varchar('personnel_number', { length: 20 }).notNull(),
    recordType: varchar('record_type', { length: 6 }).notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    fieldCode: varchar('field_code', { length: 30 }).notNull(),
    textValue: varchar('text_value', { length: 500 }),
    numberValue: numeric('number_value', { precision: 15, scale: 2 }),
    dateValue: date('date_value', { mode: 'string' }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.personnelNumber, t.recordType, t.validFrom, t.fieldCode] }),
    foreignKey({
      name: 'record_field_value_record_fk',
      columns: [t.client, t.personnelNumber, t.recordType, t.validFrom],
      foreignColumns: [
        employeeRecord.client, employeeRecord.personnelNumber, employeeRecord.recordType, employeeRecord.validFrom,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'record_field_value_field_fk',
      columns: [t.client, t.recordType, t.fieldCode],
      foreignColumns: [recordField.client, recordField.recordType, recordField.code],
    }).onDelete('restrict'),
    check(
      'record_field_value_one_slot_ck',
      sql`(${t.textValue} is not null)::int + (${t.numberValue} is not null)::int + (${t.dateValue} is not null)::int = 1`,
    ),
  ],
);

/**
 * An organisational unit: a name, a place in a tree, and a validity flag. The parent is a row of
 * `orgHierarchy` rather than a column, so there is exactly one answer to "what is above this". A unit is
 * retired by validity and never deleted: `9194` grants no DELETE on it, because positions and other units
 * cite it.
 */
export const orgUnit = pgTable(
  'org_unit',
  {
    client: tenant(),
    code: varchar('code', { length: 10 }).notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    description: varchar('description', { length: 200 }),
    isValid: boolean('is_valid').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.code] }),
    check('org_unit_code_format_ck', sql`${t.code} ~ '^([A-Z][A-Z0-9]{1,9})$'`),
  ],
);

/** What a position does, named by the tenant and independent of where it is done. §10.8 gives jobs no code
 * of their own, so the authority that maintains positions maintains these. */
export const job = pgTable(
  'job',
  {
    client: tenant(),
    code: varchar('code', { length: 10 }).notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    description: varchar('description', { length: 200 }),
    isValid: boolean('is_valid').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.code] }),
    check('job_code_format_ck', sql`${t.code} ~ '^([A-Z][A-Z0-9]{1,9})$'`),
  ],
);

/** One place in the structure an employee can be assigned to. Its unit is an edge; who holds it is a query
 * against the assignment table, never a column here. */
export const position = pgTable(
  'position',
  {
    client: tenant(),
    code: varchar('code', { length: 10 }).notNull(),
    title: varchar('title', { length: 60 }).notNull(),
    jobCode: varchar('job_code', { length: 10 }),
    description: varchar('description', { length: 200 }),
    isValid: boolean('is_valid').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.code] }),
    check('position_code_format_ck', sql`${t.code} ~ '^([A-Z][A-Z0-9]{1,9})$'`),
    foreignKey({
      name: 'position_job_fk',
      columns: [t.client, t.jobCode],
      foreignColumns: [job.client, job.code],
    }).onDelete('restrict'),
  ],
);

/**
 * The structure itself: `STRUCTURE` rows say what hangs below what (a unit under a unit, a position in a
 * unit), `REPORTS_TO` rows say which position is above which. The key is the child, which *is* the
 * one-parent rule; the absence of a ring and the depth cap are the service's, both judged in the transaction
 * that writes the edge. This is the one table of the slice the application may delete from, because a
 * misfiled object has to be movable and a move in a child-keyed table is a delete and an insert.
 */
export const orgHierarchy = pgTable(
  'org_hierarchy',
  {
    client: tenant(),
    relationType: varchar('relation_type', { length: 12 }).notNull(),
    parentKind: varchar('parent_kind', { length: 8 }).notNull(),
    parentCode: varchar('parent_code', { length: 10 }).notNull(),
    childKind: varchar('child_kind', { length: 8 }).notNull(),
    childCode: varchar('child_code', { length: 10 }).notNull(),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.relationType, t.childKind, t.childCode] }),
    check('org_hierarchy_relation_ck', sql`${t.relationType} in ('STRUCTURE', 'REPORTS_TO')`),
    check(
      'org_hierarchy_pairs_ck',
      sql`(${t.relationType} = 'STRUCTURE' and ${t.parentKind} = 'ORGUNIT' and ${t.childKind} in ('ORGUNIT', 'POSITION'))
        or (${t.relationType} = 'REPORTS_TO' and ${t.parentKind} = 'POSITION' and ${t.childKind} = 'POSITION')`,
    ),
    check(
      'org_hierarchy_not_self_ck',
      sql`${t.parentKind} <> ${t.childKind} or ${t.parentCode} <> ${t.childCode}`,
    ),
  ],
);

/**
 * The assignment: an employee, a position, the cost centre that carried them, and the span it was true for.
 * Keyed by (employee, first day) so a second assignment cannot begin the same day; overlapping spans are
 * refused by the service, in the transaction, for the same reason `employee_record`'s overlap is. A change
 * appends a row and delimits the one it replaces — `valid_to` is the only write history ever takes.
 */
export const positionAssignment = pgTable(
  'position_assignment',
  {
    client: tenant(),
    personnelNumber: varchar('personnel_number', { length: 20 }).notNull(),
    positionCode: varchar('position_code', { length: 10 }).notNull(),
    controllingArea: varchar('controlling_area', { length: 4 }).notNull(),
    costCenter: varchar('cost_center', { length: 10 }).notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }),
    requestKey: varchar('request_key', { length: 64 }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.personnelNumber, t.validFrom] }),
    foreignKey({
      name: 'position_assignment_employee_fk',
      columns: [t.client, t.personnelNumber],
      foreignColumns: [employee.client, employee.personnelNumber],
    }).onDelete('restrict'),
    foreignKey({
      name: 'position_assignment_position_fk',
      columns: [t.client, t.positionCode],
      foreignColumns: [position.client, position.code],
    }).onDelete('restrict'),
    // The cost centre itself cannot be a foreign key: its own key carries a from-date (drizzle/0050), so a
    // span cannot name one interval of it. The controlling area *is* a real key — declared in
    // `9194`'s SQL, since no drizzle schema in this repository names that table and cross-module references
    // are plain columns throughout (src/modules/finance/schema.ts stores `cost_center` the same way). What
    // the code's validity across the span means is the service's question, asked of the dated master.
    check('position_assignment_area_format_ck', sql`${t.controllingArea} ~ '^[A-Z0-9]{4}$'`),
    check('position_assignment_cc_format_ck', sql`${t.costCenter} ~ '^[A-Z0-9]{1,10}$'`),
    check('position_assignment_span_ck', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
    uniqueIndex('position_assignment_request_key_uq')
      .on(t.client, t.personnelNumber, t.requestKey)
      .where(sql`${t.requestKey} is not null`),
  ],
);

// ── 9195: the pay structure ─────────────────────────────────────────────────
// §8.10's "pay_component, pay_component_config | Pay structure and its GL/cost mapping". Two tables, one
// screen, no amounts: the header of drizzle/9195_people_pay_structure.sql says what the kinds and the two
// sides of a mapping are read from, and what waits on a jurisdiction decision instead.

/** The four kinds §15.2's posting example reduces to, and no more than that. */
export const PAY_COMPONENT_KINDS = ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'EOS_PROVISION'] as const;
export type PayComponentKind = (typeof PAY_COMPONENT_KINDS)[number];

/** Where a debit is charged: the employee's assignment, a centre this row names, or nothing. */
export const COST_RECEIVER_CATEGORIES = ['ASSIGNMENT', 'FIXED', 'NONE'] as const;
export type CostReceiverCategory = (typeof COST_RECEIVER_CATEGORIES)[number];

export const PAY_COMPONENT_ROUTE = '/config/pay-components';
export const PAY_COMPONENT_CAPABILITY = 'CFG.PEOPLE.PAYCOMPONENT.DEFINE';
export const PAY_COMPONENT_OBJECT_CLASS = 'pay_component';
export const PAY_COMPONENT_CONFIG_OBJECT_CLASS = 'pay_component_config';

/** A component is a name for a kind of pay. It never carries a rule about how much. */
export const payComponent = pgTable(
  'pay_component',
  {
    client: tenant(),
    code: varchar('code', { length: 10 }).notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    componentKind: varchar('component_kind', { length: 24 }).notNull(),
    affectsNetPay: boolean('affects_net_pay').notNull().default(false),
    description: varchar('description', { length: 200 }),
    isValid: boolean('is_valid').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.code] }),
    check('pay_component_code_format_ck', sql`${t.code} ~ '^([A-Z][A-Z0-9]{1,9})$'`),
    check('pay_component_name_length_ck', sql`length(trim(${t.name})) > 0`),
    check(
      'pay_component_kind_vocabulary_ck',
      sql`${t.componentKind} in ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'EOS_PROVISION')`,
    ),
    check('pay_component_net_effect_ck', sql`${t.affectsNetPay} = (${t.componentKind} in ('EARNING', 'DEDUCTION'))`),
  ],
);

/**
 * The mapping of one component within one chart of accounts. The relations to `gl_account` and to the
 * cost-centre master are the database's rather than drizzle's: `public.gl_account` belongs to the finance
 * schema and `public.cost_center` is dated by a key this file cannot point at, exactly as 9194 left its own
 * cost-centre relation to SQL. The service checks both, in the transaction that writes the row.
 */
export const payComponentConfig = pgTable(
  'pay_component_config',
  {
    client: tenant(),
    componentCode: varchar('component_code', { length: 10 }).notNull(),
    chartOfAccounts: varchar('chart_of_accounts', { length: 4 }).notNull(),
    debitAccount: varchar('debit_account', { length: 10 }),
    creditAccount: varchar('credit_account', { length: 10 }),
    costReceiverCategory: varchar('cost_receiver_category', { length: 10 }).notNull().default('NONE'),
    controllingArea: varchar('controlling_area', { length: 4 }),
    costCenter: varchar('cost_center', { length: 10 }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.componentCode, t.chartOfAccounts] }),
    foreignKey({
      name: 'pay_component_config_component_fk',
      columns: [t.client, t.componentCode],
      foreignColumns: [payComponent.client, payComponent.code],
    }).onDelete('restrict'),
    check('pay_component_config_chart_format_ck', sql`${t.chartOfAccounts} ~ '^[A-Z0-9]{4}$'`),
    check('pay_component_config_not_hollow_ck', sql`${t.debitAccount} is not null or ${t.creditAccount} is not null`),
    check(
      'pay_component_config_sides_differ_ck',
      sql`${t.debitAccount} is null or ${t.creditAccount} is null or ${t.debitAccount} <> ${t.creditAccount}`,
    ),
    check(
      'pay_component_config_receiver_vocabulary_ck',
      sql`${t.costReceiverCategory} in ('ASSIGNMENT', 'FIXED', 'NONE')`,
    ),
    check(
      'pay_component_config_cost_pair_ck',
      sql`(${t.controllingArea} is null and ${t.costCenter} is null) or (${t.controllingArea} is not null and ${t.costCenter} is not null)`,
    ),
    check(
      'pay_component_config_fixed_needs_centre_ck',
      sql`${t.costReceiverCategory} <> 'FIXED' or (${t.controllingArea} is not null and ${t.costCenter} is not null)`,
    ),
    check(
      'pay_component_config_assignment_needs_nothing_ck',
      sql`${t.costReceiverCategory} <> 'ASSIGNMENT' or (${t.controllingArea} is null and ${t.costCenter} is null})`,
    ),
  ],
);

// ── 9197: time and leave ────────────────────────────────────────────────────
// §8.10: time_recording, absence, attendance, leave_quota — Time data.
// §10.8: PEOPLE.TIME.ENTER (absence and attendance entry), PEOPLE.LEAVE.VIEW
// (leave quota and balance). §15.3: country-specific leave law is not built —
// entitlement is what the tenant configures, and nothing here invents a statute.

/** What a time type is: absence reduces a quota, attendance and overtime do not. */
export const TIME_TYPE_KINDS = ['ABSENCE', 'ATTENDANCE', 'OVERTIME'] as const;
export type TimeTypeKind = (typeof TIME_TYPE_KINDS)[number];

/** The absence status lifecycle. REQUESTED is the only status a write can set. */
export const ABSENCE_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type AbsenceStatus = (typeof ABSENCE_STATUSES)[number];

/** A kind of time the tenant counts: annual leave, sick leave, attendance, overtime. */
export const timeType = pgTable(
  'time_type',
  {
    client: tenant(),
    code: varchar('code', { length: 10 }).notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    description: varchar('description', { length: 200 }),
    typeKind: varchar('type_kind', { length: 12 }).notNull(),
    reducesQuota: boolean('reduces_quota').notNull().default(false),
    isValid: boolean('is_valid').notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.code] }),
    check('time_type_code_format_ck', sql`${t.code} ~ '^([A-Z][A-Z0-9]{1,9})$'`),
    check('time_type_kind_ck', sql`${t.typeKind} in ('ABSENCE', 'ATTENDANCE', 'OVERTIME')`),
    check('time_type_name_length_ck', sql`length(trim(${t.name})) > 0`),
  ],
);

/** A dated absence/leave request: one employee, one type, an inclusive span, a status. */
export const absence = pgTable(
  'absence',
  {
    client: tenant(),
    personnelNumber: varchar('personnel_number', { length: 20 }).notNull(),
    timeTypeCode: varchar('time_type_code', { length: 10 }).notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }),
    status: varchar('status', { length: 12 }).notNull().default('REQUESTED'),
    reason: varchar('reason', { length: 200 }),
    requestKey: varchar('request_key', { length: 64 }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.personnelNumber, t.timeTypeCode, t.validFrom] }),
    foreignKey({
      name: 'absence_emp_fk',
      columns: [t.client, t.personnelNumber],
      foreignColumns: [employee.client, employee.personnelNumber],
    }).onDelete('restrict'),
    foreignKey({
      name: 'absence_type_fk',
      columns: [t.client, t.timeTypeCode],
      foreignColumns: [timeType.client, timeType.code],
    }).onDelete('restrict'),
    check('absence_span_ck', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
    check('absence_status_ck', sql`${t.status} in ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED')`),
    uniqueIndex('absence_request_key_uq')
      .on(t.client, t.personnelNumber, t.requestKey)
      .where(sql`${t.requestKey} is not null`),
  ],
);

/** One leave quota per employee, per type that reduces quota, per calendar year. */
export const leaveQuota = pgTable(
  'leave_quota',
  {
    client: tenant(),
    personnelNumber: varchar('personnel_number', { length: 20 }).notNull(),
    timeTypeCode: varchar('time_type_code', { length: 10 }).notNull(),
    year: integer('year').notNull(),
    entitlement: numeric('entitlement', { precision: 5, scale: 2 }).notNull().default('0'),
    taken: numeric('taken', { precision: 5, scale: 2 }).notNull().default('0'),
    remaining: numeric('remaining', { precision: 5, scale: 2 }).notNull().default('0'),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.personnelNumber, t.timeTypeCode, t.year] }),
    foreignKey({
      name: 'leave_quota_emp_fk',
      columns: [t.client, t.personnelNumber],
      foreignColumns: [employee.client, employee.personnelNumber],
    }).onDelete('restrict'),
    check('leave_quota_year_ck', sql`${t.year} > 1900 and ${t.year} < 2100`),
    check('leave_quota_nonnegative_ck', sql`${t.entitlement} >= 0 and ${t.taken} >= 0 and ${t.remaining} >= 0`),
  ],
);

/** Hours an employee recorded on a day, of one type: a measurement, not history. */
export const timeRecording = pgTable(
  'time_recording',
  {
    client: tenant(),
    personnelNumber: varchar('personnel_number', { length: 20 }).notNull(),
    timeTypeCode: varchar('time_type_code', { length: 10 }).notNull(),
    recordingDate: date('recording_date', { mode: 'string' }).notNull(),
    hours: numeric('hours', { precision: 5, scale: 2 }).notNull(),
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.personnelNumber, t.timeTypeCode, t.recordingDate] }),
    foreignKey({
      name: 'time_recording_emp_fk',
      columns: [t.client, t.personnelNumber],
      foreignColumns: [employee.client, employee.personnelNumber],
    }).onDelete('restrict'),
    foreignKey({
      name: 'time_recording_type_fk',
      columns: [t.client, t.timeTypeCode],
      foreignColumns: [timeType.client, timeType.code],
    }).onDelete('restrict'),
    check('time_recording_hours_ck', sql`${t.hours} > 0 and ${t.hours} <= 24`),
  ],
);
