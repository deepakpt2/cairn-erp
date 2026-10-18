'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  IndustryError,
  deleteIndustry,
  saveIndustry,
  setIndustryActive,
} from '@/modules/foundation/industry-definition';

export interface IndustryActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/industries';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): IndustryActionState {
  if (error instanceof IndustryError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveIndustryAction(
  _previous: IndustryActionState,
  form: FormData,
): Promise<IndustryActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await saveIndustry({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      code: read(form, 'industry'),
      texts: [{
        language: read(form, 'language') || 'en',
        description: read(form, 'description'),
      }],
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Industry ${result.code} saved.` }
      : { ok: true, message: `Industry ${result.code} already holds this description; nothing was changed.` };
  } catch (error) {
    return fail(error);
  }
}

export async function setIndustryActiveAction(
  _previous: IndustryActionState,
  form: FormData,
): Promise<IndustryActionState> {
  const session = await requireSession(ROUTE);
  const active = read(form, 'active') === 'true';
  try {
    const result = await setIndustryActive({
      client: session.user.client,
      changedBy: session.user.username,
      code: read(form, 'industry'),
      active,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Industry ${result.code} ${active ? 'reactivated' : 'deactivated'}.` }
      : { ok: true, message: `Industry ${result.code} already stands ${active ? 'active' : 'inactive'}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteIndustryAction(
  _previous: IndustryActionState,
  form: FormData,
): Promise<IndustryActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await deleteIndustry({
      client: session.user.client,
      changedBy: session.user.username,
      code: read(form, 'industry'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Industry ${result.code} deleted.` };
  } catch (error) {
    return fail(error);
  }
}
