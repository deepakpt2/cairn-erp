'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ActivityTypeError,
  deleteActivityType,
  saveActivityType,
  setActivityTypePostingLock,
  type ActivityTypeDeleteInput,
  type ActivityTypeInput,
  type ActivityTypeLockInput,
} from '@/modules/foundation/activity-type-definition';

export interface ActivityTypeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/activity-types';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function readAll(form: FormData, name: string): string[] {
  return form.getAll(name).filter((value): value is string => typeof value === 'string');
}

function activityArgument(form: FormData): string {
  return `${read(form, 'controllingArea')}/${read(form, 'activityType')}/${read(form, 'validFrom')}`;
}

export async function saveActivityTypeAction(
  _previous: ActivityTypeActionState,
  form: FormData,
): Promise<ActivityTypeActionState> {
  const session = await requireSession(ROUTE);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';

  const input: ActivityTypeInput = {
    client: session.user.client,
    changedBy: session.user.username,
    mode,
    controllingArea: read(form, 'controllingArea'),
    activityType: read(form, 'activityType'),
    validFrom: read(form, 'validFrom'),
    validTo: read(form, 'validTo'),
    name: read(form, 'name'),
    activityUnit: read(form, 'activityUnit'),
    category: read(form, 'category'),
    priceIndicator: read(form, 'priceIndicator'),
    validCcCategories: readAll(form, 'validCcCategories'),
    reason: read(form, 'reason'),
  };

  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'ACTIVITY_TYPE', argument: activityArgument(form) });
    }
    const result = await saveActivityType(input);
    revalidatePath(ROUTE);
    if (!result.changed) {
      return {
        ok: true,
        message: `Activity Type ${result.activityType} already holds these facts for the period from ${result.validFrom}; nothing was changed.`,
      };
    }
    return {
      ok: true,
      message:
        mode === 'CREATE'
          ? `Activity Type ${result.activityType} created in Controlling Area ${result.controllingArea} from ${result.validFrom}.`
          : `Activity Type ${result.activityType} changed for the period from ${result.validFrom}.`,
    };
  } catch (error) {
    if (error instanceof ActivityTypeError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The activity type could not be saved.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}

export async function lockActivityTypeAction(
  _previous: ActivityTypeActionState,
  form: FormData,
): Promise<ActivityTypeActionState> {
  const session = await requireSession(ROUTE);
  const locked = read(form, 'locked') === 'true';

  const input: ActivityTypeLockInput = {
    client: session.user.client,
    changedBy: session.user.username,
    controllingArea: read(form, 'controllingArea'),
    activityType: read(form, 'activityType'),
    validFrom: read(form, 'validFrom'),
    locked,
    reason: read(form, 'reason'),
  };

  try {
    await assertChangeForSession(session, { lockObject: 'ACTIVITY_TYPE', argument: activityArgument(form) });
    const result = await setActivityTypePostingLock(input);
    revalidatePath(ROUTE);
    if (!result.changed) {
      return {
        ok: true,
        message: `Activity Type ${input.activityType} is already ${locked ? 'locked' : 'open'} for posting; nothing was changed.`,
      };
    }
    return {
      ok: true,
      message: locked
        ? `Activity Type ${input.activityType} locked for posting from ${input.validFrom}.`
        : `Activity Type ${input.activityType} open for posting again from ${input.validFrom}.`,
    };
  } catch (error) {
    if (error instanceof ActivityTypeError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The posting lock could not be changed.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}

export async function deleteActivityTypeAction(
  _previous: ActivityTypeActionState,
  form: FormData,
): Promise<ActivityTypeActionState> {
  const session = await requireSession(ROUTE);

  const input: ActivityTypeDeleteInput = {
    client: session.user.client,
    changedBy: session.user.username,
    controllingArea: read(form, 'controllingArea'),
    activityType: read(form, 'activityType'),
    validFrom: read(form, 'validFrom'),
    reason: read(form, 'reason'),
  };

  try {
    await assertChangeForSession(session, { lockObject: 'ACTIVITY_TYPE', argument: activityArgument(form) });
    await deleteActivityType(input);
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Activity Type ${input.activityType} period from ${input.validFrom} deleted.`,
    };
  } catch (error) {
    if (error instanceof ActivityTypeError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    return {
      ok: false,
      message: 'The activity type could not be deleted.',
      remedy: 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.',
    };
  }
}
