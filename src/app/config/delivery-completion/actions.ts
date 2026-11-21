'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  DeliveryCompletionScopeError,
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
  let result: { changed: boolean };
  try {
    result = await setDeliveryCompletionPolicy({
      client: session.user.client,
      changedBy: session.user.username,
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
      companyCode,
      autoClose,
    });
  } catch (caught) {
    if (caught instanceof DeliveryCompletionScopeError) return { ok: false, message: `${caught.message}${caught.remedy ? ` ${caught.remedy}` : ''}` };
    throw caught;
  }
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
  let result: { changed: boolean };
  try {
    result = await setDeliveryCompletionPlantPolicy({
      client: session.user.client,
      changedBy: session.user.username,
      authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
      plant: plantCode,
      autoClose,
    });
  } catch (caught) {
    if (caught instanceof DeliveryCompletionScopeError) return { ok: false, message: `${caught.message}${caught.remedy ? ` ${caught.remedy}` : ''}` };
    throw caught;
  }
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
