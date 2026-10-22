'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  RESERVATION_CREATE_CAPABILITY,
  ReservationError,
  completeReservationItem,
  createReservation,
  withdrawReservation,
} from '@/modules/inventory/reservations';

export interface ReservationActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  reservationNumber?: string;
}

const ROUTE = '/inventory/reservations';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function createReservationAction(
  _previous: ReservationActionState,
  form: FormData,
): Promise<ReservationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RESERVATION_CREATE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the reservation capability.' };
  }
  const items: Array<{ materialNumber: string; plant: string; requiredQuantity: number; storageLocation?: string; movementAllowed: boolean }> = [];
  for (const line of [1, 2, 3]) {
    const materialNumber = text(form, `material-${line}`);
    const plant = text(form, `plant-${line}`);
    const quantity = Number(text(form, `quantity-${line}`) || '0');
    if (!materialNumber && !plant && !(quantity > 0)) continue;
    items.push({
      materialNumber,
      plant,
      requiredQuantity: quantity,
      storageLocation: text(form, `sloc-${line}`) || undefined,
      movementAllowed: form.get(`allowed-${line}`) !== null,
    });
  }
  try {
    const created = await createReservation({
      client: session.user.client,
      changedBy: session.user.username,
      movementTypeCode: text(form, 'movementTypeCode'),
      baseDate: text(form, 'baseDate'),
      costCenter: text(form, 'costCenter') || undefined,
      items,
      requestKey: text(form, 'requestKey'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Reservation ${created.reservationNumber} created with ${created.items.length} item${created.items.length === 1 ? '' : 's'}.`,
      reservationNumber: created.reservationNumber,
    };
  } catch (error) {
    if (error instanceof ReservationError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function withdrawReservationAction(
  _previous: ReservationActionState,
  form: FormData,
): Promise<ReservationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RESERVATION_CREATE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the reservation capability.' };
  }
  try {
    await assertChangeForSession(session, { lockObject: 'RESERVATION', argument: text(form, 'reservationNumber') });
    const view = await withdrawReservation({
      client: session.user.client,
      changedBy: session.user.username,
      reservationNumber: text(form, 'reservationNumber'),
      itemNumber: Number(text(form, 'itemNumber')),
      quantity: Number(text(form, 'quantity')),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Withdrawal recorded on item ${text(form, 'itemNumber')}.`,
      reservationNumber: view.reservationNumber,
    };
  } catch (error) {
    if (error instanceof ReservationError || error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function completeItemAction(
  _previous: ReservationActionState,
  form: FormData,
): Promise<ReservationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RESERVATION_CREATE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the reservation capability.' };
  }
  try {
    await assertChangeForSession(session, { lockObject: 'RESERVATION', argument: text(form, 'reservationNumber') });
    const view = await completeReservationItem({
      client: session.user.client,
      changedBy: session.user.username,
      reservationNumber: text(form, 'reservationNumber'),
      itemNumber: Number(text(form, 'itemNumber')),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Item ${text(form, 'itemNumber')} completed; it no longer demands stock.`,
      reservationNumber: view.reservationNumber,
    };
  } catch (error) {
    if (error instanceof ReservationError || error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
