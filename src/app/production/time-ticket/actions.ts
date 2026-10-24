'use server';

import { can, requireSession } from '@/platform/auth/current';
import {
  TIME_TICKET_CAPABILITY,
  TIME_TICKET_ROUTE,
  TimeTicketError,
  enterTimeTicket,
  previewTimeTicket,
  timeTicketRefusal,
  type TimeTicketView,
} from '@/modules/production/time-ticket';

export interface TimeTicketActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  ticket?: TimeTicketView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function activities(form: FormData) {
  const parameters = form.getAll('activityParameter').map((value) => String(value));
  return parameters.map((parameter, index) => ({
    parameter,
    quantity: String(form.getAll('activityQuantity')[index] ?? ''),
    unit: String(form.getAll('activityUnit')[index] ?? ''),
  })).filter((row) => row.quantity !== '');
}

export async function enterTimeTicketAction(
  _previous: TimeTicketActionState,
  form: FormData,
): Promise<TimeTicketActionState> {
  const session = await requireSession(TIME_TICKET_ROUTE);
  if (!can(session, TIME_TICKET_CAPABILITY)) {
    return { ok: false, message: `You do not hold the confirmation capability (${TIME_TICKET_CAPABILITY}).` };
  }
  const named = {
    confirmationProfile: text(form, 'confirmationProfile'),
    automatic: text(form, 'automatic'),
    sequence: text(form, 'sequence'),
    suboperation: text(form, 'suboperation'),
    personnel: text(form, 'personnel'),
    shift: text(form, 'shift'),
    backflush: text(form, 'backflush'),
    automaticGoodsReceipt: text(form, 'automaticGoodsReceipt'),
    goodsMovement: text(form, 'goodsMovement'),
    clearOpenReservations: text(form, 'clearOpenReservations'),
    confirmationNumber: text(form, 'confirmationNumber'),
    co13: text(form, 'co13'),
    cost: text(form, 'cost'),
    workCenter: text(form, 'workCenter'),
  };
  const refused = timeTicketRefusal(named);
  if (refused) return { ok: false, message: refused };
  const input = {
    orderNumber: text(form, 'orderNumber'),
    operationNumber: text(form, 'operationNumber'),
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
    activities: activities(form),
    expectedVersion: Number(text(form, 'expectedVersion')),
    confirmFinal: text(form, 'confirmFinal') === 'on',
    named,
  };
  const check = text(form, 'intent') === 'check';
  try {
    const ticket = check
      ? await previewTimeTicket(session.user.client, input)
      : await enterTimeTicket(session.user.client, {
        ...input,
        requestedBy: session.user.username,
        requestKey: text(form, 'requestKey'),
      });
    const failed = !check && !ticket.written;
    return {
      ok: check || ticket.written,
      ticket,
      message: check
        ? 'The check wrote nothing. No goods movement was proposed.'
        : failed
          ? 'The confirmation was not saved.'
          : `Confirmation ${ticket.confirmationNumber} stands. The order status is still ${ticket.orderStatus}. ${ticket.movementNote}`,
    };
  } catch (error) {
    if (error instanceof TimeTicketError) return { ok: false, message: error.message, remedy: error.remedy };
    return { ok: false, message: error instanceof Error ? error.message : 'The confirmation was not saved.' };
  }
}
