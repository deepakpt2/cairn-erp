'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';

import { can, requireSession, type SessionContext } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { auditAccessLog } from '@/platform/tables/security';
import {
  TIME_LEAVE_ROUTE,
  TIME_ENTER_CAPABILITY,
  LEAVE_VIEW_CAPABILITY,
  TimeLeaveError,
  changeTimeType,
  defineTimeType,
  decideAbsence,
  recordTime,
  requestAbsence,
  setLeaveQuota,
} from '@/modules/people/time-leave';

const ROUTE = TIME_LEAVE_ROUTE;

export interface TimeLeaveActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  type?: string;
  employee?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function dateOrBlank(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

function booleanOrBlank(form: FormData, name: string): boolean | undefined {
  const value = text(form, name);
  if (value === '') return undefined;
  return value === 'yes';
}

function hours(form: FormData, name: string): number | undefined {
  const value = text(form, name);
  if (value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 24) return undefined;
  return n;
}

function refusal(error: unknown): TimeLeaveActionState {
  if (error instanceof TimeLeaveError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function done(message: string, links: { type?: string; employee?: string }): TimeLeaveActionState {
  revalidatePath(ROUTE);
  return { ok: true, message, ...links };
}

/** Write a capability denial to the audit log, then return the refusal the screen shows. */
async function denied(session: SessionContext, capability: string, doing: string): Promise<TimeLeaveActionState> {
  await withTenant(session.user.client, async (tx) => {
    await tx.execute(sql`
      insert into audit_access_log
        (id, client, user_id, username, event_type, transaction_code, detail)
      values (
        ${randomUUID()}, ${session.user.client}, ${session.user.userId}, ${session.user.username},
        'CAPABILITY_DENIED', ${capability},
        `Direct API or screen action refused: session holds none of ${capability}.`
      )
    `);
  });
  return {
    ok: false,
    message: `${doing} needs ${capability}, which this session does not hold.`,
    remedy: `Ask an administrator to add ${capability} to one of your roles.`,
  };
}

async function guard(capability: string, doing: string): Promise<{ client: string; actor: string; capabilities: string[] } | TimeLeaveActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, capability)) return denied(session, capability, doing);
  return { client: session.user.client, actor: session.user.username, capabilities: session.user.capabilities };
}

export async function defineTimeTypeAction(
  _previous: TimeLeaveActionState,
  formData: FormData,
): Promise<TimeLeaveActionState> {
  const access = await guard(TIME_ENTER_CAPABILITY, 'Defining a time type');
  if (!('actor' in access)) return access;
  try {
    const view = await defineTimeType(
      {
        client: access.client,
        code: text(formData, 'code'),
        name: text(formData, 'name'),
        description: text(formData, 'description') || null,
        typeKind: text(formData, 'typeKind'),
        reducesQuota: booleanOrBlank(formData, 'reducesQuota') ?? false,
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(`Time type ${view.code} — ${view.name} — defined as ${view.typeKind.toLowerCase()}.`, {
      type: view.code,
    });
  } catch (error) {
    return refusal(error);
  }
}

export async function changeTimeTypeAction(
  _previous: TimeLeaveActionState,
  formData: FormData,
): Promise<TimeLeaveActionState> {
  const access = await guard(TIME_ENTER_CAPABILITY, 'Changing a time type');
  if (!('actor' in access)) return access;
  try {
    const view = await changeTimeType(
      {
        client: access.client,
        code: text(formData, 'typeCode'),
        name: text(formData, 'name') || undefined,
        description: formData.has('description') ? text(formData, 'description') || null : undefined,
        isValid: booleanOrBlank(formData, 'isValid'),
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(`Time type ${view.code} — ${view.name} — ${view.isValid ? 'valid' : 'retired'}.`, {
      type: view.code,
    });
  } catch (error) {
    return refusal(error);
  }
}

export async function requestAbsenceAction(
  _previous: TimeLeaveActionState,
  formData: FormData,
): Promise<TimeLeaveActionState> {
  const access = await guard(TIME_ENTER_CAPABILITY, 'Requesting an absence');
  if (!('actor' in access)) return access;
  try {
    const view = await requestAbsence(
      {
        client: access.client,
        personnelNumber: text(formData, 'personnelNumber'),
        timeTypeCode: text(formData, 'timeTypeCode'),
        validFrom: dateOrBlank(formData, 'validFrom')!,
        validTo: dateOrBlank(formData, 'validTo'),
        reason: text(formData, 'reason') || null,
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(
      `Absence requested for ${view.personnelNumber} — ${view.timeTypeCode} from ${view.validFrom}${view.validTo ? ` to ${view.validTo}` : ''} (${view.status}).`,
      { employee: view.personnelNumber, type: view.timeTypeCode },
    );
  } catch (error) {
    return refusal(error);
  }
}

export async function decideAbsenceAction(
  _previous: TimeLeaveActionState,
  formData: FormData,
): Promise<TimeLeaveActionState> {
  const access = await guard(TIME_ENTER_CAPABILITY, 'Deciding an absence');
  if (!('actor' in access)) return access;
  try {
    const view = await decideAbsence(
      {
        client: access.client,
        personnelNumber: text(formData, 'personnelNumber'),
        timeTypeCode: text(formData, 'timeTypeCode'),
        validFrom: dateOrBlank(formData, 'validFrom')!,
        status: text(formData, 'status') as 'APPROVED' | 'REJECTED',
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(
      `Absence for ${view.personnelNumber} — ${view.timeTypeCode} from ${view.validFrom} is now ${view.status}.`,
      { employee: view.personnelNumber, type: view.timeTypeCode },
    );
  } catch (error) {
    return refusal(error);
  }
}

export async function recordTimeAction(
  _previous: TimeLeaveActionState,
  formData: FormData,
): Promise<TimeLeaveActionState> {
  const access = await guard(TIME_ENTER_CAPABILITY, 'Recording time');
  if (!('actor' in access)) return access;
  try {
    const view = await recordTime(
      {
        client: access.client,
        personnelNumber: text(formData, 'personnelNumber'),
        timeTypeCode: text(formData, 'timeTypeCode'),
        recordingDate: dateOrBlank(formData, 'recordingDate')!,
        hours: hours(formData, 'hours')!,
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(
      `Time recorded for ${view.personnelNumber} — ${view.timeTypeCode} on ${view.recordingDate}: ${view.hours} hours.`,
      { employee: view.personnelNumber, type: view.timeTypeCode },
    );
  } catch (error) {
    return refusal(error);
  }
}

export async function setLeaveQuotaAction(
  _previous: TimeLeaveActionState,
  formData: FormData,
): Promise<TimeLeaveActionState> {
  const access = await guard(TIME_ENTER_CAPABILITY, 'Setting a leave quota');
  if (!('actor' in access)) return access;
  try {
    const view = await setLeaveQuota(
      {
        client: access.client,
        personnelNumber: text(formData, 'personnelNumber'),
        timeTypeCode: text(formData, 'timeTypeCode'),
        year: text(formData, 'year'),
        entitlement: text(formData, 'entitlement'),
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(
      `Leave quota for ${view.personnelNumber} — ${view.timeTypeCode} ${view.year}: entitlement ${view.entitlement}, remaining ${view.remaining}.`,
      { employee: view.personnelNumber, type: view.timeTypeCode },
    );
  } catch (error) {
    return refusal(error);
  }
}
