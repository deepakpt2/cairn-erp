'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  SERIAL_CAPABILITY, SERIAL_ROUTE, SerialNumberError, saveSerialNumber,
} from '@/modules/inventory/serial-number';

const ROUTE = SERIAL_ROUTE;

export interface SerialActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/**
 * Record one serialised unit, or move one that stands.
 *
 * The serial number is the identity, and it is the identity of a *thing*: a unit recorded twice is
 * the same unit, so a second save moves it rather than making another one.
 */
export async function saveSerialAction(
  _previous: SerialActionState,
  form: FormData,
): Promise<SerialActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SERIAL_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the serial number capability.',
      remedy: `Ask for ${SERIAL_CAPABILITY}.`,
    };
  }
  try {
    await saveSerialNumber({
      client: session.user.client,
      changedBy: session.user.username,
      materialNumber: text(form, 'materialNumber'),
      serialNumber: text(form, 'serialNumber'),
      ...(optional(form, 'plant') ? { plant: optional(form, 'plant') } : {}),
      ...(optional(form, 'storageLocation') ? { storageLocation: optional(form, 'storageLocation') } : {}),
      ...(optional(form, 'batchNumber') ? { batchNumber: optional(form, 'batchNumber') } : {}),
      ...(optional(form, 'status') ? { status: optional(form, 'status') as 'IN_STOCK' } : {}),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Serial ${text(form, 'serialNumber')} recorded.` };
  } catch (error) {
    if (error instanceof SerialNumberError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return { ok: false, message: String((error as Error).message ?? error) };
  }
}
