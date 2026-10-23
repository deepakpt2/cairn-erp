'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  LOCK_OBJECT,
  ROUTE,
  BatchDocumentError,
  saveBatchDocumentManagement,
} from '@/modules/inventory/batch-document-management';

export interface DocumentActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  code?: string;
  version?: number;
  replaceRequestKey?: boolean;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function saveDocumentManagementAction(
  _state: DocumentActionState,
  form: FormData,
): Promise<DocumentActionState> {
  const session = await requireCapability(ACTIVITY);
  try {
    await assertChangeForSession(session, { lockObject: LOCK_OBJECT, argument: session.user.client });
    const saved = await saveBatchDocumentManagement({
      client: session.user.client,
      changedBy: session.user.username,
      documentManagement: read(form, 'documentManagement'),
      version: Number(read(form, 'version') || '0'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      code: saved.code ?? '',
      version: saved.version,
      replaceRequestKey: true,
      message: saved.code === 'X'
        ? `Document management X stands at version ${saved.version}. No document was created.`
        : `Document management is not active at version ${saved.version}. No batch or link was deleted.`,
    };
  } catch (error) {
    if (error instanceof BatchDocumentError || error instanceof EnqueueError || error instanceof AuthzError) {
      return {
        ok: false,
        message: error.message,
        remedy: error.remedy,
        replaceRequestKey: /request key/i.test(error.message),
      };
    }
    throw error;
  }
}
