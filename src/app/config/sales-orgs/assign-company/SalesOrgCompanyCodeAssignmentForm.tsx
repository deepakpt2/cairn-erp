'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import {
  assignSalesOrgCompanyCodeAction,
  type SalesOrgCompanyCodeAssignmentState,
} from './actions';
import { SearchIcon } from '@/ui/fields/SearchIcon';

interface SalesOrgChoice {
  code: string;
  name: string;
  isActive: boolean;
  companyCode: string | null;
}

interface CompanyCodeChoice {
  code: string;
  name: string;
}

type HelpField = 'salesOrg' | 'companyCode';

export function SalesOrgCompanyCodeAssignmentForm({
  salesOrganisations,
  companyCodes,
}: {
  salesOrganisations: SalesOrgChoice[];
  companyCodes: CompanyCodeChoice[];
}) {
  const [state, action, pending] = useActionState<SalesOrgCompanyCodeAssignmentState, FormData>(
    assignSalesOrgCompanyCodeAction,
    { ok: true },
  );
  const [salesOrgValue, setSalesOrgValue] = useState('');
  const [companyCodeValue, setCompanyCodeValue] = useState('');
  const [helpField, setHelpField] = useState<HelpField | null>(null);
  const [helpSearch, setHelpSearch] = useState('');
  const [engaged, setEngaged] = useState(false);
  const chosen = salesOrganisations.find((item) => item.code.toUpperCase() === salesOrgValue.trim().toUpperCase());
  const changing = Boolean(chosen?.companyCode);
  const companyLock = useChangeLock(
    'SALES_ORG_COMPANY',
    salesOrgValue.trim().toUpperCase(),
    'CFG.ORG.SALESORG.ASSIGN_COMPANY',
    engaged && changing,
  );

  function openHelp(field: HelpField) {
    setHelpSearch('');
    setHelpField(field);
  }

  function chooseValue(code: string) {
    if (helpField === 'salesOrg') setSalesOrgValue(code);
    if (helpField === 'companyCode') setCompanyCodeValue(code);
    setHelpField(null);
  }

  const helpTitle = helpField === 'salesOrg'
    ? t('salesOrg.salesOrgHelpTitle')
    : t('salesOrg.companyCodeHelpTitle');
  const visibleSalesOrgs = salesOrganisations.filter((item) =>
    `${item.code} ${item.name}`.toLocaleLowerCase().includes(helpSearch.trim().toLocaleLowerCase()),
  );
  const visibleCompanyCodes = companyCodes.filter((item) =>
    `${item.code} ${item.name}`.toLocaleLowerCase().includes(helpSearch.trim().toLocaleLowerCase()),
  );

  if (state.ok && state.message) {
    return (
      <div className="space-y-3 border border-[#a8c9b1] bg-[#f3faf4] p-4" role="status">
        <p className="text-sm font-medium text-[#285d37]">{state.message}</p>
        {state.salesOrg && (
          <Link
            className="inline-flex min-h-11 items-center text-sm text-accent underline sm:min-h-8"
            href={`/config/sales-orgs?salesOrg=${encodeURIComponent(state.salesOrg)}`}
          >
            {t('salesOrg.openAssignedDefinition')}
          </Link>
        )}
      </div>
    );
  }

  return (
    <>
      <section className="border border-[#cbd5de] bg-white p-3 sm:p-5" aria-labelledby="scr021-form-title">
        <div className="mb-4 border-b border-[#d6dce1] pb-3">
          <h2 id="scr021-form-title" className="text-base font-semibold text-[#334f65]">
            {t('salesOrg.assignmentFormTitle')}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{t('salesOrg.assignmentF4Hint')}</p>
        </div>

        {state.message && (
          <div role="alert" className="mb-4 border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
            <p>{state.message}</p>
            {state.remedy && <p className="mt-1">{state.remedy}</p>}
          </div>
        )}

        <form
          action={action}
          className="space-y-4"
          onFocus={() => setEngaged(true)}
          onSubmit={(event) => {
            if (changing && companyLock?.mode !== 'CHANGE') event.preventDefault();
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="scr021-sales-org" className="field-label">
                {t('salesOrg.salesOrgField')} <span className="text-signal-error" aria-hidden="true">*</span>
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="scr021-sales-org"
                  name="salesOrg"
                  type="text"
                  required
                  maxLength={4}
                  minLength={4}
                  pattern="[A-Za-z0-9]{4}"
                  title={t('salesOrg.fourCharKeyHelp')}
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
                  aria-label={t('salesOrg.salesOrgField')}
                  disabled={pending || salesOrganisations.length === 0}
                />
                <button
                  type="button"
                  className="inline-flex min-h-11 min-w-12 items-center justify-center border border-[#8faabd] bg-[#eef3f7] px-3 font-mono text-sm font-semibold text-[#264e6b] hover:bg-[#e3edf4] disabled:opacity-50 sm:min-h-9"
                  aria-label={t('salesOrg.openSalesOrgHelp')}
                  title={t('salesOrg.openSalesOrgHelp')}
                  onClick={() => openHelp('salesOrg')}
                  disabled={pending || salesOrganisations.length === 0}
                >
                  <SearchIcon />
                </button>
              </div>
              <p className="mt-1 text-xs text-ink-faint">{t('salesOrg.salesOrgValueHelpRule')}</p>
            </div>

            <div>
              <label htmlFor="scr021-company-code" className="field-label">
                {t('salesOrg.companyCodeField')} <span className="text-signal-error" aria-hidden="true">*</span>
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="scr021-company-code"
                  name="companyCode"
                  type="text"
                  required
                  maxLength={4}
                  minLength={4}
                  pattern="[A-Za-z0-9]{4}"
                  title={t('salesOrg.fourCharKeyHelp')}
                  autoComplete="off"
                  value={companyCodeValue}
                  onChange={(event) => setCompanyCodeValue(event.target.value.toUpperCase().slice(0, 4))}
                  onKeyDown={(event) => {
                    if (event.key === 'F4') {
                      event.preventDefault();
                      openHelp('companyCode');
                    }
                  }}
                  className="field-input code min-h-11 min-w-0 flex-1 uppercase sm:min-h-9"
                  aria-label={t('salesOrg.companyCodeField')}
                  disabled={pending || companyCodes.length === 0}
                />
                <button
                  type="button"
                  className="inline-flex min-h-11 min-w-12 items-center justify-center border border-[#8faabd] bg-[#eef3f7] px-3 font-mono text-sm font-semibold text-[#264e6b] hover:bg-[#e3edf4] disabled:opacity-50 sm:min-h-9"
                  aria-label={t('salesOrg.openCompanyCodeHelp')}
                  title={t('salesOrg.openCompanyCodeHelp')}
                  onClick={() => openHelp('companyCode')}
                  disabled={pending || companyCodes.length === 0}
                >
                  <SearchIcon />
                </button>
              </div>
              <p className="mt-1 text-xs text-ink-faint">{t('salesOrg.companyCodeValueHelpRule')}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#d6dce1] pt-4">
            <p className="max-w-2xl text-xs text-ink-soft">{t('salesOrg.assignmentOneCompanyRule')}</p>
            <LockNotice message={changing && companyLock?.mode === 'DISPLAY' ? companyLock.message : null} remedy={companyLock?.remedy} />
            <button
              type="submit"
              className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto"
              disabled={pending || salesOrganisations.length === 0 || companyCodes.length === 0 || (changing && companyLock?.mode === 'DISPLAY')}
            >
              {pending ? t('common.saving') : t('salesOrg.submitCompanyAssignment')}
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
            aria-labelledby="scr021-value-help-title"
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto border border-[#8faabd] bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setHelpField(null);
            }}
          >
            <header className="flex items-center gap-3 border-b border-[#9eb6c8] bg-[#c9dce9] px-4 py-3 text-[#28445b]">
              <h2 id="scr021-value-help-title" className="min-w-0 flex-1 font-semibold">{helpTitle}</h2>
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
              <label htmlFor="scr021-value-help-search" className="field-label">{t('salesOrg.valueHelpSearch')}</label>
              <input
                id="scr021-value-help-search"
                type="search"
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                value={helpSearch}
                autoFocus
                onChange={(event) => setHelpSearch(event.target.value)}
              />
            </div>
            {helpField === 'salesOrg' ? (
              visibleSalesOrgs.length ? (
                <ul className="divide-y divide-[#d6dce1]">
                  {visibleSalesOrgs.map((item) => {
                    const eligible = item.isActive;
                    return (
                      <li key={item.code}>
                        <button
                          type="button"
                          className="flex min-h-14 w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-[#f4f8fa] disabled:cursor-not-allowed disabled:bg-[#f6f7f8] disabled:text-ink-faint"
                          disabled={!eligible}
                          onClick={() => chooseValue(item.code)}
                        >
                          <span className="code w-20 shrink-0 font-semibold">{item.code}</span>
                          <span className="min-w-0 flex-1 break-words text-sm">{item.name}</span>
                          <span className={`chip ${eligible ? 'chip-ok' : 'chip-neutral'}`}>
                            {item.companyCode
                              ? t('salesOrg.valueHelpCurrentAssignment', { companyCode: item.companyCode })
                              : t(eligible ? 'salesOrg.active' : 'salesOrg.inactive')}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p role="status" className="p-5 text-center text-sm text-ink-soft">{t('salesOrg.salesOrgLookupEmpty')}</p>
              )
            ) : (
              visibleCompanyCodes.length ? (
                <ul className="divide-y divide-[#d6dce1]">
                  {visibleCompanyCodes.map((item) => (
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
                <p role="status" className="p-5 text-center text-sm text-ink-soft">{t('salesOrg.companyCodeLookupEmpty')}</p>
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
