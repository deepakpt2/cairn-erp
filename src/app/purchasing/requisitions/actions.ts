'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  PR_CREATE_CAPABILITY,
  PurchaseRequisitionError,
  changeRequisition,
  createRequisition,
} from '@/modules/purchasing/requisitions';
import { can } from '@/platform/auth/current';

export interface RequisitionActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  requisitionNumber?: string;
  warnings?: string[];
}

const ROUTE = '/purchasing/requisitions';

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
    const result = typeof requisitionNumber === 'string' && requisitionNumber
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
    if (error instanceof PurchaseRequisitionError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
