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
        {loaded.productionVersion && <p>Production version {loaded.productionVersion} is the one copied onto this order. A later routing edit is not read.</p>}
        {loaded.blockingReason && <p className="text-red-700">{loaded.blockingReason}</p>}
        {loaded.gaps.map((gap) => <p key={gap} className="text-ink-soft">{gap}</p>)}
      </section>

      {loaded.operations.length > 0 && (
        <table className="w-full text-sm" data-co11n-operations>
          <thead>
            <tr className="text-left text-ink-faint">
              <th>Execution order</th>
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
                <td className="py-1">{row.executionOrder}</td>
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
          <p className="mt-3 text-sm text-ink-soft" data-co11n-movement-config>
            {loaded.movementConfig.note} A final confirmation does not clear a reservation. Leaving the screen saves nothing.
          </p>
          {state.ticket && (
            <section className="mt-3 border-t border-line pt-3" aria-label="Goods movements caused by this confirmation" data-co11n-movements>
              <p className="text-sm font-medium">
                {state.ticket.written
                  ? 'Goods movements posted with this confirmation'
                  : 'Goods movements this confirmation would cause'}
              </p>
              <p className="mt-1 text-2xs text-ink-soft" role="status">{state.ticket.movementNote}</p>
              {state.ticket.replayed && (
                <p className="mt-1 text-2xs" data-co11n-replay>
                  This request was already saved. The confirmation and the documents it caused were not changed and nothing was posted again.
                </p>
              )}
              {state.ticket.movements.length === 0 ? (
                <p className="mt-1 text-2xs text-ink-soft">
                  No goods movement stands behind this confirmation. Stock was not changed.
                </p>
              ) : (
                <table className="mt-1 w-full text-sm">
                  <thead>
                    <tr className="text-left text-ink-faint">
                      <th scope="col">Movement</th>
                      <th scope="col">Material</th>
                      <th scope="col">Quantity</th>
                      <th scope="col">Location</th>
                      <th scope="col">Order item</th>
                      <th scope="col">Material document</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.ticket.movements.map((row) => (
                      <tr key={`${row.kind}-${row.materialNumber}-${row.itemNumber ?? 0}`} data-co11n-movement={row.kind}>
                        <td className="py-1">
                          {row.kind === 'ISSUE' ? `Goods issue ${row.movementCode}` : `Goods receipt ${row.movementCode}`}
                          {row.kind === 'ISSUE' && !row.posted && row.requiredQuantity !== null && (
                            <span className="block text-2xs text-ink-soft">
                              {row.issuedQuantity} already issued of {row.requiredQuantity} required. {row.openQuantity} is open.
                            </span>
                          )}
                        </td>
                        <td>{row.materialNumber}</td>
                        <td>{row.quantity} {row.unit}</td>
                        <td>{row.kind === 'ISSUE' ? row.storageLocation ?? 'No location on the component' : 'Plant default'}</td>
                        <td>{row.itemNumber ?? '—'}</td>
                        <td>
                          {row.materialDocumentNumber ? (
                            <Link href={`/inventory/material-documents?document=${encodeURIComponent(row.materialDocumentNumber)}&fiscalYear=${encodeURIComponent(String(row.documentYear ?? ''))}`}>
                              {row.materialDocumentNumber}
                            </Link>
                          ) : 'not posted yet'}
                          {row.materialDocumentNumber && !row.standing ? ' — reversed' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {state.ticket.movementPlan && state.ticket.movementPlan.skipped.length > 0 && (
                <ul className="mt-1 space-y-1 text-2xs text-ink-soft" data-co11n-movement-skipped>
                  {state.ticket.movementPlan.skipped.map((row) => (
                    <li key={`${row.itemNumber}-${row.materialNumber}`}>
                      Item {row.itemNumber} {row.materialNumber}: {row.reason}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-2xs text-ink-soft">
                A quantity is drawn from what the component still needs on this order. Scrap is not grossed into it, and a reservation is not cleared by it.
              </p>
            </section>
          )}
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
              Confirmation <span className="font-medium">{state.ticket.confirmationNumber}</span> stands for order {state.ticket.orderNumber} operation {state.ticket.operationNumber}.
              {' '}Order {state.ticket.orderNumber}
              {' '}still has status {state.ticket.orderStatus}.
              {' '}{state.ticket.movementsPosted === 0
                ? 'No goods movement was posted with it.'
                : `${state.ticket.movementsPosted} goods-movement line${state.ticket.movementsPosted === 1 ? '' : 's'} posted with it.`}
              {' '}<Link href={`/production/confirmation-cancel?confirmation=${encodeURIComponent(state.ticket.confirmationNumber)}`}>Cancel is CO13</Link>
            </p>
          )}
        </form>
      )}
    </div>
  );
}
