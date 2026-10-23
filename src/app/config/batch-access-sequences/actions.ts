'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchAccessSequenceError,
  deleteBatchAccessSequence,
  deleteBatchAccessStep,
  saveBatchAccessSequence,
  saveBatchAccessStep,
} from '@/modules/inventory/batch-access-sequence';

export interface AccessSequenceActionState {
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
    conditionTable: read(form, 'conditionTable'),
    accessNumber: read(form, 'accessNumber'),
    exclusive: read(form, 'exclusive'),
    requirement: read(form, 'requirement'),
    fieldMapping: read(form, 'fieldMapping'),
  };
}

export async function saveBatchAccessSequenceAction(
  _state: AccessSequenceActionState,
  form: FormData,
): Promise<AccessSequenceActionState> {
  const session = await requireCapability(ACTIVITY);
  const key = read(form, 'accessSequence');
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: key });
    }
    const saved = await saveBatchAccessSequence({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      mode,
      accessSequence: key,
      description: read(form, 'description'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
      ...extras(form),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Access sequence ${saved.accessSequence} is ${saved.description}. Usage H, application ME. No access ran and no stock was posted.`,
    };
  } catch (error) {
    if (error instanceof BatchAccessSequenceError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function deleteBatchAccessSequenceAction(
  _state: AccessSequenceActionState,
  form: FormData,
): Promise<AccessSequenceActionState> {
  const session = await requireCapability(ACTIVITY);
  const key = read(form, 'accessSequence');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: key });
    const removed = await deleteBatchAccessSequence({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      accessSequence: key,
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'deleteConfirmed') === 'yes',
      reason: read(form, 'deleteReason'),
      transportRequest: read(form, 'transportRequest'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Access sequence ${removed.accessSequence} was deleted. No posted movement was rewritten.` };
  } catch (error) {
    if (error instanceof BatchAccessSequenceError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function saveBatchAccessStepAction(
  _state: AccessSequenceActionState,
  form: FormData,
): Promise<AccessSequenceActionState> {
  const session = await requireCapability(ACTIVITY);
  const sequence = read(form, 'accessSequence');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: sequence });
    const saved = await saveBatchAccessStep({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      mode: read(form, 'stepMode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      accessSequence: sequence,
      accessNumber: read(form, 'accessNumber'),
      conditionTable: read(form, 'conditionTable'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'stepConfirmed') === 'yes',
      reason: read(form, 'stepReason'),
      exclusive: read(form, 'exclusive'),
      requirement: read(form, 'requirement'),
      fieldMapping: read(form, 'fieldMapping'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Access ${saved.accessNumber} of ${saved.accessSequence} names condition table ${saved.conditionTable}. No access ran and no stock was posted.`,
    };
  } catch (error) {
    if (error instanceof BatchAccessSequenceError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function deleteBatchAccessStepAction(
  _state: AccessSequenceActionState,
  form: FormData,
): Promise<AccessSequenceActionState> {
  const session = await requireCapability(ACTIVITY);
  const sequence = read(form, 'accessSequence');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: sequence });
    const removed = await deleteBatchAccessStep({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      accessSequence: sequence,
      accessNumber: read(form, 'accessNumber'),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'deleteStepConfirmed') === 'yes',
      reason: read(form, 'deleteStepReason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Access ${removed.accessNumber} was deleted. No posted movement was rewritten.` };
  } catch (error) {
    if (error instanceof BatchAccessSequenceError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
