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
      const key = String(value);
      const [documentNumber, fiscalYear, lineNumber] = key.split('|');
      const settlement = text(form, `settlement:${key}`);
      return {
        documentNumber, fiscalYear: Number(fiscalYear), lineNumber: Number(lineNumber),
        ...(settlement ? { settlementAmount: settlement } : {}),
      };
    });
    const methodValue = text(form, 'method');
    const method = methodValue === 'PARTIAL' || methodValue === 'RESIDUAL' ? methodValue : 'STANDARD';
    const result = await clearGlItems({
      client: session.user.client, changedBy: session.user.username,
      companyCode: text(form, 'companyCode'), glAccount: text(form, 'glAccount').toUpperCase(),
      documentType: text(form, 'documentType').toUpperCase(),
      clearingDate: text(form, 'clearingDate'), postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      confirmed: text(form, 'confirmed') === 'yes',
      requestKey: text(form, 'requestKey'),
      items,
      method,
      ...(text(form, 'residualReasonCode') ? { residualReasonCode: text(form, 'residualReasonCode').toUpperCase() } : {}),
      crossCurrency: text(form, 'crossCurrency') === 'yes',
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Clearing posted as document ${result.clearingDocumentNumber} (fiscal year ${result.clearingFiscalYear}): ${items.length} items settled on ${text(form, 'clearingDate')} by ${method.toLowerCase()} clearing`
        + (result.residualItems.length
          ? `, ${result.residualItems.length} residual item(s) re-stood (${result.residualItems.map((r) => `${r.amount} ${r.reasonCode}`).join(', ')}).`
          : method === 'PARTIAL'
            ? ', the short-settled items standing open.'
            : '.'),
    };
  } catch (error) {
    return wrap(error);
  }
}
