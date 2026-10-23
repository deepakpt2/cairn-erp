'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchLevelError,
  prepareBatchLevelConversion,
  saveBatchLevel,
} from '@/modules/inventory/batch-level';

export interface BatchLevelActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  batchLevel?: string;
  version?: number;
  replaceRequestKey?: boolean;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): BatchLevelActionState {
  if (error instanceof BatchLevelError || error instanceof EnqueueError || error instanceof AuthzError) {
    return {
      ok: false,
      message: error.message,
      remedy: error.remedy,
      replaceRequestKey: /request key/i.test(error.message),
    };
  }
  throw error;
}

export async function saveBatchLevelAction(
  _state: BatchLevelActionState,
  form: FormData,
): Promise<BatchLevelActionState> {
  const session = await requireCapability(ACTIVITY);
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: session.user.client });
    const saved = await saveBatchLevel({
      client: session.user.client,
      changedBy: session.user.username,
      batchLevel: read(form, 'batchLevel'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      transportRequest: read(form, 'transportRequest'),
      approval: read(form, 'approval'),
      postingPeriod: read(form, 'postingPeriod'),
      companyCode: read(form, 'companyCode'),
      batchStatusManagement: read(form, 'batchStatusManagement') === 'true',
      internalNumbering: read(form, 'internalNumbering') === 'true',
      batchNumberRange: read(form, 'batchNumberRange'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Batch level ${saved.batchLevel} — ${saved.name} stands at version ${saved.version}. Nothing was posted.`,
      batchLevel: saved.batchLevel,
      version: saved.version,
      replaceRequestKey: true,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function prepareConversionAction(
  _state: BatchLevelActionState,
  form: FormData,
): Promise<BatchLevelActionState> {
  const session = await requireCapability(ACTIVITY);
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: session.user.client });
    const attempt = await prepareBatchLevelConversion({
      client: session.user.client,
      changedBy: session.user.username,
      targetLevel: read(form, 'targetLevel'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: attempt.status === 'NOT_REQUIRED',
      message: attempt.errorSummary,
      remedy: attempt.status === 'BLOCKED'
        ? 'The level was not changed. Live conversion is not available.'
        : 'Save the level. Nothing was converted.',
      batchLevel: attempt.sourceLevel,
      version: attempt.sourceVersion,
    };
  } catch (error) {
    return fail(error);
  }
}

