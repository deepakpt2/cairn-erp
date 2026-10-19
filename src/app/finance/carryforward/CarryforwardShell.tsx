'use client';

import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import type { CarryforwardResultView, CarryforwardRunView } from '@/modules/finance/carryforward';
import { executeCarryforwardAction, type CarryState } from './actions';

const INITIAL: CarryState = { ok: true };

/**
 * G/L balance carryforward (SCR-102 / F.16): choose ledger,
 * companies and target year; test-run first, then update. Every
 * execution stands as its own run with its result protocol. The
 * carryforward never closes the prior year or locks a period.
 */
export default function CarryforwardShell({ canUse, companies, runs, results }: {
  canUse: boolean;
  companies: Array<{ companyCode: string; name: string }>;
  runs: CarryforwardRunView[];
  results: CarryforwardResultView[];
}) {
  const [state, action, pending] = useActionState(executeCarryforwardAction, INITIAL);
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.CLOSE.CARRYFORWARD' })}
      </div>
    );
  }
  const latest = runs[0];
  return (
    <div className="space-y-4">
      {state.message && (
        <div className={`border p-3 ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft' : 'border-signal-error/30 bg-signal-error-soft'}`}>
          <p className={`text-sm font-semibold ${state.ok ? 'text-signal-ok' : 'text-signal-error'}`}>{state.message}</p>
          {state.remedy && <p className="mt-0.5 text-sm text-ink-soft">{state.remedy}</p>}
        </div>
      )}

      <form action={action} className="panel space-y-3 p-4" aria-label={t('carry.selectionTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('carry.ledger')}>
            <input name="ledger" defaultValue="0L" maxLength={2} className="field-input code w-24" />
          </Field>
          <Field label={t('carry.companyCodes')}>
            <select name="companyCodes" className="field-input code w-56" defaultValue={companies[0]?.companyCode ?? ''}>
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>)}
            </select>
          </Field>
          <Field label={t('carry.targetYear')}>
            <input name="targetFiscalYear" type="number" required className="field-input code w-28" placeholder="2027" />
          </Field>
          <Field label={t('carry.testRun')}>
            <select name="testRun" className="field-input w-36" defaultValue="true">
              <option value="true">{t('carry.testRunYes')}</option>
              <option value="false">{t('carry.testRunNo')}</option>
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>
            {pending ? t('carry.running') : t('carry.execute')}
          </button>
          <span className="text-2xs text-ink-faint">{t('carry.noCloseHint')}</span>
        </div>
      </form>

      {latest && (
        <section className="panel p-4" aria-label={t('carry.latestTitle')}>
          <h2 className="panel-title">{t('carry.latestTitle')}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            {latest.runId} · {latest.sourceFiscalYear} → {latest.targetFiscalYear} · {latest.status}
            {latest.testRun ? ` · ${t('carry.testRunYes')}` : ''} · {latest.accountsProcessed} {t('carry.accounts')}
            {' · '}{latest.errors} {t('carry.errors')}
            {latest.transferDocuments.length > 0 && ` · ${latest.transferDocuments.join(', ')}`}
          </p>
        </section>
      )}

      <section className="panel" aria-label={t('carry.runsTitle')}>
        <div className="panel-header"><h2 className="panel-title">{t('carry.runsTitle')}</h2></div>
        <table className="grid-table">
          <thead>
            <tr>
              <th>{t('carry.run')}</th><th>{t('carry.years')}</th><th>{t('carry.mode')}</th>
              <th>{t('carry.status')}</th><th className="text-end">{t('carry.accounts')}</th>
              <th className="text-end">{t('carry.carried')}</th><th className="text-end">{t('carry.transferred')}</th>
              <th className="text-end">{t('carry.errors')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.runId}>
                <td className="code">{run.runId}</td>
                <td className="tabular">{run.sourceFiscalYear} → {run.targetFiscalYear}</td>
                <td>{run.testRun ? t('carry.testRunYes') : t('carry.testRunNo')}</td>
                <td>{run.status}</td>
                <td className="tabular text-end">{run.accountsProcessed}</td>
                <td className="tabular text-end">{run.balancesCarried.toFixed(2)}</td>
                <td className="tabular text-end">{run.plTransferred.toFixed(2)}</td>
                <td className="tabular text-end">{run.errors}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr><td colSpan={8} className="text-sm text-ink-soft">{t('carry.runsEmpty')}</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel" aria-label={t('carry.resultsTitle')}>
        <div className="panel-header"><h2 className="panel-title">{t('carry.resultsTitle')}</h2></div>
        <table className="grid-table">
          <thead>
            <tr>
              <th>{t('carry.company')}</th><th>{t('carry.account')}</th><th>{t('carry.category')}</th>
              <th className="text-end">{t('carry.sourceClosing')}</th>
              <th className="text-end">{t('carry.targetOpening')}</th>
              <th>{t('carry.document')}</th><th>{t('carry.status')}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={`${r.companyCode}-${r.accountNumber}-${r.profitCenter ?? ''}-${i}`}>
                <td className="code">{r.companyCode}</td>
                <td className="code">{r.accountNumber}{r.profitCenter ? ` / ${r.profitCenter}` : ''}</td>
                <td>{r.accountCategory}</td>
                <td className="tabular text-end">{r.sourceClosingBalance.toFixed(2)} {r.currency}</td>
                <td className="tabular text-end">{r.targetOpeningBalance.toFixed(2)} {r.currency}</td>
                <td className="code">{r.transferDocumentNumber ?? '—'}</td>
                <td>{r.status}{r.detail ? <span className="block text-2xs text-ink-faint">{r.detail}</span> : null}</td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr><td colSpan={7} className="text-sm text-ink-soft">{t('carry.resultsEmpty')}</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}
