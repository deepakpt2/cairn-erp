'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  INTERCOMPANY_CAPABILITY, IntercompanyError, postIntercompany,
} from '@/modules/finance/intercompany';

export interface IntercompanyActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/intercompany';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): IntercompanyActionState {
  if (error instanceof IntercompanyError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function postIntercompanyAction(
  _previous: IntercompanyActionState,
  form: FormData,
): Promise<IntercompanyActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INTERCOMPANY_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the intercompany posting capability.' };
  }
  try {
    // Lines arrive as parallel lists: account | debitCredit | amount | costCenter.
    const accounts = form.getAll('glAccount').map(String);
    const directions = form.getAll('debitCredit').map(String);
    const amounts = form.getAll('amount').map(String);
    const costCenters = form.getAll('costCenter').map(String);
    const lines = accounts
      .map((glAccount, i) => ({
        glAccount: glAccount.trim().toUpperCase(),
        debitCredit: (directions[i] === 'H' ? 'H' : 'S') as 'S' | 'H',
        amount: (amounts[i] ?? '').trim(),
        ...(costCenters[i]?.trim() ? { costCenter: costCenters[i]!.trim() } : {}),
      }))
      .filter((l) => l.glAccount && l.amount);
    const result = await postIntercompany({
      client: session.user.client, changedBy: session.user.username,
      sendingCompanyCode: text(form, 'sendingCompanyCode').toUpperCase(),
      receivingCompanyCode: text(form, 'receivingCompanyCode').toUpperCase(),
      postingDate: text(form, 'postingDate'), documentDate: text(form, 'documentDate'),
      documentType: text(form, 'documentType').toUpperCase(),
      ...(text(form, 'currency') ? { currency: text(form, 'currency').toUpperCase() } : {}),
      ...(text(form, 'reference') ? { reference: text(form, 'reference') } : {}),
      confirmed: text(form, 'confirmed') === 'yes',
      requestKey: text(form, 'requestKey'),
      lines,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Intercompany posted: ${result.sendingDocumentNumber} in ${text(form, 'sendingCompanyCode')} and ${result.receivingDocumentNumber} in ${text(form, 'receivingCompanyCode')}, ` +
        `clearing through ${result.sendingClearingAccount} and ${result.receivingClearingAccount} in ${result.currency}.`,
    };
  } catch (error) {
    return wrap(error);
  }
}
