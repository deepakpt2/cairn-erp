'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';

import type { OrderConfirmationLoad } from '@/modules/production/order-confirmation';
import { enterOrderConfirmationAction, type OrderConfirmationActionState } from './actions';

const INITIAL: OrderConfirmationActionState = { ok: false, message: '' };

function newRequestKey(): string {
  return `co15-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function OrderConfirmationWorkbench({
  canConfirm,
  loaded,
}: {
  canConfirm: boolean;
  loaded: OrderConfirmationLoad;
}) {
  const [state, action, pending] = useActionState(enterOrderConfirmationAction, INITIAL);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const blocked = loaded.status !== 'RELEASED' || loaded.eligible.length === 0;

  useEffect(() => {
    if (state.ok && state.confirmation?.written) setRequestKey(newRequestKey());
  }, [state]);

  return (
    <div className="space-y-4">
      <section className="rounded-card border border-line bg-surface p-4 text-sm shadow-card" data-co15-order={loaded.orderNumber}>
        <p>{loaded.orderNumber} · {loaded.materialNumber} {loaded.materialDescription}</p>
        <p>Plant {loaded.plant}. Quantity {loaded.orderQuantity} {loaded.unit}. Status {loaded.status}. Record version {loaded.version}.</p>
        <p>Previously confirmed at header {loaded.previouslyConfirmed} {loaded.unit}. Remaining {loaded.remainingQuantity} {loaded.unit}. Scrap {loaded.previouslyScrapped}. Rework {loaded.previouslyReworked}.</p>
        <p>Start {loaded.scheduledStart}. Finish {loaded.scheduledFinish}. Those dates are not rewritten by a confirmation.</p>
        {loaded.productionVersion && <p>Production version {loaded.productionVersion}. It is not stored on the order.</p>}
        {loaded.blockingReason && <p className="text-red-700">{loaded.blockingReason}</p>}
        {loaded.gaps.map((gap) => <p key={gap} className="text-ink-soft">{gap}</p>)}
      </section>

      {loaded.operations.length > 0 && (
        <table className="w-full text-sm" data-co15-operations>
          <thead>
            <tr className="text-left text-ink-faint">
              <th>Operation</th>
              <th>Work center</th>
              <th>Confirmed</th>
              <th>Header effect</th>
            </tr>
          </thead>
          <tbody>
            {loaded.operations.map((row) => (
              <tr key={row.operationNumber} data-co15-operation={row.operationNumber}>
                <td className="py-1">{row.operationNumber} {row.shortText ?? ''}</td>
                <td>{row.workCenter ?? '—'}</td>
                <td>{row.yieldQuantity} {loaded.unit}</td>
                <td>{loaded.eligible.includes(row.operationNumber) ? 'Eligible' : row.blockingReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form action={action} className="rounded-card border border-line bg-surface p-4 shadow-card">
        <input type="hidden" name="requestKey" value={requestKey} />
        <input type="hidden" name="orderNumber" value={loaded.orderNumber} />
        <input type="hidden" name="productionVersion" value={loaded.productionVersion ?? ''} />
        <input type="hidden" name="expectedVersion" value={loaded.version} />
        <input type="hidden" name="unit" value={loaded.unit} />
        <p className="text-sm">The header quantity is applied to every eligible operation. It is not split across them, and a time-ticket number is not created.</p>
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
            <span>Final blocks another confirmation of each affected operation. The order status stays {loaded.status}.</span>
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
        <p className="mt-3 text-sm text-ink-soft" data-co15-movements>No goods movement was proposed. Backflush is not configured, and automatic goods receipt is not configured.</p>
        <p className="mt-1 text-sm text-ink-soft">Leaving the screen saves nothing. A posted confirmation is not edited here.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="submit" name="intent" value="check" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canConfirm || blocked || pending} data-co15-check>
            {pending ? 'Checking…' : 'Check'}
          </button>
          <button type="submit" name="intent" value="save" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canConfirm || blocked || pending} data-co15-save>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
        {state.message && (
          <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
            {state.message}{state.remedy ? ` ${state.remedy}` : ''}
          </p>
        )}
        {state.confirmation && (
          <div className="mt-3 text-sm" data-co15-result={state.confirmation.confirmationNumber || 'preview'}>
            {state.confirmation.confirmationNumber && (
              <p>
                <Link href={`/production/production-order-display?order=${encodeURIComponent(state.confirmation.orderNumber)}`}>
                  Order {state.confirmation.orderNumber}
                </Link>
                {' '}still has status {state.confirmation.orderStatus}. Confirmation {state.confirmation.confirmationNumber} is a header confirmation.
              </p>
            )}
            {state.confirmation.effects.length > 0 && (
              <ul data-co15-effects>
                {state.confirmation.effects.map((row) => (
                  <li key={row.operationNumber}>
                    Operation {row.operationNumber} effect {row.yieldQuantity} {state.confirmation?.unit} ({row.quantityBasis === 'OPERATION_QUANTITY' ? 'operation quantity' : 'order quantity'}). No separate confirmation number.
                  </li>
                ))}
              </ul>
            )}
            {state.confirmation.skipped.length > 0 && (
              <ul>
                {state.confirmation.skipped.map((row) => (
                  <li key={row.operationNumber}>Operation {row.operationNumber} was not affected. {row.reason}</li>
                ))}
              </ul>
            )}
            <p>{state.confirmation.movementNote}</p>
          </div>
        )}
      </form>
    </div>
  );
}
