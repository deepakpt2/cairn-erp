'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { deactivateStorageLocationAction, type StorageLocationActionState } from './actions';

interface Props {
  plant: string;
  storageLocation: string;
  version: number;
  active: boolean;
}

export function DeactivateStorageLocationForm({ plant, storageLocation, version, active }: Props) {
  const [state, action, pending] = useActionState<StorageLocationActionState, FormData>(
    deactivateStorageLocationAction,
    { ok: true },
  );
  const detailHref = `/config/storage-locations?plant=${encodeURIComponent(plant)}&location=${encodeURIComponent(storageLocation)}`;

  if (state.ok && state.message) {
    return (
      <section className="panel p-4">
        <p role="status" className="text-sm text-signal-ok">{state.message}</p>
        <Link className="mt-3 inline-block text-sm text-accent underline" href={detailHref}>
          {t('storageLocation.openSaved')}
        </Link>
      </section>
    );
  }
  if (!active && state.ok) return null;

  return (
    <details className="panel p-4">
      <summary className="cursor-pointer font-semibold">{t('storageLocation.deactivate')}</summary>
      <p className="mt-2 text-sm text-ink-soft">{t('storageLocation.deactivationNote')}</p>
      {state.message && (
        <div role="alert" className="mt-3 rounded border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
        </div>
      )}
      <form action={action} className="mt-4 space-y-3">
        <input type="hidden" name="plant" value={plant} />
        <input type="hidden" name="storageLocation" value={storageLocation} />
        <input type="hidden" name="expectedVersion" value={version} />
        <label className="block">
          <span className="field-label">{t('storageLocation.reason')}</span>
          <textarea className="field-input" name="reason" maxLength={500} rows={2} />
        </label>
        <button className="btn btn-danger" type="submit" disabled={pending}>
          {pending ? t('common.saving') : t('storageLocation.deactivateAction')}
        </button>
      </form>
    </details>
  );
}
