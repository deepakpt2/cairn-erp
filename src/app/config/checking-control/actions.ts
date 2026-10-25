'use server';

import { revalidatePath } from 'next/cache';

import {
  ACTIVITY,
  CheckingControlError,
  LOCK_OBJECT,
  ROUTE,
  saveCheckingControl,
} from '@/modules/production/checking-control';
import { requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';

export interface CheckingControlActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function readIndicator(form: FormData, name: string): string {
  const value = read(form, name);
  if (value === 'BLANK') return ' ';
  return value;
}

function fail(error: unknown): CheckingControlActionState {
  if (error instanceof CheckingControlError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveCheckingControlAction(
  _previous: CheckingControlActionState,
  form: FormData,
): Promise<CheckingControlActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const plant = read(form, 'plant');
    const orderType = read(form, 'orderType');
    const businessFunction = read(form, 'businessFunction');
    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : read(form, 'mode') === 'DELETE' ? 'DELETE' : 'CREATE';
    if (mode !== 'CREATE') {
      await assertChangeForSession(session, {
        lockObject: LOCK_OBJECT,
        argument: `${plant}/${orderType}/${businessFunction}`,
      });
    }
    const saved = await saveCheckingControl({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      plant,
      orderType,
      businessFunction,
      noCheck: readIndicator(form, 'noCheck'),
      checkingRule: read(form, 'checkingRule'),
      checkOnSave: readIndicator(form, 'checkOnSave'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    const key = `${plant} / ${orderType} / ${businessFunction}`;
    return {
      ok: true,
      message: saved
        ? `Checking control for ${saved.plant} / ${saved.orderType} / ${saved.businessFunction} saved. No availability check was run.`
        : `Checking control for ${key} deleted. The combination is not configured. No check was run.`,
    };
  } catch (error) {
    return fail(error);
  }
}
