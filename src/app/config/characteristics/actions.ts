'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  CharacteristicError,
  deleteCharacteristic,
  saveCharacteristic,
  setCharacteristicStatus,
} from '@/modules/foundation/characteristic-definition';

export interface CharacteristicActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/characteristics';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): CharacteristicActionState {
  if (error instanceof CharacteristicError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveCharacteristicAction(
  _previous: CharacteristicActionState,
  form: FormData,
): Promise<CharacteristicActionState> {
  const session = await requireSession(ROUTE);
  const payload = JSON.parse(read(form, 'payload') || '{}') as Record<string, unknown>;
  try {
    const result = await saveCharacteristic({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      characteristicName: String(payload.characteristicName ?? ''),
      description: String(payload.description ?? ''),
      dataFormat: String(payload.dataFormat ?? 'CHAR'),
      valueLength: Number(payload.valueLength ?? 30),
      decimalPlaces: Number(payload.decimalPlaces ?? 0),
      unit: String(payload.unit ?? ''),
      currency: String(payload.currency ?? ''),
      negativeValuesAllowed: payload.negativeValuesAllowed === true,
      caseSensitive: payload.caseSensitive === true,
      intervalsAllowed: payload.intervalsAllowed === true,
      additionalValuesAllowed: payload.additionalValuesAllowed === true,
      valueAssignment: String(payload.valueAssignment ?? 'SINGLE'),
      requiredEntry: payload.requiredEntry === true,
      values: Array.isArray(payload.values) ? payload.values.map(String) : [],
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Characteristic ${result.characteristicName} saved.` };
  } catch (error) {
    return fail(error);
  }
}

export async function setCharacteristicStatusAction(
  _previous: CharacteristicActionState,
  form: FormData,
): Promise<CharacteristicActionState> {
  const session = await requireSession(ROUTE);
  const status = read(form, 'status') === 'BLOCKED' ? 'BLOCKED' : 'ACTIVE';
  try {
    const result = await setCharacteristicStatus({
      client: session.user.client,
      changedBy: session.user.username,
      characteristicName: read(form, 'characteristicName'),
      status,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Characteristic ${result.characteristicName} is now ${status === 'ACTIVE' ? 'active' : 'blocked'}.` }
      : { ok: true, message: `Characteristic ${result.characteristicName} already stands ${status.toLowerCase()}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteCharacteristicAction(
  _previous: CharacteristicActionState,
  form: FormData,
): Promise<CharacteristicActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await deleteCharacteristic({
      client: session.user.client,
      changedBy: session.user.username,
      characteristicName: read(form, 'characteristicName'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Characteristic ${result.characteristicName} deleted.` };
  } catch (error) {
    return fail(error);
  }
}

