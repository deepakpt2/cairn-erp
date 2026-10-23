'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  changeInternalOrder,
  createInternalOrder,
  INTERNAL_ORDER_ROUTE,
  InternalOrderError,
} from '@/modules/foundation/internal-order';

export interface OrderActionState {
  ok: boolean;
  message?: string;
  orderNumber?: string;
}

export async function saveInternalOrderAction(
  _previous: OrderActionState,
  formData: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(INTERNAL_ORDER_ROUTE);
  const payload = String(formData.get('payload') ?? '');
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'The order could not be read.' };
  }
  const existing = String(input.orderNumber ?? '').trim();
  try {
    const saved = existing
      ? await changeInternalOrder({
          client: session.user.client,
          changedBy: session.user.username,
          orderNumber: existing,
          orderType: String(input.orderType ?? ''),
          description: String(input.description ?? ''),
          controllingArea: String(input.controllingArea ?? ''),
          companyCode: String(input.companyCode ?? ''),
          startDate: String(input.startDate ?? ''),
          endDate: String(input.endDate ?? ''),
          personResponsible: String(input.personResponsible ?? ''),
          responsibleUser: String(input.responsibleUser ?? ''),
          costCenter: String(input.costCenter ?? ''),
          profitCenter: String(input.profitCenter ?? ''),
          statistical: Boolean(input.statistical),
          isPostingLocked: Boolean(input.isPostingLocked),
          markedForDeletion: Boolean(input.markedForDeletion),
        })
      : await createInternalOrder({
          client: session.user.client,
          changedBy: session.user.username,
          orderType: String(input.orderType ?? ''),
          description: String(input.description ?? ''),
          controllingArea: String(input.controllingArea ?? ''),
          companyCode: String(input.companyCode ?? ''),
          startDate: String(input.startDate ?? ''),
          endDate: String(input.endDate ?? ''),
          personResponsible: String(input.personResponsible ?? ''),
          responsibleUser: String(input.responsibleUser ?? ''),
          costCenter: String(input.costCenter ?? ''),
          profitCenter: String(input.profitCenter ?? ''),
          statistical: input.statistical === undefined ? undefined : Boolean(input.statistical),
          sourceOrderNumber: String(input.sourceOrderNumber ?? ''),
          requestKey: String(input.requestKey ?? '') || undefined,
        });
    revalidatePath(INTERNAL_ORDER_ROUTE);
    return { ok: true, orderNumber: saved.orderNumber, message: `Internal order ${saved.orderNumber} saved. Nothing was posted.` };
  } catch (error) {
    const message = error instanceof InternalOrderError ? error.message : 'The order could not be saved.';
    return { ok: false, message };
  }
}
