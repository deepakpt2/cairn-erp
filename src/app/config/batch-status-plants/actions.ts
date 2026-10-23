'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchStatusPlantError,
  savePlantBatchStatus,
} from '@/modules/inventory/batch-status-plant';

export interface PlantStatusActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function savePlantBatchStatusAction(
  _state: PlantStatusActionState,
  form: FormData,
): Promise<PlantStatusActionState> {
  const session = await requireCapability(ACTIVITY);
  const plant = read(form, 'plant');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: plant || session.user.client });
    const saved = await savePlantBatchStatus({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      plant,
      statusActive: read(form, 'statusActive') === 'X' ? 'X' : '',
      version: Number(read(form, 'version') || '0'),
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
      transportRequest: read(form, 'transportRequest'),
      companyCode: read(form, 'companyCode'),
      batchLevel: read(form, 'batchLevel'),
      plantName: read(form, 'plantName'),
      initialStatus: read(form, 'initialStatus'),
      movement: read(form, 'movement'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Plant ${saved.plant} is ${saved.statusActive === 'X' ? 'selected' : 'not selected'}. ${saved.plantName} was not renamed. No batch was created, and movement 341 was not posted.`,
      remedy: saved.effective ? 'Status management applies in this plant.' : 'The selection is stored. It is not effective until the batch level is plant and OMCS is active.',
    };
  } catch (error) {
    if (error instanceof BatchStatusPlantError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
