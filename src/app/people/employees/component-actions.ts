'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EMPLOYEE_ROUTE } from '@/modules/people/payroll-structure';
import { PayrollRunError } from '@/modules/people/payroll-run';
import { PayrollStructureError } from '@/modules/people/payroll-structure';
import {
  COMPONENT_MAINTAIN_CAPABILITY,
  addEmployeeComponent,
  endEmployeeComponent,
  withdrawEmployeeComponent,
} from '@/modules/people/payroll-components';

export interface ComponentActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  requestKey?: string;
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

async function guard(): Promise<{ client: string; actor: string; access: { authorization: { userId: string; sessionId: string } } } | ComponentActionState> {
  const session = await requireSession(EMPLOYEE_ROUTE);
  if (!can(session, COMPONENT_MAINTAIN_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${COMPONENT_MAINTAIN_CAPABILITY}.`, remedy: `Ask for ${COMPONENT_MAINTAIN_CAPABILITY}.` };
  }
  return {
    client: session.user.client,
    actor: session.user.username,
    access: { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
  };
}

function refusal(error: unknown): ComponentActionState {
  if (error instanceof PayrollRunError || error instanceof PayrollStructureError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

/**
 * Add an employee-specific recurring component: `personnelNumber`, `componentCode`, `mode` (ADD | REPLACE — no default),
 * `amountKind`, `amountValue`, `currency`, `validFrom`, `validTo` (optional), `prorationPolicy`, `reason`.
 */
export async function addComponentAction(_prev: ComponentActionState, form: FormData): Promise<ComponentActionState> {
  const g = await guard();
  if (!('actor' in g)) return g;
  try {
    const view = await addEmployeeComponent({
      client: g.client, personnelNumber: text(form, 'personnelNumber'), componentCode: text(form, 'componentCode'),
      mode: text(form, 'mode') as 'ADD', amountKind: text(form, 'amountKind') as 'FIXED', amountValue: text(form, 'amountValue'),
      currency: text(form, 'currency'), validFrom: text(form, 'validFrom'), validTo: text(form, 'validTo') || null,
      prorationPolicy: text(form, 'prorationPolicy') as 'FULL_PERIOD', reason: text(form, 'reason'),
      requestKey: text(form, 'requestKey') || undefined, changedBy: g.actor,
    }, g.access);
    revalidatePath(EMPLOYEE_ROUTE);
    return { ok: true, message: `${view.mode === 'REPLACE' ? 'Replacement' : 'Addition'} for ${view.componentCode} saved from ${view.validFrom}. A proposed payroll run affected by it must be recalculated before release.` };
  } catch (error) {
    return refusal(error);
  }
}

/** End an entry on its last day: `entryId`, `validTo`, `reason`. */
export async function endComponentAction(_prev: ComponentActionState, form: FormData): Promise<ComponentActionState> {
  const g = await guard();
  if (!('actor' in g)) return g;
  try {
    const view = await endEmployeeComponent({ client: g.client, entryId: text(form, 'entryId'), validTo: text(form, 'validTo'), reason: text(form, 'reason'), changedBy: g.actor }, g.access);
    revalidatePath(EMPLOYEE_ROUTE);
    return { ok: true, message: `Entry ends ${view.validTo}.` };
  } catch (error) {
    return refusal(error);
  }
}

/** Withdraw an entry no released result used: `entryId`, `reason`. */
export async function withdrawComponentAction(_prev: ComponentActionState, form: FormData): Promise<ComponentActionState> {
  const g = await guard();
  if (!('actor' in g)) return g;
  try {
    await withdrawEmployeeComponent({ client: g.client, entryId: text(form, 'entryId'), reason: text(form, 'reason'), changedBy: g.actor }, g.access);
    revalidatePath(EMPLOYEE_ROUTE);
    return { ok: true, message: 'Entry withdrawn.' };
  } catch (error) {
    return refusal(error);
  }
}
