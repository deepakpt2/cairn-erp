'use client';

import { useState, type FormEvent } from 'react';
import { t } from '@/platform/i18n';
import { ControllingAreaValueHelp, type ControllingAreaChoice } from './ControllingAreaValueHelp';

export interface ControllingAreaAssignmentRow {
  controllingArea: string;
  controllingAreaName: string | null;
  companyCodeScope: string | null;
  controllingAreaCurrency: string | null;
  controllingAreaFiscalYearVariant: string | null;
  controllingAreaIsActive: boolean | null;
  companyCode: string;
  companyCodeName: string | null;
  companyCodeCurrency: string | null;
  companyCodeChartOfAccounts: string | null;
  companyCodeFiscalYearVariant: string | null;
  companyCodeIsActive: boolean | null;
}

interface ControllingAreaCompanyAssignmentUIProps {
  controllingAreas: ControllingAreaChoice[];
  companyCodes: ControllingAreaChoice[];
  assignments: ControllingAreaAssignmentRow[];
  canMaintain: boolean;
}

type HelpField = 'controllingArea' | 'companyCode';

/**
 * SCR-025 / OX19 presentation stage. Value help and current assignments are wired
 * to tenant-local read data; mutation controls remain deliberately disabled until
 * the separate schema and business-function stages are delivered.
 */
export function ControllingAreaCompanyAssignmentUI({
  controllingAreas,
  companyCodes,
  assignments,
  canMaintain,
}: ControllingAreaCompanyAssignmentUIProps) {
  const [controllingAreaValue, setControllingAreaValue] = useState('');
  const [companyCodeValue, setCompanyCodeValue] = useState('');

  function keepPreviewLocal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
  }

  return (
    <div className="space-y-4">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm" aria-labelledby="ox19-assignment-form-title">
        <header className="border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4">
          <h2 id="ox19-assignment-form-title" className="text-base font-semibold text-[#334f65]">
            {t('controllingArea.assignmentFormTitle')}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{t('controllingArea.assignmentFormHint')}</p>
        </header>

        {!canMaintain && (
          <p role="status" className="border-b border-[#d6dce1] bg-[#f7f9fa] px-3 py-3 text-sm text-ink-soft sm:px-4">
            {t('controllingArea.assignmentPermissionRequired')}
          </p>
        )}

        <form onSubmit={keepPreviewLocal} className="space-y-4 p-3 sm:p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ControllingAreaValueHelp
              id="ox19-controlling-area"
              name="controllingArea"
              label={t('controllingArea.code')}
              value={controllingAreaValue}
              onChange={setControllingAreaValue}
              choices={controllingAreas}
              dialogTitle={t('controllingArea.assignmentAreaLookupTitle')}
              openLabel={t('controllingArea.assignmentOpenAreaLookup')}
              emptyText={t('controllingArea.assignmentNoAreasMatch')}
              rule={t('controllingArea.assignmentAreaRule')}
              maxLength={4}
              pattern="[A-Za-z0-9]{4}"
              disabled={!canMaintain}
            />
            <ControllingAreaValueHelp
              id="ox19-company-code"
              name="companyCode"
              label={t('cc.code')}
              value={companyCodeValue}
              onChange={setCompanyCodeValue}
              choices={companyCodes}
              dialogTitle={t('controllingArea.assignmentCompanyLookupTitle')}
              openLabel={t('controllingArea.assignmentOpenCompanyLookup')}
              emptyText={t('controllingArea.assignmentNoCompanyCodesMatch')}
              rule={t('controllingArea.assignmentCompanyRule')}
              maxLength={4}
              pattern="[A-Za-z0-9]{4}"
              disabled={!canMaintain}
              normalizeUppercase={false}
            />
          </div>

          <p className="border-s-2 border-[#8faabd] bg-[#f7f9fa] px-3 py-2 text-xs text-[#435b6d]">
            {t('controllingArea.assignmentCompatibilityRule')}
          </p>

          <div className="flex flex-col gap-3 border-t border-[#d6dce1] pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-ink-soft">{t('controllingArea.assignmentActionsPending')}</p>
            <button
              type="submit"
              className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto"
              disabled
              aria-describedby="ox19-assignment-actions-pending"
            >
              {t('controllingArea.assignmentAddButton')}
            </button>
          </div>
          <span id="ox19-assignment-actions-pending" className="sr-only">
            {t('controllingArea.assignmentActionsPending')}
          </span>
        </form>
      </section>

      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm" aria-labelledby="ox19-current-assignments-title">
        <div className="flex items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4">
          <h2 id="ox19-current-assignments-title" className="min-w-0 flex-1 text-sm font-semibold text-[#334f65]">
            {t('controllingArea.assignmentListTitle')}
          </h2>
          <span className="code text-xs tabular text-ink-faint">{assignments.length}</span>
        </div>

        {assignments.length === 0 ? (
          <p role="status" className="p-4 text-sm text-ink-soft">{t('controllingArea.assignmentListEmpty')}</p>
        ) : (
          <>
            <div className="divide-y divide-[#d6dce1] sm:hidden" role="list" aria-label={t('controllingArea.assignmentListTitle')}>
              {assignments.map((item) => (
                <article key={`${item.controllingArea}/${item.companyCode}`} role="listitem" className="space-y-3 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="code font-semibold">{item.controllingArea}</span>
                    {item.controllingAreaIsActive !== null && (
                      <span className={`chip ${item.controllingAreaIsActive ? 'chip-ok' : 'chip-neutral'}`}>
                        {t(item.controllingAreaIsActive ? 'controllingArea.active' : 'controllingArea.inactive')}
                      </span>
                    )}
                    <span className="chip chip-info">
                      {t(item.companyCodeScope === 'MULTIPLE' ? 'controllingArea.assignmentScopeMultiple' : 'controllingArea.assignmentScopeSingle')}
                    </span>
                  </div>
                  <p className="break-words text-sm text-[#263b4d]">{item.controllingAreaName || t('controllingArea.assignmentUnknownArea')}</p>
                  <div className="border-s-2 border-[#d6dce1] ps-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="code font-semibold">{item.companyCode}</span>
                      {item.companyCodeIsActive !== null && (
                        <span className={`chip ${item.companyCodeIsActive ? 'chip-ok' : 'chip-neutral'}`}>
                          {t(item.companyCodeIsActive ? 'controllingArea.active' : 'controllingArea.inactive')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 break-words text-sm text-[#263b4d]">{item.companyCodeName || t('controllingArea.assignmentUnknownCompanyCode')}</p>
                    <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs text-ink-soft">
                      <div className="flex flex-wrap gap-x-2">
                        <dt>{t('controllingArea.assignmentOperationalChart')}:</dt>
                        <dd className="code">{item.companyCodeChartOfAccounts || '—'}</dd>
                      </div>
                      <div className="flex flex-wrap gap-x-2">
                        <dt>{t('controllingArea.fiscalYearVariant')}:</dt>
                        <dd className="code">{item.companyCodeFiscalYearVariant || '—'} / {item.controllingAreaFiscalYearVariant || '—'}</dd>
                      </div>
                      <div className="flex flex-wrap gap-x-2">
                        <dt>{t('controllingArea.assignmentCurrency')}:</dt>
                        <dd className="code">{item.companyCodeCurrency || '—'} / {item.controllingAreaCurrency || '—'}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="flex justify-end border-t border-[#e1e5e8] pt-2">
                    <button type="button" className="btn btn-default min-h-11" disabled>
                      {t('controllingArea.assignmentUnassignButton')}
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <div className="hidden overflow-x-auto sm:block">
              <table className="min-w-[920px] w-full border-collapse text-sm" aria-label={t('controllingArea.assignmentListTitle')}>
                <thead className="bg-[#eef1f4] text-[#33414c]">
                  <tr className="border-y border-[#c4ccd2]">
                    <th className="w-36 border-r border-[#cbd1d6] px-3 py-2 text-left">{t('controllingArea.code')}</th>
                    <th className="w-44 px-3 py-2 text-left">{t('controllingArea.assignmentControl')}</th>
                    <th className="w-36 border-r border-[#cbd1d6] px-3 py-2 text-left">{t('cc.code')}</th>
                    <th className="min-w-48 px-3 py-2 text-left">{t('controllingArea.assignmentOperationalChart')}</th>
                    <th className="w-40 px-3 py-2 text-left">{t('controllingArea.fiscalYearVariant')}</th>
                    <th className="w-36 px-3 py-2 text-left">{t('controllingArea.assignmentCurrency')}</th>
                    <th className="w-32 px-3 py-2 text-right">{t('controllingArea.assignmentActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((item) => (
                    <tr key={`${item.controllingArea}/${item.companyCode}`} className="border-b border-[#d6dce1] hover:bg-[#f8fbfd]">
                      <td className="border-r border-[#e1e5e8] px-3 py-2">
                        <span className="code font-semibold">{item.controllingArea}</span>
                        <span className="mt-0.5 block text-xs text-ink-soft">{item.controllingAreaName || t('controllingArea.assignmentUnknownArea')}</span>
                      </td>
                      <td className="px-3 py-2">{t(item.companyCodeScope === 'MULTIPLE' ? 'controllingArea.assignmentScopeMultiple' : 'controllingArea.assignmentScopeSingle')}</td>
                      <td className="border-r border-[#e1e5e8] px-3 py-2">
                        <span className="code font-semibold">{item.companyCode}</span>
                        <span className="mt-0.5 block text-xs text-ink-soft">{item.companyCodeName || t('controllingArea.assignmentUnknownCompanyCode')}</span>
                      </td>
                      <td className="px-3 py-2 font-mono">{item.companyCodeChartOfAccounts || '—'}</td>
                      <td className="px-3 py-2 font-mono">{item.companyCodeFiscalYearVariant || '—'} / {item.controllingAreaFiscalYearVariant || '—'}</td>
                      <td className="px-3 py-2 font-mono">{item.companyCodeCurrency || '—'} / {item.controllingAreaCurrency || '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" className="btn btn-default min-h-11 sm:min-h-9" disabled>
                          {t('controllingArea.assignmentUnassignButton')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
