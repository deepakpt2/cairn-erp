'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';

import { can, requireSession, type SessionContext } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { auditAccessLog } from '@/platform/tables/security';
import {
  PAY_COMPONENT_CAPABILITY,
  PAY_COMPONENT_ROUTE,
  PayComponentError,
  changePayComponent,
  definePayComponent,
  savePayComponentMapping,
} from '@/modules/people/pay-components';

const ROUTE = PAY_COMPONENT_ROUTE;

/**
 * The choice a select offers when an operator means "none". `undefined` means the field was not sent, which
 * for a change is a different answer from this one: a mapping keeps what stands until the form says otherwise.
 */
const CLEAR = 'NONE';

export interface PayActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  component?: string;
  chart?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Absent means "not said"; the sentinel means "put nothing here"; anything else is the value. */
function account(form: FormData, name: string): string | null | undefined {
  const value = text(form, name);
  if (value === '') return undefined;
  return value === CLEAR ? null : value;
}

function validity(form: FormData, name: string): boolean | undefined {
  const value = text(form, name);
  if (value === '') return undefined;
  return value === 'yes';
}

/** The service's own words and remedy are the refusal; anything else is a bug, not a refusal. */
function refuse(error: unknown): PayActionState {
  if (error instanceof PayComponentError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

/** The four kind labels need both articles, and a hardcoded `a` reads as a slip on two of them. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function done(message: string, links: { component?: string; chart?: string }): PayActionState {
  revalidatePath(ROUTE);
  return { ok: true, message, ...links };
}

/**
 * One read of the session for both answers an action needs — whose tenant, and who is writing — so no action
 * takes a tenant from a form field. On a refusal the guard's own state is what the form shows, and
 * `'actor' in access` is how the callers tell the two apart.
 */
/** Write a capability denial to the audit log, then return the refusal the screen shows. */
async function denied(session: SessionContext, doing: string): Promise<PayActionState> {
  const detail = `Direct API or screen action refused: session holds none of ${PAY_COMPONENT_CAPABILITY}.`;
  await withTenant(session.user.client, async (tx) => {
    await tx.execute(sql`
      insert into audit_access_log
        (id, client, user_id, username, event_type, transaction_code, detail)
      values (
        ${randomUUID()}, ${session.user.client}, ${session.user.userId}, ${session.user.username},
        'CAPABILITY_DENIED', ${PAY_COMPONENT_CAPABILITY}, ${detail}
      )
    `);
  });
  return {
    ok: false,
    message: `${doing} needs ${PAY_COMPONENT_CAPABILITY}, which this session does not hold.`,
    remedy: `Ask an administrator to add ${PAY_COMPONENT_CAPABILITY} to one of your roles.`,
  };
}

async function guard(doing: string): Promise<{ client: string; actor: string; capabilities: string[] } | PayActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PAY_COMPONENT_CAPABILITY)) return denied(session, doing);
  return { client: session.user.client, actor: session.user.username, capabilities: session.user.capabilities };
}

export async function defineComponentAction(
  _previous: PayActionState,
  formData: FormData,
): Promise<PayActionState> {
  const access = await guard('Defining a pay component');
  if (!('actor' in access)) return access;
  try {
    const view = await definePayComponent(
      {
        client: access.client,
        code: text(formData, 'code'),
        name: text(formData, 'name'),
        componentKind: text(formData, 'componentKind'),
        description: text(formData, 'description') || null,
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(`Component ${view.code} — ${view.name} — defined as ${article(label(view.componentKind))} ${label(view.componentKind)}.`, {
      component: view.code,
    });
  } catch (error) {
    return refuse(error);
  }
}

export async function changeComponentAction(
  _previous: PayActionState,
  formData: FormData,
): Promise<PayActionState> {
  const access = await guard('Changing a pay component');
  if (!('actor' in access)) return access;
  try {
    const view = await changePayComponent(
      {
        client: access.client,
        code: text(formData, 'code'),
        name: text(formData, 'name') || undefined,
        description: formData.has('description') ? text(formData, 'description') || null : undefined,
        isValid: validity(formData, 'isValid'),
        changedBy: access.actor,
      },
      access.capabilities,
    );
    return done(
      `Component ${view.code} updated — ${view.name}, ${view.mappings.length} mapping${
        view.mappings.length === 1 ? '' : 's'
      }, ${view.isValid ? 'open for new mappings' : 'retired: every mapping that stands still stands'}.`,
      { component: view.code },
    );
  } catch (error) {
    return refuse(error);
  }
}

/**
 * The mapping form is one form for both acts, because the row is keyed by component and chart: it is written
 * once and corrected afterwards. The cost pair is dropped unless the receiver says FIXED — a select the
 * screen left visible while the choice says otherwise is a half-written mapping, and the service would refuse
 * it, so the action refuses to send it.
 */
function mappingFields(access: { client: string; actor: string; capabilities: string[] }, formData: FormData): Record<string, unknown> & { capabilities?: string[] } {
  const fields: Record<string, unknown> & { capabilities?: string[] } = {
    client: access.client,
    componentCode: text(formData, 'componentCode'),
    chartOfAccounts: text(formData, 'chart'),
    debitAccount: account(formData, 'debitAccount'),
    creditAccount: account(formData, 'creditAccount'),
    changedBy: access.actor,
    capabilities: access.capabilities,
  };
  // The centre and its area arrive as one choice, because a centre named without the area that owns it is a
  // mapping nobody could charge. Saying nothing about the receiver leaves the pair as it stands; saying
  // ASSIGNMENT or NONE clears it, since neither of those has a centre of its own.
  const receiver = text(formData, 'costReceiverCategory');
  if (receiver === '') return fields;
  fields.costReceiverCategory = receiver;
  if (receiver !== 'FIXED') {
    fields.controllingArea = null;
    fields.costCenter = null;
    return fields;
  }
  const pair = text(formData, 'costCenter');
  const [area, centre] = pair.includes('/') ? pair.split('/') : [undefined, undefined];
  fields.controllingArea = area;
  fields.costCenter = centre;
  return fields;
}

export async function defineMappingAction(
  _previous: PayActionState,
  formData: FormData,
): Promise<PayActionState> {
  const access = await guard('Mapping a pay component');
  if (!('actor' in access)) return access;
  try {
    const view = await savePayComponentMapping(
      mappingFields(access, formData),
      'CREATE',
      access.capabilities,
    );
    return done(`Mapping for ${text(formData, 'componentCode')} in ${view.chartOfAccounts} defined: ${describe(view)}.`, {
      component: text(formData, 'componentCode'),
      chart: view.chartOfAccounts,
    });
  } catch (error) {
    return refuse(error);
  }
}

export async function changeMappingAction(
  _previous: PayActionState,
  formData: FormData,
): Promise<PayActionState> {
  const access = await guard('Correcting a pay component mapping');
  if (!('actor' in access)) return access;
  try {
    const view = await savePayComponentMapping(
      mappingFields(access, formData),
      'CHANGE',
      access.capabilities,
    );
    return done(`Mapping for ${text(formData, 'componentCode')} in ${view.chartOfAccounts} corrected: ${describe(view)}.`, {
      component: text(formData, 'componentCode'),
      chart: view.chartOfAccounts,
    });
  } catch (error) {
    return refuse(error);
  }
}

function label(kind: string): string {
  if (kind === 'EARNING') return 'earning';
  if (kind === 'DEDUCTION') return 'deduction';
  if (kind === 'EMPLOYER_CONTRIBUTION') return 'employer contribution';
  return 'end-of-service provision';
}

/** What the screen says the mapping now is, in the same words the panel uses. */
function describe(view: {
  debitAccount: string | null;
  creditAccount: string | null;
  costReceiverCategory: string;
  controllingArea: string | null;
  costCenter: string | null;
}): string {
  const charge =
    view.costReceiverCategory === 'ASSIGNMENT'
      ? 'charged to the employee’s assignment'
      : view.costReceiverCategory === 'FIXED'
        ? `charged to ${view.controllingArea}/${view.costCenter}`
        : 'charged to nothing';
  return `debit ${view.debitAccount ?? 'none'}, credit ${view.creditAccount ?? 'none'}, ${charge}`;
}
