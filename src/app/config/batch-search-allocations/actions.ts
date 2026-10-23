'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchSearchAllocationError,
  deleteBatchSearchAllocation,
  saveBatchSearchAllocation,
} from '@/modules/inventory/batch-search-allocation';

export interface AllocationActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function saveBatchSearchAllocationAction(
  _state: AllocationActionState,
  form: FormData,
): Promise<AllocationActionState> {
  const session = await requireCapability(ACTIVITY);
  const movement = read(form, 'movementType');
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: movement });
    }
    const saved = await saveBatchSearchAllocation({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      mode,
      movementType: movement,
      specialStock: read(form, 'specialStock'),
      searchProcedure: read(form, 'searchProcedure'),
      transferProcedure: read(form, 'transferProcedure'),
      checkBatch: read(form, 'checkBatch'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
      transportRequest: read(form, 'transportRequest'),
      plant: read(form, 'plant'),
      usage: read(form, 'usage'),
      application: read(form, 'application'),
      transferCheck: read(form, 'transferCheck'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Movement type ${saved.movementType} uses search procedure ${saved.searchProcedure}. No batch was selected and no stock was posted.` };
  } catch (error) {
    if (error instanceof BatchSearchAllocationError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function deleteBatchSearchAllocationAction(
  _state: AllocationActionState,
  form: FormData,
): Promise<AllocationActionState> {
  const session = await requireCapability(ACTIVITY);
  const movement = read(form, 'movementType');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: movement });
    const removed = await deleteBatchSearchAllocation({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      movementType: movement,
      specialStock: read(form, 'specialStock'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'deleteConfirmed') === 'yes',
      reason: read(form, 'deleteReason'),
      transportRequest: read(form, 'transportRequest'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `The allocation for movement type ${removed.movementType} was deleted. No posted movement was rewritten.` };
  } catch (error) {
    if (error instanceof BatchSearchAllocationError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
