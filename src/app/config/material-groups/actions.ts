'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  MaterialGroupError,
  deleteMaterialGroup,
  saveMaterialGroup,
  setMaterialGroupActive,
} from '@/modules/inventory/material-group-definition';

export interface MaterialGroupActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/material-groups';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): MaterialGroupActionState {
  if (error instanceof MaterialGroupError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveMaterialGroupAction(
  _previous: MaterialGroupActionState,
  form: FormData,
): Promise<MaterialGroupActionState> {
  const session = await requireSession(ROUTE);
  try {
    if (read(form, 'mode') === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'MATERIAL_GROUP', argument: read(form, 'materialGroup') });
    }
    const result = await saveMaterialGroup({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      materialGroup: read(form, 'materialGroup'),
      name: read(form, 'name'),
      longDescription: read(form, 'longDescription'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Material group ${result.materialGroup} saved.` }
      : { ok: true, message: `Material group ${result.materialGroup} already holds these descriptions; nothing was changed.` };
  } catch (error) {
    return fail(error);
  }
}

export async function setMaterialGroupActiveAction(
  _previous: MaterialGroupActionState,
  form: FormData,
): Promise<MaterialGroupActionState> {
  const session = await requireSession(ROUTE);
  const active = read(form, 'active') === 'true';
  try {
    await assertChangeForSession(session, { lockObject: 'MATERIAL_GROUP', argument: read(form, 'materialGroup') });
    const result = await setMaterialGroupActive({
      client: session.user.client,
      changedBy: session.user.username,
      materialGroup: read(form, 'materialGroup'),
      active,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Material group ${result.materialGroup} ${active ? 'reactivated' : 'deactivated'}.` }
      : { ok: true, message: `Material group ${result.materialGroup} already stands ${active ? 'active' : 'inactive'}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteMaterialGroupAction(
  _previous: MaterialGroupActionState,
  form: FormData,
): Promise<MaterialGroupActionState> {
  const session = await requireSession(ROUTE);
  try {
    await assertChangeForSession(session, { lockObject: 'MATERIAL_GROUP', argument: read(form, 'materialGroup') });
    const result = await deleteMaterialGroup({
      client: session.user.client,
      changedBy: session.user.username,
      materialGroup: read(form, 'materialGroup'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Material group ${result.materialGroup} deleted.` };
  } catch (error) {
    return fail(error);
  }
}
