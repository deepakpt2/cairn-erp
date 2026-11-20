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
  releasePayrollRun,
} from '@/modules/people/payroll-run';
import { PAYROLL_POST_CAPABILITY, PayrollPostingError } from '@/modules/people/payroll-posting';
import {
  cancelPayrollOperation,
  getPayrollOperation,
  submitPayrollPosting,
  submitPayrollProposal,
  submitPayrollRecalculation,
  type PayrollOperationView,
} from '@/modules/people/payroll-background';
import { SALARY_PAYMENT_CAPABILITY, SalaryPaymentError, paySalaryRun } from '@/modules/people/salary-payment';

const ROUTE = PAYROLL_RUN_ROUTE;

export interface PayrollRunActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  /** The run acted on, so the screen can open it. */
  runId?: string;
  /** A fresh idempotency key for the next submission of the propose form. */
  requestKey?: string;
  /** The accounting document a posting produced. */
  documentNumber?: string;
  /** The queued background operation, when the action queued one. */
  operationId?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function guard(): Promise<{ client: string; actor: string; access: { authorization: { userId: string; sessionId: string } } } | PayrollRunActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PAYROLL_RUN_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${PAYROLL_RUN_CAPABILITY}.`, remedy: `Ask for ${PAYROLL_RUN_CAPABILITY}.` };
  }
  return {
    client: session.user.client,
    actor: session.user.username,
    // The service judges the session itself: capability and Company Code scope.
    access: { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
  };
}

function refusal(error: unknown, extra: Partial<PayrollRunActionState> = {}): PayrollRunActionState {
  if (error instanceof PayrollRunError) return { ok: false, message: error.message, remedy: error.remedy, ...extra };
  throw error;
}

function refresh(): void {
  revalidatePath(ROUTE);
  revalidatePath(PAYROLL_RESULT_ROUTE);
}

/**
 * Propose a run: `companyCode`, `fiscalYear`, `period`, `requestKey` (hidden). The answer is the run and
 * QUEUED, never a result: the employees are selected and calculated by the intensive worker.
 */
export async function proposeRunAction(_prev: PayrollRunActionState, form: FormData): Promise<PayrollRunActionState> {
  const access = await guard();
  if (!('actor' in access)) return access;
  const next = randomUUID();
  try {
    const op = await submitPayrollProposal({
      client: access.client,
      actorUserId: access.access.authorization.userId,
      companyCode: text(form, 'companyCode'),
      fiscalYear: text(form, 'fiscalYear'),
      period: text(form, 'period'),
      requestKey: text(form, 'requestKey') || undefined,
      changedBy: access.actor,
    }, access.access);
    refresh();
    return {
      ok: true,
      runId: op.runId,
      requestKey: next,
      operationId: op.operationId,
      message: `Proposal queued (${op.status}). The run is calculated in the background; open it to follow the progress.`,
    };
  } catch (error) {
    return refusal(error, { requestKey: next });
  }
}

/** Recalculate a proposed run: `runId` (hidden). Queued; the previous proposal stays until the new one is published. */
export async function recalculateRunAction(_prev: PayrollRunActionState, form: FormData): Promise<PayrollRunActionState> {
  const access = await guard();
  if (!('actor' in access)) return access;
  try {
    const op = await submitPayrollRecalculation({
      client: access.client, runId: text(form, 'runId'), changedBy: access.actor, actorUserId: access.access.authorization.userId,
    }, access.access);
    refresh();
    return { ok: true, runId: op.runId, operationId: op.operationId, message: `Recalculation queued (${op.status}). The current proposal stays until the new one is published.` };
  } catch (error) {
    return refusal(error);
  }
}

/** Release a proposed run: `runId` (hidden). */
export async function releaseRunAction(_prev: PayrollRunActionState, form: FormData): Promise<PayrollRunActionState> {
  const access = await guard();
  if (!('actor' in access)) return access;
  try {
    const view = await releasePayrollRun({ client: access.client, runId: text(form, 'runId'), changedBy: access.actor, acknowledgePending: text(form, 'acknowledgePending') === 'yes' }, access.access);
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
    const view = await cancelPayrollRun({ client: access.client, runId: text(form, 'runId'), reason: text(form, 'reason'), changedBy: access.actor }, access.access);
    refresh();
    return { ok: true, runId: view.runId, message: `Run cancelled: ${view.cancelReason}. The period is free for a new run.` };
  } catch (error) {
    return refusal(error);
  }
}

/**
 * Post a released run to the G/L: `runId` (hidden) and nothing else. Queued: the intensive worker posts
 * it as one all-or-nothing journal as the user who asked, after re-checking their authority.
 */
export async function postPayrollRunAction(_prev: PayrollRunActionState, form: FormData): Promise<PayrollRunActionState> {
  const session = await requireSession(ROUTE);
  const runId = text(form, 'runId');
  try {
    if (!can(session, PAYROLL_POST_CAPABILITY)) {
      throw new PayrollPostingError(
        'You do not hold the authority to post payroll.',
        `Ask an administrator for the Post payroll authority (${PAYROLL_POST_CAPABILITY}).`,
      );
    }
    const op = await submitPayrollPosting({
      client: session.user.client,
      changedBy: session.user.username,
      actorUserId: session.user.userId,
      runId,
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
    });
    refresh();
    return { ok: true, runId, operationId: op.operationId, message: `Posting queued (${op.status}). The run is posted in the background as one document; nothing is posted until it finishes.` };
  } catch (error) {
    if (error instanceof PayrollPostingError || error instanceof PayrollRunError) return { ok: false, message: error.message, remedy: error.remedy };
    console.error('Payroll posting could not be queued', error);
    return { ok: false, message: 'Posting could not be queued. Nothing was saved.', remedy: 'Contact an administrator if the problem persists.' };
  }
}

/** Cancel a queued or running background operation: `operationId` (hidden). */
export async function cancelOperationAction(_prev: PayrollRunActionState, form: FormData): Promise<PayrollRunActionState> {
  const access = await guard();
  if (!('actor' in access)) return access;
  try {
    const op = await cancelPayrollOperation({ client: access.client, operationId: text(form, 'operationId'), changedBy: access.actor }, access.access);
    refresh();
    return {
      ok: true, runId: op.runId, operationId: op.operationId,
      message: op.status === 'CANCELLED'
        ? 'Cancelled. Nothing was changed on the run.'
        : 'Cancel requested. A calculation stops at its next chunk and the previous proposal stays; a posting already in its transaction finishes or rolls back whole.',
    };
  } catch (error) {
    return refusal(error);
  }
}

/** Light status read for the run page's polling. */
export async function payrollOperationStatusAction(operationId: string): Promise<PayrollOperationView | null> {
  const access = await guard();
  if (!('actor' in access)) return null;
  return getPayrollOperation(access.client, operationId, access.access);
}

/**
 * Pay a posted run: `runId` (hidden), `paymentDate`, `houseBankKey`, `bankAccountId`. The request key
 * is derived from the run by the service (`SALARY-PAY-<runId>`); nothing client-supplied is used.
 */
export async function paySalaryRunAction(_prev: PayrollRunActionState, form: FormData): Promise<PayrollRunActionState> {
  const session = await requireSession(ROUTE);
  const runId = text(form, 'runId');
  try {
    if (!can(session, SALARY_PAYMENT_CAPABILITY)) {
      throw new SalaryPaymentError(
        'You do not hold the authority to pay salaries.',
        `Ask an administrator for the Pay salaries authority (${SALARY_PAYMENT_CAPABILITY}).`,
      );
    }
    const result = await paySalaryRun({
      client: session.user.client,
      changedBy: session.user.username,
      runId,
      paymentDate: text(form, 'paymentDate'),
      houseBankKey: text(form, 'houseBankKey').toUpperCase(),
      bankAccountId: text(form, 'bankAccountId').toUpperCase(),
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
    });
    refresh();
    revalidatePath('/finance/journal');
    return {
      ok: true,
      runId,
      documentNumber: result.documentNumber,
      message: `Paid ${result.employeeCount} employees, ${result.totalAmount}, as document ${result.displayNumber} on ${result.paymentDate}.`,
    };
  } catch (error) {
    if (error instanceof SalaryPaymentError) return { ok: false, message: error.message, remedy: error.remedy };
    console.error('Salary payment failed', error);
    return { ok: false, message: 'The payment failed. Nothing was saved.', remedy: 'Check the house bank configuration and contact an administrator if the problem persists.' };
  }
}
