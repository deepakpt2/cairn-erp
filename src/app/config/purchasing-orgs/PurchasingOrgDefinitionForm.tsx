'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import {
  savePurchasingOrgDefinitionAction,
  type PurchasingOrgMaintenanceActionState,
} from './actions';

export interface PurchasingOrgDefinitionDraft {
  purchasingOrg: string;
  name: string;
}

interface Props {
  mode: 'CREATE' | 'CHANGE';
  initial: PurchasingOrgDefinitionDraft;
  version: number;
}

export function PurchasingOrgDefinitionForm({ mode, initial, version }: Props) {
  const [state, action, pending] = useActionState<PurchasingOrgMaintenanceActionState, FormData>(
    savePurchasingOrgDefinitionAction,
    { ok: true },
  );
  const creating = mode === 'CREATE';
  const purchasingOrg = state.purchasingOrg ?? initial.purchasingOrg;
  const savedHref = `/config/purchasing-orgs?purchasingOrg=${encodeURIComponent(purchasingOrg)}`;
  const cancelHref = creating ? '/config/purchasing-orgs' : savedHref;

  if (state.ok && state.message) {
    return (
      <section className="panel p-4">
        <p role="status" className="text-sm text-signal-ok">{state.message}</p>
        <div className="mt-3 flex gap-4 text-sm">
          <Link className="text-accent underline" href={savedHref}>{t('purchasingOrg.openSaved')}</Link>
          <Link className="text-accent underline" href="/config/purchasing-orgs">{t('purchasingOrg.backToList')}</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="panel p-4">
      <h2 className="panel-title">{t(creating ? 'purchasingOrg.create' : 'purchasingOrg.change')}</h2>
      {state.message && (
        <div role="alert" className="mt-3 rounded border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
        </div>
      )}
      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="expectedVersion" value={version} />

        {creating ? (
          <label className="block">
            <span className="field-label">{t('purchasingOrg.code')} *</span>
            <input
              className="field-input code"
              name="purchasingOrg"
              defaultValue={initial.purchasingOrg}
              minLength={2}
              maxLength={10}
              pattern="[A-Z0-9]{2,10}"
              autoCapitalize="characters"
              spellCheck={false}
              required
              aria-describedby="purchasing-org-code-help"
            />
            <span id="purchasing-org-code-help" className="field-hint">{t('purchasingOrg.codeHelp')}</span>
          </label>
        ) : (
          <>
            <input type="hidden" name="purchasingOrg" value={initial.purchasingOrg} />
            <label className="block">
              <span className="field-label">{t('purchasingOrg.code')}</span>
              <input className="field-input code bg-sunken" value={initial.purchasingOrg} readOnly />
              <span className="field-hint">{t('purchasingOrg.codeImmutable')}</span>
            </label>
          </>
        )}

        <label className="block">
          <span className="field-label">{t('purchasingOrg.name')} *</span>
          <input className="field-input" name="name" defaultValue={initial.name} maxLength={160} required />
        </label>

        <label className="block">
          <span className="field-label">{t('purchasingOrg.reason')}</span>
          <textarea className="field-input" name="reason" maxLength={500} rows={2} />
        </label>

        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {pending ? t('common.saving') : t(creating ? 'purchasingOrg.create' : 'common.save')}
          </button>
          <Link className="btn btn-default" href={cancelHref}>{t('common.cancel')}</Link>
        </div>
      </form>
    </section>
  );
}
