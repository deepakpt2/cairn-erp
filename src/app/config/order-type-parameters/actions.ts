'use server';

import { revalidatePath } from 'next/cache';

import {
  ACTIVITY,
  LOCK_OBJECT,
  OrderTypeParameterError,
  ROUTE,
  saveOrderTypeParameter,
} from '@/modules/production/order-type-parameters';
import { requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';

export interface OrderParameterActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): OrderParameterActionState {
  if (error instanceof OrderTypeParameterError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveOrderTypeParameterAction(
  _previous: OrderParameterActionState,
  form: FormData,
): Promise<OrderParameterActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const plant = read(form, 'plant');
    const orderType = read(form, 'orderType');
    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : read(form, 'mode') === 'DELETE' ? 'DELETE' : 'CREATE';
    if (mode !== 'CREATE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: `${plant}/${orderType}` });
    }
    const saved = await saveOrderTypeParameter({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      plant,
      orderType,
      taskListType: read(form, 'taskListType'),
      productionVersionSelection: read(form, 'productionVersionSelection'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: saved
        ? `Parameters for ${saved.plant} / ${saved.orderType} saved. No order was created.`
        : `Parameters for ${plant} / ${orderType} deleted. No order was changed.`,
    };
  } catch (error) {
    return fail(error);
  }
}
