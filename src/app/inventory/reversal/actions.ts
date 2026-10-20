'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
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
  const lines = form.getAll('lines')
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  const fiscalYear = text(form, 'fiscalYear');
  try {
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
      message: `Reversal posted as material document ${doc.materialDocumentNumber}.`,
      documentNumber: doc.materialDocumentNumber,
    };
  } catch (error) {
    if (error instanceof MaterialReversalError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
