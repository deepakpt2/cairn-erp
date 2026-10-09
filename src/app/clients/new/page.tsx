'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { createTenantAction, type OnboardState } from '../actions';

const INITIAL: OnboardState = { ok: true };

/**
 * Tenant onboarding — CAIRN.md §7.2.
 *
 * Grouped the way an implementation actually runs: identity, then structure,
 * then the financial basis, then the first user. Field order follows that
 * sequence deliberately, because a user working from an implementation plan
 * reads top to bottom.
 */
export default function CreateTenantPage() {
  const [state, action, pending] = useActionState(createTenantAction, INITIAL);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">CFG.PLT.CLIENT.ONBOARD</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('onboard.title')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">{t('onboard.subtitle')}</p>
      </header>

      {!state.ok && state.message && (
        <div className="mb-4 border border-signal-error/30 bg-signal-error-soft p-3">
          <p className="text-sm font-semibold text-signal-error">{state.message}</p>
          {state.remedy && (
            <p className="mt-0.5 text-sm text-ink-soft">{state.remedy}</p>
          )}
        </div>
      )}

      <form action={action} className="space-y-5">
        <Section title={t('onboard.section.identity')}>
          <Field label={t('onboard.clientKey')} hint={t('onboard.clientKey.hint')} required width="w-40">
            <input name="clientKey" required maxLength={4} defaultValue="0200" className="field-input code" />
          </Field>
          <Field label={t('onboard.name')} required width="flex-1">
            <input name="name" required defaultValue="Acme Manufacturing" className="field-input" />
          </Field>
          <Field label={t('onboard.legalName')} width="flex-1">
            <input name="legalName" className="field-input" />
          </Field>
          <Field label={t('onboard.country')} width="w-32">
            <input name="country" defaultValue="KW" maxLength={2} className="field-input code" />
          </Field>
          <Field label={t('onboard.currency')} width="w-32">
            <input name="currency" defaultValue="USD" maxLength={3} className="field-input code" />
          </Field>
          <Field label={t('onboard.timezone')} width="w-56">
            <input name="timezone" defaultValue="Asia/Kuwait" className="field-input" />
          </Field>
        </Section>

        <Section title={t('onboard.section.structure')}>
          <Field
            label={t('onboard.companyCode')}
            hint={t('onboard.companyCode.hint')}
            required
            width="w-40"
          >
            <input name="companyCode" required maxLength={4} defaultValue="1000" className="field-input code" />
          </Field>
          <Field label={t('onboard.companyName')} required width="flex-1">
            <input name="companyName" required defaultValue="Acme Manufacturing" className="field-input" />
          </Field>
        </Section>

        <Section title={t('onboard.section.finance')}>
          <Field label={t('onboard.chartOfAccounts')} width="w-40">
            <input name="chartOfAccounts" defaultValue="CAIRN" className="field-input code" />
          </Field>
          <Field label={t('onboard.fiscalYearVariant')} width="w-64">
            <select name="fiscalYearVariant" defaultValue="K4" className="field-input">
              <option value="K4">K4 — calendar year, 4 special periods</option>
              <option value="K1">K1 — calendar year, 1 special period</option>
            </select>
          </Field>
        </Section>

        <Section title={t('onboard.section.admin')}>
          <Field label={t('onboard.username')} required width="w-56">
            <input name="username" required defaultValue="admin" className="field-input code" />
          </Field>
          <Field label={t('onboard.fullName')} required width="flex-1">
            <input name="fullName" required defaultValue="System Administrator" className="field-input" />
          </Field>
          <Field label={t('onboard.email')} width="w-72">
            <input name="email" type="email" className="field-input" />
          </Field>
          <Field
            label={t('onboard.password')}
            hint={t('onboard.password.hint')}
            required
            width="w-72"
          >
            <input name="password" type="password" required className="field-input" />
          </Field>
        </Section>

        <div className="flex items-center gap-3 border-t border-line pt-4">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" name="isDevelopment" defaultChecked className="accent-accent" />
            {t('tenants.origin.development')} tenant
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              name="activateStandardPackage"
              defaultChecked
              className="accent-accent"
            />
            {t('onboard.activatePackage')}
          </label>
          <div className="flex-1" />
          <Link href="/clients" className="btn btn-default">
            {t('onboard.cancel')}
          </Link>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? 'Creating…' : t('onboard.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="panel p-4">
      <legend className="px-1 text-2xs font-semibold uppercase tracking-wide text-ink-soft">
        {title}
      </legend>
      <div className="flex flex-wrap gap-3">{children}</div>
    </fieldset>
  );
}

function Field({
  label,
  hint,
  required,
  width,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={width ?? 'w-56'}>
      <label className="field-label">
        {label}
        {required && <span className="ms-1 text-signal-error">*</span>}
      </label>
      {children}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
