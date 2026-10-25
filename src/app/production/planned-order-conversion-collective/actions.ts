'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import {
  PLANNED_ORDER_CONVERT_COLLECTIVE_CAPABILITY,
  PLANNED_ORDER_CONVERT_COLLECTIVE_ROUTE,
  PlannedOrderConversionError,
  convertPlannedOrders,
  notAttemptedConversion,
  rolledBackConversion,
  type PlannedOrderConversionResult,
} from '@/modules/production/planned-order-conversion';
import { summarizeConversionResults } from '@/modules/production/conversion-outcome';

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
      const result = notAttemptedConversion({
        message: 'Confirm the collective conversion before it is saved.',
        remedy: 'Tick the confirmation. Nothing was converted.',
      });
      return { ok: false, message: result.message, remedy: result.remedy ?? undefined, results: [result] };
    }
    const orderType = text(form, 'orderType');
    if (!orderType) {
      const result = notAttemptedConversion({
        message: 'An order type is required for conversion. None was selected.',
        remedy: 'Enter a standing production order type. The first type was not chosen.',
      });
      return { ok: false, message: result.message, remedy: result.remedy ?? undefined, results: [result] };
    }
    const correlationId = text(form, 'correlationId') || crypto.randomUUID();
    const result = await convertPlannedOrders({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumbers: form.getAll('orderNumber').filter((value): value is string => typeof value === 'string'),
      correlationId,
      orderType,
      productionVersion: text(form, 'productionVersion') || undefined,
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
      message: summarizeConversionResults(result.results),
      correlationId: result.correlationId,
      results: result.results,
    };
  } catch (error) {
    if (error instanceof PlannedOrderConversionError) {
      const result = error.reconciliation === 'ROLLED_BACK'
        ? rolledBackConversion({ plannedOrderNumber: '', code: error.code, message: error.message, remedy: error.remedy })
        : notAttemptedConversion({ message: error.message, remedy: error.remedy });
      return { ok: false, message: result.message, remedy: result.remedy ?? undefined, results: [result] };
    }
    if (error instanceof AuthzError) {
      const result = notAttemptedConversion({
        message: 'You do not hold collective planned-order conversion.',
        remedy: 'Conversion was not attempted.',
      });
      return { ok: false, message: result.message, remedy: result.remedy ?? undefined, results: [result] };
    }
    throw error;
  }
}
