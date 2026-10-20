'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import type { IntercompanyPairConfig } from '@/modules/finance/intercompany';
import { postIntercompanyAction, type IntercompanyActionState } from './actions';

const INITIAL: IntercompanyActionState = { ok: false, message: '' };
let lineSeed = 0;
const newLine = () => ({ key: ++lineSeed, glAccount: '', debitCredit: 'S', amount: '', costCenter: '' });

export function IntercompanyPosting({ companies, pairs, canPost, today }: {
  companies: Array<{ companyCode: string; name: string; currency: string }>;
  pairs: IntercompanyPairConfig[];
  canPost: boolean;
  today: string;
}) {
  const [state, action, posting] = useActionState(postIntercompanyAction, INITIAL);
  const [lines, setLines] = useState([newLine()]);
  const [sending, setSending] = useState('');
  const [receiving, setReceiving] = useState('');
  const pair = pairs.find((p) => p.sendingCompanyCode === sending && p.receivingCompanyCode === receiving);
  const requestKey = `ic-${sending}-${receiving}-${lines.map((l) => `${l.glAccount}:${l.debitCredit}:${l.amount}`).join('|')}-${today}`;

  const update = (key: number, patch: Partial<ReturnType<typeof newLine>>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <section aria-labelledby="ic-post" className="rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id="ic-post" className="text-sm font-semibold">{t('icPost.section')}</h2>
      {state.message && (
        <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="requestKey" value={requestKey} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icPost.sending')}</span>
            <select name="sendingCompanyCode" className="input w-32" value={sending} onChange={(e) => setSending(e.target.value)} required>
              <option value="" disabled>—</option>
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icPost.receiving')}</span>
            <select name="receivingCompanyCode" className="input w-32" value={receiving} onChange={(e) => setReceiving(e.target.value)} required>
              <option value="" disabled>—</option>
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icPost.postingDate')}</span>
            <input type="date" name="postingDate" className="input" defaultValue={today} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icPost.documentDate')}</span>
            <input type="date" name="documentDate" className="input" defaultValue={today} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icPost.documentType')}</span>
            <input name="documentType" className="input w-24" maxLength={2} defaultValue="SA" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icPost.currency')}</span>
            <input name="currency" className="input w-24" maxLength={3} placeholder={pair?.defaultCurrency ?? t('icPost.companyCurrency')} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('icPost.reference')}</span>
            <input name="reference" className="input w-40" maxLength={16} placeholder="IC-2026-001" />
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th className="px-2 py-2">{t('icPost.account')}</th>
                <th className="px-2 py-2">{t('icPost.dc')}</th>
                <th className="px-2 py-2">{t('icPost.amount')}</th>
                <th className="px-2 py-2">{t('icPost.costCenter')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key} className="border-t border-line">
                  <td className="px-2 py-2">
                    <input
                      name="glAccount" className="input w-32" maxLength={10} value={line.glAccount}
                      onChange={(e) => update(line.key, { glAccount: e.target.value })}
                      aria-label={`G/L account line ${line.key}`} required
                    />
                  </td>
                  <td className="px-2 py-2">
                    <select
                      name="debitCredit" className="input w-20" value={line.debitCredit}
                      onChange={(e) => update(line.key, { debitCredit: e.target.value })}
                      aria-label={`Debit or credit line ${line.key}`}
                    >
                      <option value="S">S</option>
                      <option value="H">H</option>
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <input
                      name="amount" className="input w-32" inputMode="decimal" value={line.amount}
                      onChange={(e) => update(line.key, { amount: e.target.value })}
                      aria-label={`Amount line ${line.key}`} required
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      name="costCenter" className="input w-32" maxLength={20} value={line.costCenter}
                      onChange={(e) => update(line.key, { costCenter: e.target.value })}
                      aria-label={`Cost center line ${line.key}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setLines((p) => [...p, newLine()])}>
            {t('icPost.addLine')}
          </button>
          <label className="flex items-end gap-2">
            <input type="checkbox" name="confirmed" value="yes" className="size-4" required />
            <span className="text-sm">{t('icPost.confirm')}</span>
          </label>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || posting}>
            {t('icPost.post')}
          </button>
        </div>
        <p className="text-sm text-ink-soft">{t('icPost.hint')}</p>
      </form>
    </section>
  );
}
