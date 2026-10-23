'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import { ACTIVITY, LOCK_OBJECT, ROUTE, BatchChangeError, changeBatch } from '@/modules/inventory/batch-change';

export interface ChangeBatchState {
  ok: boolean;
  message?: string;
  remedy?: string;
  version?: number;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function changeBatchAction(_state: ChangeBatchState, form: FormData): Promise<ChangeBatchState> {
  const session = await requireCapability(ACTIVITY);
  const materialNumber = read(form, 'materialNumber');
  const batchNumber = read(form, 'batchNumber');
  const plant = read(form, 'plant');
  const argument = [materialNumber, plant, batchNumber].filter(Boolean).join('/');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument });
    const status = form.has('restrictedUse') ? read(form, 'restrictedUse') : undefined;
    const changed = await changeBatch({
      client: session.user.client,
      changedBy: session.user.username,
      materialNumber,
      plant,
      batchNumber,
      expectedVersion: Number(read(form, 'version')),
      restrictedUse: status === undefined || status === 'KEEP' ? undefined : status,
      manufactureDate: read(form, 'manufactureDate'),
      shelfLifeExpirationDate: read(form, 'shelfLifeExpirationDate'),
      vendorBatch: read(form, 'vendorBatch'),
      countryOfOrigin: read(form, 'countryOfOrigin'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      version: changed.version,
      message: changed.changed
        ? `Batch ${changed.batchNumber} was changed. No stock was posted.`
        : `Batch ${changed.batchNumber} was not changed. The batch number was not regenerated.`,
      remedy: changed.changed
        ? 'Movements 341 and 342 were not posted. Stock has no batch.'
        : 'Send a different date, vendor batch, country, or restricted-use indicator.',
    };
  } catch (error) {
    if (error instanceof BatchChangeError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
