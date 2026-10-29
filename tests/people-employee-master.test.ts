import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  EMPLOYEE_CAPABILITY,
  RECORD_CAPABILITY,
  changeEmployee,
  changeRecordValues,
  createEmployee,
  createRecord,
  delimitRecord,
  getEmployee,
  listEmployees,
} from '../src/modules/people/employee-master';
import {
  RECORD_TYPE_CAPABILITY,
  RecordTypeConfigError,
  addRecordField,
  changeRecordField,
  changeRecordType,
  defineRecordType,
  getRecordType,
  listRecordTypes,
} from '../src/modules/people/record-types';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * The People slice 1 — a record type, an employee, and what is known about them as of a date.
 *
 * Nothing is mocked: the record type is defined by the configuration service the config screen calls, the
 * employee and the dated record by the services `/people/employees` calls, and every promise is checked
 * against what the tenant reads back afterwards. Four assertions carry the weight of the slice:
 *
 *   1. a record is never overwritten — a superseded record reads back as it was written, both after a newer
 *      record of the same type stands beside it and after a correction is attempted on it;
 *   2. the application cannot delete history at all, which is a privilege question and not a code question,
 *      so it is tested against the database the way `migration-grant-policy` tests the others;
 *   3. a field's kind decides which column its answer lives in, so an ill-typed answer is refused rather than
 *      quietly kept as text, and a number keeps the two places it was given;
 *   4. a value already stored is not forced onto history when a type later requires a new field: the old
 *      record keeps standing, and the next one written has to answer it.
 *
 * Each block creates its own employee, so no block depends on the span another one left open — except where
 * the point is that a span is open and has to be ended first.
 */
const ACTOR = 'PEOPLE_9193_TEST';
// A number the first tenant has never used: `numberFor()` starts at T9000001, so borrowing a number it hands
// out would prove nothing about isolation.
const FOREIGN_PERSON = 'T9100001';
const TYPE = 'PERSGR';
const FAMTYPE = 'FAMDT';
const REQTYPE = 'REQDT';

let tenant: TestTenant;
let other: TestTenant;
let counter = 0;
const key = (what: string) => `ppl9193-${what}-${++counter}`;
const numberFor = () => `T${String(9000000 + ++counter)}`;

async function person(label: string): Promise<string> {
  const personnelNumber = numberFor();
  await createEmployee({
    client: tenant.client,
    personnelNumber,
    fullName: `Test Person ${label}`,
    changedBy: ACTOR,
    requestKey: key(`emp-${label}`),
  });
  return personnelNumber;
}

/** The type used by most blocks: a required text field, an optional date, an optional two-decimal number. */
async function definePersonalDataType(client = tenant.client) {
  return defineRecordType({
    client,
    code: TYPE,
    name: 'Personal data',
    description: 'What the tenant keeps about a person besides their name.',
    changedBy: ACTOR,
    fields: [
      { code: 'NACHN', label: 'Last name', valueKind: 'TEXT', isRequired: true, displayOrder: 10 },
      { code: 'GEBDT', label: 'Date of birth', valueKind: 'DATE', displayOrder: 20 },
      { code: 'KIDS', label: 'Children entitled', valueKind: 'NUMBER', displayOrder: 30 },
    ],
  });
}

const answer = (fieldCode: string, value: string) => ({ [fieldCode]: { text: value, number: value, date: value } });

async function writeRecord(
  personnelNumber: string,
  validFrom: string,
  values: Record<string, { text?: string; number?: string; date?: string }>,
  recordType = TYPE,
) {
  return createRecord({
    client: tenant.client,
    personnelNumber,
    recordType,
    validFrom,
    values,
    changedBy: ACTOR,
    requestKey: key(`rec-${personnelNumber}-${validFrom}`),
  });
}

describe('people employee master and record types (9193)', () => {
  beforeAll(async () => {
    tenant = await createTenant('people-9193', { currency: 'INR' });
    other = await createTenant('people-9193-b', { currency: 'INR' });
    await definePersonalDataType();
  }, 180_000);

  afterAll(async () => {
    // The helper takes the client code, not the record: handing it the tenant object fails inside the cleanup
    // and leaves the fixture key claimed for the next run.
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
  }, 180_000);

  it('defines a type whose fields carry the kind that decides how an answer is stored', async () => {
    const type = await getRecordType(tenant.client, TYPE);
    expect(type.code).toBe(TYPE);
    expect(type.name).toBe('Personal data');
    expect(type.isValid).toBe(true);
    expect(type.recordsStanding).toBe(0);
    expect(type.fields.map((f) => f.code)).toEqual(['NACHN', 'GEBDT', 'KIDS']);
    expect(type.fields[0]).toMatchObject({ valueKind: 'TEXT', isRequired: true, displayOrder: 10 });
    expect(type.fields[2]).toMatchObject({ valueKind: 'NUMBER', isRequired: false });

    const listed = await listRecordTypes(tenant.client);
    expect(listed.map((t) => t.code)).toEqual([TYPE]);
  });

  it('refuses a second definition of a code that stands, and one that lists a field twice', async () => {
    await expect(definePersonalDataType()).rejects.toThrow(RecordTypeConfigError);
    await expect(definePersonalDataType()).rejects.toThrow(/already defined in this tenant/);

    await expect(defineRecordType({
      client: tenant.client, code: 'DUPFLD', name: 'Duplicate fields', changedBy: ACTOR,
      fields: [
        { code: 'AAA', label: 'One', valueKind: 'TEXT' },
        { code: 'AAA', label: 'Again', valueKind: 'NUMBER' },
      ],
    })).rejects.toThrow(/same field code was given twice/);
    // The refusal wrote nothing: a type is defined with its fields or not at all.
    await expect(getRecordType(tenant.client, 'DUPFLD')).rejects.toThrow(/No record type of that code/);

    await expect(defineRecordType({
      client: tenant.client, code: 'BAD CODE', name: 'Lower case', changedBy: ACTOR,
      fields: [{ code: 'AAA', label: 'One', valueKind: 'TEXT' }],
    })).rejects.toThrow(/two to six characters, starting with a letter/);
  });

  it('judges an answer against the kind its field declares, and stores it in that kind\u2019s column', async () => {
    const who = await person('kinds');
    await expect(writeRecord(who, '2026-05-01', { NACHN: { text: 'x'.repeat(501) } }))
      .rejects.toThrow(/longer than 500 characters/);
    await expect(writeRecord(who, '2026-05-01', { ...answer('NACHN', 'Decimal Person'), KIDS: { number: '1.234' } }))
      .rejects.toThrow(/form its field does not accept/);
    await expect(writeRecord(who, '2026-05-01', { ...answer('NACHN', 'Leap Person'), GEBDT: { date: '2026-02-30' } }))
      .rejects.toThrow(/real calendar day/);
    await expect(writeRecord(who, '2026-05-01', answer('GEBDT', '1990-01-31')))
      .rejects.toThrow(/marks as required was left unanswered/);
    await expect(writeRecord(who, '2026-05-01', { NACHN: { text: 'Ghost' }, NOPE1: { text: 'nobody asked' } }))
      .rejects.toThrow(/answers a field its type does not ask for/);

    const written = await writeRecord(who, '2026-05-01', {
      NACHN: { text: ' Dated Person ' }, GEBDT: { date: '1990-02-28' }, KIDS: { number: '2' },
    });
    expect(written.recordType).toBe(TYPE);
    expect(written.isCurrent).toBe(true);
    // The text answer is trimmed and the number keeps the two places `numeric(15,2)` stands, so a later reader
    // sums the same figures the clerk typed.
    expect(written.values.map((v) => [v.fieldCode, v.value])).toEqual([
      ['NACHN', 'Dated Person'], ['GEBDT', '1990-02-28'], ['KIDS', '2.00'],
    ]);

    const stored = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select field_code,
             text_value is not null as text_used,
             number_value is not null as number_used,
             date_value is not null as date_used,
             coalesce(to_char(date_value, 'YYYY-MM-DD'), '') as date_text
        from record_field_value
       where client = ${tenant.client} and personnel_number = ${who}
         and record_type = ${TYPE} and valid_from = date '2026-05-01'
       order by field_code`));
    expect((stored as Array<Record<string, unknown>>).map((r) => [r.field_code, r.text_used, r.number_used, r.date_used, r.date_text])).toEqual([
      ['GEBDT', false, false, true, '1990-02-28'],
      ['KIDS', false, true, false, ''],
      ['NACHN', true, false, false, ''],
    ]);
  });

  it('does not force a value onto history when the type later requires a new field', async () => {
    const who = await person('required');
    const standing = await writeRecord(who, '2026-01-01', answer('NACHN', 'Standing Name'));
    expect(standing.values).toHaveLength(1);

    // The field arrives in the type with history already written under it.
    await addRecordField({
      client: tenant.client, recordType: TYPE, code: 'ZABGR', label: 'Tax bracket',
      valueKind: 'TEXT', isRequired: true, changedBy: ACTOR,
    });
    const after = await getRecordType(tenant.client, TYPE);
    // Every record the earlier blocks wrote under this type counts here, so the figure is a floor rather than
    // an exact: what the assertion carries is that the type's standing history is undisturbed by the new field.
    expect(after.recordsStanding).toBeGreaterThanOrEqual(1);
    expect(after.fields[3]).toMatchObject({ code: 'ZABGR', isRequired: true });
    expect(after.fields[3].displayOrder).toBeGreaterThan(after.fields[2].displayOrder);

    // The record already standing is neither rewritten nor hidden by that decision...
    const read = await getEmployee(tenant.client, who);
    expect(read.records[0].values.map((v) => v.fieldCode)).toEqual(['NACHN']);
    // ...it simply cannot be corrected until the new question is answered, because the correction has to leave
    // a record that answers everything its type requires.
    await expect(changeRecordValues({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2026-01-01',
      values: answer('NACHN', 'Corrected Name'), changedBy: ACTOR,
    })).rejects.toThrow(/marks as required was left unanswered/);
    const filled = await changeRecordValues({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2026-01-01',
      values: { ...answer('NACHN', 'Corrected Name'), ...answer('ZABGR', 'bracket 2') }, changedBy: ACTOR,
    });
    expect(filled.values.map((v) => [v.fieldCode, v.value])).toEqual([['NACHN', 'Corrected Name'], ['ZABGR', 'bracket 2']]);
    expect(filled.isCurrent).toBe(true);

    // A field that answers stand may not be re-typed: its value lives in the column its kind picks.
    await expect(changeRecordField({
      client: tenant.client, recordType: TYPE, code: 'NACHN', valueKind: 'NUMBER', changedBy: ACTOR,
    })).rejects.toThrow(/value kind cannot be changed while records answer/);
    // The count behind the refusal is per field, over every record the tenant holds under the type — so it is
    // read as a floor here, and the zero case is proved on a type nobody has answered yet.
    const answeredCounts = await getRecordType(tenant.client, TYPE);
    expect(answeredCounts.fields.find((f) => f.code === 'NACHN')?.valuesStanding).toBeGreaterThanOrEqual(1);
    expect(answeredCounts.fields.find((f) => f.code === 'GEBDT')?.valuesStanding).toBeGreaterThanOrEqual(1);
    await defineRecordType({
      client: tenant.client, code: 'ZEDT', name: 'Empty type', changedBy: ACTOR,
      fields: [{ code: 'NOTHING', label: 'Nobody answered this', valueKind: 'TEXT' }],
    });
    const untouchedType = await getRecordType(tenant.client, 'ZEDT');
    expect(untouchedType.recordsStanding).toBe(0);
    expect(untouchedType.fields[0].valuesStanding).toBe(0);
    // A kind may still be moved on a field nothing answers, which is what makes the refusal above a guard and
    // not a blanket ban on correcting a definition.
    const retyped = await changeRecordField({
      client: tenant.client, recordType: 'ZEDT', code: 'NOTHING', valueKind: 'DATE', changedBy: ACTOR,
    });
    expect(retyped.fields[0].valueKind).toBe('DATE');

    // Undo the requirement so the blocks that follow are not chained to this decision.
    await changeRecordField({
      client: tenant.client, recordType: TYPE, code: 'ZABGR', isRequired: false, changedBy: ACTOR,
    });
  });

  it('treats a change as a new dated record, never as an overwrite', async () => {
    const who = await person('dated');
    const first = await writeRecord(who, '2026-07-01', { ...answer('NACHN', 'First Name'), ...answer('KIDS', '1') });
    expect(first.isCurrent).toBe(true);

    // The same day twice is the same record; a later day is still inside an open span.
    await expect(writeRecord(who, '2026-07-01', answer('NACHN', 'Same Day')))
      .rejects.toThrow(/already covers that date|written in the same moment/);
    await expect(writeRecord(who, '2026-09-01', answer('NACHN', 'Later, still inside')))
      .rejects.toThrow(/already covers that date/);

    // The open record has to be ended before a newer one can start, and a record cannot end before the day it
    // began, nor be ended twice.
    await expect(delimitRecord({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2026-07-01',
      validTo: '2026-06-30', changedBy: ACTOR,
    })).rejects.toThrow(/last day cannot fall before the day it started/);
    const ended = await delimitRecord({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2026-07-01',
      validTo: '2026-09-30', changedBy: ACTOR,
    });
    expect(ended.validTo).toBe('2026-09-30');
    expect(ended.isCurrent).toBe(false);
    await expect(delimitRecord({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2026-07-01',
      validTo: '2026-12-31', changedBy: ACTOR,
    })).rejects.toThrow(/already has a last day/);

    // A record the tenant has never heard of cannot be delimited.
    await expect(delimitRecord({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2020-01-01',
      validTo: '2020-12-31', changedBy: ACTOR,
    })).rejects.toThrow(/no record of PERSGR from 2020-01-01 stands/);

    const second = await writeRecord(who, '2026-10-01', { ...answer('NACHN', 'Second Name'), ...answer('KIDS', '2') });
    expect(second.isCurrent).toBe(true);

    const read = await getEmployee(tenant.client, who);
    const dated = read.records.filter((r) => r.recordType === TYPE);
    expect(dated.map((r) => [r.validFrom, r.validTo, r.isCurrent])).toEqual([
      ['2026-10-01', null, true],
      ['2026-07-01', '2026-09-30', false],
    ]);
    // The replaced record reads back exactly as it was written, which is the whole point of the dated shape.
    expect(dated[1].values.map((v) => [v.fieldCode, v.value])).toEqual([['NACHN', 'First Name'], ['KIDS', '1.00']]);
    expect(dated[0].isCurrent).toBe(true);
    expect(dated[0].values.find((v) => v.fieldCode === 'KIDS')?.value).toBe('2.00');

    // The span is inclusive at both ends, so the day a record ends on is still that record's day, and a day
    // inside a closed span is a fact rather than a gap waiting to be filled.
    await expect(writeRecord(who, '2026-09-30', answer('NACHN', 'Boundary Day')))
      .rejects.toThrow(/already covers that date/);
    await expect(writeRecord(who, '2026-09-15', answer('NACHN', 'Inside The Span')))
      .rejects.toThrow(/already covers that date/);

    // The open record has to end before anything after it can start; then a one-day record is legal, because
    // its span covers exactly the day it names, and the day after that is free again.
    await delimitRecord({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2026-10-01',
      validTo: '2027-01-04', changedBy: ACTOR,
    });
    await writeRecord(who, '2027-01-05', answer('NACHN', 'One Day Only'));
    const closed = await delimitRecord({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2027-01-05',
      validTo: '2027-01-05', changedBy: ACTOR,
    });
    expect(closed).toMatchObject({ validFrom: '2027-01-05', validTo: '2027-01-05', isCurrent: false });
    const after = await writeRecord(who, '2027-01-06', answer('NACHN', 'The Day After'));
    expect(after.isCurrent).toBe(true);

    // Every span a clerk wrote stands, in the order a payroll reader would ask for them, each with the answers
    // it was written with. Nothing here was ever rewritten or removed.
    const final = await getEmployee(tenant.client, who);
    expect(final.records.filter((r) => r.recordType === TYPE).map((r) => [r.validFrom, r.validTo, r.isCurrent])).toEqual([
      ['2027-01-06', null, true],
      ['2027-01-05', '2027-01-05', false],
      ['2026-10-01', '2027-01-04', false],
      ['2026-07-01', '2026-09-30', false],
    ]);
  });

  it('corrects the newest open record and refuses to touch one a newer record replaced', async () => {
    const who = await person('corrections');
    await writeRecord(who, '2027-01-01', { ...answer('NACHN', 'Typo Person'), ...answer('KIDS', '3') });

    const corrected = await changeRecordValues({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2027-01-01', changedBy: ACTOR,
      values: { ...answer('NACHN', 'Fixed Person'), ...answer('GEBDT', '1988-07-04') },
    });
    expect(corrected.values.map((v) => [v.fieldCode, v.value])).toEqual([
      ['NACHN', 'Fixed Person'], ['GEBDT', '1988-07-04'], ['KIDS', '3.00'],
    ]);

    // An empty box leaves the answer alone rather than blanking it: a slot holds exactly one value, so
    // withdrawing an answer is a new record and not an edit.
    const untouched = await changeRecordValues({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2027-01-01', changedBy: ACTOR,
      values: { KIDS: { text: '   ', number: '   ', date: '   ' } },
    });
    expect(untouched.values.find((v) => v.fieldCode === 'KIDS')?.value).toBe('3.00');
    expect(untouched.values.find((v) => v.fieldCode === 'NACHN')?.value).toBe('Fixed Person');

    // Once a newer record stands, the one it replaced is history: not corrected, not re-delimited.
    await delimitRecord({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2027-01-01',
      validTo: '2027-05-31', changedBy: ACTOR,
    });
    await writeRecord(who, '2027-06-01', answer('NACHN', 'Newer Person'));
    await expect(changeRecordValues({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2027-01-01', changedBy: ACTOR,
      values: answer('NACHN', 'Rewritten history'),
    })).rejects.toThrow(/newest open record of a type may be corrected/);
    await expect(delimitRecord({
      client: tenant.client, personnelNumber: who, recordType: TYPE, validFrom: '2027-01-01',
      validTo: '2027-05-31', changedBy: ACTOR,
    })).rejects.toThrow(/already has a last day|newer record of the same type is already newer/);
    const read = await getEmployee(tenant.client, who);
    expect(read.records.find((r) => r.validFrom === '2027-01-01')?.values.find((v) => v.fieldCode === 'NACHN')?.value)
      .toBe('Fixed Person');
  });

  it('changes the master and only the master', async () => {
    const who = await person('master');
    await writeRecord(who, '2026-01-01', answer('NACHN', 'Original Surname'));

    const changed = await changeEmployee({
      client: tenant.client, personnelNumber: who, fullName: 'Renamed Person', isActive: false, changedBy: ACTOR,
    });
    expect(changed.fullName).toBe('Renamed Person');
    expect(changed.isActive).toBe(false);
    // The dated record is untouched by a master change, in both directions.
    expect(changed.records[0]).toMatchObject({ validFrom: '2026-01-01', isCurrent: true });
    expect(changed.records[0].values[0].value).toBe('Original Surname');

    await expect(changeEmployee({ client: tenant.client, personnelNumber: who, changedBy: ACTOR }))
      .rejects.toThrow(/carried nothing to change/i);
    await expect(changeEmployee({ client: tenant.client, personnelNumber: '00009999', fullName: 'Ghost', changedBy: ACTOR }))
      .rejects.toThrow(/No employee of that personnel number/);
    // The name is the master's; a surname is a record, and this module will not let the two be confused.
    expect((await getEmployee(tenant.client, who)).records).toHaveLength(1);
  });

  it('replays a repeated request key as the standing employee and refuses a second person on the number', async () => {
    const personnelNumber = numberFor();
    const requestKey = key('replay');
    const created = await createEmployee({
      client: tenant.client, personnelNumber, fullName: 'Repeat Person', changedBy: ACTOR, requestKey,
    });
    expect(created.records).toEqual([]);
    const replay = await createEmployee({
      client: tenant.client, personnelNumber, fullName: 'Repeat Person', changedBy: ACTOR, requestKey,
    });
    expect(replay.personnelNumber).toBe(personnelNumber);
    expect((await listEmployees(tenant.client, 'REPEAT PERSON')).filter((e) => e.personnelNumber === personnelNumber)).toHaveLength(1);

    await expect(createEmployee({
      client: tenant.client, personnelNumber, fullName: 'Someone Else', changedBy: ACTOR, requestKey: key('other'),
    })).rejects.toThrow(/already stands in this tenant/);
    await expect(createEmployee({
      client: tenant.client, personnelNumber: 'A', fullName: 'Short', changedBy: ACTOR,
    })).rejects.toThrow(/personnel number is 2 to 20 characters/);
    await expect(createEmployee({
      client: tenant.client, personnelNumber: numberFor(), fullName: '   ', changedBy: ACTOR,
    })).rejects.toThrow(/name was blank or longer/i);
    // The list is a search over numbers and names, and it is bounded like every other list in the system.
    const all = await listEmployees(tenant.client);
    expect(all.length).toBeGreaterThan(4);
    expect(all.every((e) => typeof e.recordCount === 'number')).toBe(true);
  });

  it('refuses a record for an unknown employee, an unknown type, and a retired type', async () => {
    await expect(createRecord({
      client: tenant.client, personnelNumber: '00007777', recordType: TYPE, validFrom: '2026-06-01',
      changedBy: ACTOR, values: answer('NACHN', 'Nobody'),
    })).rejects.toThrow(/No employee of that personnel number/);
    await expect(createRecord({
      client: tenant.client, personnelNumber: await person('types').then((w) => w), recordType: 'ZZZZ',
      validFrom: '2026-06-01', changedBy: ACTOR, values: answer('NACHN', 'Nothing'),
    })).rejects.toThrow(/No record type of that code/);

    // A retired type accepts no new record, and every record that stands keeps its answers.
    await defineRecordType({
      client: tenant.client, code: FAMTYPE, name: 'Family data', changedBy: ACTOR,
      fields: [{ code: 'FAMST', label: 'Status', valueKind: 'TEXT', isRequired: true }],
    });
    const who = await person('retired');
    const standing = await writeRecord(who, '2026-02-01', answer('FAMST', 'married'), FAMTYPE);
    expect(standing.values[0].value).toBe('married');

    const retired = await changeRecordType({ client: tenant.client, code: FAMTYPE, isValid: false, changedBy: ACTOR });
    expect(retired.isValid).toBe(false);
    await expect(createRecord({
      client: tenant.client, personnelNumber: who, recordType: FAMTYPE, validFrom: '2026-03-01',
      changedBy: ACTOR, values: answer('FAMST', 'divorced'), requestKey: key('retired'),
    })).rejects.toThrow(/retired, so no new record may be written/);

    const read = await getEmployee(tenant.client, who);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]).toMatchObject({ recordType: FAMTYPE, recordTypeName: 'Family data', validFrom: '2026-02-01', isCurrent: true });
    // A retired type cannot be given a field while it is retired — nor can any type be deleted while history cites it.
    const guarded = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select confdeltype from pg_constraint
       where conrelid = 'public.employee_record'::regclass and conname = 'employee_record_type_fk'`));
    expect(String((guarded[0] as { confdeltype: string }).confdeltype)).toBe('r');
    await changeRecordType({ client: tenant.client, code: FAMTYPE, isValid: true, changedBy: ACTOR });
  });

  it('keeps history out of the application\u2019s reach at the database, not by convention', async () => {
    const who = await person('privileges');
    await writeRecord(who, '2026-04-01', answer('NACHN', 'Privileged Person'));

    // The runtime role may write and delimit a record. It may not remove one, and it may not empty the table.
    for (const statement of [
      sql`delete from record_field_value where client = ${tenant.client} and personnel_number = ${who}`,
      sql`delete from employee_record where client = ${tenant.client} and personnel_number = ${who}`,
      sql`delete from employee where client = ${tenant.client} and personnel_number = ${who}`,
      sql`truncate table employee_record`,
      sql`truncate table record_type`,
    ]) {
      await expect(withTenant(tenant.client, async (tx) => tx.execute(statement))).rejects.toThrow(/permission denied/);
    }
    // The row is still there, which is what the refusal is for.
    expect((await getEmployee(tenant.client, who)).records).toHaveLength(1);
  });

  it('does not let one tenant read another, even on the same personnel number', async () => {
    await definePersonalDataType(other.client);
    await createEmployee({
      client: other.client, personnelNumber: FOREIGN_PERSON, fullName: 'Other Tenant Person', changedBy: ACTOR,
    });
    await createRecord({
      client: other.client, personnelNumber: FOREIGN_PERSON, recordType: TYPE, validFrom: '2026-01-01',
      changedBy: ACTOR, values: answer('NACHN', 'Other Tenant Person'), requestKey: key('other-rec'),
    });

    const mine = await listEmployees(tenant.client, 'OTHER TENANT');
    expect(mine).toHaveLength(0);
    const theirs = await getEmployee(other.client, FOREIGN_PERSON);
    expect(theirs.fullName).toBe('Other Tenant Person');
    expect(theirs.records[0].values[0].value).toBe('Other Tenant Person');
    // A tenant cannot even see that the other tenant's employee exists.
    await expect(getEmployee(tenant.client, FOREIGN_PERSON)).rejects.toThrow(/No employee of that personnel number/);
    const crossRead = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as seen from employee`));
    expect(Number((crossRead[0] as { seen: number }).seen)).toBeGreaterThan(0);
    const foreign = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as seen from employee where client = ${other.client}`));
    expect(Number((foreign[0] as { seen: number }).seen)).toBe(0);
  });

  it('writes a change document for the definition, the master and every dated record', async () => {
    const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select object_class, change_type, count(*)::int as documents
        from change_document
       where client = ${tenant.client} and changed_by = ${ACTOR}
         and object_class in ('employee', 'employee_record', 'record_type')
       group by object_class, change_type order by object_class, change_type`));
    const counts = new Map((rows as unknown as Array<{ object_class: string; change_type: string; documents: number }>)
      .map((r) => [`${r.object_class}/${r.change_type}`, Number(r.documents)]));
    expect(counts.get('employee/CREATE') ?? 0).toBeGreaterThanOrEqual(6);
    expect(counts.get('employee/CHANGE') ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.get('employee_record/CREATE') ?? 0).toBeGreaterThanOrEqual(6);
    expect(counts.get('employee_record/CHANGE') ?? 0).toBeGreaterThanOrEqual(4);
    expect(counts.get('record_type/CREATE') ?? 0).toBeGreaterThanOrEqual(3);

    // The dated record's change document names the record it is about, so an auditor can find the span.
    const keys = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select object_key from change_document
       where client = ${tenant.client} and object_class = 'employee_record' and change_type = 'CHANGE'
       order by object_key limit 5`));
    const keyRows = keys as unknown as Array<{ object_key: string }>;
    expect(keyRows.length).toBeGreaterThan(0);
    for (const row of keyRows) {
      expect(row.object_key).toMatch(/^T\d{7}\/(PERSGR|FAMDT)\/\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('registers the People codes as master-data codes, not posting codes, and names their screens', async () => {
    const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select code, module, action, is_posting_relevant, description from capability
       where code in ('PEOPLE.EMPLOYEE.CREATE', 'PEOPLE.RECORD.MAINTAIN', 'CFG.PEOPLE.RECORDTYPE.DEFINE')
       order by code`));
    const found = rows as unknown as Array<{ code: string; module: string; action: string; is_posting_relevant: boolean; description: string }>;
    expect(found.map((r) => r.code)).toEqual([
      RECORD_TYPE_CAPABILITY, EMPLOYEE_CAPABILITY, RECORD_CAPABILITY,
    ]);
    for (const row of found) {
      expect(row.module).toBe('PEOPLE');
      // Nothing in this slice posts. The two codes a screen enforces also name the route it guards, so the
      // catalogue and the migration cannot drift away from the path a reader is sent to.
      expect(row.is_posting_relevant).toBe(false);
      if (row.code !== RECORD_CAPABILITY) {
        expect(row.description).toMatch(/\/(people|config)\/[a-z-]+/);
      } else {
        expect(row.description).toMatch(/dated record/);
      }
    }
    // The one posting-relevant People code is the payroll posting the design still has nothing to execute.
    const posting = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select code from capability where module = 'PEOPLE' and is_posting_relevant and code <> 'PEOPLE.PAYROLL.POST'`));
    expect(posting as unknown[]).toEqual([]);
    expect(found.find((r) => r.code === RECORD_CAPABILITY)?.action).toBe('MAINTAIN');
    expect(found.find((r) => r.code === EMPLOYEE_CAPABILITY)?.action).toBe('CREATE');

    const routes = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select our_code, route_path, title, conformance_tier from term_registry
       where our_code in ('PEOPLE.EMPLOYEE.CREATE', 'CFG.PEOPLE.RECORDTYPE.DEFINE') order by our_code`));
    expect((routes as unknown as Array<{ our_code: string; route_path: string }>).map((r) => `${r.our_code}=${r.route_path}`)).toEqual([
      'CFG.PEOPLE.RECORDTYPE.DEFINE=/config/people-record-types',
      'PEOPLE.EMPLOYEE.CREATE=/people/employees',
    ]);

    // No posting in this module, and no attempt at one. `9195` added the pay *structure* — what a component
    // is and where its money would go — so it is asserted as present beside its mapping, while every table that
    // would carry a payroll amount, a run, a payslip or an accrual is still absent. Migration 9197 added the
    // time/leave tables (`time_type`, `absence`, `leave_quota`, `time_recording`) — those are time and leave
    // functionality, not payroll, so they are not part of this assertion.
    const payroll = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as built from information_schema.tables
       where table_schema = 'public' and table_name in
         ('payroll_run','payroll_result','payroll_result_line','payroll_posting_run','payroll_posting_line','payslip','eos_provision_run','deduction_rule')`));
    expect(Number((payroll[0] as { built: number }).built)).toBe(0);
    const structure = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select table_name from information_schema.tables
       where table_schema = 'public' and table_name in ('pay_component','pay_component_config') order by 1`));
    expect((structure as unknown as Array<{ table_name: string }>).map((r) => r.table_name)).toEqual(['pay_component', 'pay_component_config']);
    const tolerance = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as still_there from information_schema.tables
       where table_schema = 'public' and table_name = 'employee_tolerance_group'`));
    expect(Number((tolerance[0] as { still_there: number }).still_there)).toBe(1);
  });
});
