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
 * The organisational block (`org_unit`, `position`, `job`, `org_hierarchy`, `position_assignment`), time and
 * leave, and every payroll table are deliberately absent. The org block comes next and for a specific
 * reason: assignment data is itself a record of a configured type, so building it with fixed columns first
 * would fix the shape the record types exist to avoid.
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
    ...auditColumns,
  },
  (t) => [
    primaryKey({ columns: [t.client, t.personnelNumber] }),
    check('employee_number_format_ck', sql`${t.personnelNumber} ~ '^([A-Z0-9]{1,20})$'`),
    uniqueIndex('employee_request_key_uq')
      .on(t.client, t.requestKey)
      .where(sql`${t.requestKey} is not null`),
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
