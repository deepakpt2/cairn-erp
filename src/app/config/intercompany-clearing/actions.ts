'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  INTERCOMPANY_CONFIG_CAPABILITY, IntercompanyError,
  deleteIntercompanyConfig, saveIntercompanyConfig,
} from '@/modules/finance/intercompany';

export interface IntercompanyConfigActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/config/intercompany-clearing';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): IntercompanyConfigActionState {
  if (error instanceof IntercompanyError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function saveIntercompanyConfigAction(
  _previous: IntercompanyConfigActionState,
  form: FormData,
): Promise<IntercompanyConfigActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INTERCOMPANY_CONFIG_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the intercompany configuration capability.' };
  }
  try {
    const saved = await saveIntercompanyConfig({
      client: session.user.client, changedBy: session.user.username,
      sendingCompanyCode: read(form, 'sendingCompanyCode'),
      receivingCompanyCode: read(form, 'receivingCompanyCode'),
      sendingClearingGl: read(form, 'sendingClearingGl') || undefined,
      receivingClearingGl: read(form, 'receivingClearingGl') || undefined,
      defaultCurrency: read(form, 'defaultCurrency') || undefined,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Pair ${saved.sendingCompanyCode} to ${saved.receivingCompanyCode} stands configured.`,
    };
  } catch (error) {
    return wrap(error);
  }
}

export async function deleteIntercompanyConfigAction(
  _previous: IntercompanyConfigActionState,
  form: FormData,
): Promise<IntercompanyConfigActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INTERCOMPANY_CONFIG_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the intercompany configuration capability.' };
  }
  try {
    await deleteIntercompanyConfig({
      client: session.user.client, changedBy: session.user.username,
      sendingCompanyCode: read(form, 'sendingCompanyCode'),
      receivingCompanyCode: read(form, 'receivingCompanyCode'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Pair ${read(form, 'sendingCompanyCode')} to ${read(form, 'receivingCompanyCode')} stands deleted.` };
  } catch (error) {
    return wrap(error);
  }
}
