'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  MaterialPeriodError,
  initializeMaterialPeriodControl,
  setMaterialPeriodIndicators,
  shiftMaterialPeriod,
} from '@/modules/inventory/material-period-control';

export interface MaterialPeriodActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/material-period-control';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): MaterialPeriodActionState {
  if (error instanceof MaterialPeriodError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function initializeMaterialPeriodAction(
  _previous: MaterialPeriodActionState,
  form: FormData,
): Promise<MaterialPeriodActionState> {
  const session = await requireSession(ROUTE);
  const companyCode = read(form, 'companyCode');
  try {
    await assertChangeForSession(session, { lockObject: 'MATERIAL_PERIOD', argument: companyCode });
    await initializeMaterialPeriodControl({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode,
      fiscalYear: Number(read(form, 'fiscalYear')),
      period: Number(read(form, 'period')),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Material period for company code ${companyCode} initialized at ${read(form, 'fiscalYear')} / ${read(form, 'period')}.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function setMaterialPeriodIndicatorsAction(
  _previous: MaterialPeriodActionState,
  form: FormData,
): Promise<MaterialPeriodActionState> {
  const session = await requireSession(ROUTE);
  const companyCode = read(form, 'companyCode');
  try {
    await assertChangeForSession(session, { lockObject: 'MATERIAL_PERIOD', argument: companyCode });
    const result = await setMaterialPeriodIndicators({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode,
      allowBackposting: read(form, 'allowBackposting') === 'true',
      disallowBackpostingAfterChange: read(form, 'disallowBackpostingAfterChange') === 'true',
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Backposting indicators for company code ${companyCode} saved.` }
      : { ok: true, message: `Company code ${companyCode} already holds these indicators; nothing was changed.` };
  } catch (error) {
    return fail(error);
  }
}

export async function shiftMaterialPeriodAction(
  _previous: MaterialPeriodActionState,
  form: FormData,
): Promise<MaterialPeriodActionState> {
  const session = await requireSession(ROUTE);
  const companyCode = read(form, 'companyCode');
  try {
    await assertChangeForSession(session, { lockObject: 'MATERIAL_PERIOD', argument: companyCode });
    const result = await shiftMaterialPeriod({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Material period for company code ${companyCode} shifted to ${result.currentFiscalYear} / ${String(result.currentPeriod).padStart(2, '0')}; the previous period is ${result.previousFiscalYear} / ${String(result.previousPeriod).padStart(2, '0')}.`,
    };
  } catch (error) {
    return fail(error);
  }
}
