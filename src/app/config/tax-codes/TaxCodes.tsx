'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import type {
  CountryChoice,
  TaxCodeRow,
} from '@/modules/foundation/tax-code-definition';
import {
  deleteTaxCodeAction,
  saveTaxCodeAction,
  type TaxCodeActionState,
} from './actions';

function DialogHeader({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
      <div>
        <span className="code text-xs text-ink-faint">FTXP · {sub}</span>
        <p className="font-semibold">{label}</p>
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
  );
}

/** The action's answer, refusal or confirmation, with the remedy underneath it. */
function TaxMessage({ state }: { state: TaxCodeActionState }) {
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

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
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
        {t('taxCode.reason')}<RequiredMark />
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

function CreatePanel({ countries }: { countries: CountryChoice[] }) {
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<TaxCodeActionState, FormData>(
    saveTaxCodeAction,
    { ok: true },
  );

  return (
    <section className="panel overflow-hidden" aria-labelledby="tax-code-create-title">
      <div className="panel-header">
        <h2 id="tax-code-create-title" className="panel-title">{t('taxCode.newTitle')}</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="tax-code-country" className="field-label">
              {t('taxCode.country')}<RequiredMark />
            </label>
            <select id="tax-code-country" name="country" className="field-input" defaultValue="">
              <option value="">{t('taxCode.chooseCountry')}</option>
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.code} — {country.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="tax-code-code" className="field-label">
              {t('taxCode.code')}<RequiredMark />
            </label>
            <input id="tax-code-code" name="taxCode" className="field-input code" maxLength={4} placeholder="V1" required />
          </div>
          <div>
            <label htmlFor="tax-code-name" className="field-label">
              {t('taxCode.name')}<RequiredMark />
            </label>
            <input id="tax-code-name" name="name" className="field-input" maxLength={50} required />
          </div>
          <div>
            <label htmlFor="tax-code-type" className="field-label">
              {t('taxCode.taxType')}<RequiredMark />
            </label>
            <input id="tax-code-type" name="taxType" className="field-input code" maxLength={4} placeholder="VST" required />
            <p className="mt-1 text-xs text-ink-soft">{t('taxCode.taxTypeHint')}</p>
          </div>
          <div>
            <label htmlFor="tax-code-rate" className="field-label">
              {t('taxCode.rate')}<RequiredMark />
            </label>
            <input id="tax-code-rate" name="ratePercent" inputMode="decimal" className="field-input code" placeholder="15.00" required />
          </div>
          <div>
            <label htmlFor="tax-code-account-key" className="field-label">{t('taxCode.accountKey')}</label>
            <input id="tax-code-account-key" name="accountKey" className="field-input code" maxLength={3} placeholder="NVV" />
            <p className="mt-1 text-xs text-ink-soft">{t('taxCode.accountKeyHint')}</p>
          </div>
        </div>
        <ReasonField id="tax-code-reason" value={reason} onChange={setReason} />
        <TaxMessage state={state} />
        <button type="submit" className="btn-primary" disabled={pending || !reason.trim()}>
          {t('taxCode.create')}
        </button>
      </form>
    </section>
  );
}

/**
 * Change and delete, one dialog each per row. A code's key — country and code — cannot
 * be edited in place: renaming it means defining the new code and, where the old one
 * should not stand, deleting it. The Change dialog therefore offers only the
 * description, rate, condition type and account key, guarded on the rate the dialog
 * opened against. The Delete dialog says where the code is used before it offers
 * anything: journal lines carry the code without its country, so the count is every
 * line in the tenant carrying it, under any country.
 */
function RowDialogs({ row }: { row: TaxCodeRow }) {
  const [changeReason, setChangeReason] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [changeState, changeAction, changePending] = useActionState<TaxCodeActionState, FormData>(
    saveTaxCodeAction,
    { ok: true },
  );
  const [deleteState, deleteAction, deletePending] = useActionState<TaxCodeActionState, FormData>(
    deleteTaxCodeAction,
    { ok: true },
  );
  const keyText = `${row.country} · ${row.taxCode}`;
  const idKey = `${row.country}-${row.taxCode}`;
  const changeLabel = `${t('taxCode.change')} ${row.taxCode}`;
  const used = row.usedByLines > 0;

  return (
    <div className="flex gap-3">
      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
          {t('taxCode.change')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={changeLabel} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={changeLabel} sub={keyText} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3" action={changeAction}>
                <input type="hidden" name="mode" value="CHANGE" />
                <input type="hidden" name="country" value={row.country} />
                <input type="hidden" name="taxCode" value={row.taxCode} />
                <input type="hidden" name="expectedRate" value={row.ratePercent} />
                <div>
                  <span className="field-label">{t('taxCode.name')}</span>
                  <p className="font-medium">{row.name}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`tax-code-name-${idKey}`} className="field-label">
                      {t('taxCode.newName')}<RequiredMark />
                    </label>
                    <input id={`tax-code-name-${idKey}`} name="name" className="field-input" maxLength={50} defaultValue={row.name} required />
                  </div>
                  <div>
                    <label htmlFor={`tax-code-rate-${idKey}`} className="field-label">
                      {t('taxCode.rate')}<RequiredMark />
                    </label>
                    <input id={`tax-code-rate-${idKey}`} name="ratePercent" inputMode="decimal" className="field-input code" defaultValue={row.ratePercent} required />
                  </div>
                  <div>
                    <label htmlFor={`tax-code-type-${idKey}`} className="field-label">
                      {t('taxCode.taxType')}<RequiredMark />
                    </label>
                    <input id={`tax-code-type-${idKey}`} name="taxType" className="field-input code" maxLength={4} defaultValue={row.taxType} required />
                  </div>
                  <div>
                    <label htmlFor={`tax-code-account-key-${idKey}`} className="field-label">{t('taxCode.accountKey')}</label>
                    <input id={`tax-code-account-key-${idKey}`} name="accountKey" className="field-input code" maxLength={3} defaultValue={row.accountKey ?? ''} />
                  </div>
                </div>
                {used && (
                  <p className="text-xs text-ink-soft">
                    {t('taxCode.changeUsedNote', { count: String(row.usedByLines) })}
                  </p>
                )}
                <ReasonField id={`tax-code-change-reason-${idKey}`} value={changeReason} onChange={setChangeReason} />
                <TaxMessage state={changeState} />
                <button type="submit" className="btn-primary" disabled={changePending || !changeReason.trim()}>
                  {t('taxCode.save')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>

      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-signal-error hover:underline sm:min-h-9">
          {t('taxCode.delete')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('taxCode.delete')} ${row.taxCode}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={t('taxCode.delete')} sub={keyText} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3" action={deleteAction}>
                <input type="hidden" name="country" value={row.country} />
                <input type="hidden" name="taxCode" value={row.taxCode} />
                {used ? (
                  <p role="alert" className="text-sm text-signal-error">
                    {t('taxCode.deleteBlocked', { count: String(row.usedByLines) })}
                  </p>
                ) : (
                  <p className="text-sm text-ink-soft">{t('taxCode.deleteNote')}</p>
                )}
                <ReasonField id={`tax-code-delete-reason-${idKey}`} value={deleteReason} onChange={setDeleteReason} />
                <TaxMessage state={deleteState} />
                <button type="submit" className="btn-primary" disabled={deletePending || used || !deleteReason.trim()}>
                  {t('taxCode.delete')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>
    </div>
  );
}

export function TaxCodes({
  rows,
  countries,
  canMaintain,
}: {
  rows: TaxCodeRow[];
  countries: CountryChoice[];
  canMaintain: boolean;
}) {
  return (
    <>
      {canMaintain && <CreatePanel countries={countries} />}
      <section className="panel overflow-hidden" aria-labelledby="tax-code-grid-title">
        <div className="panel-header">
          <h2 id="tax-code-grid-title" className="panel-title">
            {t('taxCode.gridTitle')}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[51.25rem]">
            <thead>
              <tr>
                <th>{t('taxCode.country')}</th>
                <th>{t('taxCode.code')}</th>
                <th>{t('taxCode.name')}</th>
                <th>{t('taxCode.taxType')}</th>
                <th>{t('taxCode.rate')}</th>
                <th>{t('taxCode.accountKey')}</th>
                <th>{t('taxCode.usedBy')}</th>
                {canMaintain && <th>{t('taxCode.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.country}-${row.taxCode}`}>
                  <td className="code">{row.country}</td>
                  <td className="code font-semibold">{row.taxCode}</td>
                  <td>{row.name}</td>
                  <td className="code">{row.taxType}</td>
                  <td className="code">{row.ratePercent}%</td>
                  <td className="code">{row.accountKey ?? '—'}</td>
                  <td>{row.usedByLines > 0 ? row.usedByLines : '—'}</td>
                  {canMaintain && (
                    <td>
                      <RowDialogs row={row} />
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={canMaintain ? 8 : 7} className="px-4 py-8 text-center text-sm text-ink-soft">
                    {t('taxCode.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
