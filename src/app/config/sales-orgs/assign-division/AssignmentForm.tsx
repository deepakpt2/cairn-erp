'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import {
  assignSalesOrgDivisionAction,
  type SalesOrgDivisionAssignmentState,
} from './actions';

interface Choice {
  code: string;
  name: string;
}

type HelpField = 'salesOrg' | 'division';

export function SalesOrgDivisionAssignmentForm({
  salesOrganizations,
  divisions,
}: {
  salesOrganizations: Choice[];
  divisions: Choice[];
}) {
  const [state, action, pending] = useActionState<SalesOrgDivisionAssignmentState, FormData>(
    assignSalesOrgDivisionAction,
    { ok: true },
  );
  const [salesOrgValue, setSalesOrgValue] = useState('');
  const [divisionValue, setDivisionValue] = useState('');
  const [helpField, setHelpField] = useState<HelpField | null>(null);
  const [helpSearch, setHelpSearch] = useState('');

  function openHelp(field: HelpField) {
    setHelpSearch('');
    setHelpField(field);
  }

  function chooseValue(code: string) {
    if (helpField === 'salesOrg') setSalesOrgValue(code);
    if (helpField === 'division') setDivisionValue(code);
    setHelpField(null);
  }

  const helpTitle = helpField === 'salesOrg'
    ? t('salesOrgDivision.salesOrgHelpTitle')
    : t('salesOrgDivision.divisionHelpTitle');
  const search = helpSearch.trim().toLocaleLowerCase();
  const visibleSalesOrganizations = salesOrganizations.filter((item) =>
    `${item.code} ${item.name}`.toLocaleLowerCase().includes(search),
  );
  const visibleDivisions = divisions.filter((item) =>
    `${item.code} ${item.name}`.toLocaleLowerCase().includes(search),
  );

  return (
    <>
      <section className="border border-[#cbd5de] bg-white p-3 sm:p-5" aria-labelledby="ovxa-form-title">
        <div className="mb-4 border-b border-[#d6dce1] pb-3">
          <h2 id="ovxa-form-title" className="text-base font-semibold text-[#334f65]">
            {t('salesOrgDivision.formTitle')}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{t('salesOrgDivision.formHint')}</p>
        </div>

        {state.message && (
          <div
            role={state.ok ? 'status' : 'alert'}
            className={`mb-4 border p-3 text-sm ${state.ok
              ? 'border-[#a8c9b1] bg-[#f3faf4] text-[#285d37]'
              : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}
          >
            <p>{state.message}</p>
            {state.remedy && <p className="mt-1">{state.remedy}</p>}
          </div>
        )}

        <form action={action} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="ovxa-sales-org" className="field-label">
                {t('salesOrgDivision.salesOrgField')} <span className="text-signal-error" aria-hidden="true">*</span>
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="ovxa-sales-org"
                  name="salesOrg"
                  type="text"
                  required
                  minLength={4}
                  maxLength={4}
                  pattern="[A-Za-z0-9]{4}"
                  title={t('salesOrgDivision.fourCharHelp')}
                  autoComplete="off"
                  value={salesOrgValue}
                  onChange={(event) => setSalesOrgValue(event.target.value.toUpperCase().slice(0, 4))}
                  onKeyDown={(event) => {
                    if (event.key === 'F4') {
                      event.preventDefault();
                      openHelp('salesOrg');
                    }
                  }}
                  className="field-input code min-h-11 min-w-0 flex-1 uppercase sm:min-h-9"
                  aria-label={t('salesOrgDivision.salesOrgField')}
                  disabled={pending || salesOrganizations.length === 0}
                />
                <button
                  type="button"
                  className="inline-flex min-h-11 min-w-12 items-center justify-center border border-[#8faabd] bg-[#eef3f7] px-3 font-mono text-sm font-semibold text-[#264e6b] hover:bg-[#e3edf4] disabled:opacity-50 sm:min-h-9"
                  aria-label={t('salesOrgDivision.openSalesOrgHelp')}
                  title={t('salesOrgDivision.openSalesOrgHelp')}
                  onClick={() => openHelp('salesOrg')}
                  disabled={pending || salesOrganizations.length === 0}
                >
                  F4
                </button>
              </div>
              <p className="mt-1 text-xs text-ink-faint">{t('salesOrgDivision.salesOrgValueHelpRule')}</p>
            </div>

            <div>
              <label htmlFor="ovxa-division" className="field-label">
                {t('salesOrgDivision.divisionField')} <span className="text-signal-error" aria-hidden="true">*</span>
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="ovxa-division"
                  name="division"
                  type="text"
                  required
                  minLength={2}
                  maxLength={2}
                  pattern="[A-Za-z0-9]{2}"
                  title={t('salesOrgDivision.twoCharHelp')}
                  autoComplete="off"
                  value={divisionValue}
                  onChange={(event) => setDivisionValue(event.target.value.toUpperCase().slice(0, 2))}
                  onKeyDown={(event) => {
                    if (event.key === 'F4') {
                      event.preventDefault();
                      openHelp('division');
                    }
                  }}
                  className="field-input code min-h-11 min-w-0 flex-1 uppercase sm:min-h-9"
                  aria-label={t('salesOrgDivision.divisionField')}
                  disabled={pending || divisions.length === 0}
                />
                <button
                  type="button"
                  className="inline-flex min-h-11 min-w-12 items-center justify-center border border-[#8faabd] bg-[#eef3f7] px-3 font-mono text-sm font-semibold text-[#264e6b] hover:bg-[#e3edf4] disabled:opacity-50 sm:min-h-9"
                  aria-label={t('salesOrgDivision.openDivisionHelp')}
                  title={t('salesOrgDivision.openDivisionHelp')}
                  onClick={() => openHelp('division')}
                  disabled={pending || divisions.length === 0}
                >
                  F4
                </button>
              </div>
              <p className="mt-1 text-xs text-ink-faint">{t('salesOrgDivision.divisionValueHelpRule')}</p>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-[#d6dce1] pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-2xl text-xs text-ink-soft">{t('salesOrgDivision.assignmentRule')}</p>
            <button
              type="submit"
              className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto"
              disabled={pending || salesOrganizations.length === 0 || divisions.length === 0}
            >
              {pending ? t('common.saving') : t('salesOrgDivision.assignButton')}
            </button>
          </div>
        </form>
      </section>

      {helpField && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6"
          onClick={() => setHelpField(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="ovxa-value-help-title"
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto border border-[#8faabd] bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setHelpField(null);
            }}
          >
            <header className="flex items-center gap-3 border-b border-[#9eb6c8] bg-[#c9dce9] px-4 py-3 text-[#28445b]">
              <h2 id="ovxa-value-help-title" className="min-w-0 flex-1 font-semibold">{helpTitle}</h2>
              <button
                type="button"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center border border-[#8faabd] bg-white text-lg hover:bg-[#eef3f7] sm:h-9 sm:w-9"
                aria-label={t('common.close')}
                onClick={() => setHelpField(null)}
              >
                ×
              </button>
            </header>
            <div className="border-b border-[#d6dce1] bg-[#eef3f7] p-3">
              <label htmlFor="ovxa-value-help-search" className="field-label">{t('salesOrgDivision.valueHelpSearch')}</label>
              <input
                id="ovxa-value-help-search"
                type="search"
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                value={helpSearch}
                autoFocus
                onChange={(event) => setHelpSearch(event.target.value)}
              />
            </div>
            {helpField === 'salesOrg' ? (
              visibleSalesOrganizations.length ? (
                <ul className="divide-y divide-[#d6dce1]">
                  {visibleSalesOrganizations.map((item) => (
                    <li key={item.code}>
                      <button
                        type="button"
                        className="flex min-h-14 w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-[#f4f8fa]"
                        onClick={() => chooseValue(item.code)}
                      >
                        <span className="code w-20 shrink-0 font-semibold">{item.code}</span>
                        <span className="min-w-0 flex-1 break-words text-sm">{item.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p role="status" className="p-5 text-center text-sm text-ink-soft">{t('salesOrgDivision.salesOrgLookupEmpty')}</p>
              )
            ) : (
              visibleDivisions.length ? (
                <ul className="divide-y divide-[#d6dce1]">
                  {visibleDivisions.map((item) => (
                    <li key={item.code}>
                      <button
                        type="button"
                        className="flex min-h-14 w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-[#f4f8fa]"
                        onClick={() => chooseValue(item.code)}
                      >
                        <span className="code w-20 shrink-0 font-semibold">{item.code}</span>
                        <span className="min-w-0 flex-1 break-words text-sm">{item.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p role="status" className="p-5 text-center text-sm text-ink-soft">{t('salesOrgDivision.divisionLookupEmpty')}</p>
              )
            )}
            <footer className="flex justify-end border-t border-[#d6dce1] p-3">
              <button type="button" className="btn btn-default min-h-11 sm:min-h-9" onClick={() => setHelpField(null)}>
                {t('common.cancel')}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
