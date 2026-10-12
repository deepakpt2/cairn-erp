'use client';
import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { saveSupplierCompanyAction } from './company-actions';

type PaymentMethodOption = { code: string; description: string };

export interface CompanyFields {
  reconciliationAccount: string;
  paymentTermsCode: string;
  paymentMethods: string;
  isBlocked: boolean;
  version: number;
  companyStatus: string;
}

export function SupplierCompanyPanel({
  partner,
  company,
  initial,
  chart,
  currency,
  accounts,
  terms,
  paymentMethodOptions,
  editable,
}: {
  partner: string;
  company: string;
  initial: CompanyFields;
  chart: string;
  currency: string;
  accounts: Array<{ number: string; name: string }>;
  terms: Array<{ code: string; description: string }>;
  paymentMethodOptions: PaymentMethodOption[];
  editable: boolean;
}) {
  const [state, action, pending] = useActionState(saveSupplierCompanyAction, { ok: true });

  if (!editable) {
    return (
      <section className="panel p-4">
        <p>{t('auth.readOnly', { authority: 'FIN.SUPPLIER.COMPANY.MAINTAIN' })}</p>
        <dl className="mt-3 grid gap-2 sm:grid-cols-3">
          <Value label={t('sc.account')} value={initial.reconciliationAccount || '—'} />
          <Value label={t('sc.terms')} value={initial.paymentTermsCode || '—'} />
          <Value label={t('sc.paymentMethods')} value={initial.paymentMethods || '—'} />
          <Value label={t('sc.chart')} value={chart} />
          <Value label={t('sc.currency')} value={currency} />
          <Value label={t('sc.status')} value={t(`bp.status.${initial.isBlocked ? 'BLOCKED' : initial.companyStatus}`)} />
        </dl>
        <PendingCompanyDefaults />
      </section>
    );
  }

  return (
    <section className="panel p-4">
      <h2 className="panel-title mb-3">{t('sc.title')}</h2>
      {state.message && (
        <div
          role="status"
          className={`mb-3 border p-3 text-sm ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}
        >
          <p>{state.message}</p>
          {state.remedy && <p>{state.remedy}</p>}
        </div>
      )}
      <form key={initial.version} action={action} className="space-y-4">
        <input type="hidden" name="partnerNumber" value={partner} />
        <input type="hidden" name="companyCode" value={company} />
        <input type="hidden" name="expectedVersion" value={state.version ?? initial.version} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Value label={t('sc.company')} value={company} />
          <Value label={t('sc.chart')} value={chart} />
          <Value label={t('sc.currency')} value={currency} />
          <label>
            <span className="field-label">{t('sc.account')}</span>
            <select name="reconciliationAccount" defaultValue={initial.reconciliationAccount} className="field-input">
              <option value="">{t('bp.notSet')}</option>
              {accounts.map((row) => <option key={row.number} value={row.number}>{row.number} · {row.name}</option>)}
            </select>
          </label>
          <label>
            <span className="field-label">{t('sc.terms')}</span>
            <select name="paymentTermsCode" defaultValue={initial.paymentTermsCode} className="field-input">
              <option value="">{t('bp.notSet')}</option>
              {terms.map((row) => <option key={row.code} value={row.code}>{row.code} · {row.description}</option>)}
            </select>
          </label>
          <Value label={t('sc.status')} value={t(`bp.status.${initial.isBlocked ? 'BLOCKED' : initial.companyStatus}`)} />
        </div>
        <PaymentMethodsEditor
          key={initial.version}
          initialValue={initial.paymentMethods}
          options={paymentMethodOptions}
          pending={pending}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isBlocked" defaultChecked={initial.isBlocked} className="accent-accent" />
          {t('sc.blocked')}
        </label>
        <p className="text-2xs text-ink-soft">{t('sc.note')}</p>
        <label className="block">
          <span className="field-label">{t('bp.reason')}</span>
          <input name="reason" required minLength={3} maxLength={500} className="field-input" />
        </label>
        <button className="btn btn-primary" disabled={pending}>
          {pending ? t('common.saving') : t('common.save')}
        </button>
      </form>
      <PendingCompanyDefaults />
    </section>
  );
}

function PaymentMethodsEditor({
  initialValue,
  options,
  pending,
}: {
  initialValue: string;
  options: PaymentMethodOption[];
  pending: boolean;
}) {
  const [selectedCodes, setSelectedCodes] = useState(() =>
    [...new Set(initialValue.split(',').map((code) => code.trim()).filter(Boolean))].sort(),
  );
  const eligibleCodes = new Set(options.map((option) => option.code));
  const unavailableCodes = selectedCodes.filter((code) => !eligibleCodes.has(code));

  function setSelected(code: string, checked: boolean) {
    setSelectedCodes((current) => checked
      ? current.includes(code) ? current : [...current, code].sort()
      : current.filter((currentCode) => currentCode !== code));
  }

  return (
    <fieldset className="border border-line p-3">
      <legend className="field-label px-1">{t('sc.paymentMethods')}</legend>
      <input type="hidden" name="paymentMethods" value={selectedCodes.join(',')} />
      <p className="mb-3 text-xs text-ink-soft">{t('sc.paymentMethodsHelp')}</p>
      {options.length === 0 && unavailableCodes.length === 0 && (
        <p className="mb-3 text-sm text-ink-soft">{t('sc.noEligiblePaymentMethods')}</p>
      )}
      {unavailableCodes.length > 0 && (
        <p className="mb-3 text-sm text-signal-error">{t('sc.savedPaymentMethodsUnavailable')}</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {unavailableCodes.map((code) => (
          <label key={`unavailable-${code}`} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked
              disabled={pending}
              onChange={(event) => setSelected(code, event.currentTarget.checked)}
              className="accent-accent"
            />
            <span>{code} · {t('sc.ineligibleSavedPaymentMethod')}</span>
          </label>
        ))}
        {options.map((option) => {
          const checked = selectedCodes.includes(option.code);
          return (
            <label key={option.code} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked}
                disabled={pending || (!checked && selectedCodes.length >= 10)}
                onChange={(event) => setSelected(option.code, event.currentTarget.checked)}
                className="accent-accent"
              />
              <span>{option.code} · {option.description}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const PENDING_COMPANY_DEFAULTS = ['sc.dunningProcedure', 'sc.cashDiscount', 'sc.toleranceGroup'] as const;

function PendingCompanyDefaults() {
  return (
    <fieldset disabled className="mt-4 border border-line p-3">
      <legend className="field-label px-1">{t('sc.pendingDefaultsTitle')}</legend>
      <p className="mb-3 text-xs text-ink-soft">{t('sc.pendingDefaultsNote')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {PENDING_COMPANY_DEFAULTS.map((key) => (
          <label key={key} className="block">
            <span className="field-label">{t(key)}</span>
            <input type="text" value={t('sc.masterRequired')} disabled readOnly className="field-input" />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return <div><p className="field-label">{label}</p><p>{value}</p></div>;
}
