'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import {
  PLANNED_ORDER_CONVERT_ALIAS,
  PLANNED_ORDER_CONVERT_CAPABILITY,
  PLANNED_ORDER_CONVERT_ROUTE,
  PlannedOrderConversionError,
  convertPlannedOrder,
  notAttemptedConversion,
  rolledBackConversion,
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
      const result = notAttemptedConversion({
        plannedOrderNumber: text(form, 'orderNumber'),
        message: 'Confirm the conversion before it is saved.',
        remedy: 'Tick the confirmation. Nothing was converted.',
      });
      return { ok: false, message: result.message, remedy: result.remedy ?? undefined, result };
    }
    const orderType = text(form, 'orderType');
    if (!orderType) {
      const result = notAttemptedConversion({
        plannedOrderNumber: text(form, 'orderNumber'),
        message: 'An order type is required for conversion. None was selected.',
        remedy: 'Enter a standing production order type. The first type was not chosen.',
      });
      return { ok: false, message: result.message, remedy: result.remedy ?? undefined, result };
    }
    const result = await convertPlannedOrder({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: text(form, 'orderNumber'),
      expectedVersion: Number(text(form, 'expectedVersion')),
      quantity: text(form, 'quantity'),
      unit: text(form, 'unit'),
      orderType,
      productionVersion: text(form, 'productionVersion') || undefined,
      named: {
        mrpArea: text(form, 'mrpArea'),
        openingDate: text(form, 'openingDate'),
        salesOrder: text(form, 'salesOrder'),
        wbs: text(form, 'wbs'),
        availability: text(form, 'availability'),
        partialQuantity: text(form, 'partialQuantity'),
      },
      transactionCode: PLANNED_ORDER_CONVERT_ALIAS,
    });
    revalidatePath(PLANNED_ORDER_CONVERT_ROUTE);
    return {
      ok: result.status === 'CONVERTED' || result.status === 'ALREADY_CONVERTED',
      message: result.message,
      remedy: result.remedy ?? undefined,
      result,
    };
  } catch (error) {
    if (error instanceof PlannedOrderConversionError) {
      const result = error.reconciliation === 'NOT_ATTEMPTED'
        ? notAttemptedConversion({
          plannedOrderNumber: text(form, 'orderNumber'),
          message: error.message,
          remedy: error.remedy,
        })
        : rolledBackConversion({
          plannedOrderNumber: text(form, 'orderNumber'),
          code: error.code,
          message: error.message,
          remedy: error.remedy,
        });
      return { ok: false, message: result.message, remedy: result.remedy ?? undefined, result };
    }
    if (error instanceof AuthzError) {
      const result = notAttemptedConversion({
        message: 'You do not hold planned-order conversion.',
        remedy: 'Conversion was not attempted.',
      });
      return { ok: false, message: result.message, remedy: result.remedy ?? undefined, result };
    }
    throw error;
  }
}
