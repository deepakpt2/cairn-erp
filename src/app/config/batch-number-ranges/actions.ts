'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchNumberRangeError,
  adjustBatchNumberStatus,
  deleteBatchNumberInterval,
  saveBatchNumberInterval,
} from '@/modules/inventory/batch-number-range';

export interface BatchRangeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): BatchRangeActionState {
  if (error instanceof BatchNumberRangeError || error instanceof EnqueueError || error instanceof AuthzError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveBatchIntervalAction(
  _state: BatchRangeActionState,
  form: FormData,
): Promise<BatchRangeActionState> {
  const session = await requireCapability(ACTIVITY);
  const interval = read(form, 'interval');
  try {
    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    await assertChangeForSession(session, {
      lockObject: LOCK_OBJECT,
      argument: mode === 'CHANGE' ? interval : session.user.client,
    });
    const saved = await saveBatchNumberInterval({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      interval,
      fromNumber: read(form, 'fromNumber'),
      toNumber: read(form, 'toNumber'),
      external: read(form, 'external') === 'X',
      status: read(form, 'status') || 'ACTIVE',
      mode,
      expectedTo: read(form, 'expectedTo'),
      expectedCurrent: read(form, 'expectedCurrent'),
      reason: read(form, 'reason'),
      transportRequest: read(form, 'transportRequest'),
      companyCode: read(form, 'companyCode'),
      fiscalYear: read(form, 'fiscalYear'),
      objectCode: read(form, 'objectCode'),
      buffered: read(form, 'buffered') === 'true',
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Interval ${saved.interval} stands, ${saved.fromNumber} to ${saved.toNumber}. ${saved.external ? 'External check.' : 'Internal.'} No batch was created.`,
      remedy: 'The next number is not reserved by being shown.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteBatchIntervalAction(
  _state: BatchRangeActionState,
  form: FormData,
): Promise<BatchRangeActionState> {
  const session = await requireCapability(ACTIVITY);
  const interval = read(form, 'interval');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: interval || session.user.client });
    await deleteBatchNumberInterval({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      interval,
      reason: read(form, 'reason'),
      transportRequest: read(form, 'transportRequest'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Interval ${interval} was deleted. Issued numbers were not removed, because none stood.` };
  } catch (error) {
    return fail(error);
  }
}

export async function adjustBatchIntervalAction(
  _state: BatchRangeActionState,
  form: FormData,
): Promise<BatchRangeActionState> {
  const session = await requireCapability(ACTIVITY);
  const interval = read(form, 'interval');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: interval });
    const saved = await adjustBatchNumberStatus({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      interval,
      currentNumber: read(form, 'currentNumber'),
      expectedCurrent: read(form, 'expectedCurrent'),
      reason: read(form, 'reason'),
      transportRequest: read(form, 'transportRequest'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: saved.changed
        ? `Interval ${interval} current number is ${saved.currentDisplay ?? 'nothing issued'}. It was not moved backwards.`
        : `Interval ${interval} already stood at that current number.`,
    };
  } catch (error) {
    return fail(error);
  }
}
