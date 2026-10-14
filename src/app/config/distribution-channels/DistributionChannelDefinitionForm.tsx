'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { saveDistributionChannelAction, type DistributionChannelActionState } from './actions';

export interface DistributionChannelDraft {
  distributionChannel: string;
  name: string;
}
interface Props {
  mode: 'CREATE' | 'CHANGE';
  initial: DistributionChannelDraft;
  version: number;
}

export function DistributionChannelDefinitionForm({ mode, initial, version }: Props) {
  const [state, action, pending] = useActionState<DistributionChannelActionState, FormData>(
    saveDistributionChannelAction,
    { ok: true },
  );
  const creating = mode === 'CREATE';
  const code = state.distributionChannel ?? initial.distributionChannel;
  const savedHref = `/config/distribution-channels?distributionChannel=${encodeURIComponent(code)}`;
  const cancelHref = creating ? '/config/distribution-channels' : savedHref;

  if (state.ok && state.message) {
    return (
      <section className="panel p-4">
        <p role="status" className="text-sm text-signal-ok">{state.message}</p>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <Link className="text-accent underline" href={savedHref}>{t('orgDefinition.openSaved')}</Link>
          <Link className="text-accent underline" href="/config/distribution-channels">{t('orgDefinition.backToList')}</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="panel p-4">
      <h2 className="panel-title">{t(creating ? 'orgDefinition.create' : 'orgDefinition.change')} · {t('distributionChannel.singular')}</h2>
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
            <span className="field-label">{t('distributionChannel.code')} *</span>
            <input
              className="field-input code"
              name="distributionChannel"
              defaultValue={initial.distributionChannel}
              minLength={2}
              maxLength={2}
              pattern="[A-Za-z0-9]{2}"
              autoCapitalize="characters"
              spellCheck={false}
              required
              aria-describedby="distribution-channel-code-help"
            />
            <span id="distribution-channel-code-help" className="field-hint">{t('distributionChannel.codeHelp')}</span>
          </label>
        ) : (
          <>
            <input type="hidden" name="distributionChannel" value={initial.distributionChannel} />
            <label className="block">
              <span className="field-label">{t('distributionChannel.code')}</span>
              <input className="field-input code bg-sunken" value={initial.distributionChannel} readOnly />
              <span className="field-hint">{t('orgDefinition.codeImmutable')}</span>
            </label>
          </>
        )}
        <label className="block">
          <span className="field-label">{t('orgDefinition.name')} *</span>
          <input className="field-input" name="name" defaultValue={initial.name} maxLength={20} required />
          <span className="field-hint">{t('orgDefinition.nameHelp')}</span>
        </label>
        <label className="block">
          <span className="field-label">{t('orgDefinition.reason')}</span>
          <textarea className="field-input" name="reason" maxLength={500} rows={2} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {pending ? t('common.saving') : t(creating ? 'orgDefinition.create' : 'common.save')}
          </button>
          <Link className="btn btn-default" href={cancelHref}>{t('common.cancel')}</Link>
        </div>
      </form>
    </section>
  );
}
