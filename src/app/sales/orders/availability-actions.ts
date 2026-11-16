'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  AVAILABILITY_CHECK_CAPABILITY,
  SalesAvailabilityError,
  checkSalesOrderAvailability,
  simulateSalesOrderAvailability,
  type SalesAvailabilityResult,
} from '@/modules/sales/availability-check';
import { SALES_ORDER_ROUTE } from '@/modules/sales/sales-order';

export interface AvailabilityActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  result?: SalesAvailabilityResult;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function guard() {
  const session = await requireSession(SALES_ORDER_ROUTE);
  if (!can(session, AVAILABILITY_CHECK_CAPABILITY)) {
    return { refused: { ok: false, message: `You do not hold ${AVAILABILITY_CHECK_CAPABILITY}.`, remedy: `Ask an administrator for ${AVAILABILITY_CHECK_CAPABILITY}.` } as AvailabilityActionState };
  }
  return {
    client: session.user.client,
    options: { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
  };
}

/** Show what the check returns now, beside what stands. Writes nothing. `orderNumber`. */
export async function simulateAvailabilityAction(_prev: AvailabilityActionState, form: FormData): Promise<AvailabilityActionState> {
  const g = await guard();
  if ('refused' in g && g.refused) return g.refused;
  try {
    const result = await simulateSalesOrderAvailability({ client: g.client!, orderNumber: text(form, 'orderNumber') }, g.options);
    return { ok: true, message: 'Nothing has been written. These are the confirmations the check would write.', result };
  } catch (error) {
    if (error instanceof SalesAvailabilityError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

/** Write the confirmations the check returns now, on the lines that could be checked. `orderNumber`. */
export async function confirmAvailabilityAction(_prev: AvailabilityActionState, form: FormData): Promise<AvailabilityActionState> {
  const g = await guard();
  if ('refused' in g && g.refused) return g.refused;
  try {
    const result = await checkSalesOrderAvailability({ client: g.client!, orderNumber: text(form, 'orderNumber') }, g.options);
    revalidatePath(SALES_ORDER_ROUTE);
    return {
      ok: true,
      message: result.written ? `The confirmations of sales order ${result.orderNumber} were rewritten.` : 'No line could be checked, so nothing was written.',
      result,
    };
  } catch (error) {
    if (error instanceof SalesAvailabilityError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
