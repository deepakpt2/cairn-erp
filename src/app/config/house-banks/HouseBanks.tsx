'use client';

import { useState } from 'react';

import { t } from '@/platform/i18n';
import type {
  BankChoice,
  CompanyChoice,
  HouseBankRow,
} from '@/modules/foundation/house-bank-definition';

function DialogHeader({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
      <div>
        <span className="code text-xs text-ink-faint">FI12 · {sub}</span>
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

function ReasonField({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {t('houseBank.reason')}<RequiredMark />
      </label>
      <textarea id={id} name="reason" className="field-input" rows={2} maxLength={500} disabled />
    </div>
  );
}

function InertNote() {
  return (
    <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
      {t('houseBank.inert')}
    </p>
  );
}

function BankSelect({ id, name, banks }: { id: string; name: string; banks: BankChoice[] }) {
  return (
    <select id={id} name={name} className="field-input" defaultValue="" disabled>
      <option value="">{t('houseBank.chooseBank')}</option>
      {banks.map((bank) => (
        <option key={`${bank.bankCountry}/${bank.bankKey}`} value={`${bank.bankCountry}/${bank.bankKey}`}>
          {bank.bankCountry} · {bank.bankKey} — {bank.name}
        </option>
      ))}
    </select>
  );
}

/**
 * The stage-1 shape of the screen (SCR-037): every form renders the fields its
 * write will be judged against, disabled, with the inert note where a save
 * answer would stand. The tables arrive in stage 2 and the writes in stage 3;
 * nothing here pretends otherwise.
 */
export function HouseBanks({
  houseBanks,
  companies,
  banks,
  canMaintain,
}: {
  houseBanks: HouseBankRow[];
  companies: CompanyChoice[];
  banks: BankChoice[];
  canMaintain: boolean;
}) {
  const [company, setCompany] = useState(companies[0]?.companyCode ?? '');
  const [selectedHouse, setSelectedHouse] = useState<string | null>(null);

  const rows = houseBanks.filter((row) => row.companyCode === company);
  const selected = rows.find((row) => `${row.companyCode}/${row.houseBankKey}` === selectedHouse) ?? null;

  return (
    <div className="space-y-4">
      {canMaintain && (
        <section className="panel overflow-hidden" aria-labelledby="house-bank-create-title">
          <div className="panel-header">
            <h2 id="house-bank-create-title" className="panel-title">{t('houseBank.newTitle')}</h2>
          </div>
          <form className="space-y-3 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="house-bank-company" className="field-label">
                  {t('houseBank.company')}<RequiredMark />
                </label>
                <select
                  id="house-bank-company"
                  name="companyCode"
                  className="field-input"
                  value={company}
                  onChange={(event) => setCompany(event.target.value)}
                >
                  {companies.map((choice) => (
                    <option key={choice.companyCode} value={choice.companyCode}>
                      {choice.companyCode} — {choice.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="house-bank-key" className="field-label">
                  {t('houseBank.key')}<RequiredMark />
                </label>
                <input id="house-bank-key" name="houseBankKey" className="field-input code" maxLength={5} placeholder="NBK01" disabled />
                <p className="mt-1 text-xs text-ink-soft">{t('houseBank.keyHint')}</p>
              </div>
              <div>
                <label htmlFor="house-bank-bank" className="field-label">
                  {t('houseBank.bank')}<RequiredMark />
                </label>
                <BankSelect id="house-bank-bank" name="bank" banks={banks} />
                <p className="mt-1 text-xs text-ink-soft">{t('houseBank.bankHint')}</p>
              </div>
            </div>
            <ReasonField id="house-bank-reason" />
            <InertNote />
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
              {t('houseBank.create')}
            </button>
          </form>
        </section>
      )}

      <section className="panel overflow-hidden" aria-labelledby="house-bank-grid-title">
        <div className="panel-header">
          <h2 id="house-bank-grid-title" className="panel-title">{t('houseBank.gridTitle')}</h2>
        </div>
        {!canMaintain && (
          <div className="p-4 pb-0">
            <label htmlFor="house-bank-company-view" className="field-label">{t('houseBank.company')}</label>
            <select
              id="house-bank-company-view"
              className="field-input max-w-sm"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
            >
              {companies.map((choice) => (
                <option key={choice.companyCode} value={choice.companyCode}>
                  {choice.companyCode} — {choice.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[820px]">
            <thead>
              <tr>
                <th>{t('houseBank.key')}</th>
                <th>{t('houseBank.bank')}</th>
                <th>{t('houseBank.bankName')}</th>
                <th>{t('houseBank.city')}</th>
                <th>{t('houseBank.swift')}</th>
                <th>{t('houseBank.accounts')}</th>
                {canMaintain && <th>{t('houseBank.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={canMaintain ? 7 : 6} className="text-ink-soft">
                    {t('houseBank.empty')}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={`${row.companyCode}/${row.houseBankKey}`}>
                    <td><span className="code">{row.houseBankKey}</span></td>
                    <td><span className="code">{row.bankCountry} · {row.bankKey}</span></td>
                    <td>{row.bankName}</td>
                    <td>{row.bankCity ?? '—'}</td>
                    <td><span className="code">{row.bankSwift ?? '—'}</span></td>
                    <td>
                      <button
                        type="button"
                        className="text-sm font-medium text-accent hover:underline"
                        onClick={() => setSelectedHouse(`${row.companyCode}/${row.houseBankKey}`)}
                      >
                        {t('houseBank.accountsCount', { count: String(row.accounts.length) })}
                      </button>
                    </td>
                    {canMaintain && (
                      <td>
                        <RowDialogs row={row} banks={banks} />
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel overflow-hidden" aria-labelledby="house-bank-accounts-title">
        <div className="panel-header">
          <h2 id="house-bank-accounts-title" className="panel-title">
            {selected
              ? t('houseBank.accountsFor', { key: selected.houseBankKey, company: selected.companyCode })
              : t('houseBank.accountsTitle')}
          </h2>
        </div>
        {selected ? (
          <AccountsPanel row={selected} canMaintain={canMaintain} />
        ) : (
          <p className="p-4 text-sm text-ink-soft">{t('houseBank.selectHouseBank')}</p>
        )}
      </section>
    </div>
  );
}

function AccountsPanel({ row, canMaintain }: { row: HouseBankRow; canMaintain: boolean }) {
  return (
    <div className="space-y-4 p-4">
      <div className="overflow-x-auto">
        <table className="grid-table min-w-[720px]">
          <thead>
            <tr>
              <th>{t('houseBank.accountId')}</th>
              <th>{t('houseBank.accountNumber')}</th>
              <th>{t('houseBank.iban')}</th>
              <th>{t('houseBank.currency')}</th>
              <th>{t('houseBank.glAccount')}</th>
              {canMaintain && <th>{t('houseBank.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {row.accounts.length === 0 ? (
              <tr>
                <td colSpan={canMaintain ? 6 : 5} className="text-ink-soft">
                  {t('houseBank.emptyAccounts')}
                </td>
              </tr>
            ) : (
              row.accounts.map((account) => (
                <tr key={account.accountId}>
                  <td><span className="code">{account.accountId}</span></td>
                  <td><span className="code">{account.accountNumber}</span></td>
                  <td><span className="code">{account.iban ?? '—'}</span></td>
                  <td><span className="code">{account.currency}</span></td>
                  <td><span className="code">{account.glAccount}</span></td>
                  {canMaintain && (
                    <td>
                      <AccountDialogs row={row} accountId={account.accountId} />
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {canMaintain && (
        <form className="space-y-3 border border-line p-4">
          <h3 className="text-sm font-semibold">{t('houseBank.accountNew')}</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="bank-account-id" className="field-label">
                {t('houseBank.accountId')}<RequiredMark />
              </label>
              <input id="bank-account-id" name="accountId" className="field-input code" maxLength={5} placeholder="ACC01" disabled />
            </div>
            <div>
              <label htmlFor="bank-account-number" className="field-label">
                {t('houseBank.accountNumber')}<RequiredMark />
              </label>
              <input id="bank-account-number" name="accountNumber" className="field-input code" maxLength={18} disabled />
            </div>
            <div>
              <label htmlFor="bank-account-iban" className="field-label">{t('houseBank.iban')}</label>
              <input id="bank-account-iban" name="iban" className="field-input code" maxLength={34} placeholder="KW81CBKU…" disabled />
              <p className="mt-1 text-xs text-ink-soft">{t('houseBank.ibanHint')}</p>
            </div>
            <div>
              <label htmlFor="bank-account-currency" className="field-label">
                {t('houseBank.currency')}<RequiredMark />
              </label>
              <input id="bank-account-currency" name="currency" className="field-input code" maxLength={5} placeholder="KWD" disabled />
            </div>
            <div>
              <label htmlFor="bank-account-gl" className="field-label">
                {t('houseBank.glAccount')}<RequiredMark />
              </label>
              <input id="bank-account-gl" name="glAccount" className="field-input code" maxLength={10} placeholder="113100" disabled />
              <p className="mt-1 text-xs text-ink-soft">{t('houseBank.glHint')}</p>
            </div>
          </div>
          <ReasonField id="bank-account-reason" />
          <InertNote />
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
            {t('houseBank.createAccount')}
          </button>
        </form>
      )}
    </div>
  );
}

function RowDialogs({ row, banks }: { row: HouseBankRow; banks: BankChoice[] }) {
  const keyText = `${row.companyCode} · ${row.houseBankKey}`;
  const idKey = `${row.companyCode}-${row.houseBankKey}`;
  const changeLabel = `${t('houseBank.change')} ${row.houseBankKey}`;

  return (
    <div className="flex gap-3">
      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
          {t('houseBank.change')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={changeLabel} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={changeLabel} sub={keyText} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3">
                <div>
                  <label htmlFor={`house-bank-change-bank-${idKey}`} className="field-label">
                    {t('houseBank.bank')}<RequiredMark />
                  </label>
                  <BankSelect id={`house-bank-change-bank-${idKey}`} name="bank" banks={banks} />
                </div>
                <ReasonField id={`house-bank-change-reason-${idKey}`} />
                <InertNote />
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
                  {t('houseBank.save')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>

      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-signal-error hover:underline sm:min-h-9">
          {t('houseBank.delete')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('houseBank.delete')} ${row.houseBankKey}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={t('houseBank.delete')} sub={keyText} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3">
                <p className="text-sm text-ink-soft">{t('houseBank.deleteNote')}</p>
                <ReasonField id={`house-bank-delete-reason-${idKey}`} />
                <InertNote />
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
                  {t('houseBank.delete')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>
    </div>
  );
}

function AccountDialogs({ row, accountId }: { row: HouseBankRow; accountId: string }) {
  const account = row.accounts.find((entry) => entry.accountId === accountId);
  if (!account) return null;
  const keyText = `${row.houseBankKey} · ${account.accountId}`;
  const idKey = `${row.companyCode}-${row.houseBankKey}-${account.accountId}`;
  const changeLabel = `${t('houseBank.change')} ${account.accountId}`;

  return (
    <div className="flex gap-3">
      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
          {t('houseBank.change')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={changeLabel} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={changeLabel} sub={keyText} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3">
                <div>
                  <label htmlFor={`bank-account-number-${idKey}`} className="field-label">
                    {t('houseBank.accountNumber')}<RequiredMark />
                  </label>
                  <input id={`bank-account-number-${idKey}`} name="accountNumber" className="field-input code" maxLength={18} defaultValue={account.accountNumber} disabled />
                </div>
                <div>
                  <label htmlFor={`bank-account-iban-${idKey}`} className="field-label">{t('houseBank.iban')}</label>
                  <input id={`bank-account-iban-${idKey}`} name="iban" className="field-input code" maxLength={34} defaultValue={account.iban ?? ''} disabled />
                </div>
                <div>
                  <label htmlFor={`bank-account-currency-${idKey}`} className="field-label">
                    {t('houseBank.currency')}<RequiredMark />
                  </label>
                  <input id={`bank-account-currency-${idKey}`} name="currency" className="field-input code" maxLength={5} defaultValue={account.currency} disabled />
                </div>
                <div>
                  <label htmlFor={`bank-account-gl-${idKey}`} className="field-label">
                    {t('houseBank.glAccount')}<RequiredMark />
                  </label>
                  <input id={`bank-account-gl-${idKey}`} name="glAccount" className="field-input code" maxLength={10} defaultValue={account.glAccount} disabled />
                </div>
                <ReasonField id={`bank-account-change-reason-${idKey}`} />
                <InertNote />
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
                  {t('houseBank.saveAccount')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>

      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-signal-error hover:underline sm:min-h-9">
          {t('houseBank.delete')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('houseBank.delete')} ${account.accountId}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={t('houseBank.delete')} sub={keyText} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3">
                <p className="text-sm text-ink-soft">{t('houseBank.deleteAccountNote')}</p>
                <ReasonField id={`bank-account-delete-reason-${idKey}`} />
                <InertNote />
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
                  {t('houseBank.delete')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>
    </div>
  );
}
