'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { CREDIT_CONTROL_AREA_LOCKS } from '@/modules/finance/credit-control-area-contract';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  CREDIT_CONTROL_AREA_CAPABILITY,
  CreditControlAreaMaintenanceError,
  createCreditControlAreaSetup,
} from '@/modules/finance/credit-control-area-maintenance';

export interface CreditControlAreaActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/config/credit-control-areas';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): CreditControlAreaActionState {
  if (error instanceof CreditControlAreaMaintenanceError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function createCreditControlAreaAction(
  _previous: CreditControlAreaActionState,
  form: FormData,
): Promise<CreditControlAreaActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CREDIT_CONTROL_AREA_CAPABILITY)) {
    return {
      ok: false,
      message: `You do not hold the authority ${CREDIT_CONTROL_AREA_CAPABILITY}.`,
      remedy: 'Ask an administrator for an explicit exact-code role assignment; wildcard role patterns do not grant this authority.',
    };
  }

  try {
    const areaCode = read(form, 'creditControlArea').toUpperCase();
    const companyCode = read(form, 'companyCode').toUpperCase();
    const thresholdText = read(form, 'warningThresholdPercent');

    // The save is bound to both the CCA master row and the Company Code assignment row.
    await assertChangeForSession(session, {
      lockObject: CREDIT_CONTROL_AREA_LOCKS.area,
      argument: areaCode,
    });
    await assertChangeForSession(session, {
      lockObject: CREDIT_CONTROL_AREA_LOCKS.company,
      argument: companyCode,
    });

    const result = await createCreditControlAreaSetup({
      client: session.user.client,
      changedBy: session.user.username,
      creditControlArea: areaCode,
      name: read(form, 'name'),
      companyCode,
      warningThresholdPercent: thresholdText ? Number(thresholdText) : Number.NaN,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: result.unchanged
        ? `Credit control area ${result.creditControlArea} is already assigned to Company Code ${result.companyCode}; no data changed.`
        : `Credit control area ${result.creditControlArea} (${result.currency}) ${result.created ? 'created' : 'confirmed'} and ${result.assigned ? 'initially assigned' : 'already assigned'} to Company Code ${result.companyCode}.`,
    };
  } catch (error) {
    return wrap(error);
  }
}
