'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  CONDITION_CAPABILITY,
  CONDITION_ROUTE,
  ConditionError,
  saveSalesCondition,
} from '@/modules/sales/conditions';

export interface ConditionActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  conditionNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Save one condition record. A blank customer or material is the general record, so it is submitted as
 * the empty value rather than as a guess; `supersedeStanding` is the confirmation that the price standing
 * for an overlapping period is to be closed at the day before, and it is a deliberate check box.
 */
export async function saveConditionAction(
  _previous: ConditionActionState,
  form: FormData,
): Promise<ConditionActionState> {
  const session = await requireSession(CONDITION_ROUTE);
  if (!can(session, CONDITION_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the sales condition capability.',
      remedy: 'Ask for CFG.SALES.CONDITION.MAINTAIN.',
    };
  }
  try {
    const saved = await saveSalesCondition({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg: text(form, 'salesOrg'),
      distributionChannel: text(form, 'distributionChannel'),
      division: text(form, 'division'),
      customerNumber: text(form, 'customerNumber'),
      materialNumber: text(form, 'materialNumber'),
      currency: text(form, 'currency'),
      amount: Number(text(form, 'amount') || '0'),
      priceUnit: Number(text(form, 'priceUnit') || '1'),
      validityFrom: text(form, 'validityFrom'),
      validityTo: text(form, 'validityTo'),
      supersedeStanding: form.get('supersedeStanding') === 'on',
    });
    revalidatePath(CONDITION_ROUTE);
    return {
      ok: true,
      conditionNumber: saved.condition.conditionNumber,
      message: saved.superseded
        ? `Condition record ${saved.condition.conditionNumber} saved; the price it replaced (${saved.closedConditionNumber}) now ends the day before.`
        : `Condition record ${saved.condition.conditionNumber} saved.`,
    };
  } catch (error) {
    if (error instanceof ConditionError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
