'use client';

import { useActionState, useEffect, useState } from 'react';
import { t } from '@/platform/i18n';
import { saveControllingAreaAction, type ControllingAreaActionState } from './actions';
import { ActionMessage } from './ControllingAreaForm';
import { AssignmentControlField } from './AssignmentControlField';
import { ControllingAreaValueHelp, type ControllingAreaChoice } from './ControllingAreaValueHelp';

export interface ControllingAreaListEntry {
  controllingArea: string;
  name: string;
  organizationName: string | null;
  companyCodeScope: 'SINGLE' | 'MULTIPLE';
  currency: string;
  fiscalYearVariant: string;
  isActive: boolean;
  companyCodeCount: number;
  currencyLocked: boolean;
  fiscalYearVariantLocked: boolean;
  version: number;
}

interface ControllingAreasListProps {
  areas: ControllingAreaListEntry[];
  canMaintain: boolean;
  currencies: ControllingAreaChoice[];
  fiscalYearVariants: ControllingAreaChoice[];
}

export function ControllingAreasList({
  areas,
  canMaintain,
  currencies,
  fiscalYearVariants,
}: ControllingAreasListProps) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="controlling-area-list-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="controlling-area-list-title" className="font-semibold">{t('controllingArea.listTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('controllingArea.listRule')}</p>
      </div>
      {areas.length === 0 ? (
        <p role="status" className="px-4 py-8 text-center text-sm text-ink-soft">{t('controllingArea.empty')}</p>
      ) : (
        <ul className="divide-y divide-line" role="list" aria-label={t('controllingArea.listTitle')}>
          {areas.map((area) => (
            <ControllingAreaItem
              key={area.controllingArea}
              area={area}
              canMaintain={canMaintain}
              currencies={currencies}
              fiscalYearVariants={fiscalYearVariants}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ControllingAreaItem({
  area,
  canMaintain,
  currencies,
  fiscalYearVariants,
}: {
  area: ControllingAreaListEntry;
  canMaintain: boolean;
  currencies: ControllingAreaChoice[];
  fiscalYearVariants: ControllingAreaChoice[];
}) {
  const [state, action, pending] = useActionState<ControllingAreaActionState, FormData>(
    saveControllingAreaAction,
    { ok: true },
  );
  const [values, setValues] = useState({
    name: area.name,
    organizationName: area.organizationName ?? '',
    companyCodeScope: area.companyCodeScope,
    currency: area.currency,
    fiscalYearVariant: area.fiscalYearVariant,
  });

  useEffect(() => {
    setValues({
      name: area.name,
      organizationName: area.organizationName ?? '',
      companyCodeScope: area.companyCodeScope,
      currency: area.currency,
      fiscalYearVariant: area.fiscalYearVariant,
    });
  }, [area.version, area.name, area.organizationName, area.companyCodeScope, area.currency, area.fiscalYearVariant]);

  const idPrefix = `scr024-${area.controllingArea.toLowerCase()}`;
  const locked = area.currencyLocked || area.fiscalYearVariantLocked;

  return (
    <li className="p-3 sm:p-4">
      <article className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.85fr)] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="code font-semibold text-ink">{area.controllingArea}</span>
            <span className={`chip ${area.isActive ? 'chip-ok' : 'chip-neutral'}`}>
              {t(area.isActive ? 'controllingArea.active' : 'controllingArea.inactive')}
            </span>
          </div>
          <p className="mt-2 break-words text-base font-medium">{area.name}</p>
          {area.organizationName && <p className="mt-1 break-words text-sm text-ink-soft">{area.organizationName}</p>}
          <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-ink-faint">{t('controllingArea.assignmentControl')}</dt>
              <dd className="mt-0.5 break-words">{t(area.companyCodeScope === 'SINGLE' ? 'controllingArea.optionSingle' : 'controllingArea.optionMultiple')}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-ink-faint">{t('controllingArea.assignedCompanyCodes')}</dt>
              <dd className="mt-0.5 tabular">{area.companyCodeCount}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-ink-faint">{t('controllingArea.currency')}</dt>
              <dd className="mt-0.5 code">{area.currency}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-ink-faint">{t('controllingArea.fiscalYearVariant')}</dt>
              <dd className="mt-0.5 code">{area.fiscalYearVariant}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-ink-faint">{t('controllingArea.assignmentSeparate')}</p>
          {locked && <p role="status" className="mt-2 border border-signal-warn/30 bg-signal-warn-soft p-2 text-xs text-signal-warn">{t('controllingArea.financialFieldsLocked')}</p>}
          {!area.isActive && <p role="status" className="mt-2 text-xs text-ink-soft">{t('controllingArea.inactiveRetained')}</p>}
        </div>

        {canMaintain && area.isActive && (
          <details className="border-t border-line pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
            <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">{t('controllingArea.changeSettings')}</summary>
            <form action={action} className="mt-3 space-y-4">
              <input type="hidden" name="mode" value="CHANGE" />
              <input type="hidden" name="expectedVersion" value={area.version} />
              <input type="hidden" name="controllingArea" value={area.controllingArea} />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${idPrefix}-name`} className="field-label">{t('controllingArea.name')} <span className="ms-1 text-signal-error" aria-hidden="true">*</span></label>
                  <input
                    id={`${idPrefix}-name`}
                    name="name"
                    type="text"
                    required
                    minLength={1}
                    maxLength={30}
                    value={values.name}
                    onChange={(event) => {
                      const name = event.currentTarget.value.slice(0, 30);
                      setValues((current) => ({ ...current, name }));
                    }}
                    className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                    disabled={pending}
                  />
                  <p className="mt-1 text-xs text-ink-faint">{t('controllingArea.nameRule')}</p>
                </div>

                <div>
                  <label htmlFor={`${idPrefix}-organization-name`} className="field-label">{t('controllingArea.organizationName')}</label>
                  <input
                    id={`${idPrefix}-organization-name`}
                    name="organizationName"
                    type="text"
                    maxLength={30}
                    value={values.organizationName}
                    onChange={(event) => {
                      const organizationName = event.currentTarget.value.slice(0, 30);
                      setValues((current) => ({ ...current, organizationName }));
                    }}
                    className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                    disabled={pending}
                  />
                  <p className="mt-1 text-xs text-ink-faint">{t('controllingArea.organizationNameRule')}</p>
                </div>

                <AssignmentControlField
                  id={`${idPrefix}-assignment-control`}
                  value={values.companyCodeScope}
                  onChange={(companyCodeScope) => setValues((current) => ({ ...current, companyCodeScope }))}
                  disabled={pending}
                  singleDisabled={area.companyCodeCount > 1}
                />

                <ControllingAreaValueHelp
                  id={`${idPrefix}-currency`}
                  name="currency"
                  label={t('controllingArea.currency')}
                  value={values.currency}
                  onChange={(currency) => setValues((current) => ({ ...current, currency }))}
                  choices={currencies}
                  dialogTitle={t('controllingArea.currencyLookup')}
                  openLabel={t('controllingArea.openCurrencyLookup')}
                  emptyText={t('controllingArea.noCurrenciesMatch')}
                  rule={area.currencyLocked ? t('controllingArea.financialFieldsLockedShort') : t('controllingArea.currencyRule')}
                  maxLength={3}
                  pattern="[A-Z]{3}"
                  readOnly={area.currencyLocked}
                  disabled={pending}
                />

                <ControllingAreaValueHelp
                  id={`${idPrefix}-fiscal-year`}
                  name="fiscalYearVariant"
                  label={t('controllingArea.fiscalYearVariant')}
                  value={values.fiscalYearVariant}
                  onChange={(fiscalYearVariant) => setValues((current) => ({ ...current, fiscalYearVariant }))}
                  choices={fiscalYearVariants}
                  dialogTitle={t('controllingArea.fiscalYearLookup')}
                  openLabel={t('controllingArea.openFiscalYearLookup')}
                  emptyText={t('controllingArea.noFiscalYearsMatch')}
                  rule={area.fiscalYearVariantLocked ? t('controllingArea.financialFieldsLockedShort') : t('controllingArea.fiscalYearRule')}
                  maxLength={2}
                  pattern="[A-Z0-9]{2}"
                  readOnly={area.fiscalYearVariantLocked}
                  disabled={pending}
                />
              </div>

              <p className="text-xs text-ink-soft">{t('controllingArea.changeHistoryNote')}</p>
              {state.message && <ActionMessage state={state} />}
              <button type="submit" className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto" disabled={pending}>
                {pending ? t('common.saving') : t('controllingArea.saveButton')}
              </button>
            </form>
          </details>
        )}
      </article>
    </li>
  );
}
