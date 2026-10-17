'use client';

import { useState, type FormEvent } from 'react';

import { t } from '@/platform/i18n';
import type {
  CurrencyChoice,
  ExchangeRateRow,
} from '@/modules/foundation/exchange-rate-maintenance';

/**
 * The write path arrives with the service (SCR-034 stage 3). An inert form says so
 * rather than pretending: a button that silently does nothing teaches an operator
 * that the screen is broken. Same pattern as the OBBO and OBBP screens' first stages.
 */
function inertSubmit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  window.alert(t('exRate.inert'));
}

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

function RateTypeSelect({
  id,
  value,
  rateTypes,
  onChange,
}: {
  id: string;
  value: string;
  rateTypes: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      id={id}
      name="rateType"
      className="field-input"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {rateTypes.map((type) => (
        <option key={type} value={type}>
          {t(`exRate.type.${type}`)}
        </option>
      ))}
    </select>
  );
}

function CurrencySelect({
  id,
  name,
  value,
  currencies,
  onChange,
}: {
  id: string;
  name: string;
  value: string;
  currencies: CurrencyChoice[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      id={id}
      name={name}
      className="field-input code"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{t('exRate.chooseCurrency')}</option>
      {currencies.map((currency) => (
        <option key={currency.code} value={currency.code}>
          {currency.code} — {currency.name}
        </option>
      ))}
    </select>
  );
}

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function CreatePanel({ currencies, rateTypes }: { currencies: CurrencyChoice[]; rateTypes: readonly string[] }) {
  const [rateType, setRateType] = useState<string>('AVERAGE');
  const [fromCurrency, setFromCurrency] = useState('');
  const [toCurrency, setToCurrency] = useState('');
  const [reason, setReason] = useState('');
  const samePair = fromCurrency !== '' && fromCurrency === toCurrency;
  const canSave = Boolean(reason.trim()) && !samePair && fromCurrency !== '' && toCurrency !== '';

  return (
    <section className="panel overflow-hidden" aria-labelledby="ex-rate-create-title">
      <div className="panel-header">
        <h2 id="ex-rate-create-title" className="panel-title">{t('exRate.newTitle')}</h2>
      </div>
      <form className="space-y-3 p-4" onSubmit={inertSubmit}>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="ex-rate-type" className="field-label">
              {t('exRate.rateType')}<RequiredMark />
            </label>
            <RateTypeSelect id="ex-rate-type" value={rateType} rateTypes={rateTypes} onChange={setRateType} />
          </div>
          <div>
            <label htmlFor="ex-rate-from" className="field-label">
              {t('exRate.fromCurrency')}<RequiredMark />
            </label>
            <CurrencySelect id="ex-rate-from" name="fromCurrency" value={fromCurrency} currencies={currencies} onChange={setFromCurrency} />
          </div>
          <div>
            <label htmlFor="ex-rate-to" className="field-label">
              {t('exRate.toCurrency')}<RequiredMark />
            </label>
            <CurrencySelect id="ex-rate-to" name="toCurrency" value={toCurrency} currencies={currencies} onChange={setToCurrency} />
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
 * rate and its ratios, which is the correction the package allows before period locking.
 */
function RowDialogs({ row }: { row: ExchangeRateRow }) {
  const [reason, setReason] = useState('');
  const keyText = `${row.rateType} · ${row.fromCurrency} → ${row.toCurrency} · ${row.validFrom}`;
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
              <form className="space-y-3" onSubmit={inertSubmit}>
                <input type="hidden" name="rateType" value={row.rateType} />
                <input type="hidden" name="fromCurrency" value={row.fromCurrency} />
                <input type="hidden" name="toCurrency" value={row.toCurrency} />
                <input type="hidden" name="validFrom" value={row.validFrom} />
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
                    <input id={`ex-rate-ratio-from-${idKey}`} name="ratioFrom" type="number" min={1} step={1} defaultValue={1} className="field-input code" />
                  </div>
                  <div>
                    <label htmlFor={`ex-rate-ratio-to-${idKey}`} className="field-label">{t('exRate.ratioTo')}</label>
                    <input id={`ex-rate-ratio-to-${idKey}`} name="ratioTo" type="number" min={1} step={1} defaultValue={1} className="field-input code" />
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
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
                <button type="submit" className="btn-primary" disabled={!reason.trim()}>
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
              <form className="space-y-3" onSubmit={inertSubmit}>
                <input type="hidden" name="rateType" value={row.rateType} />
                <input type="hidden" name="fromCurrency" value={row.fromCurrency} />
                <input type="hidden" name="toCurrency" value={row.toCurrency} />
                <input type="hidden" name="validFrom" value={row.validFrom} />
                <p className="text-sm text-ink-soft">{t('exRate.deleteNote')}</p>
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
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
                <button type="submit" className="btn-primary" disabled={!reason.trim()}>
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
                  {canMaintain && (
                    <td>
                      <RowDialogs row={row} />
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={canMaintain ? 5 : 4} className="px-4 py-8 text-center text-sm text-ink-soft">
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
