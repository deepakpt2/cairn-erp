'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { deactivateDistributionChannelAction, type DistributionChannelActionState } from './actions';

interface Props {
  distributionChannel: string;
  name: string;
  version: number;
  isActive: boolean;
}

export function DeactivateDistributionChannelForm({ distributionChannel, name, version, isActive }: Props) {
  const [state, action, pending] = useActionState<DistributionChannelActionState, FormData>(
    deactivateDistributionChannelAction,
    { ok: true },
  );
  const detailHref = `/config/distribution-channels?distributionChannel=${encodeURIComponent(distributionChannel)}`;

  if (state.ok && state.message) {
    return (
      <section className="panel p-4">
        <p role="status" className="text-sm text-signal-ok">{state.message}</p>
        <Link className="mt-3 inline-block text-sm text-accent underline" href={detailHref}>{t('orgDefinition.openSaved')}</Link>
      </section>
    );
  }
  if (!isActive) {
    return <p className="rounded border border-line bg-sunken p-3 text-sm text-ink-soft">{t('orgDefinition.inactiveRetained')}</p>;
  }

  return (
    <details className="panel p-4">
      <summary className="cursor-pointer font-semibold text-signal-error">{t('orgDefinition.deactivate')} · {t('distributionChannel.singular')}</summary>
      <p className="mt-3 text-sm text-ink-soft">{t('orgDefinition.deactivationNote')}</p>
      {state.message && (
        <div role="alert" className="mt-3 rounded border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
        </div>
      )}
      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="distributionChannel" value={distributionChannel} />
        <input type="hidden" name="expectedVersion" value={version} />
        <p className="text-sm"><span className="font-semibold">{distributionChannel}</span> · {name}</p>
        <label className="block">
          <span className="field-label">{t('orgDefinition.reason')}</span>
          <textarea className="field-input" name="reason" maxLength={500} rows={2} />
        </label>
        <button className="btn btn-danger" type="submit" disabled={pending}>
          {pending ? t('common.saving') : t('orgDefinition.confirmDeactivate')}
        </button>
      </form>
    </details>
  );
}
