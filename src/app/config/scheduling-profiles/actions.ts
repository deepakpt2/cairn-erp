'use server';

import { revalidatePath } from 'next/cache';

import { requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  SchedulingProfileError,
  assignSchedulingProfile,
  saveSchedulingProfile,
} from '@/modules/inventory/scheduling-profile';

export interface ProfileActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): ProfileActionState {
  if (error instanceof SchedulingProfileError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveSchedulingProfileAction(
  _previous: ProfileActionState,
  form: FormData,
): Promise<ProfileActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const plant = read(form, 'plant').trim();
    const profile = read(form, 'profile');
    if (read(form, 'mode') === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: `${plant}/${profile}` });
    }
    const saved = await saveSchedulingProfile({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      plant,
      profile,
      description: read(form, 'description'),
      releaseOnCreate: form.get('releaseOnCreate') === 'X' ? 'X' : ' ',
      batchCreation: read(form, 'batchCreation'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Profile ${saved.profile} saved for plant ${saved.plant}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function assignSchedulingProfileAction(
  _previous: ProfileActionState,
  form: FormData,
): Promise<ProfileActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const saved = await assignSchedulingProfile({
      client: session.user.client,
      changedBy: session.user.username,
      materialNumber,
      plant,
      profile: read(form, 'assignProfile'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      reason: read(form, 'assignReason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: saved.profile
        ? `Material ${saved.materialNumber} in plant ${saved.plant} uses profile ${saved.profile}.`
        : `Material ${saved.materialNumber} in plant ${saved.plant} has no scheduling profile.`,
    };
  } catch (error) {
    return fail(error);
  }
}
