'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  PRODUCTION_ORDER_CAPABILITY,
  PRODUCTION_ORDER_RELEASE_CAPABILITY,
  PRODUCTION_ORDER_ROUTE,
  ProductionOrderError,
  createProductionOrder,
  releaseProductionOrder,
  type ProductionOrderView,
} from '@/modules/inventory/production-orders';

export interface OrderActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  order?: ProductionOrderView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

const LINE_COUNT = 4;

export async function createOrderAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(PRODUCTION_ORDER_ROUTE);
  if (!can(session, PRODUCTION_ORDER_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the production order create capability.' };
  }
  const components: Array<{ materialNumber: string; plant: string; storageLocation?: string; requiredQuantity: number }> = [];
  for (let n = 1; n <= LINE_COUNT; n += 1) {
    const materialNumber = text(form, `componentMaterial-${n}`);
    if (!materialNumber) continue;
    components.push({
      materialNumber,
      plant: text(form, `componentPlant-${n}`),
      storageLocation: text(form, `componentSloc-${n}`) || undefined,
      requiredQuantity: Number(text(form, `componentQuantity-${n}`) || '0'),
    });
  }
  try {
    const order = await createProductionOrder({
      client: session.user.client,
      createdBy: session.user.username,
      materialNumber: text(form, 'materialNumber'),
      plant: text(form, 'plant'),
      orderQuantity: Number(text(form, 'orderQuantity') || '0'),
      scheduledStart: text(form, 'scheduledStart'),
      scheduledFinish: text(form, 'scheduledFinish'),
      batch: text(form, 'batch') || undefined,
      components,
      requestKey: text(form, 'requestKey') || undefined,
    });
    revalidatePath(PRODUCTION_ORDER_ROUTE);
    return { ok: true, message: `Order ${order.orderNumber} created.`, order };
  } catch (caught) {
    if (caught instanceof ProductionOrderError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, order: null };
    }
    return { ok: false, message: 'The order could not be created.', order: null };
  }
}

export async function releaseOrderAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(PRODUCTION_ORDER_ROUTE);
  if (!can(session, PRODUCTION_ORDER_RELEASE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the production order release capability.' };
  }
  try {
    await assertChangeForSession(session, { lockObject: 'PRODUCTION_ORDER', argument: text(form, 'orderNumber') });
    const order = await releaseProductionOrder({
      client: session.user.client,
      orderNumber: text(form, 'orderNumber'),
      releasedBy: session.user.username,
    });
    revalidatePath(PRODUCTION_ORDER_ROUTE);
    return { ok: true, message: `Order ${order.orderNumber} released.`, order };
  } catch (caught) {
    if (caught instanceof ProductionOrderError || caught instanceof EnqueueError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, order: null };
    }
    return { ok: false, message: 'The order could not be released.', order: null };
  }
}
