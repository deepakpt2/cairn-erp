'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import {
  PLANNED_ORDER_CONVERT_ALIAS,
  PLANNED_ORDER_CONVERT_CAPABILITY,
  PLANNED_ORDER_CONVERT_ROUTE,
  PlannedOrderConversionError,
  convertPlannedOrder,
  type PlannedOrderConversionResult,
} from '@/modules/production/planned-order-conversion';

export interface PlannedOrderConvertState {
  ok: boolean;
  message?: string;
  remedy?: string;
  result?: PlannedOrderConversionResult;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function convertPlannedOrderAction(
  _previous: PlannedOrderConvertState,
  form: FormData,
): Promise<PlannedOrderConvertState> {
  try {
    const session = await requireCapability(PLANNED_ORDER_CONVERT_CAPABILITY);
    if (text(form, 'confirm') !== 'X') {
      return { ok: false, message: 'Confirm the conversion before it is saved.', remedy: 'Tick the confirmation. Nothing was converted.' };
    }
    const orderType = text(form, 'orderType');
    if (!orderType) {
      return {
        ok: false,
        message: 'An order type is required for conversion. None was selected.',
        remedy: 'Enter a standing production order type. The first type was not chosen.',
      };
    }
    const result = await convertPlannedOrder({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: text(form, 'orderNumber'),
      expectedVersion: Number(text(form, 'expectedVersion')),
      quantity: text(form, 'quantity'),
      unit: text(form, 'unit'),
      orderType,
      named: {
        mrpArea: text(form, 'mrpArea'),
        openingDate: text(form, 'openingDate'),
        productionVersion: text(form, 'productionVersion'),
        salesOrder: text(form, 'salesOrder'),
        wbs: text(form, 'wbs'),
        availability: text(form, 'availability'),
        partialQuantity: text(form, 'partialQuantity'),
      },
      transactionCode: PLANNED_ORDER_CONVERT_ALIAS,
    });
    revalidatePath(PLANNED_ORDER_CONVERT_ROUTE);
    return {
      ok: result.status !== 'FAILED',
      message: result.message,
      remedy: result.remedy ?? undefined,
      result,
    };
  } catch (error) {
    if (error instanceof PlannedOrderConversionError) return { ok: false, message: error.message, remedy: error.remedy };
    if (error instanceof AuthzError) return { ok: false, message: 'You do not hold planned-order conversion.' };
    throw error;
  }
}
