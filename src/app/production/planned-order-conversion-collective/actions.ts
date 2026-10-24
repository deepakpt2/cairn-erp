'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import {
  PLANNED_ORDER_CONVERT_COLLECTIVE_CAPABILITY,
  PLANNED_ORDER_CONVERT_COLLECTIVE_ROUTE,
  PlannedOrderConversionError,
  convertPlannedOrders,
  type PlannedOrderConversionResult,
} from '@/modules/production/planned-order-conversion';

export interface CollectiveConvertState {
  ok: boolean;
  message?: string;
  remedy?: string;
  correlationId?: string;
  results?: PlannedOrderConversionResult[];
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function convertPlannedOrdersAction(
  _previous: CollectiveConvertState,
  form: FormData,
): Promise<CollectiveConvertState> {
  try {
    const session = await requireCapability(PLANNED_ORDER_CONVERT_COLLECTIVE_CAPABILITY);
    if (text(form, 'confirm') !== 'X') {
      return { ok: false, message: 'Confirm the collective conversion before it is saved.', remedy: 'Tick the confirmation. Nothing was converted.' };
    }
    const correlationId = text(form, 'correlationId') || crypto.randomUUID();
    const result = await convertPlannedOrders({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumbers: form.getAll('orderNumber').filter((value): value is string => typeof value === 'string'),
      correlationId,
      named: {
        mrpArea: text(form, 'mrpArea'),
        openingDate: text(form, 'openingDate'),
        salesOrder: text(form, 'salesOrder'),
        wbs: text(form, 'wbs'),
        availability: text(form, 'availability'),
        bomExplosionNumber: text(form, 'bomExplosionNumber'),
      },
    });
    revalidatePath(PLANNED_ORDER_CONVERT_COLLECTIVE_ROUTE);
    const failed = result.results.filter((row) => row.status === 'FAILED').length;
    return {
      ok: failed === 0,
      message: failed === 0
        ? `${result.results.length} planned order${result.results.length === 1 ? '' : 's'} processed.`
        : `${failed} of ${result.results.length} did not convert. The others were not rolled back.`,
      correlationId: result.correlationId,
      results: result.results,
    };
  } catch (error) {
    if (error instanceof PlannedOrderConversionError) return { ok: false, message: error.message, remedy: error.remedy };
    if (error instanceof AuthzError) return { ok: false, message: 'You do not hold collective planned-order conversion.' };
    throw error;
  }
}
