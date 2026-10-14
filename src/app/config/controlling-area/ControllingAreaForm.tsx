'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { saveControllingAreaAction, type ControllingAreaActionState } from './actions';
import { AssignmentControlField } from './AssignmentControlField';
import { ControllingAreaValueHelp, type ControllingAreaChoice } from './ControllingAreaValueHelp';

export function ControllingAreaForm({
  currencies,
  fiscalYearVariants,
}: {
  currencies: ControllingAreaChoice[];
  fiscalYearVariants: ControllingAreaChoice[];
}) {
  const [state, action, pending] = useActionState<ControllingAreaActionState, FormData>(
    saveControllingAreaAction,
    { ok: true },
  );
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [scope, setScope] = useState<'SINGLE' | 'MULTIPLE'>('SINGLE');
  const [currency, setCurrency] = useState('');
  const [fiscalYearVariant, setFiscalYearVariant] = useState('');

  return (
    <section className="panel overflow-hidden" aria-labelledby="controlling-area-create-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="controlling-area-create-title" className="font-semibold">{t('controllingArea.createTitle')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('controllingArea.createHint')}</p>
      </div>

      {state.message && <ActionMessage state={state} />}

      <form action={action} className="space-y-4 p-3 sm:p-5">
        <input type="hidden" name="mode" value="CREATE" />
        <input type="hidden" name="expectedVersion" value="0" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="scr024-create-code" className="field-label">
              {t('controllingArea.code')} <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id="scr024-create-code"
              name="controllingArea"
              type="text"
              required
              minLength={4}
              maxLength={4}
              pattern="[A-Z0-9]{4}"
              title={t('controllingArea.codeRule')}
              autoComplete="off"
              autoCapitalize="characters"
              value={code}
              onChange={(event) => setCode(event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
              className="field-input code mt-1 min-h-11 w-full uppercase sm:min-h-9"
              disabled={pending}
            />
            <p className="mt-1 text-xs text-ink-faint">{t('controllingArea.codeRule')}</p>
          </div>

          <div>
            <label htmlFor="scr024-create-name" className="field-label">
              {t('controllingArea.name')} <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id="scr024-create-name"
              name="name"
              type="text"
              required
              minLength={1}
              maxLength={30}
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.currentTarget.value.slice(0, 30))}
              className="field-input mt-1 min-h-11 w-full sm:min-h-9"
              disabled={pending}
            />
            <p className="mt-1 text-xs text-ink-faint">{t('controllingArea.nameRule')}</p>
          </div>

          <div>
            <label htmlFor="scr024-create-organization-name" className="field-label">{t('controllingArea.organizationName')}</label>
            <input
              id="scr024-create-organization-name"
              name="organizationName"
              type="text"
              maxLength={30}
              autoComplete="off"
              value={organizationName}
              onChange={(event) => setOrganizationName(event.currentTarget.value.slice(0, 30))}
              className="field-input mt-1 min-h-11 w-full sm:min-h-9"
              disabled={pending}
            />
            <p className="mt-1 text-xs text-ink-faint">{t('controllingArea.organizationNameRule')}</p>
          </div>

          <AssignmentControlField
            id="scr024-create-assignment-control"
            value={scope}
            onChange={setScope}
            disabled={pending}
          />

          <ControllingAreaValueHelp
            id="scr024-create-currency"
            name="currency"
            label={t('controllingArea.currency')}
            value={currency}
            onChange={setCurrency}
            choices={currencies}
            dialogTitle={t('controllingArea.currencyLookup')}
            openLabel={t('controllingArea.openCurrencyLookup')}
            emptyText={t('controllingArea.noCurrenciesMatch')}
            rule={t('controllingArea.currencyRule')}
            maxLength={3}
            pattern="[A-Z]{3}"
            disabled={pending}
          />

          <ControllingAreaValueHelp
            id="scr024-create-fiscal-year"
            name="fiscalYearVariant"
            label={t('controllingArea.fiscalYearVariant')}
            value={fiscalYearVariant}
            onChange={setFiscalYearVariant}
            choices={fiscalYearVariants}
            dialogTitle={t('controllingArea.fiscalYearLookup')}
            openLabel={t('controllingArea.openFiscalYearLookup')}
            emptyText={t('controllingArea.noFiscalYearsMatch')}
            rule={t('controllingArea.fiscalYearRule')}
            maxLength={2}
            pattern="[A-Z0-9]{2}"
            disabled={pending}
          />
        </div>

        {currencies.length === 0 && <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">{t('controllingArea.noActiveCurrencies')}</p>}
        {fiscalYearVariants.length === 0 && <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">{t('controllingArea.noFiscalYearDefinitions')}</p>}

        <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-3xl text-xs text-ink-soft">{t('controllingArea.creationRule')}</p>
          <button type="submit" className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto" disabled={pending || currencies.length === 0 || fiscalYearVariants.length === 0}>
            {pending ? t('common.saving') : t('controllingArea.createButton')}
          </button>
        </div>
      </form>
    </section>
  );
}

export function ActionMessage({ state }: { state: ControllingAreaActionState }) {
  return (
    <div role={state.ok ? 'status' : 'alert'} className={`mx-3 mt-3 border p-3 text-sm ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}>
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1">{state.remedy}</p>}
    </div>
  );
}
