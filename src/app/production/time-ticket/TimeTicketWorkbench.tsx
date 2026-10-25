'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';

import type { TimeTicketLoad } from '@/modules/production/time-ticket';
import { enterTimeTicketAction, type TimeTicketActionState } from './actions';

const INITIAL: TimeTicketActionState = { ok: false, message: '' };

function newRequestKey(): string {
  return `co11n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function TimeTicketWorkbench({
  canConfirm,
  loaded,
}: {
  canConfirm: boolean;
  loaded: TimeTicketLoad;
}) {
  const [state, action, pending] = useActionState(enterTimeTicketAction, INITIAL);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const operation = loaded.selected;

  useEffect(() => {
    if (state.ok && state.ticket?.written) setRequestKey(newRequestKey());
  }, [state]);

  return (
    <div className="space-y-4">
      <section className="rounded-card border border-line bg-surface p-4 text-sm shadow-card" data-co11n-order={loaded.orderNumber}>
        <p>{loaded.orderNumber} · {loaded.materialNumber} {loaded.materialDescription}</p>
        <p>Plant {loaded.plant}. Quantity {loaded.orderQuantity} {loaded.unit}. Status {loaded.status}. Record version {loaded.version}.</p>
        <p>Start {loaded.scheduledStart}. Finish {loaded.scheduledFinish}. Those dates are not rewritten by a confirmation.</p>
        {loaded.productionVersion && <p>Production version {loaded.productionVersion}. It is not stored on the order.</p>}
        {loaded.blockingReason && <p className="text-red-700">{loaded.blockingReason}</p>}
        {loaded.gaps.map((gap) => <p key={gap} className="text-ink-soft">{gap}</p>)}
      </section>

      {loaded.operations.length > 0 && (
        <table className="w-full text-sm" data-co11n-operations>
          <thead>
            <tr className="text-left text-ink-faint">
              <th>Operation</th>
              <th>Work center</th>
              <th>Confirmed</th>
              <th>Remaining</th>
              <th>Eligibility</th>
            </tr>
          </thead>
          <tbody>
            {loaded.operations.map((row) => (
              <tr key={row.operationNumber} data-co11n-operation={row.operationNumber}>
                <td className="py-1">
                  <Link href={`/production/time-ticket?order=${encodeURIComponent(loaded.orderNumber)}&operation=${encodeURIComponent(row.operationNumber)}${loaded.productionVersion ? `&version=${encodeURIComponent(loaded.productionVersion)}` : ''}`}>
                    {row.operationNumber}
                  </Link>
                  {' '}{row.shortText ?? ''}
                </td>
                <td>{row.workCenter ?? '—'}</td>
                <td>{row.yieldQuantity} {loaded.unit}</td>
                <td>{row.remainingQuantity}</td>
                <td>{row.confirmable ? 'Confirmable' : row.blockingReason}{row.cancellationNote ? ` ${row.cancellationNote}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {operation && (
        <form action={action} className="rounded-card border border-line bg-surface p-4 shadow-card">
          <input type="hidden" name="requestKey" value={requestKey} />
          <input type="hidden" name="orderNumber" value={loaded.orderNumber} />
          <input type="hidden" name="operationNumber" value={operation.operationNumber} />
          <input type="hidden" name="productionVersion" value={loaded.productionVersion ?? ''} />
          <input type="hidden" name="expectedVersion" value={loaded.version} />
          <input type="hidden" name="unit" value={loaded.unit} />
          <p className="text-sm">Operation {operation.operationNumber} {operation.shortText ?? ''}. Control key {operation.controlKey}. Work center {operation.workCenter ?? '—'} is not changed here.</p>
          <p className="mt-1 text-sm text-ink-soft">Previously confirmed yield {operation.yieldQuantity}, scrap {operation.scrapQuantity}, rework {operation.reworkQuantity}. Remaining {operation.remainingQuantity} {loaded.unit}.</p>
          {operation.cancellationNote && <p className="mt-1 text-sm" data-co11n-cancellation>{operation.cancellationNote}</p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block text-ink-soft">Confirmation type</span>
              <select name="confirmationType" className="input w-full" required defaultValue="">
                <option value="">Choose</option>
                <option value="PARTIAL">Partial</option>
                <option value="FINAL">Final</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-ink-soft">Posting date</span>
              <input type="date" name="postingDate" required className="input w-full" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-ink-soft">Yield</span>
              <input name="yieldQuantity" inputMode="decimal" className="input w-full" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-ink-soft">Scrap</span>
              <input name="scrapQuantity" inputMode="decimal" className="input w-full" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-ink-soft">Rework</span>
              <input name="reworkQuantity" inputMode="decimal" className="input w-full" />
            </label>
            <label className="flex items-end gap-2 text-sm">
              <input type="checkbox" name="confirmFinal" />
              <span>Final blocks another confirmation of this operation. The order status stays {loaded.status}.</span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-ink-soft">Actual start</span>
              <span className="flex gap-2">
                <input type="date" name="executionStartDate" className="input" />
                <input type="time" name="executionStartTime" className="input" />
              </span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-ink-soft">Actual finish</span>
              <span className="flex gap-2">
                <input type="date" name="executionFinishDate" className="input" />
                <input type="time" name="executionFinishTime" className="input" />
              </span>
            </label>
            <label className="block text-sm sm:col-span-3">
              <span className="mb-1 block text-ink-soft">Note</span>
              <input name="note" maxLength={200} className="input w-full" />
            </label>
          </div>
          {operation.activities.length > 0 ? (
            <table className="mt-3 w-full text-sm" data-co11n-activities>
              <thead>
                <tr className="text-left text-ink-faint">
                  <th>Activity</th>
                  <th>Suggested</th>
                  <th>Actual</th>
                </tr>
              </thead>
              <tbody>
                {operation.activities.map((row) => (
                  <tr key={row.parameter}>
                    <td className="py-1">{row.parameter} {row.description} {row.required ? '(required)' : ''}</td>
                    <td>{row.suggested ?? '—'} {row.unit}</td>
                    <td>
                      <input type="hidden" name="activityParameter" value={row.parameter} />
                      <input type="hidden" name="activityUnit" value={row.unit} />
                      <input name="activityQuantity" inputMode="decimal" className="input w-28" aria-label={row.parameter} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-3 text-sm text-ink-soft">No activity is configured on this operation. Setup, machine, and labor are not invented.</p>
          )}
          <p className="mt-3 text-sm text-ink-soft">A final confirmation does not clear a reservation and does not post a goods movement. Leaving the screen saves nothing.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" name="intent" value="check" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canConfirm || !operation.confirmable || pending} data-co11n-check>
              {pending ? 'Checking…' : 'Check'}
            </button>
            <button type="submit" name="intent" value="save" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canConfirm || !operation.confirmable || pending} data-co11n-save>
              {pending ? 'Saving…' : 'Save'}
            </button>
          </div>
          {state.message && (
            <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
              {state.message}{state.remedy ? ` ${state.remedy}` : ''}
            </p>
          )}
          {state.ticket?.confirmationNumber && (
            <p className="mt-2 text-sm" data-co11n-confirmation={state.ticket.confirmationNumber}>
              <Link href={`/production/production-order-display?order=${encodeURIComponent(state.ticket.orderNumber)}`}>
                Order {state.ticket.orderNumber}
              </Link>
              {' '}still has status {state.ticket.orderStatus}.
              {' '}<Link href={`/production/confirmation-cancel?confirmation=${encodeURIComponent(state.ticket.confirmationNumber)}`}>Cancel is CO13</Link>
            </p>
          )}
        </form>
      )}
    </div>
  );
}
