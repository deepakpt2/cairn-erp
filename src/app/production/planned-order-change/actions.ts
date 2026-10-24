'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  PLANNED_ORDER_CHANGE_CAPABILITY,
  PLANNED_ORDER_CHANGE_ROUTE,
  PLANNED_ORDER_LOCK,
  PlannedOrderChangeError,
  changePlannedOrder,
  type PlannedOrderChangeResult,
} from '@/modules/production/planned-order-change';
import { PLANNED_ORDER_DISPLAY_ROUTE } from '@/modules/production/planned-order-display';

export interface PlannedOrderChangeState {
  ok: boolean;
  message?: string;
  remedy?: string;
  warnings?: string[];
  order?: PlannedOrderChangeResult['order'];
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function changePlannedOrderAction(
  _previous: PlannedOrderChangeState,
  form: FormData,
): Promise<PlannedOrderChangeState> {
  try {
    const session = await requireCapability(PLANNED_ORDER_CHANGE_CAPABILITY);
    const orderNumber = text(form, 'orderNumber');
    await assertChangeForSession(session, { lockObject: PLANNED_ORDER_LOCK, argument: orderNumber });
    const result = await changePlannedOrder({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber,
      expectedVersion: Number(text(form, 'version')),
      quantity: text(form, 'quantity'),
      unit: text(form, 'unit'),
      startDate: text(form, 'startDate'),
      finishDate: text(form, 'finishDate'),
      firmingStatus: text(form, 'firmingStatus'),
      materialNumber: text(form, 'materialNumber'),
      plant: text(form, 'plant'),
      named: {
        mrpArea: text(form, 'mrpArea'),
        orderType: text(form, 'orderType'),
        specialProcurement: text(form, 'specialProcurement'),
        openingDate: text(form, 'openingDate'),
        productionVersion: text(form, 'productionVersion'),
        bom: text(form, 'bom'),
        routing: text(form, 'routing'),
        scheduler: text(form, 'scheduler'),
        storageLocation: text(form, 'storageLocation'),
        salesOrder: text(form, 'salesOrder'),
        wbs: text(form, 'wbs'),
        deletionIndicator: text(form, 'deletionIndicator'),
        companyCode: text(form, 'companyCode'),
        convert: text(form, 'convert'),
        delete: text(form, 'delete'),
        reexplode: text(form, 'reexplode'),
        schedule: text(form, 'schedule'),
        availability: text(form, 'availability'),
        newOrderNumber: text(form, 'newOrderNumber'),
        post: text(form, 'post'),
      },
    });
    revalidatePath(PLANNED_ORDER_CHANGE_ROUTE);
    revalidatePath(PLANNED_ORDER_DISPLAY_ROUTE);
    const lead = result.changed
      ? `Planned order ${result.order.orderNumber} was saved. No production order, requisition, or posting was created.`
      : `Planned order ${result.order.orderNumber} was not changed.`;
    return { ok: true, order: result.order, warnings: result.warnings, message: lead };
  } catch (error) {
    if (error instanceof PlannedOrderChangeError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: 'remedy' in error ? error.remedy : undefined };
    }
    return { ok: false, message: 'The planned order was not changed.' };
  }
}
