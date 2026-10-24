'use server';

import { can, requireSession } from '@/platform/auth/current';
import {
  ORDER_CONFIRMATION_CAPABILITY,
  ORDER_CONFIRMATION_ROUTE,
  OrderConfirmationError,
  enterOrderConfirmation,
  orderConfirmationRefusal,
  previewOrderConfirmation,
  type OrderConfirmationView,
} from '@/modules/production/order-confirmation';
import { TimeTicketError } from '@/modules/production/time-ticket';

export interface OrderConfirmationActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  confirmation?: OrderConfirmationView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function namedOf(form: FormData) {
  return {
    confirmationProfile: text(form, 'confirmationProfile'),
    automatic: text(form, 'automatic'),
    automaticFinal: text(form, 'automaticFinal'),
    sequence: text(form, 'sequence'),
    suboperation: text(form, 'suboperation'),
    personnel: text(form, 'personnel'),
    shift: text(form, 'shift'),
    backflush: text(form, 'backflush'),
    automaticGoodsReceipt: text(form, 'automaticGoodsReceipt'),
    goodsMovement: text(form, 'goodsMovement'),
    clearOpenReservations: text(form, 'clearOpenReservations'),
    confirmationNumber: text(form, 'confirmationNumber'),
    operationNumber: text(form, 'operationNumber'),
    co11n: text(form, 'co11n'),
    co13: text(form, 'co13'),
    cost: text(form, 'cost'),
    capacity: text(form, 'capacity'),
    quality: text(form, 'quality'),
    serial: text(form, 'serial'),
    orderType: text(form, 'orderType'),
    referenceConfirmation: text(form, 'referenceConfirmation'),
    longText: text(form, 'longText'),
    varianceReason: text(form, 'varianceReason'),
    postingPeriod: text(form, 'postingPeriod'),
    workCenter: text(form, 'workCenter'),
  };
}

export async function enterOrderConfirmationAction(
  _previous: OrderConfirmationActionState,
  form: FormData,
): Promise<OrderConfirmationActionState> {
  const session = await requireSession(ORDER_CONFIRMATION_ROUTE);
  if (!can(session, ORDER_CONFIRMATION_CAPABILITY)) {
    return { ok: false, message: `You do not hold the confirmation capability (${ORDER_CONFIRMATION_CAPABILITY}).` };
  }
  const named = namedOf(form);
  const refused = orderConfirmationRefusal(named);
  if (refused) return { ok: false, message: refused };
  const input = {
    orderNumber: text(form, 'orderNumber'),
    productionVersion: text(form, 'productionVersion') || undefined,
    confirmationType: text(form, 'confirmationType'),
    yieldQuantity: text(form, 'yieldQuantity') || undefined,
    scrapQuantity: text(form, 'scrapQuantity') || undefined,
    reworkQuantity: text(form, 'reworkQuantity') || undefined,
    unit: text(form, 'unit') || undefined,
    postingDate: text(form, 'postingDate'),
    executionStartDate: text(form, 'executionStartDate') || undefined,
    executionStartTime: text(form, 'executionStartTime') || undefined,
    executionFinishDate: text(form, 'executionFinishDate') || undefined,
    executionFinishTime: text(form, 'executionFinishTime') || undefined,
    note: text(form, 'note') || undefined,
    expectedVersion: Number(text(form, 'expectedVersion')),
    confirmFinal: text(form, 'confirmFinal') === 'on',
    named,
  };
  const check = text(form, 'intent') === 'check';
  try {
    const confirmation = check
      ? await previewOrderConfirmation(session.user.client, input)
      : await enterOrderConfirmation(session.user.client, {
        ...input,
        requestedBy: session.user.username,
        requestKey: text(form, 'requestKey'),
      });
    const failed = !check && !confirmation.written;
    return {
      ok: check || confirmation.written,
      confirmation,
      message: check
        ? 'The check wrote nothing. No goods movement was proposed.'
        : failed
          ? 'The confirmation was not saved.'
          : `Confirmation ${confirmation.confirmationNumber} stands. The order status is still ${confirmation.orderStatus}. ${confirmation.movementNote}`,
    };
  } catch (error) {
    if (error instanceof OrderConfirmationError || error instanceof TimeTicketError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return { ok: false, message: error instanceof Error ? error.message : 'The confirmation was not saved.' };
  }
}
