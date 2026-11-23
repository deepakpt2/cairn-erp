'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  PAYMENT_RUN_CAPABILITY,
  PaymentRunError,
  cancelPaymentRun,
  createPaymentRun,
} from '@/modules/finance/payment-run';
import {
  cancelPaymentOperation,
  getPaymentOperation,
  submitPaymentExecution,
  submitPaymentProposal,
  type PaymentOperationView,
} from '@/modules/finance/payment-run-background';
import {
  PAYMENT_RUN_RELEASE_CAPABILITY, cancelPaymentRunRelease, releasePaymentRun,
} from '@/modules/finance/payment-run-release';
import { ReleaseError } from '@/modules/purchasing/release';

export interface PaymentRunActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  runDate?: string;
  runId?: string;
  operationId?: string;
}

const ROUTE = '/finance/payment-run';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function guard(session: Awaited<ReturnType<typeof requireSession>>): PaymentRunActionState | null {
  return can(session, PAYMENT_RUN_CAPABILITY)
    ? null
    : { ok: false, message: 'You do not hold the payment run execution capability.' };
}

function wrap(error: unknown): PaymentRunActionState {
  if (error instanceof PaymentRunError || error instanceof EnqueueError || error instanceof ReleaseError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

async function assertRun(session: Awaited<ReturnType<typeof requireSession>>, form: FormData) {
  await assertChangeForSession(session, {
    lockObject: 'PAYMENT_RUN',
    argument: `${text(form, 'runDate')}/${text(form, 'runId')}`,
  });
}

export async function createRunAction(
  _previous: PaymentRunActionState,
  form: FormData,
): Promise<PaymentRunActionState> {
  const session = await requireSession(ROUTE);
  const denied = guard(session);
  if (denied) return denied;
  const companies = text(form, 'companies').split(/[,\s]+/).filter(Boolean)
    .map((companyCode) => ({ companyCode, payingCompanyCode: companyCode }));
  const methods = text(form, 'methods').split(/[,\s]+/).filter(Boolean).map((m) => m.toUpperCase());
  try {
    const run = await createPaymentRun({
      client: session.user.client,
      changedBy: session.user.username,
      runDate: text(form, 'runDate'),
      runId: text(form, 'runId'),
      postingDate: text(form, 'postingDate'),
      documentCutoffDate: text(form, 'documentCutoffDate'),
      nextPaymentDate: text(form, 'nextPaymentDate'),
      companies,
      methods,
      supplierFrom: text(form, 'supplierFrom') || undefined,
      supplierTo: text(form, 'supplierTo') || undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Payment run ${run.runDate}/${run.runId} created.`, runDate: run.runDate, runId: run.runId };
  } catch (error) {
    return wrap(error);
  }
}

/** Queue the proposal. The answer is QUEUED, never a result: the intensive worker prepares it and publishes it whole. */
export async function proposalAction(
  _previous: PaymentRunActionState,
  form: FormData,
): Promise<PaymentRunActionState> {
  const session = await requireSession(ROUTE);
  const denied = guard(session);
  if (denied) return denied;
  try {
    await assertRun(session, form);
    const op = await submitPaymentProposal({
      client: session.user.client, changedBy: session.user.username, actorUserId: session.user.userId,
      runDate: text(form, 'runDate'), runId: text(form, 'runId'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Proposal queued (${op.status}). The current proposal and its release stay until the new proposal is published; then the release starts over.`,
      runDate: op.runDate, runId: op.runId, operationId: op.operationId,
    };
  } catch (error) {
    return wrap(error);
  }
}

/** Queue the execution of a released proposal. Nothing is posted until the worker commits, and then it is all of it or none. */
export async function executeAction(
  _previous: PaymentRunActionState,
  form: FormData,
): Promise<PaymentRunActionState> {
  const session = await requireSession(ROUTE);
  const denied = guard(session);
  if (denied) return denied;
  try {
    await assertRun(session, form);
    // Each group's actual bank amount travels under a key that names the resulting movement.
    const bankAmounts: Array<{ companyCode: string; supplier: string; currency: string; amount: string }> = [];
    for (const [name, value] of form.entries()) {
      if (!name.startsWith('bankAmount~')) continue;
      const parts = name.split('~');
      if (parts.length !== 4) continue;
      const amount = String(value).trim();
      if (amount === '') continue;
      bankAmounts.push({
        companyCode: parts[1]!, supplier: parts[2]!, currency: parts[3]!, amount,
      });
    }
    const op = await submitPaymentExecution({
      client: session.user.client, changedBy: session.user.username, actorUserId: session.user.userId,
      runDate: text(form, 'runDate'), runId: text(form, 'runId'),
      houseBankKey: text(form, 'houseBankKey'), bankAccountId: text(form, 'bankAccountId'),
      bankAmounts,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Execution queued (${op.status}). The release, supplier, bank, open items and period are checked again when the worker runs it.`,
      runDate: op.runDate, runId: op.runId, operationId: op.operationId,
    };
  } catch (error) {
    return wrap(error);
  }
}

/** Cancel a queued or running operation: `operationId` (hidden). */
export async function cancelOperationAction(
  _previous: PaymentRunActionState,
  form: FormData,
): Promise<PaymentRunActionState> {
  const session = await requireSession(ROUTE);
  const denied = guard(session);
  if (denied) return denied;
  try {
    const op = await cancelPaymentOperation({
      client: session.user.client, operationId: text(form, 'operationId'),
      changedBy: session.user.username, actorUserId: session.user.userId,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: op.status === 'CANCELLED'
        ? 'Cancelled. Nothing was changed on the run.'
        : 'Cancel requested. A proposal stops at its next chunk and the previous proposal stays; an execution already inside its transaction finishes or rolls back whole.',
      runDate: op.runDate, runId: op.runId, operationId: op.operationId,
    };
  } catch (error) {
    return wrap(error);
  }
}

/** Light status read for the screen's polling. */
export async function paymentOperationStatusAction(operationId: string): Promise<PaymentOperationView | null> {
  const session = await requireSession(ROUTE);
  if (guard(session)) return null;
  return getPaymentOperation(session.user.client, operationId);
}

export async function cancelRunAction(
  _previous: PaymentRunActionState,
  form: FormData,
): Promise<PaymentRunActionState> {
  const session = await requireSession(ROUTE);
  const denied = guard(session);
  if (denied) return denied;
  try {
    await assertRun(session, form);
    const run = await cancelPaymentRun({
      client: session.user.client, changedBy: session.user.username,
      runDate: text(form, 'runDate'), runId: text(form, 'runId'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Payment run ${run.runDate}/${run.runId} cancelled.`, runDate: run.runDate, runId: run.runId };
  } catch (error) {
    return wrap(error);
  }
}

export async function releaseRunAction(
  _previous: PaymentRunActionState,
  form: FormData,
): Promise<PaymentRunActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PAYMENT_RUN_RELEASE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the payment run release capability.' };
  }
  try {
    const runDate = text(form, 'runDate');
    const runId = text(form, 'runId');
    const state = await releasePaymentRun({
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
      client: session.user.client, changedBy: session.user.username,
      runDate, runId, releaseCode: text(form, 'releaseCode'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: state.status === 'RELEASED'
        ? `Payment run ${runDate}/${runId} is fully released and can be executed.`
        : `Payment run ${runDate}/${runId} released through step ${state.currentStep} of ${state.steps.length}.`,
    };
  } catch (error) {
    return wrap(error);
  }
}

export async function cancelRunReleaseAction(
  _previous: PaymentRunActionState,
  form: FormData,
): Promise<PaymentRunActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PAYMENT_RUN_RELEASE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the payment run release capability.' };
  }
  try {
    const runDate = text(form, 'runDate');
    const runId = text(form, 'runId');
    await cancelPaymentRunRelease({
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' }, client: session.user.client, changedBy: session.user.username, runDate, runId });
    revalidatePath(ROUTE);
    return { ok: true, message: `Release of payment run ${runDate}/${runId} cancelled; it stands at the first step again.` };
  } catch (error) {
    return wrap(error);
  }
}
