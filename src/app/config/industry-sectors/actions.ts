'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  IndustrySectorError,
  deleteIndustrySector,
  saveIndustrySector,
  setIndustrySectorActive,
} from '@/modules/inventory/industry-sector-definition';

export interface IndustrySectorActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/industry-sectors';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): IndustrySectorActionState {
  if (error instanceof IndustrySectorError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveIndustrySectorAction(
  _previous: IndustrySectorActionState,
  form: FormData,
): Promise<IndustrySectorActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await saveIndustrySector({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      sector: read(form, 'sector'),
      name: read(form, 'name'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Industry sector ${result.sector} saved.` }
      : { ok: true, message: `Industry sector ${result.sector} already holds this name; nothing was changed.` };
  } catch (error) {
    return fail(error);
  }
}

export async function setIndustrySectorActiveAction(
  _previous: IndustrySectorActionState,
  form: FormData,
): Promise<IndustrySectorActionState> {
  const session = await requireSession(ROUTE);
  const active = read(form, 'active') === 'true';
  try {
    const result = await setIndustrySectorActive({
      client: session.user.client,
      changedBy: session.user.username,
      sector: read(form, 'sector'),
      active,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Industry sector ${result.sector} ${active ? 'reactivated' : 'deactivated'}.` }
      : { ok: true, message: `Industry sector ${result.sector} already stands ${active ? 'active' : 'inactive'}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteIndustrySectorAction(
  _previous: IndustrySectorActionState,
  form: FormData,
): Promise<IndustrySectorActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await deleteIndustrySector({
      client: session.user.client,
      changedBy: session.user.username,
      sector: read(form, 'sector'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Industry sector ${result.sector} deleted.` };
  } catch (error) {
    return fail(error);
  }
}
