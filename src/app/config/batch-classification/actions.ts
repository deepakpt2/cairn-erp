'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchClassificationError,
  saveBatchClassification,
} from '@/modules/inventory/batch-classification';

export interface BatchClassificationActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function saveBatchClassificationAction(
  _state: BatchClassificationActionState,
  form: FormData,
): Promise<BatchClassificationActionState> {
  const session = await requireCapability(ACTIVITY);
  const key = read(form, 'movementType');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: key });
    const saved = await saveBatchClassification({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      movementType: key,
      classification: read(form, 'classification'),
      expectedClassification: read(form, 'expectedClassification'),
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
      transportRequest: read(form, 'transportRequest'),
      plant: read(form, 'plant'),
      copyRule: read(form, 'copyRule'),
      wipCopy: read(form, 'wipCopy'),
      extendedCfc: read(form, 'extendedCfc'),
      classType: read(form, 'classType'),
    });
    revalidatePath(ROUTE);
    const shown = saved.classification === ' ' ? 'blank' : saved.classification;
    return {
      ok: true,
      message: `Movement type ${saved.movementType} classification is ${shown}. A posted movement was not rewritten. No stock was posted.`,
    };
  } catch (error) {
    if (error instanceof BatchClassificationError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
