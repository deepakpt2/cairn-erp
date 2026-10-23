'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchConditionTableError,
  deleteBatchConditionTable,
  saveBatchConditionTable,
} from '@/modules/inventory/batch-condition-table';

export interface ConditionTableActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function saveBatchConditionTableAction(
  _state: ConditionTableActionState,
  form: FormData,
): Promise<ConditionTableActionState> {
  const session = await requireCapability(ACTIVITY);
  const key = read(form, 'conditionTable');
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: key });
    }
    const saved = await saveBatchConditionTable({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      mode,
      conditionTable: key,
      fields: [read(form, 'fields')],
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
      transportRequest: read(form, 'transportRequest'),
      plant: read(form, 'plant'),
      usage: read(form, 'usage'),
      application: read(form, 'application'),
      generate: read(form, 'generate'),
      conditionRecord: read(form, 'conditionRecord'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Condition table ${saved.conditionTable} stores ${saved.fields.join(', ')}. Usage H, application ME. No table was generated and no stock was posted.`,
    };
  } catch (error) {
    if (error instanceof BatchConditionTableError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function deleteBatchConditionTableAction(
  _state: ConditionTableActionState,
  form: FormData,
): Promise<ConditionTableActionState> {
  const session = await requireCapability(ACTIVITY);
  const key = read(form, 'conditionTable');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: key });
    const removed = await deleteBatchConditionTable({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      conditionTable: key,
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'deleteConfirmed') === 'yes',
      reason: read(form, 'deleteReason'),
      transportRequest: read(form, 'transportRequest'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Condition table ${removed.conditionTable} was deleted. No posted movement was rewritten.` };
  } catch (error) {
    if (error instanceof BatchConditionTableError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
