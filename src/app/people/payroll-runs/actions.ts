'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  PAYROLL_RESULT_ROUTE,
  PAYROLL_RUN_CAPABILITY,
  PAYROLL_RUN_ROUTE,
  PayrollRunError,
  cancelPayrollRun,
  proposePayrollRun,
  recalculatePayrollRun,
  releasePayrollRun,
  type PayrollRunView,
} from '@/modules/people/payroll-run';

const ROUTE = PAYROLL_RUN_ROUTE;

export interface PayrollRunActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  /** The run acted on, so the screen can open it. */
  runId?: string;
  /** A fresh idempotency key for the next submission of the propose form. */
  requestKey?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function guard(): Promise<{ client: string; actor: string; capabilities: string[] } | PayrollRunActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PAYROLL_RUN_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${PAYROLL_RUN_CAPABILITY}.`, remedy: `Ask for ${PAYROLL_RUN_CAPABILITY}.` };
  }
  return { client: session.user.client, actor: session.user.username, capabilities: session.user.capabilities };
}

function refusal(error: unknown, extra: Partial<PayrollRunActionState> = {}): PayrollRunActionState {
  if (error instanceof PayrollRunError) return { ok: false, message: error.message, remedy: error.remedy, ...extra };
  throw error;
}

function summary(view: PayrollRunView): string {
  return `${view.employeeCount} employee${view.employeeCount === 1 ? '' : 's'} calculated, ${view.exceptionCount} exception${view.exceptionCount === 1 ? '' : 's'}; net pay ${view.netPay} ${view.currency}.`;
}

function refresh(): void {
  revalidatePath(ROUTE);
  revalidatePath(PAYROLL_RESULT_ROUTE);
}

/** Propose a run: `companyCode`, `fiscalYear`, `period`, `requestKey` (hidden). */
export async function proposeRunAction(_prev: PayrollRunActionState, form: FormData): Promise<PayrollRunActionState> {
  const access = await guard();
  if (!('actor' in access)) return access;
  const next = randomUUID();
  try {
    const view = await proposePayrollRun({
      client: access.client,
      companyCode: text(form, 'companyCode'),
      fiscalYear: text(form, 'fiscalYear'),
      period: text(form, 'period'),
      requestKey: text(form, 'requestKey') || undefined,
      changedBy: access.actor,
    }, access.capabilities);
    refresh();
    return {
      ok: true,
      runId: view.runId,
      requestKey: next,
      message: `Run proposed for company ${view.companyCode}, period ${view.period}/${view.fiscalYear} (${view.periodFrom} to ${view.periodTo}): ${summary(view)}`,
    };
  } catch (error) {
    return refusal(error, { requestKey: next });
  }
}

/** Recalculate a proposed run: `runId` (hidden). */
export async function recalculateRunAction(_prev: PayrollRunActionState, form: FormData): Promise<PayrollRunActionState> {
  const access = await guard();
  if (!('actor' in access)) return access;
  try {
    const view = await recalculatePayrollRun({ client: access.client, runId: text(form, 'runId'), changedBy: access.actor }, access.capabilities);
    refresh();
    return { ok: true, runId: view.runId, message: `Run recalculated: ${summary(view)}` };
  } catch (error) {
    return refusal(error);
  }
}

/** Release a proposed run: `runId` (hidden). */
export async function releaseRunAction(_prev: PayrollRunActionState, form: FormData): Promise<PayrollRunActionState> {
  const access = await guard();
  if (!('actor' in access)) return access;
  try {
    const view = await releasePayrollRun({ client: access.client, runId: text(form, 'runId'), changedBy: access.actor }, access.capabilities);
    refresh();
    return { ok: true, runId: view.runId, message: `Run released by ${view.releasedBy}: ${view.employeeCount} employees, net pay ${view.netPay} ${view.currency}. It is now frozen.` };
  } catch (error) {
    return refusal(error);
  }
}

/** Cancel a run: `runId` (hidden), `reason` (required). */
export async function cancelRunAction(_prev: PayrollRunActionState, form: FormData): Promise<PayrollRunActionState> {
  const access = await guard();
  if (!('actor' in access)) return access;
  try {
    const view = await cancelPayrollRun({ client: access.client, runId: text(form, 'runId'), reason: text(form, 'reason'), changedBy: access.actor }, access.capabilities);
    refresh();
    return { ok: true, runId: view.runId, message: `Run cancelled: ${view.cancelReason}. The period is free for a new run.` };
  } catch (error) {
    return refusal(error);
  }
}
