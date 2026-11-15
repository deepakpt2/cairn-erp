'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  EMPLOYEE_ROUTE,
  PayrollStructureError,
  SALARY_STRUCTURE_CAPABILITY,
  SALARY_STRUCTURE_ROUTE,
  assignStructure,
  changeSalaryStructure,
  defineSalaryStructure,
  endAssignment,
  removeStructureComponent,
  setStructureComponent,
} from '@/modules/people/payroll-structure';

const ROUTE = SALARY_STRUCTURE_ROUTE;

export interface PayrollActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  /** A fresh idempotency key for the next submission of an assignment form. */
  requestKey?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function guard(route: string): Promise<{ client: string; actor: string; access: { authorization: { userId: string; sessionId: string } } } | PayrollActionState> {
  const session = await requireSession(route);
  if (!can(session, SALARY_STRUCTURE_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${SALARY_STRUCTURE_CAPABILITY}.`, remedy: `Ask for ${SALARY_STRUCTURE_CAPABILITY}.` };
  }
  return {
    client: session.user.client,
    actor: session.user.username,
    // The service judges the session itself: capability and Company Code scope.
    access: { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
  };
}

function refusal(error: unknown): PayrollActionState {
  if (error instanceof PayrollStructureError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

/** Define a structure: `code`, `name`, `currency`, `validFrom`, `validTo` (optional). */
export async function defineStructureAction(_prev: PayrollActionState, form: FormData): Promise<PayrollActionState> {
  const access = await guard(ROUTE);
  if (!('actor' in access)) return access;
  try {
    const view = await defineSalaryStructure({
      client: access.client,
      code: text(form, 'code'),
      name: text(form, 'name'),
      currency: text(form, 'currency'),
      validFrom: text(form, 'validFrom'),
      validTo: text(form, 'validTo') || null,
      changedBy: access.actor,
    }, access.access);
    revalidatePath(ROUTE);
    return { ok: true, message: `Structure ${view.code} — ${view.name} — defined in ${view.currency}, valid from ${view.validFrom}.` };
  } catch (error) {
    return refusal(error);
  }
}

/** Rename, move the end, or retire: `code`, `name`, `validTo`, `isValid` (yes/no). */
export async function changeStructureAction(_prev: PayrollActionState, form: FormData): Promise<PayrollActionState> {
  const access = await guard(ROUTE);
  if (!('actor' in access)) return access;
  const isValid = text(form, 'isValid');
  try {
    const view = await changeSalaryStructure({
      client: access.client,
      code: text(form, 'code'),
      name: text(form, 'name') || undefined,
      validTo: form.has('validTo') ? text(form, 'validTo') || null : undefined,
      isValid: isValid === '' ? undefined : isValid === 'yes',
      changedBy: access.actor,
    }, access.access);
    revalidatePath(ROUTE);
    return { ok: true, message: `Structure ${view.code} changed: ${view.isValid ? 'valid' : 'retired'}, ${view.validFrom} to ${view.validTo ?? 'open'}.` };
  } catch (error) {
    return refusal(error);
  }
}

/** Add or change a component's rule: `structureCode`, `componentCode`, `amountKind`, `amountValue`. */
export async function setComponentAction(_prev: PayrollActionState, form: FormData): Promise<PayrollActionState> {
  const access = await guard(ROUTE);
  if (!('actor' in access)) return access;
  try {
    const view = await setStructureComponent({
      client: access.client,
      structureCode: text(form, 'structureCode'),
      componentCode: text(form, 'componentCode'),
      amountKind: text(form, 'amountKind'),
      amountValue: text(form, 'amountValue'),
      changedBy: access.actor,
    }, access.access);
    revalidatePath(ROUTE);
    const rule = view.amountKind === 'FIXED' ? `fixed ${view.amountValue}` : `${view.amountValue} % of base`;
    return { ok: true, message: `${view.componentCode} in ${view.structureCode}: ${rule}.` };
  } catch (error) {
    return refusal(error);
  }
}

/** Take a component out of a structure: `structureCode`, `componentCode`. */
export async function removeComponentAction(_prev: PayrollActionState, form: FormData): Promise<PayrollActionState> {
  const access = await guard(ROUTE);
  if (!('actor' in access)) return access;
  try {
    const view = await removeStructureComponent({
      client: access.client,
      structureCode: text(form, 'structureCode'),
      componentCode: text(form, 'componentCode'),
      changedBy: access.actor,
    }, access.access);
    revalidatePath(ROUTE);
    return { ok: true, message: `${text(form, 'componentCode').toUpperCase()} removed from ${view.code}. Results already calculated keep their lines.` };
  } catch (error) {
    return refusal(error);
  }
}

/**
 * Assign an employee a structure (the Pay structure section of /people/employees):
 * `personnelNumber`, `structureCode`, `baseAmount`, `currency`, `validFrom`, `validTo`, `requestKey`.
 */
export async function assignStructureAction(_prev: PayrollActionState, form: FormData): Promise<PayrollActionState> {
  const access = await guard(EMPLOYEE_ROUTE);
  if (!('actor' in access)) return access;
  try {
    const view = await assignStructure({
      client: access.client,
      personnelNumber: text(form, 'personnelNumber'),
      structureCode: text(form, 'structureCode'),
      baseAmount: text(form, 'baseAmount'),
      currency: text(form, 'currency'),
      validFrom: text(form, 'validFrom'),
      validTo: text(form, 'validTo') || null,
      requestKey: text(form, 'requestKey') || undefined,
      changedBy: access.actor,
    }, access.access);
    revalidatePath(EMPLOYEE_ROUTE);
    return {
      ok: true,
      message: `${view.personnelNumber} assigned ${view.structureCode}, base ${view.baseAmount} ${view.currency}, from ${view.validFrom}.`,
      requestKey: crypto.randomUUID(),
    };
  } catch (error) {
    return refusal(error);
  }
}

/** End an assignment: `assignmentId`, `validTo`. */
export async function endAssignmentAction(_prev: PayrollActionState, form: FormData): Promise<PayrollActionState> {
  const access = await guard(EMPLOYEE_ROUTE);
  if (!('actor' in access)) return access;
  try {
    const view = await endAssignment({
      client: access.client,
      assignmentId: text(form, 'assignmentId'),
      validTo: text(form, 'validTo'),
      changedBy: access.actor,
    }, access.access);
    revalidatePath(EMPLOYEE_ROUTE);
    return { ok: true, message: `Assignment ${view.structureCode} now ends ${view.validTo}.` };
  } catch (error) {
    return refusal(error);
  }
}
