'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { deactivateSalesOrgAction, type SalesOrgMaintenanceActionState } from './actions';

const initialState: SalesOrgMaintenanceActionState = { ok: true };

export function DeactivateSalesOrgForm({ salesOrg, name, version, isActive }: {
  salesOrg: string; name: string; version: number; isActive: boolean;
}) {
  const [state, action, pending] = useActionState<SalesOrgMaintenanceActionState, FormData>(deactivateSalesOrgAction, initialState);
  const detailHref = `/config/sales-orgs?salesOrg=${encodeURIComponent(salesOrg)}`;

  if (state.ok && state.message) {
    return (
      <section className="panel p-4">
        <p role="status" className="text-sm text-signal-ok">{state.message}</p>
        <Link className="mt-3 inline-block text-sm text-accent underline" href={detailHref}>
          {t('salesOrg.openSaved')}
        </Link>
      </section>
    );
  }

  if (!isActive) {
    return <p className="rounded border border-line bg-sunken p-3 text-sm text-ink-soft">{t('salesOrg.inactiveRetained')}</p>;
  }

  return (
    <details className="panel p-4">
      <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-signal-error">{t('salesOrg.deactivate')}</summary>
      <p className="mt-3 text-sm font-medium text-signal-error">{t('salesOrg.deactivateWarning', { code: salesOrg, name })}</p>
      <p className="mt-2 text-sm text-ink-soft">{t('salesOrg.deactivationNote')}</p>
      {state.message && (
        <div role="alert" className="mt-3 rounded border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
        </div>
      )}
      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="salesOrg" value={salesOrg} />
        <input type="hidden" name="expectedVersion" value={version} />
        <p className="text-sm"><span className="font-semibold">{salesOrg}</span> · {name}</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirmDeactivation" required className="mt-1 h-5 w-5 shrink-0" />
          <span>{t('salesOrg.deactivateConfirm')}</span>
        </label>
        <label className="block">
          <span className="field-label">{t('salesOrg.changeReason')}</span>
          <textarea className="field-input" name="reason" maxLength={500} rows={2} />
        </label>
        <button type="submit" className="btn btn-danger min-h-11 px-4 sm:min-h-0" disabled={pending}>
          {pending ? t('common.saving') : t('salesOrg.confirmDeactivate')}
        </button>
      </form>
    </details>
  );
}
