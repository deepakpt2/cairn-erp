'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import type {
  CompanyChoice,
  EmployeeToleranceGroupRow,
} from '@/modules/foundation/employee-tolerance-definition';
import {
  saveToleranceGroupAction,
  type ToleranceGroupActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

/** The action's answer, refusal or confirmation, with the remedy underneath it. */
function TolMessage({ state }: { state: ToleranceGroupActionState }) {
  if (!state.message) return null;
  return (
    <div
      role={state.ok ? 'status' : 'alert'}
      className="border border-line bg-white p-3 text-sm text-ink"
    >
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

/** The blank scope and the blank group are stored values with names, not gaps. */
function scopeLabel(companyCode: string): string {
  return companyCode === '' ? t('tolGroup.allCompanies') : companyCode;
}

function groupLabel(groupKey: string): string {
  return groupKey === '' ? t('tolGroup.defaultGroup') : groupKey;
}

const LIMIT_FIELDS = [
  { name: 'maxDocumentAmount', labelKey: 'tolGroup.maxDocumentAmount', placeholder: '100000.00', required: true },
  { name: 'maxLineAmount', labelKey: 'tolGroup.maxLineAmount', placeholder: '50000.00', required: true },
  { name: 'maxCashDiscountPercent', labelKey: 'tolGroup.maxCashDiscountPercent', placeholder: '3.000', required: true },
  { name: 'paymentDiffRevenueAmount', labelKey: 'tolGroup.paymentDiffRevenueAmount', placeholder: '0.00', required: false },
  { name: 'paymentDiffExpenseAmount', labelKey: 'tolGroup.paymentDiffExpenseAmount', placeholder: '0.00', required: false },
  { name: 'paymentDiffRevenuePercent', labelKey: 'tolGroup.paymentDiffRevenuePercent', placeholder: '0.0', required: false },
  { name: 'paymentDiffExpensePercent', labelKey: 'tolGroup.paymentDiffExpensePercent', placeholder: '0.0', required: false },
] as const;

type LimitFieldName = typeof LIMIT_FIELDS[number]['name'];

function LimitFields({
  idPrefix,
  row,
}: {
  idPrefix: string;
  row: EmployeeToleranceGroupRow | null;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {LIMIT_FIELDS.map((field) => (
          <div key={field.name}>
            <label htmlFor={`${idPrefix}-${field.name}`} className="field-label">
              {t(field.labelKey)}{field.required && <RequiredMark />}
            </label>
            <input
              id={`${idPrefix}-${field.name}`}
              name={field.name}
              type="text"
              inputMode="decimal"
              className="field-input code"
              defaultValue={row ? row[field.name as LimitFieldName] : ''}
              placeholder={field.placeholder}
              required={field.required}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-soft">{t('tolGroup.zeroHint')}</p>
      <p className="text-xs text-ink-soft">{t('tolGroup.lineWithinDocument')}</p>
    </>
  );
}

function ReasonField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {t('tolGroup.reason')}<RequiredMark />
      </label>
      <textarea
        id={id}
        name="reason"
        className="field-input"
        rows={2}
        maxLength={500}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function CreatePanel({ companies }: { companies: CompanyChoice[] }) {
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<ToleranceGroupActionState, FormData>(
    saveToleranceGroupAction,
    { ok: true },
  );

  return (
    <section className="panel overflow-hidden" aria-labelledby="tol-group-create-title">
      <div className="panel-header">
        <h2 id="tol-group-create-title" className="panel-title">{t('tolGroup.newTitle')}</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="tol-group-company" className="field-label">
              {t('tolGroup.companyCode')}<RequiredMark />
            </label>
            <select id="tol-group-company" name="companyCode" className="field-input" defaultValue="">
              <option value="">{t('tolGroup.allCompanies')}</option>
              {companies.map((company) => (
                <option key={company.companyCode} value={company.companyCode}>
                  {company.companyCode} — {company.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="tol-group-key" className="field-label">{t('tolGroup.groupKey')}</label>
            <input id="tol-group-key" name="groupKey" className="field-input code" maxLength={4} placeholder="TG01" />
            <p className="mt-1 text-xs text-ink-soft">{t('tolGroup.groupKeyHint')}</p>
          </div>
        </div>
        <LimitFields idPrefix="tol-group" row={null} />
        <ReasonField id="tol-group-reason" value={reason} onChange={setReason} />
        <TolMessage state={state} />
        <button type="submit" className="btn-primary" disabled={pending || !reason.trim()}>
          {t('tolGroup.create')}
        </button>
      </form>
    </section>
  );
}

/**
 * Change, one dialog per row. The key is not among the fields: the dialog
 * names the scope and group it opened from, and limits are all it may
 * change — renaming a group means defining the new one.
 */
function ChangeDialog({ row }: { row: EmployeeToleranceGroupRow }) {
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<ToleranceGroupActionState, FormData>(
    saveToleranceGroupAction,
    { ok: true },
  );
  const keySuffix = `${row.companyCode || 'ALL'}-${row.groupKey || 'DEFAULT'}`;
  const label = `${groupLabel(row.groupKey)} · ${scopeLabel(row.companyCode)}`;

  return (
    <details className="min-w-16">
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
        {t('tolGroup.change')}
      </summary>
      <div role="dialog" aria-modal="true" aria-label={`${t('tolGroup.change')} ${label}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
        <div className="mx-auto max-w-2xl">
          <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
            <div>
              <span className="code text-xs text-ink-faint">OBA4 · {label}</span>
              <p className="font-semibold">{`${t('tolGroup.change')} ${label}`}</p>
            </div>
            <button
              type="button"
              className="btn btn-default min-h-11 sm:min-h-9"
              onClick={(event) => {
                const details = event.currentTarget.closest('details');
                if (details) details.open = false;
              }}
            >
              {t('common.close')}
            </button>
          </div>
          <section className="panel overflow-hidden p-4">
            <form className="space-y-3" action={formAction}>
              <input type="hidden" name="mode" value="CHANGE" />
              <input type="hidden" name="companyCode" value={row.companyCode} />
              <input type="hidden" name="groupKey" value={row.groupKey} />
              <LimitFields idPrefix={`tol-group-${keySuffix}`} row={row} />
              <ReasonField id={`tol-group-change-reason-${keySuffix}`} value={reason} onChange={setReason} />
              <TolMessage state={state} />
              <button type="submit" className="btn-primary" disabled={pending || !reason.trim()}>
                {t('tolGroup.save')}
              </button>
            </form>
          </section>
        </div>
      </div>
    </details>
  );
}

export function ToleranceGroups({
  rows,
  companies,
  canMaintain,
}: {
  rows: EmployeeToleranceGroupRow[];
  companies: CompanyChoice[];
  canMaintain: boolean;
}) {
  return (
    <>
      {canMaintain && <CreatePanel companies={companies} />}
      <section className="panel overflow-hidden" aria-labelledby="tol-group-grid-title">
        <div className="panel-header">
          <h2 id="tol-group-grid-title" className="panel-title">{t('tolGroup.gridTitle')}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[56.25rem]">
            <thead>
              <tr>
                <th>{t('tolGroup.companyCode')}</th>
                <th>{t('tolGroup.groupKey')}</th>
                <th>{t('tolGroup.maxDocumentAmount')}</th>
                <th>{t('tolGroup.maxLineAmount')}</th>
                <th>{t('tolGroup.maxCashDiscountPercent')}</th>
                <th>{t('tolGroup.paymentDiffRevenueAmount')}</th>
                <th>{t('tolGroup.paymentDiffExpenseAmount')}</th>
                <th>{t('tolGroup.paymentDiffRevenuePercent')}</th>
                <th>{t('tolGroup.paymentDiffExpensePercent')}</th>
                {canMaintain && <th>{t('tolGroup.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={canMaintain ? 10 : 9} className="text-ink-soft">
                    {t('tolGroup.empty')}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={`${row.companyCode}|${row.groupKey}`}>
                    <td>{row.companyCode === '' ? t('tolGroup.allCompanies') : <span className="code">{row.companyCode}</span>}</td>
                    <td>{row.groupKey === '' ? t('tolGroup.defaultGroup') : <span className="code">{row.groupKey}</span>}</td>
                    <td><span className="code">{row.maxDocumentAmount}</span></td>
                    <td><span className="code">{row.maxLineAmount}</span></td>
                    <td><span className="code">{row.maxCashDiscountPercent}</span></td>
                    <td><span className="code">{row.paymentDiffRevenueAmount}</span></td>
                    <td><span className="code">{row.paymentDiffExpenseAmount}</span></td>
                    <td><span className="code">{row.paymentDiffRevenuePercent}</span></td>
                    <td><span className="code">{row.paymentDiffExpensePercent}</span></td>
                    {canMaintain && (
                      <td>
                        <ChangeDialog row={row} />
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-sm text-ink-soft">{t('tolGroup.noDeleteNote')}</p>
    </>
  );
}
