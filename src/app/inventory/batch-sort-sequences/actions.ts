'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchSortError,
  deleteSortSequence,
  saveSortSequence,
} from '@/modules/inventory/batch-sort-sequence';

export interface SortActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function criteriaOf(form: FormData) {
  const indexes = new Set<number>();
  for (const name of form.keys()) {
    const match = /^characteristic_(\d+)$/.exec(name);
    if (match) indexes.add(Number(match[1]));
  }
  return [...indexes].sort((left, right) => left - right).flatMap((index) => {
    const characteristicName = read(form, `characteristic_${index}`);
    if (!characteristicName.trim()) return [];
    return [{ characteristicName, direction: read(form, `direction_${index}`) }];
  });
}

export async function saveSortSequenceAction(
  _state: SortActionState,
  form: FormData,
): Promise<SortActionState> {
  const session = await requireCapability(ACTIVITY);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  const sortSequence = read(form, 'sortSequence');
  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: sortSequence });
    }
    const saved = await saveSortSequence({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      mode,
      sortSequence,
      description: read(form, 'description'),
      status: read(form, 'status'),
      criteria: criteriaOf(form),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Sort sequence ${saved.sortSequence} stands as ${saved.statusTitle}. No batch was selected and no stock was posted.`,
    };
  } catch (error) {
    if (error instanceof BatchSortError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function deleteSortSequenceAction(
  _state: SortActionState,
  form: FormData,
): Promise<SortActionState> {
  const session = await requireCapability(ACTIVITY);
  const sortSequence = read(form, 'sortSequence');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: sortSequence });
    const deleted = await deleteSortSequence({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      sortSequence,
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'deleteConfirmed') === 'yes',
      reason: read(form, 'deleteReason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Sort sequence ${deleted.sortSequence} was deleted. A search strategy was not changed.` };
  } catch (error) {
    if (error instanceof BatchSortError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
