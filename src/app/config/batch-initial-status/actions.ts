'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  InitialBatchStatusError,
  saveInitialBatchStatus,
} from '@/modules/inventory/initial-batch-status';

export interface InitialStatusActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function saveInitialBatchStatusAction(
  _state: InitialStatusActionState,
  form: FormData,
): Promise<InitialStatusActionState> {
  const session = await requireCapability(ACTIVITY);
  const materialType = read(form, 'materialType');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: materialType });
    const saved = await saveInitialBatchStatus({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      materialType,
      initialStatus: read(form, 'initialStatus') === 'X' ? 'X' : '',
      expectedStatus: read(form, 'expectedStatus') === 'X' ? 'X' : '',
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
      transportRequest: read(form, 'transportRequest'),
      plant: read(form, 'plant'),
      batchLevel: read(form, 'batchLevel'),
      movement: read(form, 'movement'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Material type ${saved.materialType} initial status is ${saved.initialStatus === 'X' ? 'X' : 'blank'}. Existing batches were not rewritten. No stock was posted.`,
    };
  } catch (error) {
    if (error instanceof InitialBatchStatusError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
