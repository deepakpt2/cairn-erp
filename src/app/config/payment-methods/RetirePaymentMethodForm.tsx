'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import { retirePaymentMethodAction } from './actions';
import type { PaymentMethodActionState } from './actions';

export function RetirePaymentMethodForm({ country, methodCode, version, active }: {
  country: string;
  methodCode: string;
  version: number;
  active: boolean;
}) {
  const [state, action, pending] = useActionState<PaymentMethodActionState, FormData>(
    retirePaymentMethodAction,
    { ok: true },
  );
  const savedCountry = state.country ?? country;
  const savedCode = state.methodCode ?? methodCode;
  const [open, setOpen] = useState(false);
  const lock = useChangeLock('PAYMENT_METHOD', `${country.trim()}/${methodCode.trim()}`, 'CFG.FIN.PAYMENTMETHOD.DEFINE', (open || Boolean(state.message)) && active);

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
  if (!active) return null;

  return (
    <details open={!!state.message} className="panel p-4" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold text-signal-warn">{t('pm.retire')}</summary>
      <p className="mt-3 text-sm text-ink-soft">{t('pm.retireHint')}</p>
      {state.message && <div role="alert" className="mt-3 border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
        <p>{state.message}</p>
        {state.remedy && <p className="mt-1">{state.remedy}</p>}
      </div>}
      <form action={action} className="mt-4 space-y-3">
        <input type="hidden" name="country" value={country} />
        <input type="hidden" name="methodCode" value={methodCode} />
        <input type="hidden" name="expectedVersion" value={version} />
        <label className="block">
          <span className="field-label">{t('pm.reason')}</span>
          <input name="reason" required minLength={3} maxLength={500} className="field-input" />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirmRetirement" required className="mt-0.5 accent-accent" />
          <span>{t('pm.retireAcknowledge')}</span>
        </label>
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} remedy={lock?.remedy} />
        <button className="btn border border-signal-error/40 text-signal-error hover:bg-signal-error-soft" disabled={pending || lock?.mode !== 'CHANGE'}>
          {pending ? t('common.saving') : t('pm.retireAction')}
        </button>
      </form>
    </details>
  );
}
