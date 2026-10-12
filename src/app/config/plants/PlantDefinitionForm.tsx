'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { savePlantDefinitionAction, type PlantMaintenanceActionState } from './actions';

interface CountryChoice {
  code: string;
  name: string;
}

export interface PlantDefinitionDraft {
  plant: string;
  name: string;
  country: string;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  region: string | null;
  factoryCalendar: string | null;
  language: string;
  isProductionSite: boolean;
  isStorageSite: boolean;
}

const INITIAL_STATE: PlantMaintenanceActionState = { ok: true };

export function PlantDefinitionForm({
  mode,
  countries,
  initial,
  version,
}: {
  mode: 'CREATE' | 'CHANGE';
  countries: CountryChoice[];
  initial: PlantDefinitionDraft;
  version: number;
}) {
  const [state, action, pending] = useActionState(savePlantDefinitionAction, INITIAL_STATE);
  const creating = mode === 'CREATE';
  const savedCode = state.plant ?? initial.plant;
  const referencesReady = countries.length > 0;

  if (state.ok && state.message) {
    return (
      <section className="panel p-4">
        <div role="status" className="border border-signal-ok/30 bg-signal-ok-soft p-3 text-sm text-signal-ok">
          {state.message}
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          {creating && (
            <Link className="text-accent underline" href={`/config/plants?edit=${encodeURIComponent(savedCode)}`}>
              {t('plant.openSaved')}
            </Link>
          )}
          <Link className="text-accent underline" href="/config/plants">{t('plant.backToList')}</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="panel p-4">
      <h2 className="panel-title mb-1">{t(creating ? 'plant.create' : 'plant.change')}</h2>
      <p className="mb-4 text-sm text-ink-soft">{t('plant.assignmentNote')}</p>

      {state.message && (
        <div role="alert" className="mb-3 border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1">{state.remedy}</p>}
        </div>
      )}
      {!referencesReady && (
        <p role="status" className="mb-3 border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('plant.countryReferenceMissing')}
        </p>
      )}

      <form action={action} className="space-y-4">
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="expectedVersion" value={creating ? 0 : version} />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label>
            <span className="field-label">{t('plant.code')} <span aria-hidden="true">*</span></span>
            <input
              name="plant"
              defaultValue={initial.plant}
              readOnly={!creating}
              required
              maxLength={10}
              className="field-input code"
            />
          </label>
          <label className="sm:col-span-1 lg:col-span-2">
            <span className="field-label">{t('plant.name')} <span aria-hidden="true">*</span></span>
            <input name="name" defaultValue={initial.name} required maxLength={160} className="field-input" />
          </label>
          <label>
            <span className="field-label">{t('plant.country')} <span aria-hidden="true">*</span></span>
            <select name="country" defaultValue={initial.country} required className="field-input code" disabled={!referencesReady}>
              <option value="">{t('plant.chooseCountry')}</option>
              {countries.map((item) => (
                <option key={item.code} value={item.code}>{item.code} · {item.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('plant.street')} <span className="text-ink-faint">({t('common.optional')})</span></span>
            <input name="street" defaultValue={initial.street ?? ''} maxLength={160} className="field-input" />
          </label>
          <label>
            <span className="field-label">{t('plant.houseNumber')} <span className="text-ink-faint">({t('common.optional')})</span></span>
            <input name="houseNumber" defaultValue={initial.houseNumber ?? ''} maxLength={40} className="field-input" />
          </label>
          <label>
            <span className="field-label">{t('plant.postalCode')} <span className="text-ink-faint">({t('common.optional')})</span></span>
            <input name="postalCode" defaultValue={initial.postalCode ?? ''} maxLength={20} className="field-input" />
          </label>
          <label>
            <span className="field-label">{t('plant.city')} <span className="text-ink-faint">({t('common.optional')})</span></span>
            <input name="city" defaultValue={initial.city ?? ''} maxLength={80} className="field-input" />
          </label>
          <label>
            <span className="field-label">{t('plant.region')} <span className="text-ink-faint">({t('common.optional')})</span></span>
            <input name="region" defaultValue={initial.region ?? ''} maxLength={80} className="field-input" />
          </label>
          <label>
            <span className="field-label">{t('plant.factoryCalendar')} <span className="text-ink-faint">({t('common.optional')})</span></span>
            <input name="factoryCalendar" defaultValue={initial.factoryCalendar ?? ''} maxLength={10} className="field-input code" />
            <span className="mt-1 block text-2xs text-ink-soft">{t('plant.factoryCalendarNote')}</span>
          </label>
          <label>
            <span className="field-label">{t('plant.language')} <span className="text-ink-faint">({t('plant.languageDefault')})</span></span>
            <input
              name="language"
              defaultValue={initial.language || 'EN'}
              maxLength={2}
              pattern="[A-Za-z]{2}"
              className="field-input code"
            />
          </label>
        </div>

        <label className="block">
          <span className="field-label">{t('plant.reason')} <span className="text-ink-faint">({t('common.optional')})</span></span>
          <input name="reason" maxLength={500} className="field-input" />
        </label>

        <fieldset className="border border-line p-3">
          <legend className="field-label px-1">{t('plant.siteFlags')}</legend>
          <p className="mb-3 text-xs text-ink-soft">{t('plant.roleFlagsNote')}</p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="hidden" name="isProductionSite" value="false" />
              <input
                type="checkbox"
                name="isProductionSite"
                value="true"
                defaultChecked={initial.isProductionSite}
                className="accent-accent"
              />
              {t('plant.production')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="hidden" name="isStorageSite" value="false" />
              <input
                type="checkbox"
                name="isStorageSite"
                value="true"
                defaultChecked={initial.isStorageSite}
                className="accent-accent"
              />
              {t('plant.storage')}
            </label>
          </div>
        </fieldset>

        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={pending || !referencesReady}>
            {pending ? t('common.saving') : t(creating ? 'plant.create' : 'common.save')}
          </button>
          <Link className="btn btn-default" href="/config/plants">{t('common.cancel')}</Link>
        </div>
      </form>
    </section>
  );
}
