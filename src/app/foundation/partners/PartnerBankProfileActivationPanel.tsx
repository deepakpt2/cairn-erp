'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import type { PartnerBankProfileActivationViewRow } from '@/modules/foundation/partner-bank-profile-activation-view';
import {
  activatePartnerBankProfileAction,
  type PartnerBankProfileActivationActionState,
} from './partner-bank-profile-activation-actions';

const INITIAL_STATE: PartnerBankProfileActivationActionState = { ok: true };

export function PartnerBankProfileActivationPanel({
  rows,
}: {
  readonly rows: readonly PartnerBankProfileActivationViewRow[];
}) {
  return (
    <section className="panel overflow-x-auto" aria-labelledby="bank-profile-title">
      <h2 id="bank-profile-title" className="panel-header panel-title">
        {t('bp.profile.title')}
      </h2>
      <p className="px-3 pb-3 text-sm text-ink-soft">{t('bp.profile.subtitle')}</p>
      <p className="mx-3 mb-3 border border-line bg-surface-muted p-3 text-sm text-ink-soft">
        {t('bp.profile.oneWayHint')}
      </p>
      <table className="grid-table">
        <thead>
          <tr>
            <th>{t('bp.bank.country')}</th>
            <th>{t('bp.profile.currentPolicy')}</th>
            <th>{t('bp.profile.registryPolicy')}</th>
            <th>{t('bp.profile.status')}</th>
            <th>{t('bp.profile.version')}</th>
            <th>{t('bp.profile.action')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <ActivationRow key={row.country} row={row} />)}
        </tbody>
      </table>
    </section>
  );
}

function ActivationRow({ row }: { readonly row: PartnerBankProfileActivationViewRow }) {
  const [state, action, pending] = useActionState(activatePartnerBankProfileAction, INITIAL_STATE);
  const [open, setOpen] = useState(false);
  const lock = useChangeLock('PARTNER_BANK_PROFILE', row.country, 'CFG.FND.PARTNER.BANKPROFILE.ACTIVATE', open && row.canActivate);
  const held = lock?.mode === 'CHANGE';
  const status = t(`bp.profile.status.${row.status}`);

  return (
    <tr>
      <td>
        <span>{row.countryName}</span>
        <span className="ms-2 code text-ink-faint">{row.country}</span>
      </td>
      <td className="code">{row.currentPolicyRevision}</td>
      <td className="code">{row.registryPolicyRevision ?? '—'}</td>
      <td>{status}</td>
      <td className="code">{row.version ?? '—'}</td>
      <td className="min-w-56">
        {row.canActivate ? (
          <details onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-sm text-accent">{t('bp.profile.activate')}</summary>
            <form action={action} className="mt-2 space-y-2">
              <input type="hidden" name="country" value={row.country} />
              <input type="hidden" name="expectedPolicyRevision" value={row.currentPolicyRevision} />
              <input type="hidden" name="expectedVersion" value={row.version ?? ''} />
              <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
              <button className="btn btn-primary" type="submit" disabled={pending || !held}>
                {pending ? t('bp.profile.pending') : t('bp.profile.activate')}
              </button>
            </form>
          </details>
        ) : (
          <span className="text-sm text-ink-faint">{t('bp.profile.noAction')}</span>
        )}
        {state.ok && state.code === 'ACTIVATED' && (
          <p role="status" className="mt-2 text-sm text-signal-ok">
            {t('bp.profile.activated', { version: String(state.version ?? '') })}
          </p>
        )}
        {!state.ok && (
          <p role="alert" className="mt-2 text-sm text-signal-error">
            {state.message ?? t('bp.profile.actionFailed')}
          </p>
        )}
      </td>
    </tr>
  );
}
