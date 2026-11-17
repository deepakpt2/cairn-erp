'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  PAYMENT_RUN_CAPABILITY,
  PaymentRunError,
  cancelPaymentRun,
  createPaymentRun,
  executePaymentRun,
  generateProposal,
} from '@/modules/finance/payment-run';
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

export async function proposalAction(
  _previous: PaymentRunActionState,
  form: FormData,
): Promise<PaymentRunActionState> {
  const session = await requireSession(ROUTE);
  const denied = guard(session);
  if (denied) return denied;
  try {
    await assertRun(session, form);
    const run = await generateProposal({
      client: session.user.client, changedBy: session.user.username,
      runDate: text(form, 'runDate'), runId: text(form, 'runId'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: run.proposal.length === 0
        ? 'The proposal is empty: no open items match the selection.'
        : `Proposal created: ${run.proposal.length - run.exceptionCount} payable, ${run.exceptionCount} exceptions.`,
      runDate: run.runDate, runId: run.runId,
    };
  } catch (error) {
    return wrap(error);
  }
}

export async function executeAction(
  _previous: PaymentRunActionState,
  form: FormData,
): Promise<PaymentRunActionState> {
  const session = await requireSession(ROUTE);
  const denied = guard(session);
  if (denied) return denied;
  try {
    await assertRun(session, form);
    const run = await executePaymentRun({
      client: session.user.client, changedBy: session.user.username,
      runDate: text(form, 'runDate'), runId: text(form, 'runId'),
      houseBankKey: text(form, 'houseBankKey'), bankAccountId: text(form, 'bankAccountId'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Run executed: ${run.payments.length} payments posted.`,
      runDate: run.runDate, runId: run.runId,
    };
  } catch (error) {
    return wrap(error);
  }
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
    await cancelPaymentRunRelease({ client: session.user.client, changedBy: session.user.username, runDate, runId });
    revalidatePath(ROUTE);
    return { ok: true, message: `Release of payment run ${runDate}/${runId} cancelled; it stands at the first step again.` };
  } catch (error) {
    return wrap(error);
  }
}
