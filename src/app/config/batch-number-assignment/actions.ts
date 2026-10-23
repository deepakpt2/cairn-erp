'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  PLANT_LOCK_OBJECT,
  ROUTE,
  BatchNumberAssignmentError,
  saveAssignedReceipt,
  saveInternalBatchAssignment,
} from '@/modules/inventory/batch-number-assignment';

export interface AssignmentActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  code?: string;
  version?: number;
  plant?: string;
  replaceRequestKey?: boolean;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): AssignmentActionState {
  if (error instanceof BatchNumberAssignmentError || error instanceof EnqueueError || error instanceof AuthzError) {
    return {
      ok: false,
      message: error.message,
      remedy: error.remedy,
      replaceRequestKey: /request key/i.test(error.message),
    };
  }
  throw error;
}

export async function saveInternalAssignmentAction(
  _state: AssignmentActionState,
  form: FormData,
): Promise<AssignmentActionState> {
  const session = await requireCapability(ACTIVITY);
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: session.user.client });
    const saved = await saveInternalBatchAssignment({
      client: session.user.client,
      changedBy: session.user.username,
      internalAssignment: read(form, 'internalAssignment'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      transportRequest: read(form, 'transportRequest'),
      approval: read(form, 'approval'),
      postingPeriod: read(form, 'postingPeriod'),
      companyCode: read(form, 'companyCode'),
      batchLevel: read(form, 'batchLevel'),
      plant: read(form, 'plant'),
      materialType: read(form, 'materialType'),
      classification: read(form, 'classification') === 'true',
      movementCreation: read(form, 'movementCreation') === 'true',
      batchNumberRange: read(form, 'batchNumberRange'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: saved.code === 'X'
        ? `Internal batch number assignment X stands at version ${saved.version}. No number range was created. Nothing was posted.`
        : `Internal batch number assignment is not active at version ${saved.version}. Nothing was posted.`,
      remedy: saved.range.defined
        ? 'BATCH_CLT interval 01 already stands on the number range screen. OMAD is not this screen.'
        : 'BATCH_CLT interval 01 is not defined. Maintain it on the number range screen. This save did not create it.',
      code: saved.code ?? '',
      version: saved.version,
      replaceRequestKey: true,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function saveAssignedReceiptAction(
  _state: AssignmentActionState,
  form: FormData,
): Promise<AssignmentActionState> {
  const session = await requireCapability(ACTIVITY);
  const plant = read(form, 'plant');
  try {
    await assertChangeForSession(session, { lockObject: PLANT_LOCK_OBJECT, argument: plant || session.user.client });
    const saved = await saveAssignedReceipt({
      client: session.user.client,
      changedBy: session.user.username,
      plant,
      assignedReceipt: read(form, 'assignedReceipt'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      transportRequest: read(form, 'transportRequest'),
      companyCode: read(form, 'companyCode'),
      materialType: read(form, 'materialType'),
      movementCreation: read(form, 'movementCreation') === 'true',
      batchNumberRange: read(form, 'batchNumberRange'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: saved.code === 'X'
        ? `Plant ${saved.plant} permits an internal number for an account-assigned goods receipt. Version ${saved.version}. No receipt was posted.`
        : `Plant ${saved.plant} does not permit an internal number for an account-assigned goods receipt. Version ${saved.version}. No receipt was posted.`,
      remedy: 'This flag is not the client activation, and it does not create a batch for a stock receipt.',
      code: saved.code ?? '',
      version: saved.version,
      plant: saved.plant,
      replaceRequestKey: true,
    };
  } catch (error) {
    return fail(error);
  }
}
