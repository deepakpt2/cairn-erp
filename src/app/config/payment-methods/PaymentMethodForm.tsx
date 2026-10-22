'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { PaymentMethodDirection } from '@/modules/foundation/payment-method-schema';
import { t } from '@/platform/i18n';
import { savePaymentMethodAction } from './actions';
import type { PaymentMethodActionState } from './actions';

interface PaymentMethodDraft {
  methodCode: string;
  description: string;
  allowedDirection: PaymentMethodDirection;
  isActive: boolean;
  version: number;
}

export function PaymentMethodForm({
  country,
  initial,
  creating,
}: {
  country: string;
  initial: PaymentMethodDraft;
  creating: boolean;
}) {
  const [state, action, pending] = useActionState<PaymentMethodActionState, FormData>(
    savePaymentMethodAction,
    { ok: true },
  );
  const savedCode = state.methodCode ?? initial.methodCode;
  const savedCountry = state.country ?? country;

  if (state.ok && state.message) {
    return (
      <section className="panel p-4">
        <div role="status" className="border border-signal-ok/30 bg-signal-ok-soft p-3 text-sm text-signal-ok">
          {state.message}
        </div>
        <Link className="mt-3 inline-block text-sm text-accent underline" href={`/config/payment-methods?country=${encodeURIComponent(savedCountry)}&code=${encodeURIComponent(savedCode)}`}>
          {t('pm.openSaved')}
        </Link>
      </section>
    );
  }

  return (
    <section className="panel p-4">
      <h2 className="panel-title mb-3">{t(creating ? 'pm.create' : 'pm.edit')}</h2>
      {state.message && <div role="alert" className="mb-3 border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
        <p>{state.message}</p>
        {state.remedy && <p className="mt-1">{state.remedy}</p>}
      </div>}
      <form action={action} className="space-y-4">
        <input type="hidden" name="country" value={country} />
        <input type="hidden" name="expectedVersion" value={creating ? 0 : initial.version} />
        {!creating && <input type="hidden" name="changing" value="1" />}
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className="field-label">{t('pm.code')}</span>
            <input
              name="methodCode"
              defaultValue={initial.methodCode}
              readOnly={!creating}
              required
              maxLength={2}
              pattern="[A-Z0-9]{1,2}"
              autoCapitalize="characters"
              onInput={(event) => { if (creating) event.currentTarget.value = event.currentTarget.value.toUpperCase(); }}
              className="field-input code"
            />
          </label>
          <label>
            <span className="field-label">{t('pm.direction')}</span>
            <select name="allowedDirection" defaultValue={initial.allowedDirection} className="field-input">
              {(['OUTGOING', 'INCOMING', 'BOTH'] as const).map((direction) => (
                <option key={direction} value={direction}>{t(`pm.direction.${direction}`)}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="field-label">{t('pm.description')}</span>
          <input name="description" defaultValue={initial.description} required maxLength={160} className="field-input" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isActive" defaultChecked={initial.isActive} className="accent-accent" />
          {t('pm.active')}
        </label>
        <label className="block">
          <span className="field-label">{t('pm.reason')}</span>
          <input name="reason" required minLength={3} maxLength={500} className="field-input" />
        </label>
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={pending}>{pending ? t('common.saving') : t('common.save')}</button>
          <Link className="btn btn-default" href={creating
            ? `/config/payment-methods?country=${encodeURIComponent(country)}`
            : `/config/payment-methods?country=${encodeURIComponent(country)}&code=${encodeURIComponent(initial.methodCode)}`}>
            {t('common.cancel')}
          </Link>
        </div>
      </form>
    </section>
  );
}
