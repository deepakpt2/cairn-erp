'use client';

import { useActionState } from 'react';

import type { SalesAvailabilityLineResult } from '@/modules/sales/availability-check';
import { confirmAvailabilityAction, simulateAvailabilityAction, type AvailabilityActionState } from './availability-actions';

const EMPTY: AvailabilityActionState = { ok: false };

const CHANGE: Record<string, string> = {
  RAISED: 'raised', LOWERED: 'lowered', UNCHANGED: 'unchanged', FIRST: 'first confirmation', DATE_ONLY: 'date changes',
};

function Proposed({ line }: { line: SalesAvailabilityLineResult }) {
  if (!line.proposed) {
    return <span className="text-ink-soft">{line.skipped?.message}{line.skipped?.remedy ? ` ${line.skipped.remedy}` : ''}</span>;
  }
  const p = line.proposed;
  return (
    <div>
      <span className="num font-medium">{Number(p.confirmedQuantity).toFixed(3)}</span> {line.quantityUnit}
      {p.confirmedDate ? <> on <span className="code">{p.confirmedDate}</span></> : null}
      {p.partial ? <span className="chip chip-warn ml-1">partial</span> : null}
      {p.delayed ? <span className="chip chip-warn ml-1">later than asked</span> : null}
      {p.remainderUndated ? (
        <div className="text-xs text-ink-soft">
          The remainder has no date: it does not stand by {p.horizonEnd ?? 'the end of the search'}.
        </div>
      ) : null}
      {p.basis.length > 0 ? (
        <details className="text-xs text-ink-soft">
          <summary>{p.basis.length} element{p.basis.length === 1 ? '' : 's'} counted (rule {p.checkingRule}, group {p.checkingGroup})</summary>
          <ul>
            {p.basis.map((b, i) => (
              <li key={i} className="code">{b.date} {b.direction === 'RECEIPT' ? '+' : '−'}{b.quantity} {b.elementType.toLowerCase().replace(/_/g, ' ')} {b.documentNumber}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function AvailabilityPanel({ orderNumber }: { orderNumber: string }) {
  const [simulated, simulate, simulating] = useActionState(simulateAvailabilityAction, EMPTY);
  const [written, write, writing] = useActionState(confirmAvailabilityAction, EMPTY);
  const state = written.message ? written : simulated;
  const result = state.result;
  return (
    <section className="mt-4 space-y-2" aria-label="Availability check">
      <h3 className="text-sm font-semibold">Check availability</h3>
      <p className="text-xs text-ink-soft">
        Asks the plant again what it can promise. The answer is shown beside the confirmation that stands — a new check can raise a
        promise as well as lower it — and nothing is written until you confirm. A material with no checking group is not checked.
      </p>
      <form action={simulate} className="flex gap-2">
        <input type="hidden" name="orderNumber" value={orderNumber} />
        <button type="submit" disabled={simulating} className="btn btn-default min-h-11 sm:min-h-8">{simulating ? 'Checking…' : 'Check availability'}</button>
      </form>
      {state.message ? (
        <div className={state.ok ? 'panel panel-success p-3 text-sm' : 'panel panel-danger p-3 text-sm'} role="status">
          <p className="font-medium">{state.message}</p>
          {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
        </div>
      ) : null}
      {result ? (
        <>
          <p className="text-xs text-ink-soft">
            Checking rule {result.checkingRule}{result.ruleFromDocumentType ? ' (named by the document type)' : ' (the order rule, by default)'}.
          </p>
          <div className="overflow-x-auto">
            <table className="grid-table text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-faint">
                  <th>Item</th><th>Material</th><th>Requested</th><th className="text-right">Ordered</th>
                  <th>Standing confirmation</th><th className="text-right">Available then</th><th>Proposed</th><th>Change</th>
                </tr>
              </thead>
              <tbody>
                {result.lines.map((line) => (
                  <tr key={line.lineNumber}>
                    <td>{line.lineNumber}</td>
                    <td>{line.materialNumber}</td>
                    <td className="code">{line.requestedDate}</td>
                    <td className="text-right num">{Number(line.orderQuantity).toFixed(3)}</td>
                    <td>
                      {line.standing.confirmedQuantity === null ? <span className="text-ink-soft">never checked</span> : <span className="num">{Number(line.standing.confirmedQuantity).toFixed(3)}</span>}
                      {line.standing.confirmedDate ? <> on <span className="code">{line.standing.confirmedDate}</span></> : null}
                    </td>
                    <td className="text-right num">{line.proposed ? Number(line.proposed.availableAtRequestedDate).toFixed(3) : '—'}</td>
                    <td><Proposed line={line} /></td>
                    <td>{line.change ? <span className={line.change === 'RAISED' ? 'chip chip-ok' : line.change === 'LOWERED' ? 'chip chip-warn' : 'chip'}>{CHANGE[line.change]}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result.written ? (
            <form action={write} className="flex gap-2">
              <input type="hidden" name="orderNumber" value={orderNumber} />
              <button type="submit" disabled={writing} className="btn btn-primary min-h-11 sm:min-h-8">
                {writing ? 'Writing…' : 'Write these confirmations'}
              </button>
              <span className="self-center text-xs text-ink-soft">Replaces the standing confirmations; the order&apos;s change document records both.</span>
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
