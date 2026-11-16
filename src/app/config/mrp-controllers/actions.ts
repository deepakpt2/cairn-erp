'use server';

import { revalidatePath } from 'next/cache';

import { requireSession, can } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  MRP_CONTROLLER_ROUTE as ROUTE,
  MrpControllerError,
  deleteMrpController,
  mrpControllerKey,
  saveMrpController,
  setMrpControllerActive,
} from '@/modules/inventory/mrp-controller-maintenance';

export interface MrpControllerActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): MrpControllerActionState {
  if (error instanceof MrpControllerError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function denied(): MrpControllerActionState {
  return { ok: false, message: `You are not authorised for ${ACTIVITY}.`, remedy: 'Ask an administrator for the capability.' };
}

export async function saveMrpControllerAction(
  _previous: MrpControllerActionState,
  form: FormData,
): Promise<MrpControllerActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ACTIVITY)) return denied();
  try {
    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, {
        lockObject: LOCK_OBJECT,
        argument: mrpControllerKey(read(form, 'plant'), read(form, 'controller')),
      });
    }
    const result = await saveMrpController({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      plant: read(form, 'plant'),
      controller: read(form, 'controller'),
      name: read(form, 'name'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `MRP controller ${result.controller} in plant ${result.plant} saved.` }
      : { ok: true, message: `MRP controller ${result.controller} in plant ${result.plant} already holds this name; nothing was changed.` };
  } catch (error) {
    return fail(error);
  }
}

export async function setMrpControllerActiveAction(
  _previous: MrpControllerActionState,
  form: FormData,
): Promise<MrpControllerActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ACTIVITY)) return denied();
  const active = read(form, 'active') === 'true';
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: read(form, 'key') });
    const result = await setMrpControllerActive({
      client: session.user.client,
      changedBy: session.user.username,
      key: read(form, 'key'),
      active,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `MRP controller ${active ? 'reactivated' : 'deactivated'}.` }
      : { ok: true, message: `MRP controller already stands ${active ? 'active' : 'inactive'}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteMrpControllerAction(
  _previous: MrpControllerActionState,
  form: FormData,
): Promise<MrpControllerActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ACTIVITY)) return denied();
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: read(form, 'key') });
    await deleteMrpController({
      client: session.user.client,
      changedBy: session.user.username,
      key: read(form, 'key'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: 'MRP controller deleted.' };
  } catch (error) {
    return fail(error);
  }
}
