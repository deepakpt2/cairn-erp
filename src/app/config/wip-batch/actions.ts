'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  WipBatchError,
  saveWipBatchActivation,
} from '@/modules/production/wip-batch';

export interface WipActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  code?: string;
  version?: number;
  replaceRequestKey?: boolean;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function saveWipBatchAction(
  _state: WipActionState,
  form: FormData,
): Promise<WipActionState> {
  const session = await requireCapability(ACTIVITY);
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: session.user.client });
    const saved = await saveWipBatchActivation({
      client: session.user.client,
      changedBy: session.user.username,
      wipBatchActive: read(form, 'wipBatchActive'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
      confirmed: read(form, 'confirmed') === 'yes',
      requestKey: read(form, 'requestKey'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      code: saved.code ?? '',
      version: saved.version,
      replaceRequestKey: true,
      message: saved.code === 'X'
        ? `WIP batch X stands at version ${saved.version}. It cannot be revoked. No WIP batch was created.`
        : `WIP batch is not active at version ${saved.version}. Nothing was posted.`,
    };
  } catch (error) {
    if (error instanceof WipBatchError || error instanceof EnqueueError || error instanceof AuthzError) {
      return {
        ok: false,
        message: error.message,
        remedy: error.remedy,
        replaceRequestKey: /request key/i.test(error.message),
      };
    }
    throw error;
  }
}
