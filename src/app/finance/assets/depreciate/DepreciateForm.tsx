'use client';

import { useState } from 'react';

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

/**
 * Depreciation run shell (SCR-094 stage 1): the field matrix
 * stands complete; the run service wires in stage 3 of R-142.
 */
export default function DepreciateForm({ canRun, today }: {
  canRun: boolean;
  today: string;
}) {
  const [runType, setRunType] = useState<'1' | '2' | '3' | '4'>('1');
  const [testRun, setTestRun] = useState(true);
  return (
    <>
      <section aria-labelledby="dp-entry" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dp-entry" className="text-sm font-semibold">Run parameters</h2>
        <form className="mt-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block"><span className={labelCls}>Company code</span>
              <input name="companyCode" className={inputCls} placeholder="1000" required /></label>
            <label className="block"><span className={labelCls}>Fiscal year</span>
              <input name="fiscalYear" className={inputCls} placeholder="2026" required /></label>
            <label className="block"><span className={labelCls}>Posting period</span>
              <input name="postingPeriod" className={inputCls} placeholder="04" required /></label>
            <label className="block"><span className={labelCls}>Run type</span>
              <select name="runType" className={inputCls} value={runType}
                onChange={(e) => setRunType(e.target.value as typeof runType)}>
                <option value="1">1 — Planned</option>
                <option value="2">2 — Repeat</option>
                <option value="3">3 — Restart</option>
                <option value="4">4 — Unplanned</option>
              </select></label>
            <label className="block"><span className={labelCls}>Document type (live runs)</span>
              <input name="documentType" className={inputCls} defaultValue="AF" maxLength={2} /></label>
            <label className="block"><span className={labelCls}>Posting date</span>
              <input type="date" name="postingDate" className={inputCls} defaultValue={today} required /></label>
            {runType === '3' && (
              <label className="block"><span className={labelCls}>Restart run reference</span>
                <input name="restartOfRunId" className={inputCls} placeholder="Failed run id" required /></label>
            )}
            {runType === '4' && (
              <label className="block"><span className={labelCls}>Unplanned depreciation reference</span>
                <input name="unplannedReference" className={inputCls} placeholder="Source transaction" /></label>
            )}
            <label className="flex items-end gap-2 pb-1">
              <input type="checkbox" name="testRun" checked={testRun}
                onChange={(e) => setTestRun(e.target.checked)} />
              <span className="text-sm">Test run (simulate only)</span>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-default min-h-11 sm:min-h-8" disabled>
              Execute test run
            </button>
            <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
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
        <p className="mt-2 text-sm text-ink-soft">Execute a run to see its asset-level log.</p>
      </section>
    </>
  );
}
