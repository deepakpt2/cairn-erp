'use client';

import Link from 'next/link';
import { useActionState, useState, type ChangeEvent } from 'react';

import type { DepreciationRunResult } from '@/modules/finance/asset-depreciation';
import { executeAction, type DepreciateActionState } from './actions';

const INITIAL: DepreciateActionState = { ok: false, message: '' };

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

export interface RunSummary {
  runId: string;
  companyCode: string;
  fiscalYear: number;
  postingPeriod: number;
  runType: string;
  isTestRun: boolean;
  status: string;
  totalCalculated: number;
  totalPosted: number;
  currency: string;
  documentNumber: string | null;
  executedBy: string;
  errorMessage: string | null;
}

export default function DepreciateForm({ canRun, today, runs, selectedRunId, selectedItems }: {
  canRun: boolean;
  today: string;
  runs: RunSummary[];
  selectedRunId: string | null;
  selectedItems: DepreciationRunResult['items'];
}) {
  const [state, execute, executing] = useActionState(executeAction, INITIAL);
  const [runType, setRunType] = useState<'1' | '2' | '3' | '4'>('1');
  const [testRun, setTestRun] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  // Controlled fields: React resets uncontrolled inputs after a form action.
  const [fields, setFields] = useState({
    companyCode: '', fiscalYear: '2026', postingPeriod: '', postingDate: today,
    documentType: 'AF', restartOfRunId: '', unplannedReference: '',
  });
  const bind = (name: keyof typeof fields) => ({
    name,
    value: fields[name],
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setFields((f) => ({ ...f, [name]: e.target.value })),
  });
  const result = state.result;
  const logItems = result?.items ?? selectedItems;
  return (
    <>
      <section aria-labelledby="dp-entry" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dp-entry" className="text-sm font-semibold">Run parameters</h2>
        <form className="mt-3">
          <input type="hidden" name="runType" value={runType} />
          <input type="hidden" name="intent" value={testRun ? 'test' : 'live'} />
          {state.message && (
            <p role="status" className={`mb-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
              {state.message}{state.remedy ? ` ${state.remedy}` : ''}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block"><span className={labelCls}>Company code</span>
              <input {...bind('companyCode')} className={inputCls} placeholder="1000" required /></label>
            <label className="block"><span className={labelCls}>Fiscal year</span>
              <input {...bind('fiscalYear')} className={inputCls} placeholder="2026" required /></label>
            <label className="block"><span className={labelCls}>Posting period</span>
              <input {...bind('postingPeriod')} className={inputCls} placeholder="04" required /></label>
            <label className="block"><span className={labelCls}>Run type</span>
              <select className={inputCls} value={runType}
                onChange={(e) => setRunType(e.target.value as typeof runType)}>
                <option value="1">1 — Planned</option>
                <option value="2">2 — Repeat</option>
                <option value="3">3 — Restart</option>
                <option value="4">4 — Unplanned</option>
              </select></label>
            <label className="block"><span className={labelCls}>Document type (live runs)</span>
              <input {...bind('documentType')} className={inputCls} maxLength={2} /></label>
            <label className="block"><span className={labelCls}>Posting date</span>
              <input type="date" {...bind('postingDate')} className={inputCls} required /></label>
            {runType === '3' && (
              <label className="block"><span className={labelCls}>Restart run reference</span>
                <input {...bind('restartOfRunId')} className={inputCls} placeholder="Failed run id" required /></label>
            )}
            {runType === '4' && (
              <label className="block"><span className={labelCls}>Unplanned depreciation reference</span>
                <input {...bind('unplannedReference')} className={inputCls} placeholder="Source transaction" /></label>
            )}
            <label className="flex items-end gap-2 pb-1">
              <input type="checkbox" checked={testRun} onChange={(e) => setTestRun(e.target.checked)} />
              <span className="text-sm">Test run (simulate only)</span>
            </label>
          </div>
          {!testRun && (
            <label className="mt-3 flex items-start gap-2 text-sm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>
                I confirm the live run: it posts a real accounting document and records posted
                depreciation per asset and period. Corrections take a repeat run or a reversal —
                posted documents are never edited.
              </span>
            </label>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" formAction={execute}
              className="btn btn-default min-h-11 sm:min-h-8" disabled={!canRun || executing || !testRun}>
              Execute test run
            </button>
            <button type="submit" formAction={execute}
              className="btn btn-primary min-h-11 sm:min-h-8"
              disabled={!canRun || executing || testRun || !confirmed}>
              Execute live run
            </button>
          </div>
          {!canRun && (
            <p className="mt-2 text-sm text-ink-soft">You do not hold the depreciation run capability.</p>
          )}
          <p className="mt-2 text-sm text-ink-soft">
            A test run calculates and logs every asset without touching a balance. A live run
            posts one balanced document — depreciation expense against accumulated
            depreciation — and records what it posted per asset and period.
          </p>
        </form>
      </section>

      <section aria-labelledby="dp-log" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dp-log" className="text-sm font-semibold">Execution log</h2>
        {result && (
          <p className="mt-2 text-sm">
            Run {result.runId} · {result.status} · calculated {result.totalCalculated.toFixed(2)} ·
            posted {result.totalPosted.toFixed(2)} {result.currency}
            {result.documentNumber && (
              <> · <Link className="text-teal-800 underline" href={`/finance/journal/document?document=${result.documentNumber}`}>
                Display accounting document {result.documentNumber}</Link></>
            )}
          </p>
        )}
        {result?.warnings.map((w) => (
          <p key={w} className="mt-1 text-sm text-ink-soft">{w}</p>
        ))}
        {logItems.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">Execute a run to see its asset-level log.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Asset</th><th className="px-2 py-2">Area</th>
                  <th className="px-2 py-2">Key</th><th className="px-2 py-2">Calculated</th>
                  <th className="px-2 py-2">Previously posted</th><th className="px-2 py-2">Adjustment</th>
                  <th className="px-2 py-2">Status</th><th className="px-2 py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {logItems.map((item) => (
                  <tr key={`${item.assetNumber}-${item.subNumber}-${item.areaCode}`} className="border-t border-line">
                    <td className="px-2 py-2">{item.assetNumber}/{item.subNumber}</td>
                    <td className="px-2 py-2">{item.areaCode}</td>
                    <td className="px-2 py-2">{item.depreciationKey}</td>
                    <td className="px-2 py-2">{item.calculatedAmount.toFixed(2)} {item.currency}</td>
                    <td className="px-2 py-2">{item.previouslyPostedAmount.toFixed(2)}</td>
                    <td className="px-2 py-2">{item.adjustmentAmount.toFixed(2)}</td>
                    <td className="px-2 py-2">{item.status}</td>
                    <td className="px-2 py-2">{item.message ?? item.documentNumber ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="dp-runs" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dp-runs" className="text-sm font-semibold">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No runs stand yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Run</th><th className="px-2 py-2">Company</th>
                  <th className="px-2 py-2">Year/period</th><th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2">Status</th><th className="px-2 py-2">Calculated</th>
                  <th className="px-2 py-2">Posted</th><th className="px-2 py-2">Document</th>
                  <th className="px-2 py-2">Log</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId} className="border-t border-line">
                    <td className="px-2 py-2">{run.runId.slice(0, 8)}…</td>
                    <td className="px-2 py-2">{run.companyCode}</td>
                    <td className="px-2 py-2">{run.fiscalYear}/{String(run.postingPeriod).padStart(2, '0')}</td>
                    <td className="px-2 py-2">{run.runType}{run.isTestRun ? ' (test)' : ''}</td>
                    <td className="px-2 py-2">{run.status}</td>
                    <td className="px-2 py-2">{run.totalCalculated.toFixed(2)}</td>
                    <td className="px-2 py-2">{run.totalPosted.toFixed(2)} {run.currency}</td>
                    <td className="px-2 py-2">
                      {run.documentNumber ? (
                        <Link className="text-teal-800 underline" href={`/finance/journal/document?document=${run.documentNumber}`}>
                          {run.documentNumber}
                        </Link>
                      ) : '—'}
                    </td>
                    <td className="px-2 py-2">
                      <Link className="text-teal-800 underline" href={`/finance/assets/depreciate?run=${run.runId}`}>
                        {selectedRunId === run.runId ? 'Shown' : 'View log'}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
