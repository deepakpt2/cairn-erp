'use server';

import { revalidatePath } from 'next/cache';

import { requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  changeInternalOrder,
  createInternalOrder,
  INTERNAL_ORDER_MAINTAIN_CAPABILITY,
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
  // The screen asks for the maintain capability and the module does not check it, so the action has
  // to: otherwise any signed-in session could post this form directly.
  const session = await requireCapability(INTERNAL_ORDER_MAINTAIN_CAPABILITY);
  const payload = String(formData.get('payload') ?? '');
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'The order could not be read.' };
  }
  const existing = String(input.orderNumber ?? '').trim();
  try {
    // A change of a standing order goes to the session the screen granted the order lock to — the
    // one lock this order has, under the same key both screens and the module's own advisory lock
    // use. Whoever was told to display, or never opened the order, writes nothing. Creating an order
    // is not under the lock, and never was.
    if (existing) {
      await assertChangeForSession(session, { lockObject: 'INTERNAL_ORDER', argument: existing });
    }
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
    const message = error instanceof InternalOrderError || error instanceof EnqueueError
      ? error.message
      : 'The order could not be saved.';
    return { ok: false, message };
  }
}
