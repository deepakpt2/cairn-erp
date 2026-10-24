'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import {
  PLANNED_ORDER_CREATE_CAPABILITY,
  PLANNED_ORDER_CREATE_ROUTE,
  PlannedOrderCreateError,
  createPlannedOrder,
  type PlannedOrderCreateResult,
} from '@/modules/production/planned-order-create';
import { PLANNED_ORDER_DISPLAY_ROUTE } from '@/modules/production/planned-order-display';

export interface PlannedOrderCreateState {
  ok: boolean;
  message?: string;
  remedy?: string;
  warnings?: string[];
  order?: PlannedOrderCreateResult['order'];
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function createPlannedOrderAction(
  _previous: PlannedOrderCreateState,
  form: FormData,
): Promise<PlannedOrderCreateState> {
  try {
    const session = await requireCapability(PLANNED_ORDER_CREATE_CAPABILITY);
    const result = await createPlannedOrder({
      client: session.user.client,
      changedBy: session.user.username,
      requestKey: text(form, 'requestKey'),
      materialNumber: text(form, 'materialNumber'),
      plant: text(form, 'plant'),
      quantity: text(form, 'quantity'),
      unit: text(form, 'unit'),
      startDate: text(form, 'startDate'),
      finishDate: text(form, 'finishDate'),
      referenceOrder: text(form, 'referenceOrder'),
      named: {
        profile: text(form, 'profile'),
        mrpArea: text(form, 'mrpArea'),
        orderType: text(form, 'orderType'),
        orderNumber: text(form, 'orderNumber'),
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
        firming: text(form, 'firming'),
        origin: text(form, 'origin'),
        post: text(form, 'post'),
        schedule: text(form, 'schedule'),
        reexplode: text(form, 'reexplode'),
        availability: text(form, 'availability'),
      },
    });
    revalidatePath(PLANNED_ORDER_CREATE_ROUTE);
    revalidatePath(PLANNED_ORDER_DISPLAY_ROUTE);
    const lead = result.created
      ? `Planned order ${result.order.orderNumber} was created. It is firmed. No production order, requisition, or posting was created.`
      : `Planned order ${result.order.orderNumber} already stood for this request.`;
    return { ok: true, order: result.order, warnings: result.warnings, message: lead };
  } catch (error) {
    if (error instanceof PlannedOrderCreateError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: 'remedy' in error ? error.remedy : undefined };
    }
    return { ok: false, message: 'The planned order was not created.' };
  }
}
