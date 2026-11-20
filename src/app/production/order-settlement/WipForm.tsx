'use client';

import { useActionState, useState } from 'react';

import { costBackfillAction, runWipAction, type CostBackfillActionState, type WipActionState } from './actions';

const WIP_INITIAL: WipActionState = { ok: false };
const COST_INITIAL: CostBackfillActionState = { ok: false };

/**
 * Period-end close beside the settlement: financial WIP (actual-cost net balance) and the activity cost of
 * confirmations that were never costed. Both have a read-only test run; an update posts only through the journal.
 */
export default function WipForm({ orderNumber, method }: { orderNumber: string; method: string }) {
  const [wipState, wipAction, wipPending] = useActionState(runWipAction, WIP_INITIAL);
  const [costState, costAction, costPending] = useActionState(costBackfillAction, COST_INITIAL);
  const [order, setOrder] = useState(orderNumber);
  const [fiscalYear, setFiscalYear] = useState('2026');
  const [period, setPeriod] = useState('1');
  const [testRun, setTestRun] = useState(true);
  const [costOrder, setCostOrder] = useState(orderNumber);
  const [costPreview, setCostPreview] = useState(true);
  const requestKey = `wip-${order}-${fiscalYear}-${period}`;

  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-label="Work in process">
        <h2 className="text-lg font-semibold">Work in process (period end)</h2>
        <p className="text-sm text-ink-soft" data-wip-method>{method}</p>
        <form action={wipAction} className="space-y-3">
          <input type="hidden" name="payload" value={JSON.stringify({ orderNumber: order, fiscalYear: Number(fiscalYear), period: Number(period), testRun, requestKey })} />
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm"><span className="mb-1 block text-ink-soft">Production order</span>
              <input className="input w-full" value={order} maxLength={12} onChange={(event) => setOrder(event.target.value)} /></label>
            <label className="block text-sm"><span className="mb-1 block text-ink-soft">Fiscal year</span>
              <input className="input w-full" value={fiscalYear} onChange={(event) => setFiscalYear(event.target.value)} /></label>
            <label className="block text-sm"><span className="mb-1 block text-ink-soft">Period</span>
              <input className="input w-full" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={testRun} onChange={(event) => setTestRun(event.target.checked)} />
            Test run. Nothing is posted.
          </label>
          <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={wipPending}>
            {wipPending ? 'Calculating' : testRun ? 'Calculate WIP' : 'Post WIP'}
          </button>
        </form>
        {wipState.message && <p className={wipState.ok ? 'text-sm' : 'text-sm text-signal-error'} role={wipState.ok ? 'status' : 'alert'}>{wipState.message}</p>}
        {wipState.result && (
          <div className="overflow-x-auto">
            <table className="grid-table text-sm" data-wip-result>
              <thead><tr className="text-left text-ink-faint"><th>Order</th><th>Status</th><th>Costs</th><th>Output credits</th><th>Eligible WIP</th><th>Posted WIP</th><th>Delta</th><th>Accounts (WIP / change)</th><th>Document</th><th>Explanation</th></tr></thead>
              <tbody>{wipState.result.orders.map((row) => (
                <tr key={row.orderNumber} data-wip-order={row.orderNumber} data-wip-status={row.status}>
                  <td>{row.orderNumber} · {row.orderStatus || '—'}<br />{row.fiscalYear}-{String(row.period).padStart(2, '0')}{row.periodEnd ? ` · to ${row.periodEnd}` : ''}</td>
                  <td>{row.status}</td>
                  <td>{row.costTotal} {row.currency ?? ''}</td><td>{row.outputTotal}</td><td>{row.eligibleWip}</td><td>{row.previousPosted}</td><td>{row.delta}</td>
                  <td>{row.wipAccount ?? '—'} / {row.changeAccount ?? '—'}{row.accountsAsPosted ? ' (as posted)' : ''}</td>
                  <td>{row.document ? `${row.document.documentNumber}/${row.document.fiscalYear}` : '—'}</td>
                  <td>{row.reasons.join(' ')}{row.remedy ? ` ${row.remedy}` : ''}
                    {row.components.length > 0 && <><br />{row.components.map((c) => `${c.role} ${c.account}: ${c.net}`).join(' · ')} · journal net {row.reportNet}</>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3" aria-label="Activity cost of confirmations not yet costed">
        <h2 className="text-lg font-semibold">Confirmed activity not yet costed</h2>
        <p className="text-sm text-ink-soft">
          A confirmation saved before activity costing was configured, or one whose cost could not be posted, is not costed automatically. Preview values the
          confirmed quantity at the work center&apos;s configured plan rate (not an actual rate) and writes nothing; the update posts it once, to the order against the sender cost center.
        </p>
        <form action={costAction} className="space-y-3">
          <input type="hidden" name="payload" value={JSON.stringify({ orderNumber: costOrder, preview: costPreview })} />
          <label className="block text-sm"><span className="mb-1 block text-ink-soft">Production order</span>
            <input className="input w-full sm:w-64" value={costOrder} maxLength={12} onChange={(event) => setCostOrder(event.target.value)} /></label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={costPreview} onChange={(event) => setCostPreview(event.target.checked)} />
            Preview. Nothing is posted.
          </label>
          <button className="btn btn-default min-h-11 sm:min-h-8" type="submit" disabled={costPending}>{costPending ? 'Working' : costPreview ? 'Preview cost' : 'Post cost'}</button>
        </form>
        {costState.message && <p className={costState.ok ? 'text-sm' : 'text-sm text-signal-error'} role={costState.ok ? 'status' : 'alert'}>{costState.message}</p>}
        {costState.result && (
          <ul className="space-y-1 text-sm" data-cost-backfill-result>
            {costState.result.runs.flatMap((run) => run.outcomes.map((outcome) => (
              <li key={`${run.confirmationNumber}-${outcome.parameter}`}>
                {run.confirmationNumber} · {outcome.parameter} · {outcome.status}{outcome.amount ? ` · ${outcome.amount} ${outcome.currency ?? ''}` : ''}
                {outcome.journalDocument ? ` · ${outcome.journalDocument}` : ''}{outcome.message ? ` — ${outcome.message}` : ''}{outcome.remedy ? ` ${outcome.remedy}` : ''}
              </li>
            )))}
            {costState.result.confirmations === 0 && <li>No confirmation of this order is waiting for activity cost.</li>}
          </ul>
        )}
      </section>
    </div>
  );
}
