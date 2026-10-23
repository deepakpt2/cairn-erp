'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  SCHEDULING_AGREEMENT_MAINTAIN_CAPABILITY,
  SCHEDULING_AGREEMENT_ROUTE,
  SchedulingAgreementError,
  changeSchedulingAgreement,
  createSchedulingAgreement,
  type CreateSchedulingAgreementInput,
} from '@/modules/purchasing/scheduling-agreement';
import {
  RELEASE_CAPABILITIES,
  ReleaseError,
  cancelDocumentRelease,
  releaseDocument,
} from '@/modules/purchasing/release';

export interface SchedulingAgreementActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  agreementNumber?: string;
  warnings?: string[];
}

const ROUTE = SCHEDULING_AGREEMENT_ROUTE;

export async function saveSchedulingAgreementAction(
  _previous: SchedulingAgreementActionState,
  form: FormData,
): Promise<SchedulingAgreementActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SCHEDULING_AGREEMENT_MAINTAIN_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the scheduling-agreement maintain capability.' };
  }
  const raw = form.get('payload');
  if (typeof raw !== 'string') return { ok: false, message: 'The agreement payload is missing.' };
  let payload: CreateSchedulingAgreementInput & { agreementNumber?: string };
  try {
    payload = JSON.parse(raw) as CreateSchedulingAgreementInput & { agreementNumber?: string };
  } catch {
    return { ok: false, message: 'The agreement payload is not valid JSON.' };
  }
  const input = {
    ...payload,
    client: session.user.client,
    changedBy: session.user.username,
  };
  try {
    if (payload.agreementNumber) {
      await assertChangeForSession(session, {
        lockObject: 'SCHEDULING_AGREEMENT',
        argument: payload.agreementNumber,
      });
      const saved = await changeSchedulingAgreement({ ...input, agreementNumber: payload.agreementNumber });
      revalidatePath(ROUTE);
      return {
        ok: true,
        agreementNumber: saved.agreementNumber,
        warnings: saved.warnings,
        message: `Scheduling agreement ${saved.agreementNumber} was changed. No schedule line, stock, or accounting was posted.`,
      };
    }
    const saved = await createSchedulingAgreement(input);
    revalidatePath(ROUTE);
    return {
      ok: true,
      agreementNumber: saved.agreementNumber,
      warnings: saved.warnings,
      message: `Scheduling agreement ${saved.agreementNumber} was created. No schedule line, stock, or accounting was posted.`,
    };
  } catch (error) {
    if (error instanceof SchedulingAgreementError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: 'remedy' in error ? error.remedy : undefined };
    }
    throw error;
  }
}

export async function releaseSchedulingAgreementAction(
  _previous: SchedulingAgreementActionState,
  form: FormData,
): Promise<SchedulingAgreementActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RELEASE_CAPABILITIES.SCHED_AGREEMENT)) {
    return { ok: false, message: 'You do not hold the scheduling-agreement release capability.' };
  }
  const number = form.get('agreementNumber');
  const code = form.get('releaseCode');
  if (typeof number !== 'string' || typeof code !== 'string') {
    return { ok: false, message: 'An agreement number and a release code are required.' };
  }
  try {
    const state = await releaseDocument({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: 'SCHED_AGREEMENT',
      documentNumber: number.trim(),
      releaseCode: code.trim(),
    });
    revalidatePath(ROUTE);
    return { ok: true, agreementNumber: number.trim(), message: `Scheduling agreement ${number.trim()} is ${state.status}.` };
  } catch (error) {
    if (error instanceof ReleaseError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function cancelSchedulingAgreementReleaseAction(
  _previous: SchedulingAgreementActionState,
  form: FormData,
): Promise<SchedulingAgreementActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RELEASE_CAPABILITIES.SCHED_AGREEMENT)) {
    return { ok: false, message: 'You do not hold the scheduling-agreement release capability.' };
  }
  const number = form.get('agreementNumber');
  if (typeof number !== 'string') return { ok: false, message: 'An agreement number is required.' };
  try {
    await cancelDocumentRelease({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: 'SCHED_AGREEMENT',
      documentNumber: number.trim(),
    });
    revalidatePath(ROUTE);
    return { ok: true, agreementNumber: number.trim(), message: `Release of ${number.trim()} was cancelled.` };
  } catch (error) {
    if (error instanceof ReleaseError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
