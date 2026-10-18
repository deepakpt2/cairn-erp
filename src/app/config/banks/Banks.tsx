'use client';

import { useActionState } from 'react';

import { t } from '@/platform/i18n';
import type { BankCountryChoice, BankRow } from '@/modules/foundation/bank-master';
import {
  deleteBankAction,
  saveBankAction,
  type BankActionState,
} from './actions';

function DialogHeader({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
      <div>
        <span className="code text-xs text-ink-faint">FI01 · {sub}</span>
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
function BankMessage({ state }: { state: BankActionState }) {
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

function CreatePanel({ countries }: { countries: BankCountryChoice[] }) {
  const [state, formAction, pending] = useActionState<BankActionState, FormData>(
    saveBankAction,
    { ok: true },
  );

  return (
    <section className="panel overflow-hidden" aria-labelledby="bank-create-title">
      <div className="panel-header">
        <h2 id="bank-create-title" className="panel-title">{t('bank.newTitle')}</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="bank-country" className="field-label">
              {t('bank.country')}<RequiredMark />
            </label>
            <select id="bank-country" name="bankCountry" className="field-input" defaultValue="">
              <option value="">{t('bank.chooseCountry')}</option>
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.code} — {country.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bank-key" className="field-label">
              {t('bank.key')}<RequiredMark />
            </label>
            <input id="bank-key" name="bankKey" className="field-input code" maxLength={15} placeholder="012345678" required />
            <p className="mt-1 text-xs text-ink-soft">{t('bank.keyHint')}</p>
          </div>
          <div>
            <label htmlFor="bank-name" className="field-label">
              {t('bank.name')}<RequiredMark />
            </label>
            <input id="bank-name" name="name" className="field-input" maxLength={60} placeholder={t('bank.namePlaceholder')} required />
          </div>
          <div>
            <label htmlFor="bank-city" className="field-label">{t('bank.city')}</label>
            <input id="bank-city" name="city" className="field-input" maxLength={35} />
          </div>
          <div>
            <label htmlFor="bank-swift" className="field-label">{t('bank.swift')}</label>
            <input id="bank-swift" name="swift" className="field-input code" maxLength={11} placeholder="NBOKKWKW" />
            <p className="mt-1 text-xs text-ink-soft">{t('bank.swiftHint')}</p>
          </div>
        </div>
        <BankMessage state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          {t('bank.create')}
        </button>
      </form>
    </section>
  );
}

/**
 * Change and delete, one dialog each per row. A bank's key — country and key —
 * cannot be edited in place: renaming it means defining the new bank and, where
 * the old one should not stand, deleting it. The Change dialog therefore offers
 * only the name, city and SWIFT code. The Delete dialog states the usage rule
 * before it offers anything: a bank stands while any tenant's house bank names
 * it, and the service enforces what the words say.
 */
function RowDialogs({ row }: { row: BankRow }) {
  const [changeState, changeAction, changePending] = useActionState<BankActionState, FormData>(
    saveBankAction,
    { ok: true },
  );
  const [deleteState, deleteAction, deletePending] = useActionState<BankActionState, FormData>(
    deleteBankAction,
    { ok: true },
  );
  const keyText = `${row.bankCountry} · ${row.bankKey}`;
  const idKey = `${row.bankCountry}-${row.bankKey}`;
  const changeLabel = `${t('bank.change')} ${row.bankKey}`;

  return (
    <div className="flex gap-3">
      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
          {t('bank.change')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={changeLabel} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={changeLabel} sub={keyText} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3" action={changeAction}>
                <input type="hidden" name="mode" value="CHANGE" />
                <input type="hidden" name="bankCountry" value={row.bankCountry} />
                <input type="hidden" name="bankKey" value={row.bankKey} />
                <div>
                  <label htmlFor={`bank-name-${idKey}`} className="field-label">
                    {t('bank.name')}<RequiredMark />
                  </label>
                  <input id={`bank-name-${idKey}`} name="name" className="field-input" maxLength={60} defaultValue={row.name} required />
                </div>
                <div>
                  <label htmlFor={`bank-city-${idKey}`} className="field-label">{t('bank.city')}</label>
                  <input id={`bank-city-${idKey}`} name="city" className="field-input" maxLength={35} defaultValue={row.city ?? ''} />
                </div>
                <div>
                  <label htmlFor={`bank-swift-${idKey}`} className="field-label">{t('bank.swift')}</label>
                  <input id={`bank-swift-${idKey}`} name="swift" className="field-input code" maxLength={11} defaultValue={row.swift ?? ''} />
                </div>
                <BankMessage state={changeState} />
                <button type="submit" className="btn-primary" disabled={changePending}>
                  {t('bank.save')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>

      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-signal-error hover:underline sm:min-h-9">
          {t('bank.delete')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('bank.delete')} ${row.bankKey}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={t('bank.delete')} sub={keyText} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3" action={deleteAction}>
                <input type="hidden" name="bankCountry" value={row.bankCountry} />
                <input type="hidden" name="bankKey" value={row.bankKey} />
                <p className="text-sm text-ink-soft">{t('bank.deleteNote')}</p>
                <BankMessage state={deleteState} />
                <button type="submit" className="btn-primary" disabled={deletePending}>
                  {t('bank.delete')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>
    </div>
  );
}

export function Banks({
  banks,
  countries,
  canMaintain,
}: {
  banks: BankRow[];
  countries: BankCountryChoice[];
  canMaintain: boolean;
}) {
  return (
    <>
      {canMaintain && <CreatePanel countries={countries} />}
      <section className="panel overflow-hidden" aria-labelledby="bank-grid-title">
        <div className="panel-header">
          <h2 id="bank-grid-title" className="panel-title">
            {t('bank.gridTitle')}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[45rem]">
            <thead>
              <tr>
                <th>{t('bank.country')}</th>
                <th>{t('bank.key')}</th>
                <th>{t('bank.name')}</th>
                <th>{t('bank.city')}</th>
                <th>{t('bank.swift')}</th>
                {canMaintain && <th>{t('bank.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {banks.length === 0 ? (
                <tr>
                  <td colSpan={canMaintain ? 6 : 5} className="text-ink-soft">
                    {t('bank.empty')}
                  </td>
                </tr>
              ) : (
                banks.map((row) => (
                  <tr key={`${row.bankCountry}/${row.bankKey}`}>
                    <td><span className="code">{row.bankCountry}</span></td>
                    <td><span className="code">{row.bankKey}</span></td>
                    <td>{row.name}</td>
                    <td>{row.city ?? '—'}</td>
                    <td><span className="code">{row.swift ?? '—'}</span></td>
                    {canMaintain && (
                      <td>
                        <RowDialogs row={row} />
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
