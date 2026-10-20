'use client';

import { useActionState } from 'react';

import { t } from '@/platform/i18n';
import type { IntercompanyPairConfig } from '@/modules/finance/intercompany';
import {
  deleteIntercompanyConfigAction, saveIntercompanyConfigAction,
  type IntercompanyConfigActionState,
} from './actions';

const INITIAL: IntercompanyConfigActionState = { ok: false, message: '' };

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
                      <form action={deleteAction}>
                        <input type="hidden" name="sendingCompanyCode" value={pair.sendingCompanyCode} />
                        <input type="hidden" name="receivingCompanyCode" value={pair.receivingCompanyCode} />
                        <button
                          type="submit" className="btn btn-default min-h-11 sm:min-h-8"
                          disabled={!canMaintain || deleting}
                        >
                          {t('icCfg.delete')}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canMaintain && (
        <section aria-labelledby="icc-new" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="icc-new" className="text-sm font-semibold">{t('icCfg.define')}</h2>
          <form action={saveAction} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icCfg.sending')}</span>
              <select name="sendingCompanyCode" className="input w-32" defaultValue="" required>
                <option value="" disabled>—</option>
                {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icCfg.receiving')}</span>
              <select name="receivingCompanyCode" className="input w-32" defaultValue="" required>
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
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={saving}>
              {t('icCfg.save')}
            </button>
          </form>
        </section>
      )}
    </>
  );
}
