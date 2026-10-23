'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchStatusError,
  saveBatchStatus,
} from '@/modules/inventory/batch-status';

export interface BatchStatusActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  statusManagement?: string;
  version?: number;
  replaceRequestKey?: boolean;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): BatchStatusActionState {
  if (error instanceof BatchStatusError || error instanceof EnqueueError || error instanceof AuthzError) {
    return {
      ok: false,
      message: error.message,
      remedy: error.remedy,
      replaceRequestKey: /request key/i.test(error.message),
    };
  }
  throw error;
}

export async function saveBatchStatusAction(
  _state: BatchStatusActionState,
  form: FormData,
): Promise<BatchStatusActionState> {
  const session = await requireCapability(ACTIVITY);
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: session.user.client });
    const saved = await saveBatchStatus({
      client: session.user.client,
      changedBy: session.user.username,
      statusManagement: read(form, 'statusManagement'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      transportRequest: read(form, 'transportRequest'),
      approval: read(form, 'approval'),
      postingPeriod: read(form, 'postingPeriod'),
      companyCode: read(form, 'companyCode'),
      batchLevel: read(form, 'batchLevel'),
      plant: read(form, 'plant'),
      initialStatus: read(form, 'initialStatus'),
      classification: read(form, 'classification') === 'true',
      internalNumbering: read(form, 'internalNumbering') === 'true',
      batchNumberRange: read(form, 'batchNumberRange'),
    });
    revalidatePath(ROUTE);
    const code = saved.statusManagement ?? 'blank';
    return {
      ok: true,
      message: saved.statusManagement === '1'
        ? `Batch status management 1 stands at version ${saved.version}. ${saved.scope.explanation} Nothing was posted.`
        : `Batch status management is not active (${code}) at version ${saved.version}. Nothing was posted.`,
      remedy: saved.scope.scope === 'PLANT_NOT_SELECTED'
        ? 'OMCU is not this screen. No plant was selected.'
        : 'Goods movements still do not carry a batch. MSC2N, OMAB, and OMCU are not this screen.',
      statusManagement: saved.statusManagement ?? '',
      version: saved.version,
      replaceRequestKey: true,
    };
  } catch (error) {
    return fail(error);
  }
}
