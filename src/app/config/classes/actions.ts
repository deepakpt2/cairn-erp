'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  ClassError,
  deleteClass,
  saveClass,
  setClassStatus,
} from '@/modules/foundation/class-definition';

export interface ClassActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/classes';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): ClassActionState {
  if (error instanceof ClassError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveClassAction(
  _previous: ClassActionState,
  form: FormData,
): Promise<ClassActionState> {
  const session = await requireSession(ROUTE);
  const payload = JSON.parse(read(form, 'payload') || '{}') as Record<string, unknown>;
  try {
    const result = await saveClass({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      classType: String(payload.classType ?? ''),
      className: String(payload.className ?? ''),
      description: String(payload.description ?? ''),
      assignments: Array.isArray(payload.assignments)
        ? (payload.assignments as Array<Record<string, unknown>>).map((row) => ({
            characteristicName: String(row.characteristicName ?? ''),
            requiredForClassification: row.requiredForClassification === true,
          }))
        : [],
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Class ${result.className} saved under ${result.classType}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function setClassStatusAction(
  _previous: ClassActionState,
  form: FormData,
): Promise<ClassActionState> {
  const session = await requireSession(ROUTE);
  const status = read(form, 'status') === 'BLOCKED' ? 'BLOCKED' : 'ACTIVE';
  try {
    const result = await setClassStatus({
      client: session.user.client,
      changedBy: session.user.username,
      classType: read(form, 'classType'),
      className: read(form, 'className'),
      status,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Class ${result.className} is now ${status === 'ACTIVE' ? 'active' : 'blocked'}.` }
      : { ok: true, message: `Class ${result.className} already stands ${status.toLowerCase()}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteClassAction(
  _previous: ClassActionState,
  form: FormData,
): Promise<ClassActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await deleteClass({
      client: session.user.client,
      changedBy: session.user.username,
      classType: read(form, 'classType'),
      className: read(form, 'className'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Class ${result.className} deleted.` };
  } catch (error) {
    return fail(error);
  }
}
