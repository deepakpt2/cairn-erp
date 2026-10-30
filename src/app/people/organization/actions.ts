'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';

import { can, requireSession, type SessionContext } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { auditAccessLog } from '@/platform/tables/security';
import {
  ORG_ROUTE,
  ORG_UNIT_CAPABILITY,
  POSITION_CAPABILITY,
  OrgStructureError,
  changeJob,
  changeOrgUnit,
  changePosition,
  defineJob,
  defineOrgUnit,
  definePosition,
} from '@/modules/people/org-structure';

const ROUTE = ORG_ROUTE;

/**
 * The sentinel a select offers beside the real codes: `ROOT` detaches a unit (a unit may hang from nothing),
 * `NONE` clears a position's job or removes its reporting line. A position's unit has no `NONE` —
 * `POSITION_UNIT_REQUIRED` in the service says why — so the select does not offer it either.
 */
const ROOT = 'ROOT';
const NONE = 'NONE';

export interface OrgActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  unit?: string;
  position?: string;
  job?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Blank means "not said", which for a change form is different from `NONE`, which means "say nothing". */
function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/** `undefined` leaves the flag alone; the select's third choice is what makes that possible in a form. */
function validity(form: FormData, name: string): boolean | undefined {
  const value = text(form, name);
  if (value === '') return undefined;
  return value === 'yes';
}

/** The service's own words and remedy are the answer a refusal gives; anything else is a bug, not a refusal. */
function refuse(error: unknown): OrgActionState {
  if (error instanceof OrgStructureError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function done(message: string, links: { unit?: string; position?: string; job?: string }): OrgActionState {
  revalidatePath(ROUTE);
  return { ok: true, message, ...links };
}

/**
 * One read of the session for both answers an action needs — whose tenant, and who is writing — so a screen
 * action never takes the tenant from a form field. On a refusal the guard's own state is what the form shows;
 * `'actor' in access` is how the callers tell the two apart.
 */
/** Write a capability denial to the audit log, then return the refusal the screen shows. */
async function denied(session: SessionContext, capability: string, doing: string): Promise<OrgActionState> {
  const detail = `Direct API or screen action refused: session holds none of ${capability}.`;
  await withTenant(session.user.client, async (tx) => {
    await tx.execute(sql`
      insert into audit_access_log
        (id, client, user_id, username, event_type, transaction_code, detail)
      values (
        ${randomUUID()}, ${session.user.client}, ${session.user.userId}, ${session.user.username},
        'CAPABILITY_DENIED', ${capability}, ${detail}
      )
    `);
  });
  return {
    ok: false,
    message: `${doing} needs ${capability}, which this session does not hold.`,
    remedy: `Ask an administrator to add ${capability} to one of your roles.`,
  };
}

async function guard(capability: string, doing: string): Promise<{ client: string; actor: string; capabilities: string[] } | OrgActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, capability)) return denied(session, capability, doing);
  return { client: session.user.client, actor: session.user.username, capabilities: session.user.capabilities };
}

export async function defineOrgUnitAction(
  _previous: OrgActionState, formData: FormData,
): Promise<OrgActionState> {
  const access = await guard(ORG_UNIT_CAPABILITY, 'Defining an organisational unit');
  if (!('actor' in access)) return access;
  try {
    const view = await defineOrgUnit(
      {
        client: access.client,
        code: text(formData, 'code'),
        name: text(formData, 'name'),
        description: optional(formData, 'description'),
        parentCode: optional(formData, 'parentCode'),
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(`Unit ${view.code} — ${view.name} — defined at level ${view.level}.`, { unit: view.code });
  } catch (error) {
    return refuse(error);
  }
}

export async function changeOrgUnitAction(
  _previous: OrgActionState, formData: FormData,
): Promise<OrgActionState> {
  const access = await guard(ORG_UNIT_CAPABILITY, 'Changing an organisational unit');
  if (!('actor' in access)) return access;
  const parent = optional(formData, 'parentCode');
  try {
    const view = await changeOrgUnit(
      {
        client: access.client,
        code: text(formData, 'unitCode'),
        name: optional(formData, 'name'),
        description: formData.has('description') ? text(formData, 'description') || null : undefined,
        isValid: validity(formData, 'isValid'),
        parentCode: parent === ROOT ? null : parent,
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(`Unit ${view.code} updated — ${view.parentCode ? `under ${view.parentCode}` : 'a root'}, validity ${view.isValid ? 'on' : 'retired'}.`, { unit: view.code });
  } catch (error) {
    return refuse(error);
  }
}

export async function defineJobAction(
  _previous: OrgActionState, formData: FormData,
): Promise<OrgActionState> {
  const access = await guard(POSITION_CAPABILITY, 'Defining a job');
  if (!('actor' in access)) return access;
  try {
    const view = await defineJob(
      {
        client: access.client,
        code: text(formData, 'code'),
        name: text(formData, 'name'),
        description: optional(formData, 'description'),
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(`Job ${view.code} — ${view.name} — defined.`, { job: view.code });
  } catch (error) {
    return refuse(error);
  }
}

export async function changeJobAction(
  _previous: OrgActionState, formData: FormData,
): Promise<OrgActionState> {
  const access = await guard(POSITION_CAPABILITY, 'Changing a job');
  if (!('actor' in access)) return access;
  try {
    const view = await changeJob(
      {
        client: access.client,
        code: text(formData, 'jobCode'),
        name: optional(formData, 'name'),
        description: formData.has('description') ? text(formData, 'description') || null : undefined,
        isValid: validity(formData, 'isValid'),
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(`Job ${view.code} updated; ${view.positions} position${view.positions === 1 ? '' : 's'} still describe themselves by it.`, { job: view.code });
  } catch (error) {
    return refuse(error);
  }
}

export async function definePositionAction(
  _previous: OrgActionState, formData: FormData,
): Promise<OrgActionState> {
  const access = await guard(POSITION_CAPABILITY, 'Defining a position');
  if (!('actor' in access)) return access;
  try {
    const view = await definePosition(
      {
        client: access.client,
        code: text(formData, 'code'),
        title: text(formData, 'title'),
        jobCode: optional(formData, 'jobCode'),
        orgUnitCode: text(formData, 'orgUnitCode'),
        superiorCode: optional(formData, 'superiorCode'),
        description: optional(formData, 'description'),
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(`Position ${view.code} — ${view.title} — created in ${view.orgUnitCode}.`, { position: view.code });
  } catch (error) {
    return refuse(error);
  }
}

export async function changePositionAction(
  _previous: OrgActionState, formData: FormData,
): Promise<OrgActionState> {
  const access = await guard(POSITION_CAPABILITY, 'Changing a position');
  if (!('actor' in access)) return access;
  const superior = optional(formData, 'superiorCode');
  const job = optional(formData, 'jobCode');
  try {
    const view = await changePosition(
      {
        client: access.client,
        code: text(formData, 'positionCode'),
        title: optional(formData, 'title'),
        jobCode: job === NONE ? null : job,
        orgUnitCode: optional(formData, 'orgUnitCode'),
        superiorCode: superior === NONE ? null : superior,
        description: formData.has('description') ? text(formData, 'description') || null : undefined,
        isValid: validity(formData, 'isValid'),
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(`Position ${view.code} updated — in ${view.orgUnitCode ?? 'no unit'}, reporting to ${view.superiorCode ?? 'nothing'}, ${view.incumbents} span${view.incumbents === 1 ? '' : 's'} not yet ended.`, { position: view.code });
  } catch (error) {
    return refuse(error);
  }
}
