'use client';

import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { defineCompanyCodeAction, type CompanyCodeState } from './actions';

interface ReferenceChoice {
  code: string;
  name: string;
}

const INITIAL: CompanyCodeState = { ok: true };

export function CompanyCodeDefinitionForm({
  countries,
  currencies,
}: {
  countries: ReferenceChoice[];
  currencies: ReferenceChoice[];
}) {
  const [state, action, pending] = useActionState(defineCompanyCodeAction, INITIAL);
  const referencesReady = countries.length > 0 && currencies.length > 0;

  return (
    <section className="panel p-4">
      <h2 className="panel-title">{t('cc.create')}</h2>
      <p className="mt-1 text-sm text-ink-soft">{t('cc.defineAssignmentNote')}</p>

      {state.message && (
        <div
          role="status"
          className={`my-3 border p-3 text-sm ${
            state.ok
              ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok'
              : 'border-signal-error/30 bg-signal-error-soft text-signal-error'
          }`}
        >
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1">{state.remedy}</p>}
        </div>
      )}

      {!referencesReady && (
        <p role="status" className="my-3 border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('cc.referenceMissing')}
        </p>
      )}

      <form key={state.companyCode ?? 'new'} action={action} className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label>
            <span className="field-label">{t('cc.code')}</span>
            <input name="companyCode" required maxLength={10} className="field-input code" />
          </label>
          <label className="sm:col-span-1 lg:col-span-3">
            <span className="field-label">{t('cc.name')}</span>
            <input name="name" required maxLength={160} className="field-input" />
          </label>
          <label>
            <span className="field-label">{t('cc.country')}</span>
            <select name="country" required defaultValue="" className="field-input code">
              <option value="">{t('cc.chooseCountry')}</option>
              {countries.map((item) => (
                <option key={item.code} value={item.code}>{item.code} · {item.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('cc.currency')}</span>
            <select name="currency" required defaultValue="" className="field-input code">
              <option value="">{t('cc.chooseCurrency')}</option>
              {currencies.map((item) => (
                <option key={item.code} value={item.code}>{item.code} · {item.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('cc.city')}</span>
            <input name="city" maxLength={80} className="field-input" />
          </label>
          <label>
            <span className="field-label">{t('cc.taxNumber')}</span>
            <input name="taxRegistrationNumber" maxLength={40} className="field-input" />
          </label>
        </div>
        <button className="btn btn-primary" disabled={pending || !referencesReady}>
          {pending ? t('common.saving') : t('cc.create')}
        </button>
      </form>
    </section>
  );
}
