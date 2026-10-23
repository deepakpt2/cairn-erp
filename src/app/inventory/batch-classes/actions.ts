'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchClassError,
  saveBatchClass,
} from '@/modules/inventory/batch-class';

export interface BatchClassActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function assignmentsOf(form: FormData): Array<{ characteristicName: string; requiredForClassification: boolean }> {
  const indexes = new Set<number>();
  for (const name of form.keys()) {
    const match = /^characteristic_(\d+)$/.exec(name);
    if (match) indexes.add(Number(match[1]));
  }
  return [...indexes].sort((left, right) => left - right).flatMap((index) => {
    const characteristicName = read(form, `characteristic_${index}`);
    if (!characteristicName.trim()) return [];
    return [{
      characteristicName,
      requiredForClassification: read(form, `required_${index}`) === 'yes',
    }];
  });
}

export async function saveBatchClassAction(
  _state: BatchClassActionState,
  form: FormData,
): Promise<BatchClassActionState> {
  const session = await requireCapability(ACTIVITY);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
  const className = read(form, 'className');
  const classType = read(form, 'classType');
  try {
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: `${classType}/${className}` });
    }
    const saved = await saveBatchClass({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      mode,
      className,
      description: read(form, 'description'),
      classType,
      assignments: assignmentsOf(form),
      expectedVersion: Number(read(form, 'expectedVersion') || '0'),
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Class ${saved.className} stands under ${saved.classType}. It was not assigned to a material or a batch, and no batch was selected.`,
    };
  } catch (error) {
    if (error instanceof BatchClassError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
