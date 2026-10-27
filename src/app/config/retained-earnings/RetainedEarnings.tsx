'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import {
  STANDARD_RETAINED_EARNINGS_INDICATOR,
  type RetainedEarningsChartOption, type RetainedEarningsRow,
} from '@/modules/foundation/retained-earnings-vocabulary';
import { deleteAction, maintainAction, type RetainedEarningsActionState } from './actions';

const INITIAL: RetainedEarningsActionState = { ok: false, message: '' };
const ACTIVITY = 'CFG.FIN.RETAINED.DEFINE';

function Message({ state }: { state: RetainedEarningsActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

function determinationArgument(chart: string, indicator: string) {
  return `${chart.trim()}/${indicator.trim()}`;
}

/**
 * Retained earnings definition shell (SCR-121 stage 1): the
 * per-chart indicator determinations and the maintenance
 * forms. The values arrive with the service in stage 3.
 */
export function RetainedEarnings({ rows, charts, canMaintain }: {
  rows: RetainedEarningsRow[];
  charts: RetainedEarningsChartOption[];
  canMaintain: boolean;
}) {
  return (
    <>
      <section aria-labelledby="re-list" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="re-list" className="text-sm font-semibold">Configured retained earnings accounts</h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No retained earnings account stands defined. Balance carryforward cannot close the P&L accounts of a chart until one stands.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Chart of Accounts</th><th className="px-2 py-2">Indicator</th>
                  <th className="px-2 py-2">Retained Earnings Account</th><th className="px-2 py-2">Account Name</th>
                  <th className="px-2 py-2">P&amp;L Accounts</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.chartOfAccounts}|${row.indicator}`} className="border-t border-line">
                    <td className="code px-2 py-2">{row.chartOfAccounts}</td>
                    <td className="code px-2 py-2">{row.indicator}</td>
                    <td className="code px-2 py-2">{row.glAccount}</td>
                    <td className="px-2 py-2">{row.accountName}</td>
                    <td className="tabular px-2 py-2">{row.plAccounts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canMaintain && (
        <>
          <MaintainDetermination rows={rows} charts={charts} />
          <DeleteDetermination />
        </>
      )}
    </>
  );
}

function MaintainDetermination({ rows, charts }: {
  rows: RetainedEarningsRow[];
  charts: RetainedEarningsChartOption[];
}) {
  const [maintainState, maintain, maintaining] = useActionState(maintainAction, INITIAL);
  const [chart, setChart] = useState(charts[0]?.chartOfAccounts ?? '');
  const [indicator, setIndicator] = useState(STANDARD_RETAINED_EARNINGS_INDICATOR);
  const [engaged, setEngaged] = useState(false);
  const existing = rows.some((row) => determinationArgument(row.chartOfAccounts, row.indicator).toUpperCase() === determinationArgument(chart, indicator).toUpperCase());
  const lock = useChangeLock('RETAINED_EARNINGS', determinationArgument(chart, indicator), ACTIVITY, engaged && existing);
  const blocked = existing && lock?.mode === 'DISPLAY';
  return (
    <section aria-labelledby="re-maintain" className="rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id="re-maintain" className="text-sm font-semibold">Maintain an indicator</h2>
      <form action={maintain} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onFocus={() => setEngaged(true)} onSubmit={(event) => { if (existing && lock?.mode !== 'CHANGE') { event.preventDefault(); setEngaged(true); } }}>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Chart of Accounts</span>
          <select name="chartOfAccounts" className="field-input" required value={chart} onChange={(event) => setChart(event.target.value)}>
            {charts.map((entry) => (
              <option key={entry.chartOfAccounts} value={entry.chartOfAccounts}>
                {entry.chartOfAccounts} — {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Indicator (1 character)</span>
          <input name="indicator" className="field-input code" maxLength={1} required value={indicator} onChange={(event) => setIndicator(event.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Retained Earnings Account</span>
          <input name="glAccount" className="field-input code" maxLength={10} required />
        </label>
        <label className="block sm:col-span-2 lg:col-span-3">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason (required)</span>
          <input name="reason" className="field-input" required />
        </label>
        <div className="sm:col-span-2 lg:col-span-3">
          <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} remedy={lock?.remedy} />
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={maintaining || blocked}>Save determination</button>
        </div>
        <Message state={maintainState} />
      </form>
    </section>
  );
}

function DeleteDetermination() {
  const [deleteState, remove, deleting] = useActionState(deleteAction, INITIAL);
  const [chart, setChart] = useState('');
  const [indicator, setIndicator] = useState('');
  const [engaged, setEngaged] = useState(false);
  const ready = chart.trim() !== '' && indicator.trim() !== '';
  const lock = useChangeLock('RETAINED_EARNINGS', determinationArgument(chart, indicator), ACTIVITY, engaged && ready);
  const held = !ready || lock?.mode === 'CHANGE';
  return (
    <section aria-labelledby="re-delete" className="rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id="re-delete" className="text-sm font-semibold">Delete an indicator</h2>
      <form action={remove} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onFocus={() => setEngaged(true)} onSubmit={(event) => { if (lock?.mode !== 'CHANGE') { event.preventDefault(); setEngaged(true); } }}>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Chart of Accounts</span>
          <input name="chartOfAccounts" className="field-input code" maxLength={4} required value={chart} onChange={(event) => setChart(event.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Indicator</span>
          <input name="indicator" className="field-input code" maxLength={1} required value={indicator} onChange={(event) => setIndicator(event.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason (required)</span>
          <input name="reason" className="field-input" required />
        </label>
        <div className="sm:col-span-2 lg:col-span-3">
          <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} remedy={lock?.remedy} />
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={deleting || !held}>Delete determination</button>
        </div>
        <Message state={deleteState} />
      </form>
      <p className="mt-2 text-sm text-ink-soft">
        Deletion refuses while a P&amp;L account of the chart carries the indicator.
      </p>
    </section>
  );
}
