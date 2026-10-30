'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';

import { can, requireSession, type SessionContext } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { auditAccessLog } from '@/platform/tables/security';
import {
  RECORD_TYPE_CAPABILITY,
  RECORD_TYPE_ROUTE,
  RecordTypeConfigError,
  addRecordField,
  changeRecordField,
  changeRecordType,
  defineRecordType,
} from '@/modules/people/record-types';

const ROUTE = RECORD_TYPE_ROUTE;

export interface RecordTypeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  code?: string;
}

/**
 * Module-private on purpose. A `use server` file may export async functions and nothing else: exporting this
 * object beside the actions made every submission on the screen throw in a production build, while a
 * `next dev` render never reached the check. The client component keeps its own starting state for that
 * reason — the shape every other People screen uses, and what the browser run for 9193 found.
 */
const EMPTY: RecordTypeActionState = { ok: false };

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/**
 * A ticked box or a button that means &quot;yes&quot; sends `1`; unchecking sends the name with an empty value, and a
 * box nobody ticked sends nothing at all. Reading only presence would make an unticked box a tick.
 */
function flag(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === '1' || value === 'on';
}

/** The service's words and remedy are the refusal; anything else is a bug and stays a bug. */
function refuse(error: unknown): RecordTypeActionState {
  if (error instanceof RecordTypeConfigError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function done(code: string, message: string): RecordTypeActionState {
  revalidatePath(ROUTE);
  revalidatePath(`${ROUTE}?type=${code}`);
  return { ok: true, message, code };
}

/** Write a capability denial to the audit log, then return the refusal the screen shows. */
async function denied(session: SessionContext): Promise<RecordTypeActionState> {
  const detail = `Direct API or screen action refused: session holds none of ${RECORD_TYPE_CAPABILITY}.`;
  await withTenant(session.user.client, async (tx) => {
    await tx.execute(sql`
      insert into audit_access_log
        (id, client, user_id, username, event_type, transaction_code, detail)
      values (
        ${randomUUID()}, ${session.user.client}, ${session.user.userId}, ${session.user.username},
        'CAPABILITY_DENIED', ${RECORD_TYPE_CAPABILITY}, ${detail}
      )
    `);
  });
  return {
    ok: false,
    message: `Defining a record type needs ${RECORD_TYPE_CAPABILITY}, which this session does not hold.`,
    remedy: `Ask an administrator to add ${RECORD_TYPE_CAPABILITY} to one of your roles.`,
  };
}

function fieldsOf(form: FormData): Array<{ code: string; label: string; valueKind: 'TEXT' | 'NUMBER' | 'DATE'; isRequired: boolean }> {
  const fieldCode = text(form, 'fieldCode');
  if (fieldCode === '') return [];
  const kind = text(form, 'valueKind').toUpperCase();
  return [{
    code: fieldCode,
    label: text(form, 'fieldLabel') || fieldCode,
    valueKind: kind === 'NUMBER' || kind === 'DATE' ? kind : 'TEXT',
    isRequired: flag(form, 'fieldRequired'),
  }];
}

export async function defineRecordTypeAction(
  _previous: RecordTypeActionState, formData: FormData,
): Promise<RecordTypeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RECORD_TYPE_CAPABILITY)) return denied(session);
  try {
    const fields = fieldsOf(formData);
    if (fields.length === 0) {
      return {
        ok: false,
        message: `A record type has to ask at least one question, or nothing can be recorded with it.`,
        remedy: `Give the first field's code and label below; the rest can be added once the type stands.`,
      };
    }
    const type = await defineRecordType(
      {
        client: session.user.client,
        code: text(formData, 'code'),
        name: text(formData, 'name'),
        description: optional(formData, 'description'),
        fields,
        changedBy: session.user.username,
      },
      session.user.capabilities,
    );
    return done(type.code, `Record type ${type.code} — ${type.name} — defined with ${type.fields.length} field${type.fields.length === 1 ? '' : 's'}.`);
  } catch (error) {
    return refuse(error);
  }
}

export async function changeRecordTypeAction(
  _previous: RecordTypeActionState, formData: FormData,
): Promise<RecordTypeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RECORD_TYPE_CAPABILITY)) return denied(session);
  const code = text(formData, 'code');
  try {
    const type = await changeRecordType(
      {
        client: session.user.client,
        code,
        name: optional(formData, 'name'),
        description: formData.get('description') === null ? undefined : text(formData, 'description') || null,
        // Retiring is the act this screen offers in place of deletion: history keeps standing, no record is lost.
        isValid: formData.get('retire') !== null ? false : (formData.get('restore') !== null ? true : undefined),
        changedBy: session.user.username,
      },
      session.user.capabilities,
    );
    return done(type.code, `Record type ${type.code}: ${type.name}, ${type.isValid ? 'open for new records' : 'retired — no new record, every standing one readable'}.`);
  } catch (error) {
    return refuse(error);
  }
}

export async function addRecordFieldAction(
  _previous: RecordTypeActionState, formData: FormData,
): Promise<RecordTypeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RECORD_TYPE_CAPABILITY)) return denied(session);
  const recordType = text(formData, 'recordType');
  try {
    const fields = fieldsOf(formData);
    if (fields.length === 0) {
      return { ok: false, message: `A field needs a code of its own.`, remedy: `Use the name the payroll provider uses, uppercased: STKLD, FAMGT, ZABGR.` };
    }
    const type = await addRecordField(
      {
        client: session.user.client,
        recordType,
        ...fields[0],
        changedBy: session.user.username,
      },
      session.user.capabilities,
    );
    return done(type.code, `${fields[0].code} added to ${type.code} — ${type.fields.length} fields now.`);
  } catch (error) {
    return refuse(error);
  }
}

export async function changeRecordFieldAction(
  _previous: RecordTypeActionState, formData: FormData,
): Promise<RecordTypeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RECORD_TYPE_CAPABILITY)) return denied(session);
  const recordType = text(formData, 'recordType');
  const code = text(formData, 'code');
  try {
    const type = await changeRecordField(
      {
        client: session.user.client,
        recordType,
        code,
        label: optional(formData, 'label'),
        isRequired: flag(formData, 'required'),
        changedBy: session.user.username,
      },
      session.user.capabilities,
    );
    return done(type.code, `${code} on ${recordType}: ${flag(formData, 'required') ? 'required' : 'optional'}.`);
  } catch (error) {
    return refuse(error);
  }
}
