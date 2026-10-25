'use server';

import { revalidatePath } from 'next/cache';

import {
  ACTIVITY,
  LOCK_OBJECT,
  ProductionOrderTypeError,
  ROUTE,
  saveProductionOrderType,
} from '@/modules/production/production-order-type';
import { requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';

export interface OrderTypeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): OrderTypeActionState {
  if (error instanceof ProductionOrderTypeError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveProductionOrderTypeAction(
  _previous: OrderTypeActionState,
  form: FormData,
): Promise<OrderTypeActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const orderType = read(form, 'orderType');
    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : read(form, 'mode') === 'DELETE' ? 'DELETE' : 'CREATE';
    if (mode !== 'CREATE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: orderType });
    }
    const saved = await saveProductionOrderType({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      orderType,
      description: read(form, 'description'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: saved ? `Order type ${saved.orderType} saved. No order was created.` : `Order type ${orderType} deleted. No order was changed.`,
    };
  } catch (error) {
    return fail(error);
  }
}
