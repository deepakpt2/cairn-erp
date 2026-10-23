'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchSearchStrategyError,
  deleteBatchSearchStrategy,
  saveBatchSearchStrategy,
} from '@/modules/inventory/batch-search-strategy';

export interface StrategyActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function keysOf(form: FormData): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (name.startsWith('key_') && typeof value === 'string') keys[name.slice(4)] = value;
  }
  return keys;
}

export async function saveBatchSearchStrategyAction(
  _state: StrategyActionState,
  form: FormData,
): Promise<StrategyActionState> {
  const session = await requireCapability(ACTIVITY);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  const recordNumber = read(form, 'recordNumber');
  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: recordNumber });
    }
    const saved = await saveBatchSearchStrategy({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      mode,
      strategyType: read(form, 'strategyType'),
      conditionTable: read(form, 'conditionTable'),
      keys: keysOf(form),
      validFrom: read(form, 'validFrom'),
      validTo: read(form, 'validTo'),
      recordNumber,
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
      selectionClass: read(form, 'selectionClass'),
      sortRule: read(form, 'sortRule'),
      quantityProposal: read(form, 'quantityProposal'),
      splits: read(form, 'splits'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Search strategy ${saved.recordNumber} stands from ${saved.validFrom} to ${saved.validTo}. No batch was selected and no stock was posted.` };
  } catch (error) {
    if (error instanceof BatchSearchStrategyError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function deleteBatchSearchStrategyAction(
  _state: StrategyActionState,
  form: FormData,
): Promise<StrategyActionState> {
  const session = await requireCapability(ACTIVITY);
  const recordNumber = read(form, 'recordNumber');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: recordNumber });
    const removed = await deleteBatchSearchStrategy({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      recordNumber,
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'deleteConfirmed') === 'yes',
      reason: read(form, 'deleteReason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Search strategy ${removed.recordNumber} was deleted. No posted movement was rewritten.` };
  } catch (error) {
    if (error instanceof BatchSearchStrategyError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
