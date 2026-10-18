'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import type {
  BankAccountRow,
  BankChoice,
  CompanyChoice,
  CurrencyChoice,
  GlAccountChoice,
  HouseBankRow,
} from '@/modules/foundation/house-bank-definition';
import {
  deleteBankAccountAction,
  deleteHouseBankAction,
  saveBankAccountAction,
  saveHouseBankAction,
  type HouseBankActionState,
} from './actions';

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

/** The action's answer, refusal or confirmation, with the remedy underneath it. */
function HouseMessage({ state }: { state: HouseBankActionState }) {
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
        {t('houseBank.reason')}<RequiredMark />
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

function BankSelect({
  id,
  banks,
  defaultValue,
}: {
  id: string;
  banks: BankChoice[];
  defaultValue?: string;
}) {
  return (
    <select id={id} name="bank" className="field-input" defaultValue={defaultValue ?? ''}>
      <option value="">{t('houseBank.chooseBank')}</option>
      {banks.map((bank) => (
        <option key={`${bank.bankCountry}/${bank.bankKey}`} value={`${bank.bankCountry}/${bank.bankKey}`}>
          {bank.bankCountry} · {bank.bankKey} — {bank.name}
        </option>
      ))}
    </select>
  );
}

function CreatePanel({
  companies,
  banks,
  company,
  setCompany,
}: {
  companies: CompanyChoice[];
  banks: BankChoice[];
  company: string;
  setCompany: (value: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<HouseBankActionState, FormData>(
    saveHouseBankAction,
    { ok: true },
  );

  return (
    <section className="panel overflow-hidden" aria-labelledby="house-bank-create-title">
      <div className="panel-header">
        <h2 id="house-bank-create-title" className="panel-title">{t('houseBank.newTitle')}</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
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
            <input id="house-bank-key" name="houseBankKey" className="field-input code" maxLength={5} placeholder="NBK01" required />
            <p className="mt-1 text-xs text-ink-soft">{t('houseBank.keyHint')}</p>
          </div>
          <div>
            <label htmlFor="house-bank-bank" className="field-label">
              {t('houseBank.bank')}<RequiredMark />
            </label>
            <BankSelect id="house-bank-bank" banks={banks} />
            <p className="mt-1 text-xs text-ink-soft">{t('houseBank.bankHint')}</p>
          </div>
        </div>
        <ReasonField id="house-bank-reason" value={reason} onChange={setReason} />
        <HouseMessage state={state} />
        <button type="submit" className="btn-primary" disabled={pending || !reason.trim()}>
          {t('houseBank.create')}
        </button>
      </form>
    </section>
  );
}

/**
 * Change and delete for a house bank. Its key cannot be edited in place: the
 * Change dialog offers only the bank reference, which the master may have
 * corrected since. The Delete dialog states the structural rule where the
 * button is: the accounts under it go first, and the count standing is why.
 */
function RowDialogs({ row, banks }: { row: HouseBankRow; banks: BankChoice[] }) {
  const [changeReason, setChangeReason] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [changeState, changeAction, changePending] = useActionState<HouseBankActionState, FormData>(
    saveHouseBankAction,
    { ok: true },
  );
  const [deleteState, deleteAction, deletePending] = useActionState<HouseBankActionState, FormData>(
    deleteHouseBankAction,
    { ok: true },
  );
  const keyText = `${row.companyCode} · ${row.houseBankKey}`;
  const idKey = `${row.companyCode}-${row.houseBankKey}`;
  const changeLabel = `${t('houseBank.change')} ${row.houseBankKey}`;
  const blocked = row.accounts.length > 0;

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
              <form className="space-y-3" action={changeAction}>
                <input type="hidden" name="mode" value="CHANGE" />
                <input type="hidden" name="companyCode" value={row.companyCode} />
                <input type="hidden" name="houseBankKey" value={row.houseBankKey} />
                <div>
                  <label htmlFor={`house-bank-change-bank-${idKey}`} className="field-label">
                    {t('houseBank.bank')}<RequiredMark />
                  </label>
                  <BankSelect
                    id={`house-bank-change-bank-${idKey}`}
                    banks={banks}
                    defaultValue={`${row.bankCountry}/${row.bankKey}`}
                  />
                </div>
                <ReasonField id={`house-bank-change-reason-${idKey}`} value={changeReason} onChange={setChangeReason} />
                <HouseMessage state={changeState} />
                <button type="submit" className="btn-primary" disabled={changePending || !changeReason.trim()}>
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
              <form className="space-y-3" action={deleteAction}>
                <input type="hidden" name="companyCode" value={row.companyCode} />
                <input type="hidden" name="houseBankKey" value={row.houseBankKey} />
                {blocked ? (
                  <p role="alert" className="text-sm text-signal-error">
                    {t('houseBank.deleteBlocked', { count: String(row.accounts.length) })}
                  </p>
                ) : (
                  <p className="text-sm text-ink-soft">{t('houseBank.deleteNote')}</p>
                )}
                <ReasonField id={`house-bank-delete-reason-${idKey}`} value={deleteReason} onChange={setDeleteReason} />
                <HouseMessage state={deleteState} />
                <button type="submit" className="btn-primary" disabled={deletePending || blocked || !deleteReason.trim()}>
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

/**
 * Change and delete for one bank account. Its ID cannot be edited in place;
 * the number, IBAN, currency and G/L mapping can, with the G/L offered from
 * the asset balance-sheet accounts of the company code's chart.
 */
function AccountDialogs({
  row,
  account,
  glAccounts,
  currencies,
}: {
  row: HouseBankRow;
  account: BankAccountRow;
  glAccounts: GlAccountChoice[];
  currencies: CurrencyChoice[];
}) {
  const [changeReason, setChangeReason] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [changeState, changeAction, changePending] = useActionState<HouseBankActionState, FormData>(
    saveBankAccountAction,
    { ok: true },
  );
  const [deleteState, deleteAction, deletePending] = useActionState<HouseBankActionState, FormData>(
    deleteBankAccountAction,
    { ok: true },
  );
  const keyText = `${row.houseBankKey} · ${account.accountId}`;
  const idKey = `${row.companyCode}-${row.houseBankKey}-${account.accountId}`;
  const changeLabel = `${t('houseBank.change')} ${account.accountId}`;

  const accountFields = (suffix: string, defaults: BankAccountRow | null) => (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`bank-account-number-${suffix}`} className="field-label">
            {t('houseBank.accountNumber')}<RequiredMark />
          </label>
          <input id={`bank-account-number-${suffix}`} name="accountNumber" className="field-input code" maxLength={18} defaultValue={defaults?.accountNumber ?? ''} required />
        </div>
        <div>
          <label htmlFor={`bank-account-iban-${suffix}`} className="field-label">{t('houseBank.iban')}</label>
          <input id={`bank-account-iban-${suffix}`} name="iban" className="field-input code" maxLength={34} defaultValue={defaults?.iban ?? ''} placeholder="KW81CBKU…" />
        </div>
        <div>
          <label htmlFor={`bank-account-currency-${suffix}`} className="field-label">
            {t('houseBank.currency')}<RequiredMark />
          </label>
          <select id={`bank-account-currency-${suffix}`} name="currency" className="field-input" defaultValue={defaults?.currency ?? ''}>
            <option value="">{t('houseBank.chooseCurrency')}</option>
            {currencies.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code} — {currency.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`bank-account-gl-${suffix}`} className="field-label">
            {t('houseBank.glAccount')}<RequiredMark />
          </label>
          <select id={`bank-account-gl-${suffix}`} name="glAccount" className="field-input" defaultValue={defaults?.glAccount ?? ''}>
            <option value="">{t('houseBank.chooseGlAccount')}</option>
            {glAccounts.map((gl) => (
              <option key={gl.accountNumber} value={gl.accountNumber}>
                {gl.accountNumber} — {gl.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-soft">{t('houseBank.glHint')}</p>
        </div>
      </div>
    </>
  );

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
              <form className="space-y-3" action={changeAction}>
                <input type="hidden" name="mode" value="CHANGE" />
                <input type="hidden" name="companyCode" value={row.companyCode} />
                <input type="hidden" name="houseBankKey" value={row.houseBankKey} />
                <input type="hidden" name="accountId" value={account.accountId} />
                {accountFields(idKey, account)}
                <ReasonField id={`bank-account-change-reason-${idKey}`} value={changeReason} onChange={setChangeReason} />
                <HouseMessage state={changeState} />
                <button type="submit" className="btn-primary" disabled={changePending || !changeReason.trim()}>
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
              <form className="space-y-3" action={deleteAction}>
                <input type="hidden" name="companyCode" value={row.companyCode} />
                <input type="hidden" name="houseBankKey" value={row.houseBankKey} />
                <input type="hidden" name="accountId" value={account.accountId} />
                <p className="text-sm text-ink-soft">{t('houseBank.deleteAccountNote')}</p>
                <ReasonField id={`bank-account-delete-reason-${idKey}`} value={deleteReason} onChange={setDeleteReason} />
                <HouseMessage state={deleteState} />
                <button type="submit" className="btn-primary" disabled={deletePending || !deleteReason.trim()}>
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

function AccountsPanel({
  row,
  companies,
  currencies,
  glAccountChoices,
  canMaintain,
}: {
  row: HouseBankRow;
  companies: CompanyChoice[];
  currencies: CurrencyChoice[];
  glAccountChoices: GlAccountChoice[];
  canMaintain: boolean;
}) {
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<HouseBankActionState, FormData>(
    saveBankAccountAction,
    { ok: true },
  );

  // The G/L rule, offered rather than enforced after the fact: only the asset
  // balance-sheet accounts of this company code's chart are choices here. The
  // service judges it again, because a form is not a boundary.
  const chart = companies.find((entry) => entry.companyCode === row.companyCode)?.chartOfAccounts ?? null;
  const glAccounts = glAccountChoices.filter(
    (entry) => entry.chartOfAccounts === chart && entry.accountType === 'ASSET' && entry.isBalanceSheet,
  );

  return (
    <div className="space-y-4 p-4">
      <div className="overflow-x-auto">
        <table className="grid-table min-w-[45rem]">
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
                      <AccountDialogs
                        row={row}
                        account={account}
                        glAccounts={glAccounts}
                        currencies={currencies}
                      />
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {canMaintain && (
        <form className="space-y-3 border border-line p-4" action={formAction}>
          <h3 className="text-sm font-semibold">{t('houseBank.accountNew')}</h3>
          <input type="hidden" name="mode" value="CREATE" />
          <input type="hidden" name="companyCode" value={row.companyCode} />
          <input type="hidden" name="houseBankKey" value={row.houseBankKey} />
          <div>
            <label htmlFor={`bank-account-id-${row.companyCode}-${row.houseBankKey}`} className="field-label">
              {t('houseBank.accountId')}<RequiredMark />
            </label>
            <input
              id={`bank-account-id-${row.companyCode}-${row.houseBankKey}`}
              name="accountId"
              className="field-input code max-w-xs"
              maxLength={5}
              placeholder="ACC01"
              required
            />
          </div>
          <AccountFieldsStandalone houseKey={`${row.companyCode}-${row.houseBankKey}`} glAccounts={glAccounts} currencies={currencies} />
          <ReasonField id={`bank-account-reason-${row.companyCode}-${row.houseBankKey}`} value={reason} onChange={setReason} />
          <HouseMessage state={state} />
          <button type="submit" className="btn-primary" disabled={pending || !reason.trim()}>
            {t('houseBank.createAccount')}
          </button>
        </form>
      )}
    </div>
  );
}

function AccountFieldsStandalone({
  houseKey,
  glAccounts,
  currencies,
}: {
  houseKey: string;
  glAccounts: GlAccountChoice[];
  currencies: CurrencyChoice[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={`bank-account-number-${houseKey}`} className="field-label">
          {t('houseBank.accountNumber')}<RequiredMark />
        </label>
        <input id={`bank-account-number-${houseKey}`} name="accountNumber" className="field-input code" maxLength={18} required />
      </div>
      <div>
        <label htmlFor={`bank-account-iban-${houseKey}`} className="field-label">{t('houseBank.iban')}</label>
        <input id={`bank-account-iban-${houseKey}`} name="iban" className="field-input code" maxLength={34} placeholder="KW81CBKU…" />
        <p className="mt-1 text-xs text-ink-soft">{t('houseBank.ibanHint')}</p>
      </div>
      <div>
        <label htmlFor={`bank-account-currency-${houseKey}`} className="field-label">
          {t('houseBank.currency')}<RequiredMark />
        </label>
        <select id={`bank-account-currency-${houseKey}`} name="currency" className="field-input" defaultValue="">
          <option value="">{t('houseBank.chooseCurrency')}</option>
          {currencies.map((currency) => (
            <option key={currency.code} value={currency.code}>
              {currency.code} — {currency.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`bank-account-gl-${houseKey}`} className="field-label">
          {t('houseBank.glAccount')}<RequiredMark />
        </label>
        <select id={`bank-account-gl-${houseKey}`} name="glAccount" className="field-input" defaultValue="">
          <option value="">{t('houseBank.chooseGlAccount')}</option>
          {glAccounts.map((gl) => (
            <option key={gl.accountNumber} value={gl.accountNumber}>
              {gl.accountNumber} — {gl.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-ink-soft">{t('houseBank.glHint')}</p>
      </div>
    </div>
  );
}

export function HouseBanks({
  houseBanks,
  companies,
  banks,
  currencies,
  glAccountChoices,
  canMaintain,
}: {
  houseBanks: HouseBankRow[];
  companies: CompanyChoice[];
  banks: BankChoice[];
  currencies: CurrencyChoice[];
  glAccountChoices: GlAccountChoice[];
  canMaintain: boolean;
}) {
  const [company, setCompany] = useState(companies[0]?.companyCode ?? '');
  const [selectedHouse, setSelectedHouse] = useState<string | null>(null);

  const rows = houseBanks.filter((row) => row.companyCode === company);
  const selected = rows.find((row) => `${row.companyCode}/${row.houseBankKey}` === selectedHouse) ?? null;

  return (
    <div className="space-y-4">
      {canMaintain && (
        <CreatePanel companies={companies} banks={banks} company={company} setCompany={setCompany} />
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
          <table className="grid-table min-w-[51.25rem]">
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
          <AccountsPanel
            row={selected}
            companies={companies}
            currencies={currencies}
            glAccountChoices={glAccountChoices}
            canMaintain={canMaintain}
          />
        ) : (
          <p className="p-4 text-sm text-ink-soft">{t('houseBank.selectHouseBank')}</p>
        )}
      </section>
    </div>
  );
}
