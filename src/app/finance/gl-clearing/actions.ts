'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  GL_CLEARING_CAPABILITY, GlClearingError, clearGlItems,
} from '@/modules/finance/gl-clearing';

export interface GlClearingActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/gl-clearing';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): GlClearingActionState {
  if (error instanceof GlClearingError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function clearAction(
  _previous: GlClearingActionState,
  form: FormData,
): Promise<GlClearingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, GL_CLEARING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the G/L clearing capability.' };
  }
  try {
    const items = form.getAll('item').map((value) => {
      const [documentNumber, fiscalYear, lineNumber] = String(value).split('|');
      return { documentNumber, fiscalYear: Number(fiscalYear), lineNumber: Number(lineNumber) };
    });
    const result = await clearGlItems({
      client: session.user.client, changedBy: session.user.username,
      companyCode: text(form, 'companyCode'), glAccount: text(form, 'glAccount').toUpperCase(),
      documentType: text(form, 'documentType').toUpperCase(),
      clearingDate: text(form, 'clearingDate'), postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      confirmed: text(form, 'confirmed') === 'yes',
      requestKey: text(form, 'requestKey'),
      items,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Clearing posted as document ${result.clearingDocumentNumber} (fiscal year ${result.clearingFiscalYear}): ${items.length} items cleared on ${text(form, 'clearingDate')}.`,
    };
  } catch (error) {
    return wrap(error);
  }
}
