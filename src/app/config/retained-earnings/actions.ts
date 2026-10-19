'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  RETAINED_EARNINGS_ACTIVITY, RetainedEarningsError,
  deleteRetainedEarnings, maintainRetainedEarnings,
} from '@/modules/foundation/retained-earnings';

export interface RetainedEarningsActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/config/retained-earnings';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): RetainedEarningsActionState {
  if (error instanceof RetainedEarningsError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function maintainAction(
  _previous: RetainedEarningsActionState,
  form: FormData,
): Promise<RetainedEarningsActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RETAINED_EARNINGS_ACTIVITY)) {
    return { ok: false, message: 'You do not hold the retained earnings definition activity.' };
  }
  try {
    const row = await maintainRetainedEarnings({
      client: session.user.client, changedBy: session.user.username,
      chartOfAccounts: text(form, 'chartOfAccounts'),
      indicator: text(form, 'indicator'),
      glAccount: text(form, 'glAccount'),
      reason: text(form, 'reason') || undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Indicator ${row.indicator} of chart ${row.chartOfAccounts} closes to account ${row.glAccount}.` };
  } catch (error) {
    return wrap(error);
  }
}

export async function deleteAction(
  _previous: RetainedEarningsActionState,
  form: FormData,
): Promise<RetainedEarningsActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RETAINED_EARNINGS_ACTIVITY)) {
    return { ok: false, message: 'You do not hold the retained earnings definition activity.' };
  }
  try {
    await deleteRetainedEarnings({
      client: session.user.client, changedBy: session.user.username,
      chartOfAccounts: text(form, 'chartOfAccounts'),
      indicator: text(form, 'indicator'),
      reason: text(form, 'reason') || undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: 'The determination is deleted.' };
  } catch (error) {
    return wrap(error);
  }
}
