'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { saveStorageLocationAction, type StorageLocationActionState } from './actions';
import { t } from '@/platform/i18n';

export interface StorageLocationDraft {
  plant: string;
  storageLocation: string;
  name: string;
  allowNegativeStock: boolean;
}

interface PlantChoice {
  plant: string;
  name: string;
}

interface Props {
  mode: 'CREATE' | 'CHANGE';
  plants: PlantChoice[];
  initial: StorageLocationDraft;
  version: number;
}

export function StorageLocationForm({ mode, plants, initial, version }: Props) {
  const [state, action, pending] = useActionState<StorageLocationActionState, FormData>(
    saveStorageLocationAction,
    { ok: true },
  );
  const creating = mode === 'CREATE';
  const plant = state.plant ?? initial.plant;
  const storageLocation = state.storageLocation ?? initial.storageLocation;
  const savedHref = `/config/storage-locations?plant=${encodeURIComponent(plant)}&location=${encodeURIComponent(storageLocation)}`;
  const cancelHref = creating ? '/config/storage-locations' : savedHref;
  const canCreate = !creating || plants.length > 0;

  if (state.ok && state.message) {
    return (
      <section className="panel p-4">
        <p role="status" className="text-sm text-signal-ok">{state.message}</p>
        <div className="mt-3 flex gap-4 text-sm">
          <Link className="text-accent underline" href={savedHref}>{t('storageLocation.openSaved')}</Link>
          <Link className="text-accent underline" href="/config/storage-locations">{t('storageLocation.backToList')}</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="panel p-4">
      <h2 className="panel-title">{t(creating ? 'storageLocation.create' : 'storageLocation.change')}</h2>
      {state.message && (
        <div role="alert" className="mt-3 rounded border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
        </div>
      )}
      {creating && plants.length === 0 && (
        <p className="mt-3 rounded border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('storageLocation.noActivePlants')}
        </p>
      )}
      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="expectedVersion" value={version} />

        {creating ? (
          <label className="block">
            <span className="field-label">{t('storageLocation.plant')} *</span>
            <select name="plant" defaultValue={initial.plant} className="field-input code" required disabled={!plants.length}>
              <option value="">{t('storageLocation.choosePlant')}</option>
              {plants.map((item) => (
                <option key={item.plant} value={item.plant}>{item.plant} · {item.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <input type="hidden" name="plant" value={initial.plant} />
            <label className="block">
              <span className="field-label">{t('storageLocation.plant')}</span>
              <input className="field-input bg-sunken" value={initial.plant} readOnly />
            </label>
          </>
        )}

        <label className="block">
          <span className="field-label">{t('storageLocation.code')} *</span>
          <input
            className="field-input code"
            name="storageLocation"
            defaultValue={initial.storageLocation}
            maxLength={10}
            required
            readOnly={!creating}
            aria-describedby="storage-location-code-help"
          />
          <span id="storage-location-code-help" className="field-hint">{t('storageLocation.codeHelp')}</span>
        </label>

        <label className="block">
          <span className="field-label">{t('storageLocation.name')} *</span>
          <input className="field-input" name="name" defaultValue={initial.name} maxLength={120} required />
        </label>

        <fieldset className="rounded border border-line p-3">
          <legend className="field-label px-1">{t('storageLocation.allowNegativeStock')}</legend>
          <input type="hidden" name="allowNegativeStock" value="false" />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="allowNegativeStock"
              value="true"
              defaultChecked={initial.allowNegativeStock}
              className="mt-0.5"
            />
            <span>{t('storageLocation.allowNegativeStock')}</span>
          </label>
          <p className="mt-2 text-xs text-ink-soft">{t('storageLocation.negativeStockNote')}</p>
        </fieldset>

        <label className="block">
          <span className="field-label">{t('storageLocation.reason')}</span>
          <textarea className="field-input" name="reason" maxLength={500} rows={2} />
        </label>

        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" type="submit" disabled={pending || !canCreate}>
            {pending ? t('common.saving') : t(creating ? 'storageLocation.create' : 'common.save')}
          </button>
          <Link className="btn btn-default" href={cancelHref}>{t('common.cancel')}</Link>
        </div>
      </form>
    </section>
  );
}
