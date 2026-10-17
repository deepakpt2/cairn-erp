'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { createTenantAction, type OnboardState } from '../actions';

const INITIAL: OnboardState = { ok: true };

/**
 * Tenant onboarding — CAIRN.md §7.2, reduced by SCR-032.
 *
 * Creating a tenant asks what a tenant is, not what a company inside it is: identity,
 * then what the tenant starts with, then its first administrator. The enterprise
 * structure and the financial basis this form used to collect are configured afterwards
 * on their own screens, because a tenant may legitimately have no company code at all.
 * The standard package now holds only data that is true for any company, so choosing it
 * here no longer implies a legal entity, and the structure that does imply one belongs
 * to whichever company code the tenant defines later.
 *
 * Three consequences the form is built around. There is no start option: a created
 * tenant is available at once, which is what `client.status` already recorded. Only the
 * key is unique, so the name carries no uniqueness claim. And copying a tenant is
 * offered and refused rather than hidden, because an implementation asks for it and a
 * refusal that names the remedy is more use than an absent option.
 *
 * Field order follows the sequence an implementation actually runs, top to bottom.
 */
export default function TenantForm({ requiresOwnerToken = false }: { requiresOwnerToken?: boolean }) {
  const [state, action, pending] = useActionState(createTenantAction, INITIAL);
  const [creationType, setCreationType] = useState('empty');
  const copyRefused = creationType === 'copy';

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
        {requiresOwnerToken && <Section title={t('onboard.ownerAccess')}>
          <Field label={t('onboard.ownerToken')} hint={t('onboard.ownerTokenHint')} required width="w-full">
            <input name="provisioningToken" type="password" autoComplete="off" required maxLength={256} className="field-input" />
          </Field>
        </Section>}
        <Section title={t('onboard.section.identity')}>
          <Field label={t('onboard.clientKey')} hint={t('onboard.clientKey.hint')} required width="w-40">
            <input name="clientKey" required maxLength={4} defaultValue="0200" className="field-input code" />
          </Field>
          <Field label={t('onboard.name')} hint={t('onboard.name.hint')} required width="flex-1">
            <input name="name" required maxLength={120} defaultValue="Acme Manufacturing" className="field-input" />
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

        <Section title={t('onboard.section.creation')}>
          <div className="w-full space-y-3">
            <p className="field-hint">{t('onboard.creationType.hint')}</p>
            <Choice
              name="creationType"
              value="empty"
              title={t('onboard.creationType.empty')}
              hint={t('onboard.creationType.empty.hint')}
              checked
              onSelect={setCreationType}
            />
            <Choice
              name="creationType"
              value="standard"
              title={t('onboard.creationType.standard')}
              hint={t('onboard.creationType.standard.hint')}
              onSelect={setCreationType}
            />
            <Choice
              name="creationType"
              value="copy"
              title={t('onboard.creationType.copy')}
              hint={t('onboard.creationType.copy.hint')}
              onSelect={setCreationType}
            />
            {copyRefused && (
              <div className="border border-signal-error/30 bg-signal-error-soft p-3" role="alert">
                <p className="text-sm font-semibold text-signal-error">
                  {t('onboard.creationType.copy.refused')}
                </p>
                <p className="mt-0.5 text-sm text-ink-soft">
                  {t('onboard.creationType.copy.remedy')}
                </p>
              </div>
            )}
          </div>
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
          <div className="flex-1" />
          <Link href="/clients" className="btn btn-default">
            {t('onboard.cancel')}
          </Link>
          <button type="submit" className="btn btn-primary" disabled={pending || copyRefused}>
            {pending ? 'Creating…' : t('onboard.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}

function Choice({
  name,
  value,
  title,
  hint,
  checked = false,
  onSelect,
}: {
  name: string;
  value: string;
  title: string;
  hint: string;
  checked?: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={checked}
        onChange={() => onSelect(value)}
        className="mt-1 accent-accent"
      />
      <span>
        <span className="font-medium text-ink">{title}</span>
        <span className="block text-ink-soft">{hint}</span>
      </span>
    </label>
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
