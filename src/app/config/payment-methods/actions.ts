'use server';

import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import { PaymentMethodError, retirePaymentMethod, savePaymentMethod } from '@/modules/foundation/payment-methods';
import type { PaymentMethodDirection } from '@/modules/foundation/payment-method-schema';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.FIN.PAYMENTMETHOD.DEFINE';
const ROUTE = '/config/payment-methods';

export interface PaymentMethodActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  country?: string;
  methodCode?: string;
  version?: number;
  changed?: boolean;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}

function expectedVersion(form: FormData) {
  const value = read(form, 'expectedVersion');
  return value === '' ? Number.NaN : Number(value);
}

/** Create/change action. Tenant and actor are always taken from the verified session. */
export async function savePaymentMethodAction(
  _previous: PaymentMethodActionState,
  form: FormData,
): Promise<PaymentMethodActionState> {
  const session = await requireSession(ROUTE);
  const country = read(form, 'country').toUpperCase();
  const methodCode = read(form, 'methodCode').toUpperCase();

  try {
    await requireCapability(ACTIVITY, session);
    if (form.has('changing')) {
      await assertChangeForSession(session, { lockObject: 'PAYMENT_METHOD', argument: `${country}/${methodCode}` });
    }
    const result = await savePaymentMethod({
      client: session.user.client,
      country: read(form, 'country'),
      methodCode: read(form, 'methodCode'),
      expectedVersion: expectedVersion(form),
      changedBy: session.user.username,
      reason: read(form, 'reason'),
      values: {
        description: read(form, 'description'),
        allowedDirection: read(form, 'allowedDirection') as PaymentMethodDirection,
        isActive: form.get('isActive') === 'on',
      },
    });
    revalidatePath(ROUTE);
    revalidatePath('/config');
    return {
      ok: true,
      message: t(result.changed ? 'pm.saved' : 'pm.unchanged'),
      country,
      methodCode,
      version: result.version,
      changed: result.changed,
    };
  } catch (error) {
    if (error instanceof PaymentMethodError || error instanceof AuthzError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy, country, methodCode };
    }
    throw error;
  }
}

/** Retire action. Retirement remains a versioned soft change; rows are never deleted. */
export async function retirePaymentMethodAction(
  _previous: PaymentMethodActionState,
  form: FormData,
): Promise<PaymentMethodActionState> {
  const session = await requireSession(ROUTE);
  const country = read(form, 'country').toUpperCase();
  const methodCode = read(form, 'methodCode').toUpperCase();

  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, { lockObject: 'PAYMENT_METHOD', argument: `${country}/${methodCode}` });
    const result = await retirePaymentMethod({
      client: session.user.client,
      country: read(form, 'country'),
      methodCode: read(form, 'methodCode'),
      expectedVersion: expectedVersion(form),
      changedBy: session.user.username,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    revalidatePath('/config');
    return {
      ok: true,
      message: t(result.changed ? 'pm.retired' : 'pm.unchanged'),
      country,
      methodCode,
      version: result.version,
      changed: result.changed,
    };
  } catch (error) {
    if (error instanceof PaymentMethodError || error instanceof AuthzError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy, country, methodCode };
    }
    throw error;
  }
}
