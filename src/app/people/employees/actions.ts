'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  EMPLOYEE_CAPABILITY,
  EMPLOYEE_ROUTE,
  RECORD_CAPABILITY,
  EmployeeMasterError,
  changeEmployee,
  changeRecordValues,
  createEmployee,
  createRecord,
  delimitRecord,
} from '@/modules/people/employee-master';

const ROUTE = EMPLOYEE_ROUTE;

/**
 * A field's answer arrives as one input named `f_<FIELD CODE>`, whatever its kind. The record type says which
 * of the three slots the value goes into, so the form needs no knowledge of the configuration and a clerk never
 * picks a data type.
 */
const FIELD_INPUT = 'f_';

export interface EmployeeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  personnelNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/** The service's own words and remedy are the answer a refusal gives; anything else is a bug, not a refusal. */
function refuse(error: unknown): EmployeeActionState {
  if (error instanceof EmployeeMasterError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

/** The answer to one field, given as one string and sorted into its kind by the field's definition. */
function answersOf(form: FormData): Record<string, { text: string; number: string; date: string }> {
  const out: Record<string, { text: string; number: string; date: string }> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith(FIELD_INPUT) || typeof value !== 'string' || value.trim() === '') continue;
    const fieldCode = key.slice(FIELD_INPUT.length).toUpperCase();
    out[fieldCode] = { text: value, number: value, date: value };
  }
  return out;
}

function done(personnelNumber: string, message: string): EmployeeActionState {
  revalidatePath(ROUTE);
  revalidatePath(`${ROUTE}?employee=${personnelNumber}`);
  return { ok: true, message, personnelNumber };
}

export async function createEmployeeAction(
  _previous: EmployeeActionState, formData: FormData,
): Promise<EmployeeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, EMPLOYEE_CAPABILITY)) {
    return {
      ok: false,
      message: `Creating an employee needs ${EMPLOYEE_CAPABILITY}, which this session does not hold.`,
      remedy: `The master is written by whoever the tenant authorizes for personnel data; until then the screen reads.`,
    };
  }
  try {
    const view = await createEmployee({
      client: session.user.client,
      personnelNumber: text(formData, 'personnelNumber'),
      fullName: text(formData, 'fullName'),
      isActive: true,
      changedBy: session.user.username,
      requestKey: optional(formData, 'requestKey'),
    });
    return done(view.personnelNumber, `Employee ${view.personnelNumber} — ${view.fullName} — created with no record yet.`);
  } catch (error) {
    return refuse(error);
  }
}

export async function changeEmployeeAction(
  _previous: EmployeeActionState, formData: FormData,
): Promise<EmployeeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, EMPLOYEE_CAPABILITY)) {
    return { ok: false, message: `Changing the master needs ${EMPLOYEE_CAPABILITY}.`, remedy: `Read the employee; the name and activity are written by an authorized session.` };
  }
  const personnelNumber = text(formData, 'personnelNumber');
  try {
    const view = await changeEmployee({
      client: session.user.client,
      personnelNumber,
      fullName: optional(formData, 'fullName'),
      // The box is present only while the employee is in use, so an absent box means "stop using the number".
      isActive: formData.get('isActive') === null ? false : true,
      // A submitted form always carries the state it wants: a ticked box is in use, an unticked one is not.
      changedBy: session.user.username,
    });
    return done(view.personnelNumber, `Employee ${view.personnelNumber}: ${view.fullName}, ${view.isActive ? 'in use' : 'not in use'}.`);
  } catch (error) {
    return refuse(error);
  }
}

export async function createRecordAction(
  _previous: EmployeeActionState, formData: FormData,
): Promise<EmployeeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RECORD_CAPABILITY)) {
    return {
      ok: false,
      message: `Writing a dated record needs ${RECORD_CAPABILITY}, which this session does not hold.`,
      remedy: `A record says what was true about a person from a date onward; the tenant hands that to whoever maintains personnel data.`,
    };
  }
  const personnelNumber = text(formData, 'personnelNumber');
  try {
    const record = await createRecord({
      client: session.user.client,
      personnelNumber,
      recordType: text(formData, 'recordType'),
      validFrom: text(formData, 'validFrom'),
      values: answersOf(formData),
      changedBy: session.user.username,
      requestKey: optional(formData, 'requestKey'),
    });
    return done(personnelNumber, `Record of ${record.recordType} written from ${record.validFrom}.`);
  } catch (error) {
    return refuse(error);
  }
}

export async function delimitRecordAction(
  _previous: EmployeeActionState, formData: FormData,
): Promise<EmployeeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RECORD_CAPABILITY)) {
    return { ok: false, message: `Ending a record needs ${RECORD_CAPABILITY}.`, remedy: `Delimiting writes the last day a record applied; nothing else closes it.` };
  }
  const personnelNumber = text(formData, 'personnelNumber');
  try {
    const record = await delimitRecord({
      client: session.user.client,
      personnelNumber,
      recordType: text(formData, 'recordType'),
      validFrom: text(formData, 'validFrom'),
      validTo: text(formData, 'validTo'),
      changedBy: session.user.username,
    });
    return done(personnelNumber, `Record of ${record.recordType} from ${record.validFrom} now ends on ${record.validTo}.`);
  } catch (error) {
    return refuse(error);
  }
}

export async function changeRecordValuesAction(
  _previous: EmployeeActionState, formData: FormData,
): Promise<EmployeeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RECORD_CAPABILITY)) {
    return { ok: false, message: `Correcting a record needs ${RECORD_CAPABILITY}.`, remedy: `Only the newest open record of a type may be corrected; older ones are history.` };
  }
  const personnelNumber = text(formData, 'personnelNumber');
  try {
    const record = await changeRecordValues({
      client: session.user.client,
      personnelNumber,
      recordType: text(formData, 'recordType'),
      validFrom: text(formData, 'validFrom'),
      // An empty input is a field left alone, not an answer withdrawn: a slot has to hold a value.
      values: answersOf(formData),
      changedBy: session.user.username,
    });
    return done(personnelNumber, `Record of ${record.recordType} from ${record.validFrom} corrected — ${record.values.length} field${record.values.length === 1 ? '' : 's'} now stand answered.`);
  } catch (error) {
    return refuse(error);
  }
}
