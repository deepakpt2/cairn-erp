'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import {
  deactivatePurchasingOrgAction,
  type PurchasingOrgMaintenanceActionState,
} from './actions';

interface Props {
  purchasingOrg: string;
  name: string;
  version: number;
  isActive: boolean;
}

export function DeactivatePurchasingOrgForm({ purchasingOrg, name, version, isActive }: Props) {
  const [state, action, pending] = useActionState<PurchasingOrgMaintenanceActionState, FormData>(
    deactivatePurchasingOrgAction,
    { ok: true },
  );
  const detailHref = `/config/purchasing-orgs?purchasingOrg=${encodeURIComponent(purchasingOrg)}`;

  if (state.ok && state.message) {
    return (
      <section className="panel p-4">
        <p role="status" className="text-sm text-signal-ok">{state.message}</p>
        <Link className="mt-3 inline-block text-sm text-accent underline" href={detailHref}>
          {t('purchasingOrg.openSaved')}
        </Link>
      </section>
    );
  }

  if (!isActive) {
    return (
      <p className="rounded border border-line bg-sunken p-3 text-sm text-ink-soft">
        {t('purchasingOrg.inactiveRetained')}
      </p>
    );
  }

  return (
    <details className="panel p-4">
      <summary className="cursor-pointer font-semibold text-signal-error">{t('purchasingOrg.deactivate')}</summary>
      <p className="mt-3 text-sm text-ink-soft">{t('purchasingOrg.deactivationNote')}</p>
      {state.message && (
        <div role="alert" className="mt-3 rounded border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
        </div>
      )}
      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="purchasingOrg" value={purchasingOrg} />
        <input type="hidden" name="expectedVersion" value={version} />
        <p className="text-sm"><span className="font-semibold">{purchasingOrg}</span> · {name}</p>
        <label className="block">
          <span className="field-label">{t('purchasingOrg.reason')}</span>
          <textarea className="field-input" name="reason" maxLength={500} rows={2} />
        </label>
        <button className="btn btn-danger" type="submit" disabled={pending}>
          {pending ? t('common.saving') : t('purchasingOrg.confirmDeactivate')}
        </button>
      </form>
    </details>
  );
}
