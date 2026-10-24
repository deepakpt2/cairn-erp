'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  PRODUCTION_ORDER_CHANGE_CAPABILITY,
  PRODUCTION_ORDER_CHANGE_ROUTE,
  PRODUCTION_ORDER_LOCK,
  ProductionOrderChangeError,
  changeProductionOrder,
  type ProductionOrderChangeResult,
} from '@/modules/production/production-order-change';
import { PRODUCTION_ORDER_DISPLAY_ROUTE } from '@/modules/production/production-order-display';

export interface ProductionOrderChangeState {
  ok: boolean;
  message?: string;
  remedy?: string;
  warnings?: string[];
  order?: ProductionOrderChangeResult['order'];
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function changeProductionOrderAction(
  _previous: ProductionOrderChangeState,
  form: FormData,
): Promise<ProductionOrderChangeState> {
  try {
    const session = await requireCapability(PRODUCTION_ORDER_CHANGE_CAPABILITY);
    const orderNumber = text(form, 'orderNumber');
    await assertChangeForSession(session, { lockObject: PRODUCTION_ORDER_LOCK, argument: orderNumber });
    const itemNumbers = form.getAll('itemNumber').filter((value): value is string => typeof value === 'string');
    const components = itemNumbers.map((itemNumber, index) => ({
      itemNumber: itemNumber === '' ? null : Number(itemNumber),
      materialNumber: String(form.getAll('componentMaterial')[index] ?? ''),
      requiredQuantity: String(form.getAll('componentQuantity')[index] ?? ''),
      unit: String(form.getAll('componentUnit')[index] ?? ''),
      storageLocation: String(form.getAll('componentLocation')[index] ?? ''),
      remove: form.get(`remove-${itemNumber}`) === 'X',
    })).filter((row) => row.materialNumber.trim() || row.remove);
    const result = await changeProductionOrder({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber,
      expectedVersion: Number(text(form, 'version')),
      quantity: text(form, 'quantity'),
      unit: text(form, 'unit'),
      startDate: text(form, 'startDate'),
      finishDate: text(form, 'finishDate'),
      materialNumber: text(form, 'materialNumber'),
      plant: text(form, 'plant'),
      components,
      named: {
        orderType: text(form, 'orderType'),
        controllingArea: text(form, 'controllingArea'),
        scrap: text(form, 'scrap'),
        productionVersion: text(form, 'productionVersion'),
        schedulingType: text(form, 'schedulingType'),
        priority: text(form, 'priority'),
        operation: text(form, 'operation'),
        sequence: text(form, 'sequence'),
        reschedule: text(form, 'reschedule'),
        availability: text(form, 'availability'),
        reread: text(form, 'reread'),
        release: text(form, 'release'),
        teco: text(form, 'teco'),
        closed: text(form, 'closed'),
        delete: text(form, 'delete'),
        status: text(form, 'status'),
        post: text(form, 'post'),
      },
    });
    revalidatePath(PRODUCTION_ORDER_CHANGE_ROUTE);
    revalidatePath(PRODUCTION_ORDER_DISPLAY_ROUTE);
    return {
      ok: true,
      order: result.order,
      warnings: result.warnings,
      message: result.changed
        ? `Production order ${result.order.orderNumber} was saved. It was not released, and nothing was posted.`
        : `Production order ${result.order.orderNumber} was not changed.`,
    };
  } catch (error) {
    if (error instanceof ProductionOrderChangeError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: 'remedy' in error ? error.remedy : undefined };
    }
    throw error;
  }
}
