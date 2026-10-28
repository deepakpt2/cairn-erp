/**
 * The employee master: the person, and the dated records that say what is true about them.
 *
 * Three rules from CAIRN.md carry this file, and each is enforced where the write happens:
 *
 * **§8.10: "date-delineated records, a change is a new dated record, not an overwrite."** A record is keyed by
 * (employee, type, from-date) and covers its span inclusively — `valid_to` is the last day it applies — so
 * writing one over any day another record of the same type already covers is refused, naming the record in
 * the way; and nothing here deletes. `9193` took the DELETE privilege away, so
 * the append-only shape is the database's, not this service's promise alone. Two narrow in-place acts are
 * allowed and both are the migration's stated decisions, not conventions slipped in: ending the newest open
 * record (`delimitRecord`, which writes `valid_to` once) and correcting the values of that same record while
 * it is still open (`changeRecordValues`). An answer may be corrected; it may not be withdrawn — a slot must
 * hold one value, so withdrawal would be a new record without it.
 *
 * **DV-012: the fields are configured, so validation is read from the configuration.** A record is refused
 * when it answers a field its type does not ask for, when a required field goes unanswered, or when an answer
 * is written in the wrong kind for the field. The kind decides which of the three value columns is filled, so
 * an ill-typed answer would have nowhere to go.
 *
 * **DV-001 / D-013 / R-11: this master pays nobody.** There is no pay component, no run, no result, no
 * posting and no payslip here, and the reason is recorded once, in `drizzle/9193_people_record_types_and_employee.sql`:
 * the posting side waits on nothing in this slice, but it has nothing to post *until* a result exists, and a
 * result waits on the owner's decision about which jurisdiction's rules the deduction configuration models.
 * An employee screen that looked like payroll without being payroll would be the worse failure.
 *
 * The personnel number is the caller's, as supplier and customer numbers are. No number-range interval is
 * drawn for it, so the standard package keeps its version and a tenant may carry the numbering its payroll
 * provider already uses.
 */
import { and, asc, desc, eq, gt, gte, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type Tx, withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import {
  EMPLOYEE_OBJECT_CLASS,
  EMPLOYEE_RECORD_OBJECT_CLASS,
  employee,
  employeeRecord,
  recordField,
  recordFieldValue,
  recordType,
} from './schema';

// The screen contract lives in `schema.ts`, beside the tables it names; re-exported here because a service is
// where a reader looks for what its screens may do.
export { EMPLOYEE_CAPABILITY, EMPLOYEE_OBJECT_CLASS, EMPLOYEE_ROUTE, EMPLOYEE_RECORD_OBJECT_CLASS, RECORD_CAPABILITY } from './schema';

const PERSONNEL_MIN = 2;
const PERSONNEL_MAX = 20;
const NAME_MAX = 60;
const TEXT_MAX = 500;
/** The largest number `numeric(15,2)` holds: thirteen digits before the decimal point. */
const NUMBER_PATTERN = /^-?\d{1,13}(\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const code = z.string().transform((s) => s.trim().toUpperCase());
const kept = (max: number) => z.string().transform((s) => s.trim()).refine((s) => s.length > 0 && s.length <= max, { message: 'REQUIRED_TEXT' });

const personnelNumber = code.pipe(z.string().regex(/^[A-Z0-9]{2,20}$/, { message: 'PERSONNEL_FORMAT' }));

const valueInput = z.object({
  text: z.string().optional(),
  number: z.string().optional(),
  date: z.string().optional(),
}).transform((v) => {
  const filled = [v.text?.trim(), v.number?.trim(), v.date?.trim()].filter((x) => x !== undefined && x !== '');
  return filled.length === 0 ? null : v;
});

const valuesInput = z.record(z.string().transform((s) => s.trim().toUpperCase()), valueInput.optional());

const createEmployeeInput = z.object({
  client: code.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' })),
  personnelNumber,
  fullName: kept(NAME_MAX),
  isActive: z.boolean().optional().default(true),
  changedBy: kept(60),
  requestKey: z.string().trim().min(8).max(64).optional(),
});

const changeEmployeeInput = z.object({
  client: code.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' })),
  personnelNumber,
  fullName: kept(NAME_MAX).optional(),
  isActive: z.boolean().optional(),
  changedBy: kept(60),
});

const createRecordInput = z.object({
  client: code.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' })),
  personnelNumber,
  recordType: code.pipe(z.string().regex(/^[A-Z][A-Z0-9]{1,5}$/, { message: 'CODE_FORMAT' })),
  validFrom: z.string().trim(),
  values: valuesInput,
  changedBy: kept(60),
  requestKey: z.string().trim().min(8).max(64).optional(),
});

const delimitInput = z.object({
  client: code.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' })),
  personnelNumber,
  recordType: code.pipe(z.string().regex(/^[A-Z][A-Z0-9]{1,5}$/, { message: 'CODE_FORMAT' })),
  validFrom: z.string().trim(),
  validTo: z.string().trim(),
  changedBy: kept(60),
});

const changeValuesInput = z.object({
  client: code.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' })),
  personnelNumber,
  recordType: code.pipe(z.string().regex(/^[A-Z][A-Z0-9]{1,5}$/, { message: 'CODE_FORMAT' })),
  validFrom: z.string().trim(),
  values: valuesInput,
  changedBy: kept(60),
});

export interface RecordFieldValueView {
  fieldCode: string;
  label: string;
  valueKind: 'TEXT' | 'NUMBER' | 'DATE';
  /** The answer as one string, whichever column it was stored in, so a screen and a test read the same thing. */
  value: string;
}

export interface EmployeeRecordView {
  recordType: string;
  recordTypeName: string;
  validFrom: string;
  validTo: string | null;
  /** True while this record is the newest of its type and still open — the only one that may be corrected. */
  isCurrent: boolean;
  createdBy: string;
  createdAt: string;
  values: RecordFieldValueView[];
}

export interface EmployeeView {
  personnelNumber: string;
  fullName: string;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  records: EmployeeRecordView[];
}

export class EmployeeMasterError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'EmployeeMasterError';
    this.remedy = remedy;
  }
}

const REFUSALS: Record<string, [string, string]> = {
  PERSONNEL_FORMAT: [
    `A personnel number is ${PERSONNEL_MIN} to ${PERSONNEL_MAX} characters of capitals and digits.`,
    `Use the number the payroll provider already uses for the person — no interval is drawn, so it is yours to choose.`,
  ],
  CODE_FORMAT: [
    `A record type code is two to six characters, starting with a letter, written in capitals.`,
    `Pick the type from the list the configuration screen shows, or define it there first.`,
  ],
  CLIENT_FORMAT: [
    `A tenant is the two-to-four-character code the session was opened with.`,
    `Open the screen from the launchpad; the tenant comes from the session, not from the form.`,
  ],
  REQUIRED_TEXT: [
    `A name was blank or longer than ${NAME_MAX} characters.`,
    `Write the name as the contract writes it, up to ${NAME_MAX} characters.`,
  ],
  EMPLOYEE_EXISTS: [
    `An employee with that personnel number already stands in this tenant.`,
    `Read the employee and change the master, or write a new dated record — a second person cannot share a number.`,
  ],
  EMPLOYEE_UNKNOWN: [
    `No employee of that personnel number is known in this tenant.`,
    `Create the master first; a record needs the person it belongs to.`,
  ],
  TYPE_UNKNOWN: [
    `No record type of that code is defined in this tenant.`,
    `Define the type on the record-type screen first — a record is only meaningful as an answer to a defined question.`,
  ],
  TYPE_RETIRED: [
    `That record type is retired, so no new record may be written against it.`,
    `Retire it back to valid if the tenant is keeping that information again, or write the record under the type that replaced it.`,
  ],
  DATE_FORMAT: [
    `A validity date is a real calendar day in the form 2026-10-28.`,
    `Give the day the record starts to apply, as the letter that authorized it dates it.`,
  ],
  SPAN_ORDER: [
    `A record's last day cannot fall before the day it started on.`,
    `The last day is inclusive: end the record on the day it stops applying, and let the record that follows start the day after.`,
  ],
  OVERLAP: [
    `Another record of the same type already covers that date.`,
    `Delimit the record that is in the way, then write the new one from the day it stops applying. History is not overwritten, so the old record keeps standing.`,
  ],
  NOT_CURRENT: [
    `Only the newest open record of a type may be corrected in place.`,
    `Write a new record from the day the correction starts to apply; the record a newer one replaced is history and stays as it was written.`,
  ],
  ALREADY_DELIMITED: [
    `That record already has a last day, so it cannot be ended again.`,
    `Read the records of the type: the one to end is the open one, the row with no last day.`,
  ],
  UNKNOWN_FIELD: [
    `The record answers a field its type does not ask for.`,
    `Remove the answer, or add the field to the record type if the tenant has decided to keep it.`,
  ],
  MISSING_REQUIRED: [
    `A field the record type marks as required was left unanswered.`,
    `Answer every required field; a record that omits one would be read as a gap in the history rather than a choice.`,
  ],
  WRONG_KIND: [
    `An answer was given in a form its field does not accept.`,
    `A TEXT field takes words, a NUMBER field takes a plain number with at most two decimals, and a DATE field takes a day as 2026-10-28.`,
  ],
  TEXT_TOO_LONG: [
    `A text answer is longer than ${TEXT_MAX} characters.`,
    `Keep the answer short, or ask for it as a document reference instead of as text in the record.`,
  ],
  NOTHING_TO_CHANGE: [
    `The call carried nothing to change.`,
    `Give the values you want corrected, or the master's name or activity, or the day a record stops applying.`,
  ],
};

function refusal(key: string, detail?: string): never {
  const [message, remedy] = REFUSALS[key] ?? [
    `The employee master write was not accepted (${key}).`,
    `Correct the value and submit again.`,
  ];
  throw new EmployeeMasterError(detail ? `${message} ${detail}` : message, remedy);
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    refusal(first?.code === 'custom' ? String(first.message) : (first?.message ?? 'INVALID_INPUT'));
  }
  return parsed.data;
}

/** A real calendar day, and the same string it came in as: no timezone reading, no rounding. */
function dayOf(value: string): string {
  const day = value.trim();
  if (!DATE_PATTERN.test(day)) refusal('DATE_FORMAT', day);
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) refusal('DATE_FORMAT', day);
  const round = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  if (round !== day) refusal('DATE_FORMAT', day);
  return day;
}

async function employeeRow(tx: Tx, client: string, personnel: string) {
  const [row] = await tx.select().from(employee).where(and(
    eq(employee.client, client),
    eq(employee.personnelNumber, personnel),
  )).limit(1);
  return row ?? null;
}

async function fieldsOf(tx: Tx, client: string, typeValue: string) {
  return tx.select({
    code: recordField.code,
    label: recordField.label,
    valueKind: recordField.valueKind,
    isRequired: recordField.isRequired,
  }).from(recordField).where(and(
    eq(recordField.client, client),
    eq(recordField.recordType, typeValue),
  )).orderBy(asc(recordField.displayOrder), asc(recordField.code));
}

/**
 * The values a record must carry, judged against the type's field definitions. Every answer goes into the one
 * column its field's kind selects; a field the type requires must be answered; a field the type does not ask
 * for has nowhere to go.
 */
async function prepareValues(
  tx: Tx,
  client: string,
  typeValue: string,
  values: Record<string, { text?: string; number?: string; date?: string } | null | undefined>,
): Promise<Array<{ fieldCode: string; textValue: string | null; numberValue: string | null; dateValue: string | null }>> {
  const fields = await fieldsOf(tx, client, typeValue);
  const byCode = new Map(fields.map((f) => [f.code, f]));

  for (const given of Object.keys(values)) {
    if (!byCode.has(given)) refusal('UNKNOWN_FIELD', `${typeValue}.${given}`);
  }

  const out: Array<{ fieldCode: string; textValue: string | null; numberValue: string | null; dateValue: string | null }> = [];
  for (const [fieldCode, answer] of Object.entries(values)) {
    if (!answer) continue;
    const field = byCode.get(fieldCode)!;
    if (field.valueKind === 'TEXT') {
      const text = (answer.text ?? '').trim();
      if (text === '') continue;
      if (text.length > TEXT_MAX) refusal('TEXT_TOO_LONG', fieldCode);
      out.push({ fieldCode, textValue: text, numberValue: null, dateValue: null });
    } else if (field.valueKind === 'NUMBER') {
      const raw = (answer.number ?? '').trim();
      if (raw === '') continue;
      if (!NUMBER_PATTERN.test(raw)) refusal('WRONG_KIND', `${fieldCode} takes a plain number with at most two decimals: ${raw}.`);
      // The string goes to the column untouched, so 12.30 stays 12.30 and nothing passes through a float.
      out.push({ fieldCode, textValue: null, numberValue: raw, dateValue: null });
    } else {
      const raw = (answer.date ?? '').trim();
      if (raw === '') continue;
      out.push({ fieldCode, textValue: null, numberValue: null, dateValue: dayOf(raw) });
    }
  }

  const answered = new Set(out.map((v) => v.fieldCode));
  const missing = fields.filter((f) => f.isRequired && !answered.has(f.code)).map((f) => f.code);
  if (missing.length > 0) refusal('MISSING_REQUIRED', missing.join(', '));
  return out;
}

/** The records of one type for one person, newest first, with the answers each holds. */
async function recordsOf(
  tx: Tx,
  client: string,
  personnel: string,
  typeFilter?: string,
): Promise<EmployeeRecordView[]> {
  const rows = await tx.select({
    recordType: employeeRecord.recordType,
    validFrom: employeeRecord.validFrom,
    validTo: employeeRecord.validTo,
    createdBy: employeeRecord.createdBy,
    createdAt: employeeRecord.createdAt,
    typeName: recordType.name,
  }).from(employeeRecord).innerJoin(recordType, and(
    eq(recordType.client, employeeRecord.client),
    eq(recordType.code, employeeRecord.recordType),
  )).where(and(
    eq(employeeRecord.client, client),
    eq(employeeRecord.personnelNumber, personnel),
    ...(typeFilter ? [eq(employeeRecord.recordType, typeFilter)] : []),
  )).orderBy(desc(employeeRecord.validFrom), asc(employeeRecord.recordType));

  const out: EmployeeRecordView[] = [];
  // Rows arrive newest-first, so the first row seen for a type is that type's newest.
  const newestOfType = new Set<string>();
  for (const row of rows) {
    const answers = await tx.select({
      fieldCode: recordFieldValue.fieldCode,
      label: recordField.label,
      valueKind: recordField.valueKind,
      textValue: recordFieldValue.textValue,
      numberValue: recordFieldValue.numberValue,
      dateValue: recordFieldValue.dateValue,
    }).from(recordFieldValue).innerJoin(recordField, and(
      eq(recordField.client, recordFieldValue.client),
      eq(recordField.recordType, recordFieldValue.recordType),
      eq(recordField.code, recordFieldValue.fieldCode),
    )).where(and(
      eq(recordFieldValue.client, client),
      eq(recordFieldValue.personnelNumber, personnel),
      eq(recordFieldValue.recordType, row.recordType),
      eq(recordFieldValue.validFrom, row.validFrom),
    )).orderBy(asc(recordField.displayOrder), asc(recordField.code));

    out.push({
      recordType: row.recordType,
      recordTypeName: row.typeName,
      validFrom: row.validFrom,
      validTo: row.validTo ?? null,
      // The newest of its type and still open: the only record this slice lets be corrected in place.
      isCurrent: row.validTo === null && !newestOfType.has(row.recordType),
      createdBy: row.createdBy,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      values: answers.map((a) => ({
        fieldCode: a.fieldCode,
        label: a.label,
        valueKind: a.valueKind as 'TEXT' | 'NUMBER' | 'DATE',
        value: a.textValue ?? a.numberValue ?? a.dateValue ?? '',
      })),
    });
    newestOfType.add(row.recordType);
  }
  return out;
}

function viewOf(master: typeof employee.$inferSelect, records: EmployeeRecordView[]): EmployeeView {
  return {
    personnelNumber: master.personnelNumber,
    fullName: master.fullName,
    isActive: master.isActive,
    createdBy: master.createdBy,
    createdAt: master.createdAt instanceof Date ? master.createdAt.toISOString() : String(master.createdAt),
    records,
  };
}

/**
 * Create an employee, or read back the one a repeat of the same `requestKey` already created. Nothing else is
 * carried here but the name and whether the number is in use: what is known about the person is a record.
 */
export async function createEmployee(input: unknown): Promise<EmployeeView> {
  const parsed = parse(createEmployeeInput, input);
  await withTenant(parsed.client, async (tx) => {
    const standing = await employeeRow(tx, parsed.client, parsed.personnelNumber);
    if (standing) {
      if (parsed.requestKey && standing.requestKey === parsed.requestKey) return undefined; // replay: the row stands
      refusal('EMPLOYEE_EXISTS', parsed.personnelNumber);
    }
    try {
      await tx.insert(employee).values({
        client: parsed.client,
        personnelNumber: parsed.personnelNumber,
        fullName: parsed.fullName,
        isActive: parsed.isActive,
        requestKey: parsed.requestKey ?? null,
        createdBy: parsed.changedBy,
      });
    } catch (caught) {
      if (typeof caught === 'object' && caught !== null && 'code' in caught && caught.code === '23505') {
        refusal('EMPLOYEE_EXISTS', `${parsed.personnelNumber} was created in the same moment.`);
      }
      throw caught;
    }
    await recordChange(tx, {
      client: parsed.client,
      objectClass: EMPLOYEE_OBJECT_CLASS,
      objectKey: parsed.personnelNumber,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: { personnelNumber: parsed.personnelNumber, fullName: parsed.fullName, isActive: parsed.isActive },
    });
    return undefined;
  });
  return getEmployee(parsed.client, parsed.personnelNumber);
}

/**
 * Change the master — the name, or whether the number is in use. Employment data is never changed here: that
 * is a new dated record, because §8.10 does not let a history row be overwritten.
 */
export async function changeEmployee(input: unknown): Promise<EmployeeView> {
  const parsed = parse(changeEmployeeInput, input);
  const patch: { fullName?: string; isActive?: boolean } = {};
  if (parsed.fullName) patch.fullName = parsed.fullName;
  if (parsed.isActive !== undefined) patch.isActive = parsed.isActive;
  if (Object.keys(patch).length === 0) refusal('NOTHING_TO_CHANGE');

  await withTenant(parsed.client, async (tx) => {
    const standing = await employeeRow(tx, parsed.client, parsed.personnelNumber);
    if (!standing) refusal('EMPLOYEE_UNKNOWN', parsed.personnelNumber);
    await tx.update(employee).set({ ...patch, changedBy: parsed.changedBy, changedAt: new Date() }).where(and(
      eq(employee.client, parsed.client),
      eq(employee.personnelNumber, parsed.personnelNumber),
    ));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: EMPLOYEE_OBJECT_CLASS,
      objectKey: parsed.personnelNumber,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      before: { fullName: standing!.fullName, isActive: standing!.isActive },
      after: patch,
    });
    return undefined;
  });
  return getEmployee(parsed.client, parsed.personnelNumber);
}

/** The employee with every record they hold, newest first. */
export async function getEmployee(clientInput: string, personnelInput: string): Promise<EmployeeView> {
  const client = parse(z.string(), clientInput).trim();
  const personnel = personnelInput.trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const master = await employeeRow(tx, client, personnel);
    if (!master) refusal('EMPLOYEE_UNKNOWN', personnel);
    return viewOf(master, await recordsOf(tx, client, personnel));
  });
}

/** The tenant's employees, with the count of records each holds. `query` is a name or number fragment. */
export async function listEmployees(clientInput: string, query?: string): Promise<Array<Omit<EmployeeView, 'records'> & { recordCount: number }>> {
  const client = parse(z.string(), clientInput).trim();
  const needle = (query ?? '').trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      personnelNumber: employee.personnelNumber,
      fullName: employee.fullName,
      isActive: employee.isActive,
      createdBy: employee.createdBy,
      createdAt: employee.createdAt,
      recordCount: sql<number>`(
        select count(*)::int from public.employee_record r
         where r.client = ${employee.client} and r.personnel_number = ${employee.personnelNumber})`.as('record_count'),
    }).from(employee).where(and(
      eq(employee.client, client),
      ...(needle === '' ? [] : [or(
        sql`${employee.personnelNumber} like ${`%${needle}%`}`,
        sql`upper(${employee.fullName}) like ${`%${needle}%`}`,
      )!]),
    )).orderBy(asc(employee.personnelNumber)).limit(200);
    return rows.map((row) => ({
      personnelNumber: row.personnelNumber,
      fullName: row.fullName,
      isActive: row.isActive,
      createdBy: row.createdBy,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      recordCount: Number(row.recordCount),
    }));
  });
}

/**
 * Write a dated record and its answers. The advisory lock spans the overlap test and the insert, because two
 * clerks dating records of the same type for the same person in the same moment would otherwise both find the
 * span free; the primary key on the from-date is the backstop, not the message.
 */
export async function createRecord(input: unknown): Promise<EmployeeRecordView> {
  const parsed = parse(createRecordInput, input);
  const from = dayOf(parsed.validFrom);

  await withTenant(parsed.client, async (tx) => {
    if (!(await employeeRow(tx, parsed.client, parsed.personnelNumber))) refusal('EMPLOYEE_UNKNOWN', parsed.personnelNumber);
    const [type] = await tx.select().from(recordType).where(and(
      eq(recordType.client, parsed.client),
      eq(recordType.code, parsed.recordType),
    )).limit(1);
    if (!type) refusal('TYPE_UNKNOWN', parsed.recordType);
    if (!type!.isValid) refusal('TYPE_RETIRED', parsed.recordType);

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
      `${parsed.client}/employee-record/${parsed.personnelNumber}/${parsed.recordType}`}, 0))`);

    // A replay of the same key finds the record that stands and reports it instead of writing a second one.
    if (parsed.requestKey) {
      const [replay] = await tx.select().from(employeeRecord).where(and(
        eq(employeeRecord.client, parsed.client),
        eq(employeeRecord.personnelNumber, parsed.personnelNumber),
        eq(employeeRecord.recordType, parsed.recordType),
        eq(employeeRecord.requestKey, parsed.requestKey),
      )).limit(1);
      if (replay) return undefined;
    }

    // A record is in the way when it is still open (it runs to infinity, so it covers any date from its own
    // onward) or when it ends after the day the new record would start. A record that ended on or before that
    // day is history, and writing over a closed span is exactly what the dated-record rule is for.
    const blocking = await tx.select({
      validFrom: employeeRecord.validFrom,
      validTo: employeeRecord.validTo,
    }).from(employeeRecord).where(and(
      eq(employeeRecord.client, parsed.client),
      eq(employeeRecord.personnelNumber, parsed.personnelNumber),
      eq(employeeRecord.recordType, parsed.recordType),
      or(isNull(employeeRecord.validTo), gte(employeeRecord.validTo, from)),
    )).orderBy(desc(employeeRecord.validFrom)).limit(1);
    const clash = blocking[0];
    if (clash) {
      refusal('OVERLAP', `${parsed.recordType} from ${clash.validFrom} to ${clash.validTo ?? 'open'} already covers ${from}.`);
    }

    const values = await prepareValues(tx, parsed.client, parsed.recordType, parsed.values);

    try {
      await tx.insert(employeeRecord).values({
        client: parsed.client,
        personnelNumber: parsed.personnelNumber,
        recordType: parsed.recordType,
        validFrom: from,
        validTo: null,
        requestKey: parsed.requestKey ?? null,
        createdBy: parsed.changedBy,
      });
    } catch (caught) {
      if (typeof caught === 'object' && caught !== null && 'code' in caught && caught.code === '23505') {
        refusal('OVERLAP', `a record of ${parsed.recordType} from ${from} was written in the same moment.`);
      }
      throw caught;
    }
    for (const value of values) {
      await tx.insert(recordFieldValue).values({
        client: parsed.client,
        personnelNumber: parsed.personnelNumber,
        recordType: parsed.recordType,
        validFrom: from,
        ...value,
        createdBy: parsed.changedBy,
      });
    }

    await recordChange(tx, {
      client: parsed.client,
      objectClass: EMPLOYEE_RECORD_OBJECT_CLASS,
      objectKey: `${parsed.personnelNumber}/${parsed.recordType}/${from}`,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: { recordType: parsed.recordType, validFrom: from, validTo: null },
      fieldLabels: Object.fromEntries(values.map((v) => [v.fieldCode, v.fieldCode])),
    });
    return undefined;
  });

  const view = await getEmployee(parsed.client, parsed.personnelNumber);
  const record = view.records.find((r) => r.recordType === parsed.recordType && r.validFrom === from);
  if (!record) {
    throw new EmployeeMasterError(
      `The record of ${parsed.recordType} from ${from} is not readable after it was written.`,
      `Read the employee again; if the record does not appear, the write did not commit.`,
    );
  }
  return record;
}

/**
 * End a record: write its last day, once. Only the open record of a type can be ended, and the day has to be
 * later than the one it started on — a record that never applied is not a record.
 */
export async function delimitRecord(input: unknown): Promise<EmployeeRecordView> {
  const parsed = parse(delimitInput, input);
  const from = dayOf(parsed.validFrom);
  const to = dayOf(parsed.validTo);

  await withTenant(parsed.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
      `${parsed.client}/employee-record/${parsed.personnelNumber}/${parsed.recordType}`}, 0))`);
    const [standing] = await tx.select().from(employeeRecord).where(and(
      eq(employeeRecord.client, parsed.client),
      eq(employeeRecord.personnelNumber, parsed.personnelNumber),
      eq(employeeRecord.recordType, parsed.recordType),
      eq(employeeRecord.validFrom, from),
    )).limit(1);
    if (!standing) {
      refusal('TYPE_UNKNOWN', `no record of ${parsed.recordType} from ${from} stands for ${parsed.personnelNumber}.`);
    }
    if (standing!.validTo !== null) refusal('ALREADY_DELIMITED');
    if (!(to >= from)) refusal('SPAN_ORDER');
    const [newer] = await tx.select({ validFrom: employeeRecord.validFrom }).from(employeeRecord).where(and(
      eq(employeeRecord.client, parsed.client),
      eq(employeeRecord.personnelNumber, parsed.personnelNumber),
      eq(employeeRecord.recordType, parsed.recordType),
      gt(employeeRecord.validFrom, from),
    )).limit(1);
    if (newer) {
      refusal('NOT_CURRENT', `a record from ${newer.validFrom} of the same type is already newer.`);
    }

    await tx.update(employeeRecord).set({ validTo: to, changedBy: parsed.changedBy, changedAt: new Date() }).where(and(
      eq(employeeRecord.client, parsed.client),
      eq(employeeRecord.personnelNumber, parsed.personnelNumber),
      eq(employeeRecord.recordType, parsed.recordType),
      eq(employeeRecord.validFrom, from),
    ));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: EMPLOYEE_RECORD_OBJECT_CLASS,
      objectKey: `${parsed.personnelNumber}/${parsed.recordType}/${from}`,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      reason: 'record delimited',
      before: { validTo: null },
      after: { validTo: to },
    });
    return undefined;
  });

  const view = await getEmployee(parsed.client, parsed.personnelNumber);
  const record = view.records.find((r) => r.recordType === parsed.recordType && r.validFrom === from);
  if (!record) throw new EmployeeMasterError(`The record of ${parsed.recordType} from ${from} is not readable.`, `Read the employee again.`);
  return record;
}

/**
 * Correct the answers of the newest open record of a type. This is the one in-place write the dated-record
 * rule tolerates, and only while the record is current: once a newer record of the same type stands, the
 * correction has to be a new record, or the history two clerks read would change under them.
 */
export async function changeRecordValues(input: unknown): Promise<EmployeeRecordView> {
  const parsed = parse(changeValuesInput, input);
  const from = dayOf(parsed.validFrom);

  await withTenant(parsed.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
      `${parsed.client}/employee-record/${parsed.personnelNumber}/${parsed.recordType}`}, 0))`);
    const [standing] = await tx.select().from(employeeRecord).where(and(
      eq(employeeRecord.client, parsed.client),
      eq(employeeRecord.personnelNumber, parsed.personnelNumber),
      eq(employeeRecord.recordType, parsed.recordType),
      eq(employeeRecord.validFrom, from),
    )).limit(1);
    if (!standing) refusal('TYPE_UNKNOWN', `no record of ${parsed.recordType} from ${from} stands for ${parsed.personnelNumber}.`);
    const [newer] = await tx.select({ validFrom: employeeRecord.validFrom }).from(employeeRecord).where(and(
      eq(employeeRecord.client, parsed.client),
      eq(employeeRecord.personnelNumber, parsed.personnelNumber),
      eq(employeeRecord.recordType, parsed.recordType),
      gt(employeeRecord.validFrom, from),
    )).limit(1);
    if (newer || standing!.validTo !== null) refusal('NOT_CURRENT');

    const before = await tx.select({
      fieldCode: recordFieldValue.fieldCode,
      textValue: recordFieldValue.textValue,
      numberValue: recordFieldValue.numberValue,
      dateValue: recordFieldValue.dateValue,
    }).from(recordFieldValue).where(and(
      eq(recordFieldValue.client, parsed.client),
      eq(recordFieldValue.personnelNumber, parsed.personnelNumber),
      eq(recordFieldValue.recordType, parsed.recordType),
      eq(recordFieldValue.validFrom, from),
    ));
    // The record as it will stand: what is given replaces the answer to that field, what is not given keeps
    // the answer it had, because withdrawal of an answer is a new record and not an edit.
    const merged: Record<string, { text?: string; number?: string; date?: string } | null> = {};
    for (const row of before) {
      merged[row.fieldCode] = { text: row.textValue ?? undefined, number: row.numberValue ?? undefined, date: row.dateValue ?? undefined };
    }
    for (const [fieldCode, answer] of Object.entries(parsed.values)) {
      // An empty box is the clerk leaving that answer alone, not withdrawing it: withdrawal has no
      // representation in a slot that must hold exactly one value, and history is written by a new record.
      if (answer) merged[fieldCode] = answer;
    }
    const values = await prepareValues(tx, parsed.client, parsed.recordType, merged);

    for (const value of values) {
      await tx.update(recordFieldValue).set({
        textValue: value.textValue,
        numberValue: value.numberValue,
        dateValue: value.dateValue,
        changedBy: parsed.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(recordFieldValue.client, parsed.client),
        eq(recordFieldValue.personnelNumber, parsed.personnelNumber),
        eq(recordFieldValue.recordType, parsed.recordType),
        eq(recordFieldValue.validFrom, from),
        eq(recordFieldValue.fieldCode, value.fieldCode),
      ));
    }
    // A field the record never answered is answered for the first time here; a new column is all it takes.
    const standingCodes = new Set(before.map((row) => row.fieldCode));
    for (const value of values) {
      if (standingCodes.has(value.fieldCode)) continue;
      await tx.insert(recordFieldValue).values({
        client: parsed.client,
        personnelNumber: parsed.personnelNumber,
        recordType: parsed.recordType,
        validFrom: from,
        ...value,
        createdBy: parsed.changedBy,
      });
    }

    await recordChange(tx, {
      client: parsed.client,
      objectClass: EMPLOYEE_RECORD_OBJECT_CLASS,
      objectKey: `${parsed.personnelNumber}/${parsed.recordType}/${from}`,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      reason: 'record values corrected',
      before: Object.fromEntries(before.map((row) => [row.fieldCode, row.textValue ?? row.numberValue ?? row.dateValue ?? null])),
      after: Object.fromEntries(values.map((v) => [v.fieldCode, v.textValue ?? v.numberValue ?? v.dateValue ?? null])),
    });
    return undefined;
  });

  const view = await getEmployee(parsed.client, parsed.personnelNumber);
  const record = view.records.find((r) => r.recordType === parsed.recordType && r.validFrom === from);
  if (!record) throw new EmployeeMasterError(`The record of ${parsed.recordType} from ${from} is not readable.`, `Read the employee again.`);
  return record;
}
