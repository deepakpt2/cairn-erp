'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import { t } from '@/platform/i18n';
import type { IntercompanyPairConfig } from '@/modules/finance/intercompany';
import {
  deleteIntercompanyConfigAction, saveIntercompanyConfigAction,
  type IntercompanyConfigActionState,
} from './actions';

const INITIAL: IntercompanyConfigActionState = { ok: false, message: '' };
const ACTIVITY = 'CFG.FIN.IC.DEFINE';

export function IntercompanyClearing({ pairs, companies, canMaintain }: {
  pairs: IntercompanyPairConfig[];
  companies: Array<{ companyCode: string; name: string; currency: string }>;
  canMaintain: boolean;
}) {
  const [saveState, saveAction, saving] = useActionState(saveIntercompanyConfigAction, INITIAL);
  const [deleteState, deleteAction, deleting] = useActionState(deleteIntercompanyConfigAction, INITIAL);
  const state = saveState.message ? saveState : deleteState;

  return (
    <>
      <section aria-labelledby="icc-pairs" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="icc-pairs" className="text-sm font-semibold">{t('icCfg.pairs')}</h2>
        {state.message && (
          <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
            {state.message}{state.remedy ? ` ${state.remedy}` : ''}
          </p>
        )}
        {pairs.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">{t('icCfg.none')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">{t('icCfg.sending')}</th>
                  <th className="px-2 py-2">{t('icCfg.receiving')}</th>
                  <th className="px-2 py-2">{t('icCfg.sendingGl')}</th>
                  <th className="px-2 py-2">{t('icCfg.receivingGl')}</th>
                  <th className="px-2 py-2">{t('icCfg.currency')}</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {pairs.map((pair) => (
                  <tr key={`${pair.sendingCompanyCode}-${pair.receivingCompanyCode}`} className="border-t border-line">
                    <td className="px-2 py-2">{pair.sendingCompanyCode}</td>
                    <td className="px-2 py-2">{pair.receivingCompanyCode}</td>
                    <td className="px-2 py-2">{pair.sendingClearingGl ?? t('icCfg.companyAccount')}</td>
                    <td className="px-2 py-2">{pair.receivingClearingGl ?? t('icCfg.companyAccount')}</td>
                    <td className="px-2 py-2">{pair.defaultCurrency ?? t('icCfg.companyCurrency')}</td>
                    <td className="px-2 py-2">
                      <DeletePair pair={pair} action={deleteAction} canMaintain={canMaintain} deleting={deleting} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canMaintain && (
        <DefinePair pairs={pairs} companies={companies} action={saveAction} saving={saving} />
      )}
    </>
  );
}

function DeletePair({
  pair,
  action,
  canMaintain,
  deleting,
}: {
  pair: IntercompanyPairConfig;
  action: (payload: FormData) => void;
  canMaintain: boolean;
  deleting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const argument = `${pair.sendingCompanyCode}/${pair.receivingCompanyCode}`;
  const lock = useChangeLock('INTERCOMPANY_PAIR', argument, ACTIVITY, open && canMaintain);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-8">
        {t('icCfg.delete')}
      </summary>
      <form action={action} className="mt-2 space-y-2">
        <input type="hidden" name="sendingCompanyCode" value={pair.sendingCompanyCode} />
        <input type="hidden" name="receivingCompanyCode" value={pair.receivingCompanyCode} />
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} remedy={lock?.remedy} />
        <button
          type="submit"
          className="btn btn-default min-h-11 sm:min-h-8"
          disabled={!canMaintain || deleting || lock?.mode !== 'CHANGE'}
        >
          {t('icCfg.delete')}
        </button>
      </form>
    </details>
  );
}

function DefinePair({
  pairs,
  companies,
  action,
  saving,
}: {
  pairs: IntercompanyPairConfig[];
  companies: Array<{ companyCode: string; name: string; currency: string }>;
  action: (payload: FormData) => void;
  saving: boolean;
}) {
  const [sending, setSending] = useState('');
  const [receiving, setReceiving] = useState('');
  const [engaged, setEngaged] = useState(false);
  const existing = pairs.some((pair) => pair.sendingCompanyCode === sending && pair.receivingCompanyCode === receiving);
  const lock = useChangeLock('INTERCOMPANY_PAIR', `${sending}/${receiving}`, ACTIVITY, engaged && existing);
  const blocked = existing && lock?.mode === 'DISPLAY';
  return (
    <section aria-labelledby="icc-new" className="rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id="icc-new" className="text-sm font-semibold">{t('icCfg.define')}</h2>
      <form action={action} className="mt-3 flex flex-wrap items-end gap-3" onFocus={() => setEngaged(true)} onSubmit={(event) => { if (existing && lock?.mode !== 'CHANGE') { event.preventDefault(); setEngaged(true); } }}>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icCfg.sending')}</span>
          <select name="sendingCompanyCode" className="input w-32" value={sending} required onChange={(event) => setSending(event.target.value)}>
            <option value="" disabled>—</option>
            {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icCfg.receiving')}</span>
          <select name="receivingCompanyCode" className="input w-32" value={receiving} required onChange={(event) => setReceiving(event.target.value)}>
            <option value="" disabled>—</option>
            {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icCfg.sendingGl')}</span>
          <input name="sendingClearingGl" className="input w-32" maxLength={10} placeholder={t('icCfg.optional')} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icCfg.receivingGl')}</span>
          <input name="receivingClearingGl" className="input w-32" maxLength={10} placeholder={t('icCfg.optional')} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icCfg.currency')}</span>
          <input name="defaultCurrency" className="input w-24" maxLength={3} placeholder={t('icCfg.optional')} />
        </label>
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} remedy={lock?.remedy} />
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={saving || blocked}>
          {t('icCfg.save')}
        </button>
      </form>
    </section>
  );
}
