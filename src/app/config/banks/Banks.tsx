'use client';

import { useState } from 'react';

import { t } from '@/platform/i18n';
import type { BankCountryChoice, BankRow } from '@/modules/foundation/bank-master';

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
        {t('bank.reason')}<RequiredMark />
      </label>
      <textarea
        id={id}
        name="reason"
        className="field-input"
        rows={2}
        maxLength={500}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled
      />
    </div>
  );
}

/**
 * The stage-1 shape of the screen (SCR-036): every form renders the fields its
 * write will be judged against, disabled, with the inert note where a save answer
 * would stand. The table arrives in stage 2 and the write in stage 3; nothing
 * here pretends otherwise.
 */
export function Banks({ banks, countries }: { banks: BankRow[]; countries: BankCountryChoice[] }) {
  const [reason, setReason] = useState('');

  return (
    <div className="space-y-4">
      <section className="panel overflow-hidden" aria-labelledby="bank-create-title">
        <div className="panel-header">
          <h2 id="bank-create-title" className="panel-title">{t('bank.newTitle')}</h2>
        </div>
        <form className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="bank-country" className="field-label">
                {t('bank.country')}<RequiredMark />
              </label>
              <select id="bank-country" name="bankCountry" className="field-input" defaultValue="" disabled>
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
              <input id="bank-key" name="bankKey" className="field-input code" maxLength={15} placeholder="012345678" disabled />
              <p className="mt-1 text-xs text-ink-soft">{t('bank.keyHint')}</p>
            </div>
            <div>
              <label htmlFor="bank-name" className="field-label">
                {t('bank.name')}<RequiredMark />
              </label>
              <input id="bank-name" name="name" className="field-input" maxLength={60} placeholder={t('bank.namePlaceholder')} disabled />
            </div>
            <div>
              <label htmlFor="bank-city" className="field-label">{t('bank.city')}</label>
              <input id="bank-city" name="city" className="field-input" maxLength={35} disabled />
            </div>
            <div>
              <label htmlFor="bank-swift" className="field-label">{t('bank.swift')}</label>
              <input id="bank-swift" name="swift" className="field-input code" maxLength={11} placeholder="NBOKKWKW" disabled />
              <p className="mt-1 text-xs text-ink-soft">{t('bank.swiftHint')}</p>
            </div>
          </div>
          <ReasonField id="bank-reason" value={reason} onChange={setReason} />
          <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
            {t('bank.inert')}
          </p>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
            {t('bank.create')}
          </button>
        </form>
      </section>

      <section className="panel overflow-hidden" aria-labelledby="bank-grid-title">
        <div className="panel-header">
          <h2 id="bank-grid-title" className="panel-title">{t('bank.gridTitle')}</h2>
        </div>
        {banks.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">{t('bank.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-soft">
                  <th className="p-3 font-medium">{t('bank.country')}</th>
                  <th className="p-3 font-medium">{t('bank.key')}</th>
                  <th className="p-3 font-medium">{t('bank.name')}</th>
                  <th className="p-3 font-medium">{t('bank.city')}</th>
                  <th className="p-3 font-medium">{t('bank.swift')}</th>
                  <th className="p-3 font-medium">{t('bank.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {banks.map((bank) => (
                  <tr key={`${bank.bankCountry}/${bank.bankKey}`} className="border-b border-line">
                    <td className="p-3"><span className="code">{bank.bankCountry}</span></td>
                    <td className="p-3"><span className="code">{bank.bankKey}</span></td>
                    <td className="p-3">{bank.name}</td>
                    <td className="p-3">{bank.city ?? '—'}</td>
                    <td className="p-3"><span className="code">{bank.swift ?? '—'}</span></td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        <BankChangeDialog bank={bank} />
                        <BankDeleteDialog bank={bank} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function BankChangeDialog({ bank }: { bank: BankRow }) {
  const suffix = `${bank.bankCountry}-${bank.bankKey}`;
  const [reason, setReason] = useState('');
  const changeLabel = `${t('bank.change')} ${bank.bankKey}`;
  return (
    <details className="min-w-16">
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
        {t('bank.change')}
      </summary>
      <div role="dialog" aria-modal="true" aria-label={changeLabel} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
        <div className="mx-auto max-w-2xl">
          <DialogHeader label={changeLabel} sub={`${bank.bankCountry} · ${bank.bankKey}`} />
          <section className="panel overflow-hidden p-4">
            <form className="space-y-3">
              <div>
                <label htmlFor={`bank-name-${suffix}`} className="field-label">
                  {t('bank.name')}<RequiredMark />
                </label>
                <input id={`bank-name-${suffix}`} name="name" className="field-input" maxLength={60} defaultValue={bank.name} disabled />
              </div>
              <div>
                <label htmlFor={`bank-city-${suffix}`} className="field-label">{t('bank.city')}</label>
                <input id={`bank-city-${suffix}`} name="city" className="field-input" maxLength={35} defaultValue={bank.city ?? ''} disabled />
              </div>
              <div>
                <label htmlFor={`bank-swift-${suffix}`} className="field-label">{t('bank.swift')}</label>
                <input id={`bank-swift-${suffix}`} name="swift" className="field-input code" maxLength={11} defaultValue={bank.swift ?? ''} disabled />
              </div>
              <ReasonField id={`bank-change-reason-${suffix}`} value={reason} onChange={setReason} />
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
                {t('bank.save')}
              </button>
            </form>
          </section>
        </div>
      </div>
    </details>
  );
}

function BankDeleteDialog({ bank }: { bank: BankRow }) {
  const suffix = `${bank.bankCountry}-${bank.bankKey}`;
  const [reason, setReason] = useState('');
  const deleteLabel = `${t('bank.delete')} ${bank.bankKey}`;
  return (
    <details className="min-w-16">
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
        {t('bank.delete')}
      </summary>
      <div role="dialog" aria-modal="true" aria-label={deleteLabel} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
        <div className="mx-auto max-w-2xl">
          <DialogHeader label={deleteLabel} sub={`${bank.bankCountry} · ${bank.bankKey}`} />
          <section className="panel overflow-hidden p-4">
            <p className="text-sm text-ink-soft">{t('bank.deleteNote')}</p>
            <form className="mt-3 space-y-3">
              <ReasonField id={`bank-delete-reason-${suffix}`} value={reason} onChange={setReason} />
              <button type="submit" className="btn btn-danger min-h-11 sm:min-h-9" disabled>
                {t('bank.delete')}
              </button>
            </form>
          </section>
        </div>
      </div>
    </details>
  );
}
