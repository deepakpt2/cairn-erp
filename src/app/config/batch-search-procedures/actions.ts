'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchSearchProcedureError,
  deleteBatchSearchProcedure,
  deleteBatchSearchProcedureStep,
  saveBatchSearchProcedure,
  saveBatchSearchProcedureStep,
} from '@/modules/inventory/batch-search-procedure';

export interface SearchProcedureActionState {
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
    movementType: read(form, 'movementType'),
    requirement: read(form, 'requirement'),
    manual: read(form, 'manual'),
    strategyType: read(form, 'strategyType'),
  };
}

export async function saveBatchSearchProcedureAction(
  _state: SearchProcedureActionState,
  form: FormData,
): Promise<SearchProcedureActionState> {
  const session = await requireCapability(ACTIVITY);
  const key = read(form, 'searchProcedure');
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: key });
    }
    const saved = await saveBatchSearchProcedure({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      mode,
      searchProcedure: key,
      description: read(form, 'description'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
      ...extras(form),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Search procedure ${saved.searchProcedure} is ${saved.description}. Usage H, application ME. No batch was selected and no stock was posted.` };
  } catch (error) {
    if (error instanceof BatchSearchProcedureError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function deleteBatchSearchProcedureAction(
  _state: SearchProcedureActionState,
  form: FormData,
): Promise<SearchProcedureActionState> {
  const session = await requireCapability(ACTIVITY);
  const key = read(form, 'searchProcedure');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: key });
    const removed = await deleteBatchSearchProcedure({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      searchProcedure: key,
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'deleteConfirmed') === 'yes',
      reason: read(form, 'deleteReason'),
      transportRequest: read(form, 'transportRequest'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Search procedure ${removed.searchProcedure} was deleted. No posted movement was rewritten.` };
  } catch (error) {
    if (error instanceof BatchSearchProcedureError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function saveBatchSearchProcedureStepAction(
  _state: SearchProcedureActionState,
  form: FormData,
): Promise<SearchProcedureActionState> {
  const session = await requireCapability(ACTIVITY);
  const procedure = read(form, 'searchProcedure');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: procedure });
    const saved = await saveBatchSearchProcedureStep({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      mode: read(form, 'stepMode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      searchProcedure: procedure,
      stepNumber: read(form, 'stepNumber'),
      counter: read(form, 'counter'),
      strategyType: read(form, 'stepStrategyType'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'stepConfirmed') === 'yes',
      reason: read(form, 'stepReason'),
      movementType: read(form, 'movementType'),
      requirement: read(form, 'requirement'),
      manual: read(form, 'manual'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Step ${saved.stepNumber} counter ${saved.counter} of ${saved.searchProcedure} names strategy type ${saved.strategyType}. No batch was selected and no stock was posted.` };
  } catch (error) {
    if (error instanceof BatchSearchProcedureError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function deleteBatchSearchProcedureStepAction(
  _state: SearchProcedureActionState,
  form: FormData,
): Promise<SearchProcedureActionState> {
  const session = await requireCapability(ACTIVITY);
  const procedure = read(form, 'searchProcedure');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: procedure });
    const removed = await deleteBatchSearchProcedureStep({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      searchProcedure: procedure,
      stepNumber: read(form, 'stepNumber'),
      counter: read(form, 'counter'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'deleteStepConfirmed') === 'yes',
      reason: read(form, 'deleteStepReason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Step ${removed.stepNumber} counter ${removed.counter} was deleted. No posted movement was rewritten.` };
  } catch (error) {
    if (error instanceof BatchSearchProcedureError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
