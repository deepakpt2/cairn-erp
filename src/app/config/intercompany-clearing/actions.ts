'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  INTERCOMPANY_CONFIG_CAPABILITY, IntercompanyError,
  deleteIntercompanyConfig, listIntercompanyConfigs, saveIntercompanyConfig,
} from '@/modules/finance/intercompany';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';

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
  if (error instanceof IntercompanyError || error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

function pairArgument(sending: string, receiving: string) {
  return `${sending.trim()}/${receiving.trim()}`;
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
    const sendingCompanyCode = read(form, 'sendingCompanyCode');
    const receivingCompanyCode = read(form, 'receivingCompanyCode');
    const standing = await listIntercompanyConfigs(session.user.client);
    if (standing.some((pair) => pair.sendingCompanyCode.toUpperCase() === sendingCompanyCode.toUpperCase() && pair.receivingCompanyCode.toUpperCase() === receivingCompanyCode.toUpperCase())) {
      await assertChangeForSession(session, {
        lockObject: 'INTERCOMPANY_PAIR',
        argument: pairArgument(sendingCompanyCode, receivingCompanyCode),
      });
    }
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
    const sendingCompanyCode = read(form, 'sendingCompanyCode');
    const receivingCompanyCode = read(form, 'receivingCompanyCode');
    await assertChangeForSession(session, {
      lockObject: 'INTERCOMPANY_PAIR',
      argument: pairArgument(sendingCompanyCode, receivingCompanyCode),
    });
    await deleteIntercompanyConfig({
      client: session.user.client, changedBy: session.user.username,
      sendingCompanyCode,
      receivingCompanyCode,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Pair ${read(form, 'sendingCompanyCode')} to ${read(form, 'receivingCompanyCode')} stands deleted.` };
  } catch (error) {
    return wrap(error);
  }
}
