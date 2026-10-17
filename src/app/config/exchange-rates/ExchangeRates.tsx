'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import type {
  CurrencyChoice,
  ExchangeRateRow,
} from '@/modules/foundation/exchange-rate-maintenance';
import {
  deleteExchangeRateAction,
  saveExchangeRateAction,
  type ExchangeRateActionState,
} from './actions';

function DialogHeader({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
      <div>
        <span className="code text-xs text-ink-faint">OB08 · {sub}</span>
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
function RateMessage({ state }: { state: ExchangeRateActionState }) {
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

function CreatePanel({
  currencies,
  rateTypes,
}: {
  currencies: CurrencyChoice[];
  rateTypes: readonly string[];
}) {
  const [rateType, setRateType] = useState<string>('AVERAGE');
  const [fromCurrency, setFromCurrency] = useState('');
  const [toCurrency, setToCurrency] = useState('');
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<ExchangeRateActionState, FormData>(
    saveExchangeRateAction,
    { ok: true },
  );
  const samePair = fromCurrency !== '' && fromCurrency === toCurrency;
  const canSave = !pending && Boolean(reason.trim()) && !samePair && fromCurrency !== '' && toCurrency !== '';

  return (
    <section className="panel overflow-hidden" aria-labelledby="ex-rate-create-title">
      <div className="panel-header">
        <h2 id="ex-rate-create-title" className="panel-title">{t('exRate.newTitle')}</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="ex-rate-type" className="field-label">
              {t('exRate.rateType')}<RequiredMark />
            </label>
            <select
              id="ex-rate-type"
              name="rateType"
              className="field-input"
              value={rateType}
              onChange={(event) => setRateType(event.target.value)}
            >
              {rateTypes.map((type) => (
                <option key={type} value={type}>
                  {t(`exRate.type.${type}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ex-rate-from" className="field-label">
              {t('exRate.fromCurrency')}<RequiredMark />
            </label>
            <select
              id="ex-rate-from"
              name="fromCurrency"
              className="field-input code"
              value={fromCurrency}
              onChange={(event) => setFromCurrency(event.target.value)}
            >
              <option value="">{t('exRate.chooseCurrency')}</option>
              {currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ex-rate-to" className="field-label">
              {t('exRate.toCurrency')}<RequiredMark />
            </label>
            <select
              id="ex-rate-to"
              name="toCurrency"
              className="field-input code"
              value={toCurrency}
              onChange={(event) => setToCurrency(event.target.value)}
            >
              <option value="">{t('exRate.chooseCurrency')}</option>
              {currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ex-rate-valid-from" className="field-label">
              {t('exRate.validFrom')}<RequiredMark />
            </label>
            <input id="ex-rate-valid-from" name="validFrom" type="date" className="field-input" required />
          </div>
          <div>
            <label htmlFor="ex-rate-rate" className="field-label">
              {t('exRate.rate')}<RequiredMark />
            </label>
            <input id="ex-rate-rate" name="rate" inputMode="decimal" className="field-input code" placeholder="1.00000000" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ex-rate-ratio-from" className="field-label">{t('exRate.ratioFrom')}</label>
              <input id="ex-rate-ratio-from" name="ratioFrom" type="number" min={1} step={1} defaultValue={1} className="field-input code" />
            </div>
            <div>
              <label htmlFor="ex-rate-ratio-to" className="field-label">{t('exRate.ratioTo')}</label>
              <input id="ex-rate-ratio-to" name="ratioTo" type="number" min={1} step={1} defaultValue={1} className="field-input code" />
            </div>
          </div>
        </div>
        {samePair && (
          <p role="alert" className="text-xs text-signal-error">{t('exRate.samePair')}</p>
        )}
        <p className="text-xs text-ink-soft">{t('exRate.rateMeaning')}</p>
        <div>
          <label htmlFor="ex-rate-reason" className="field-label">
            {t('exRate.reason')}<RequiredMark />
          </label>
          <textarea
            id="ex-rate-reason"
            name="reason"
            className="field-input"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <RateMessage state={state} />
        <button type="submit" className="btn-primary" disabled={!canSave}>
          {t('exRate.create')}
        </button>
      </form>
    </section>
  );
}

/**
 * Change and delete, one dialog each per row. A rate's key — type, pair and the date it
 * takes effect — cannot be edited in place: correcting a key means a new rate and, where
 * the old one should not stand, a deletion. The Change dialog therefore offers only the
 * rate and its ratios, guarded on the rate the dialog opened against.
 */
function RowDialogs({ row }: { row: ExchangeRateRow }) {
  const [changeReason, setChangeReason] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [changeState, changeAction, changePending] = useActionState<ExchangeRateActionState, FormData>(
    saveExchangeRateAction,
    { ok: true },
  );
  const [deleteState, deleteAction, deletePending] = useActionState<ExchangeRateActionState, FormData>(
    deleteExchangeRateAction,
    { ok: true },
  );
  const keyText = `${t(`exRate.type.${row.rateType}`)} · ${row.fromCurrency} → ${row.toCurrency} · ${row.validFrom}`;
  const idKey = `${row.rateType}-${row.fromCurrency}-${row.toCurrency}-${row.validFrom}`;
  const changeLabel = `${t('exRate.change')} ${row.fromCurrency} → ${row.toCurrency}`;

  return (
    <div className="flex gap-3">
      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
          {t('exRate.change')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={changeLabel} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={changeLabel} sub={keyText} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3" action={changeAction}>
                <input type="hidden" name="mode" value="CHANGE" />
                <input type="hidden" name="rateType" value={row.rateType} />
                <input type="hidden" name="fromCurrency" value={row.fromCurrency} />
                <input type="hidden" name="toCurrency" value={row.toCurrency} />
                <input type="hidden" name="validFrom" value={row.validFrom} />
                <input type="hidden" name="expectedRate" value={row.rate} />
                <div>
                  <span className="field-label">{t('exRate.rate')}</span>
                  <p className="code font-medium">{row.rate}</p>
                  <p className="text-xs text-ink-soft">{t('exRate.rateMeaning')}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <label htmlFor={`ex-rate-new-rate-${idKey}`} className="field-label">
                      {t('exRate.newRate')}<RequiredMark />
                    </label>
                    <input id={`ex-rate-new-rate-${idKey}`} name="rate" inputMode="decimal" className="field-input code" defaultValue={row.rate} required />
                  </div>
                  <div>
                    <label htmlFor={`ex-rate-ratio-from-${idKey}`} className="field-label">{t('exRate.ratioFrom')}</label>
                    <input id={`ex-rate-ratio-from-${idKey}`} name="ratioFrom" type="number" min={1} step={1} defaultValue={row.ratioFrom} className="field-input code" />
                  </div>
                  <div>
                    <label htmlFor={`ex-rate-ratio-to-${idKey}`} className="field-label">{t('exRate.ratioTo')}</label>
                    <input id={`ex-rate-ratio-to-${idKey}`} name="ratioTo" type="number" min={1} step={1} defaultValue={row.ratioTo} className="field-input code" />
                  </div>
                </div>
                <div>
                  <label htmlFor={`ex-rate-change-reason-${idKey}`} className="field-label">
                    {t('exRate.reason')}<RequiredMark />
                  </label>
                  <textarea
                    id={`ex-rate-change-reason-${idKey}`}
                    name="reason"
                    className="field-input"
                    rows={2}
                    maxLength={500}
                    value={changeReason}
                    onChange={(event) => setChangeReason(event.target.value)}
                  />
                </div>
                <RateMessage state={changeState} />
                <button type="submit" className="btn-primary" disabled={changePending || !changeReason.trim()}>
                  {t('exRate.save')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>

      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-signal-error hover:underline sm:min-h-9">
          {t('exRate.delete')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('exRate.delete')} ${row.fromCurrency} → ${row.toCurrency}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={t('exRate.delete')} sub={keyText} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3" action={deleteAction}>
                <input type="hidden" name="rateType" value={row.rateType} />
                <input type="hidden" name="fromCurrency" value={row.fromCurrency} />
                <input type="hidden" name="toCurrency" value={row.toCurrency} />
                <input type="hidden" name="validFrom" value={row.validFrom} />
                <p className="text-sm text-ink-soft">{t('exRate.deleteNote')}</p>
                <div>
                  <span className="field-label">{t('exRate.rate')}</span>
                  <p className="code font-medium">
                    {row.rate} <span className="text-ink-soft">({row.ratioFrom} : {row.ratioTo})</span>
                  </p>
                </div>
                <div>
                  <label htmlFor={`ex-rate-delete-reason-${idKey}`} className="field-label">
                    {t('exRate.reason')}<RequiredMark />
                  </label>
                  <textarea
                    id={`ex-rate-delete-reason-${idKey}`}
                    name="reason"
                    className="field-input"
                    rows={2}
                    maxLength={500}
                    value={deleteReason}
                    onChange={(event) => setDeleteReason(event.target.value)}
                  />
                </div>
                <RateMessage state={deleteState} />
                <button type="submit" className="btn-primary" disabled={deletePending || !deleteReason.trim()}>
                  {t('exRate.delete')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>
    </div>
  );
}

export function ExchangeRates({
  rows,
  currencies,
  rateTypes,
  canMaintain,
}: {
  rows: ExchangeRateRow[];
  currencies: CurrencyChoice[];
  rateTypes: readonly string[];
  canMaintain: boolean;
}) {
  return (
    <>
      {canMaintain && <CreatePanel currencies={currencies} rateTypes={rateTypes} />}
      <section className="panel overflow-hidden" aria-labelledby="ex-rate-grid-title">
        <div className="panel-header">
          <h2 id="ex-rate-grid-title" className="panel-title">
            {t('exRate.gridTitle')}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[720px]">
            <thead>
              <tr>
                <th>{t('exRate.rateType')}</th>
                <th>{t('exRate.pair')}</th>
                <th>{t('exRate.validFrom')}</th>
                <th>{t('exRate.rate')}</th>
                <th>{t('exRate.ratio')}</th>
                <th>{t('exRate.effectiveRate')}</th>
                {canMaintain && <th>{t('exRate.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.rateType}-${row.fromCurrency}-${row.toCurrency}-${row.validFrom}`}>
                  <td>{t(`exRate.type.${row.rateType}`)}</td>
                  <td className="code">
                    {row.fromCurrency} → {row.toCurrency}
                  </td>
                  <td className="code">{row.validFrom}</td>
                  <td className="code">{row.rate}</td>
                  <td className="code">{row.ratioFrom} : {row.ratioTo}</td>
                  <td className="code">{row.effectiveRate}</td>
                  {canMaintain && (
                    <td>
                      <RowDialogs row={row} />
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={canMaintain ? 7 : 6} className="px-4 py-8 text-center text-sm text-ink-soft">
                    {t('exRate.empty')}
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
