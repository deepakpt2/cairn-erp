'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  MaterialReversalError,
  REVERSE_CAPABILITY,
  reverseMaterialDocument,
} from '@/modules/inventory/material-document-reversal';

export interface ReversalActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  documentNumber?: string;
}

const ROUTE = '/inventory/reversal';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function reverseMaterialDocumentAction(
  _previous: ReversalActionState,
  form: FormData,
): Promise<ReversalActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, REVERSE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the material document reversal capability.' };
  }
  if (text(form, 'quantity')) {
    return {
      ok: false,
      message: 'A reversal quantity cannot be entered. A line is reversed in full or not at all.',
      remedy: 'Select the lines to reverse. Do not enter a quantity.',
    };
  }
  const lines = form.getAll('lines')
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  const fiscalYear = text(form, 'fiscalYear');
  try {
    await assertChangeForSession(session, {
      lockObject: 'MATERIAL_DOCUMENT',
      argument: text(form, 'materialDocumentNumber'),
    });
    const doc = await reverseMaterialDocument({
      client: session.user.client,
      changedBy: session.user.username,
      materialDocumentNumber: text(form, 'materialDocumentNumber'),
      fiscalYear: fiscalYear ? Number(fiscalYear) : undefined,
      lines: lines.length > 0 ? lines : undefined,
      postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      headerText: text(form, 'headerText') || undefined,
      reason: text(form, 'reason') || undefined,
      requestKey: text(form, 'requestKey'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: doc.journalAccounting.state === 'DEFERRED'
        ? `Reversal posted as material document ${doc.materialDocumentNumber}. Stock and value of the selected lines moved. The journal is still posted.`
        : doc.journalAccounting.state === 'COMPLETE'
          ? `Reversal posted as material document ${doc.materialDocumentNumber}. The journal reversal is posted.`
          : `Reversal posted as material document ${doc.materialDocumentNumber}. Accounting is not reversed.`,
      documentNumber: doc.materialDocumentNumber,
    };
  } catch (error) {
    if (error instanceof MaterialReversalError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
