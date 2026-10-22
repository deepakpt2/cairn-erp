'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  PR_CREATE_CAPABILITY,
  PurchaseRequisitionError,
  changeRequisition,
  createRequisition,
} from '@/modules/purchasing/requisitions';
import {
  RELEASE_CAPABILITIES,
  ReleaseError,
  cancelDocumentRelease,
  releaseDocument,
} from '@/modules/purchasing/release';
import { can } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';

export interface RequisitionActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  requisitionNumber?: string;
  warnings?: string[];
}

const ROUTE = '/purchasing/requisitions';

export interface ReleaseActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

export async function releaseRequisitionAction(
  _previous: ReleaseActionState,
  form: FormData,
): Promise<ReleaseActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RELEASE_CAPABILITIES.PURCHASE_REQUISITION)) {
    return { ok: false, message: 'You do not hold the requisition release capability.' };
  }
  const number = form.get('requisitionNumber');
  const code = form.get('releaseCode');
  try {
    const state = await releaseDocument({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: 'PURCHASE_REQUISITION',
      documentNumber: typeof number === 'string' ? number : '',
      releaseCode: typeof code === 'string' ? code : '',
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: state.status === 'RELEASED'
        ? `Requisition ${number} is fully released.`
        : `Requisition ${number} released through step ${state.currentStep} of ${state.steps.length}.`,
    };
  } catch (error) {
    if (error instanceof ReleaseError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function cancelRequisitionReleaseAction(
  _previous: ReleaseActionState,
  form: FormData,
): Promise<ReleaseActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RELEASE_CAPABILITIES.PURCHASE_REQUISITION)) {
    return { ok: false, message: 'You do not hold the requisition release capability.' };
  }
  const number = form.get('requisitionNumber');
  try {
    await cancelDocumentRelease({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: 'PURCHASE_REQUISITION',
      documentNumber: typeof number === 'string' ? number : '',
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Release of requisition ${number} cancelled; it stands at the first step again.` };
  } catch (error) {
    if (error instanceof ReleaseError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function saveRequisitionAction(
  _previous: RequisitionActionState,
  form: FormData,
): Promise<RequisitionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PR_CREATE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the purchase-requisition create capability.' };
  }
  const payload = form.get('payload');
  const requisitionNumber = form.get('requisitionNumber');
  try {
    const input = JSON.parse(typeof payload === 'string' ? payload : '{}') as {
      documentType?: string;
      items?: unknown[];
    };
    const base = {
      client: session.user.client,
      changedBy: session.user.username,
      documentType: input.documentType ?? 'STANDARD',
      items: (input.items ?? []) as never[],
    };
    const editing = typeof requisitionNumber === 'string' && requisitionNumber;
    if (editing) {
      await assertChangeForSession(session, { lockObject: 'PURCHASE_REQUISITION', argument: requisitionNumber });
    }
    const result = editing
      ? await changeRequisition({ ...base, requisitionNumber })
      : await createRequisition(base);
    revalidatePath(ROUTE);
    return {
      ok: true,
      requisitionNumber: result.requisitionNumber,
      warnings: result.warnings,
      message: typeof requisitionNumber === 'string' && requisitionNumber
        ? `Requisition ${result.requisitionNumber} saved.`
        : `Requisition ${result.requisitionNumber} created.`,
    };
  } catch (error) {
    if (error instanceof PurchaseRequisitionError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
