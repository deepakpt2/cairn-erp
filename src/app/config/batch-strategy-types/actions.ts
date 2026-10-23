'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchStrategyTypeError,
  deleteBatchStrategyType,
  saveBatchStrategyType,
} from '@/modules/inventory/batch-strategy-type';

export interface StrategyTypeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function extras(form: FormData) {
  return {
    transportRequest: read(form, 'transportRequest'),
    plant: read(form, 'plant'),
    usage: read(form, 'usage'),
    application: read(form, 'application'),
    accessSequence: read(form, 'accessSequence'),
    selectionClass: read(form, 'selectionClass'),
    classType: read(form, 'classType'),
    sortRule: read(form, 'sortRule'),
    quantityProposal: read(form, 'quantityProposal'),
    batchSplits: read(form, 'batchSplits'),
    splitsChangeable: read(form, 'splitsChangeable'),
    overdelivery: read(form, 'overdelivery'),
    dialog: read(form, 'dialog'),
    manual: read(form, 'manual'),
    unitDisplay: read(form, 'unitDisplay'),
    selectionType: read(form, 'selectionType'),
    searchProcedure: read(form, 'searchProcedure'),
  };
}

export async function saveBatchStrategyTypeAction(
  _state: StrategyTypeActionState,
  form: FormData,
): Promise<StrategyTypeActionState> {
  const session = await requireCapability(ACTIVITY);
  const key = read(form, 'strategyType');
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: key });
    }
    const saved = await saveBatchStrategyType({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      mode,
      strategyType: key,
      description: read(form, 'description'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
      ...extras(form),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Strategy type ${saved.strategyType} is ${saved.description}. Usage H, application ME. Access sequence ${saved.accessSequence || 'blank'}. No batch was selected and no stock was posted.`,
    };
  } catch (error) {
    if (error instanceof BatchStrategyTypeError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function deleteBatchStrategyTypeAction(
  _state: StrategyTypeActionState,
  form: FormData,
): Promise<StrategyTypeActionState> {
  const session = await requireCapability(ACTIVITY);
  const key = read(form, 'strategyType');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: key });
    const deleted = await deleteBatchStrategyType({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      strategyType: key,
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'deleteConfirmed') === 'yes',
      reason: read(form, 'reason'),
      transportRequest: read(form, 'transportRequest'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Strategy type ${deleted.strategyType} was deleted. No posted movement was rewritten.` };
  } catch (error) {
    if (error instanceof BatchStrategyTypeError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
