'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import { ACTIVITY, LOCK_OBJECT, ROUTE, BatchMasterError, createBatch } from '@/modules/inventory/batch-master';

export interface CreateBatchState {
  ok: boolean;
  message?: string;
  remedy?: string;
  batchNumber?: string;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function createBatchAction(_state: CreateBatchState, form: FormData): Promise<CreateBatchState> {
  const session = await requireCapability(ACTIVITY);
  const materialNumber = read(form, 'materialNumber');
  const batchNumber = read(form, 'batchNumber');
  const plant = read(form, 'plant');
  const argument = [materialNumber, plant, batchNumber].filter(Boolean).join('/');
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument });
    const created = await createBatch({
      client: session.user.client,
      changedBy: session.user.username,
      materialNumber,
      plant,
      batchNumber,
      restrictedUse: (() => {
        const status = form.has('restrictedUse') ? read(form, 'restrictedUse') : undefined;
        return status === undefined || status === 'DERIVE' ? undefined : status;
      })(),
      manufactureDate: read(form, 'manufactureDate'),
      shelfLifeExpirationDate: read(form, 'shelfLifeExpirationDate'),
      vendorBatch: read(form, 'vendorBatch'),
      countryOfOrigin: read(form, 'countryOfOrigin'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      internalNumbering: read(form, 'internalNumbering') === 'true',
      classification: read(form, 'classification') === 'true',
      companyCode: read(form, 'companyCode'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      batchNumber: created.batchNumber,
      message: `Batch ${created.batchNumber} stands for material ${created.materialNumber}. No stock was posted.`,
      remedy: created.statusApplies
        ? created.restrictedUse === 'X' ? 'The restricted-use indicator is X.' : 'The restricted-use indicator is blank. That is unrestricted, not a number.'
        : 'Status management is not effective, so no status was stored. MSC2N and MSC3N are not this screen.',
    };
  } catch (error) {
    if (error instanceof BatchMasterError || error instanceof EnqueueError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
