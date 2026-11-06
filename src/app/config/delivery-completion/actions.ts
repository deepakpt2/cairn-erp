'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  setDeliveryCompletionPlantPolicy,
  setDeliveryCompletionPolicy,
} from '@/modules/purchasing/delivery-completion';

export interface DeliveryCompletionActionState {
  ok: boolean;
  message?: string;
}

const ROUTE = '/config/delivery-completion';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function setDeliveryCompletionPolicyAction(
  _previous: DeliveryCompletionActionState,
  form: FormData,
): Promise<DeliveryCompletionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ACTIVITY)) {
    return { ok: false, message: `You do not hold ${ACTIVITY}, so the rule is not changed.` };
  }
  const companyCode = read(form, 'companyCode');
  const autoClose = read(form, 'autoClose') === 'true';
  const result = await setDeliveryCompletionPolicy({
    client: session.user.client,
    changedBy: session.user.username,
    companyCode,
    autoClose,
  });
  revalidatePath(ROUTE);
  return {
    ok: true,
    message: result.changed
      ? `Company code ${companyCode}: a receipt ${autoClose ? 'now closes' : 'no longer closes'} an item it brings inside the underdelivery tolerance.`
      : `Company code ${companyCode} already holds that rule; nothing was changed.`,
  };
}

export async function setDeliveryCompletionPlantAction(
  _previous: DeliveryCompletionActionState,
  form: FormData,
): Promise<DeliveryCompletionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ACTIVITY)) {
    return { ok: false, message: `You do not hold ${ACTIVITY}, so the rule is not changed.` };
  }
  const plantCode = read(form, 'plant');
  const choice = read(form, 'autoClose');
  // A blank choice is not "no": it is the plant keeping no row of its own, which returns it
  // to the company it belongs to.
  const autoClose = choice === '' ? null : choice === 'true';
  const result = await setDeliveryCompletionPlantPolicy({
    client: session.user.client,
    changedBy: session.user.username,
    plant: plantCode,
    autoClose,
  });
  revalidatePath(ROUTE);
  if (!result.changed) {
    return { ok: true, message: `Plant ${plantCode} already holds that rule; nothing was changed.` };
  }
  return {
    ok: true,
    message: autoClose == null
      ? `Plant ${plantCode} keeps no rule of its own now; it inherits its company code.`
      : `Plant ${plantCode}: a receipt ${autoClose ? 'now closes' : 'no longer closes'} an item it brings inside the underdelivery tolerance.`,
  };
}
