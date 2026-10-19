'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  SPECIAL_GL_ACTIVITY,
  SpecialGlError,
  deleteSpecialGlConfig,
  maintainSpecialGlConfig,
} from '@/modules/foundation/special-gl';

export interface SpecialGlActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/config/special-gl';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): SpecialGlActionState {
  if (error instanceof SpecialGlError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function maintainAction(
  _previous: SpecialGlActionState,
  form: FormData,
): Promise<SpecialGlActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SPECIAL_GL_ACTIVITY)) {
    return { ok: false, message: 'You do not hold the special G/L configuration activity.' };
  }
  try {
    const row = await maintainSpecialGlConfig({
      client: session.user.client, changedBy: session.user.username,
      companyCode: text(form, 'companyCode'),
      accountType: text(form, 'accountType').toUpperCase(),
      indicator: text(form, 'indicator').toUpperCase(),
      alternativeReconciliationAccount: text(form, 'alternativeAccount'),
      targetSpecialGlIndicator: text(form, 'targetIndicator').toUpperCase(),
      description: text(form, 'description') || undefined,
      reason: text(form, 'reason') || undefined,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: row.targetSpecialGlIndicator
        ? `Indicator ${row.indicator} (${row.accountType}) is a request indicator expecting ${row.targetSpecialGlIndicator} at fulfillment.`
        : `Indicator ${row.indicator} (${row.accountType}) now resolves to ${row.alternativeReconciliationAccount}.`,
    };
  } catch (error) {
    return wrap(error);
  }
}

export async function deleteAction(
  _previous: SpecialGlActionState,
  form: FormData,
): Promise<SpecialGlActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SPECIAL_GL_ACTIVITY)) {
    return { ok: false, message: 'You do not hold the special G/L configuration activity.' };
  }
  try {
    await deleteSpecialGlConfig({
      client: session.user.client, changedBy: session.user.username,
      companyCode: text(form, 'companyCode'),
      accountType: text(form, 'accountType').toUpperCase(),
      indicator: text(form, 'indicator').toUpperCase(),
      reason: text(form, 'reason') || undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: 'Indicator deleted.' };
  } catch (error) {
    return wrap(error);
  }
}
