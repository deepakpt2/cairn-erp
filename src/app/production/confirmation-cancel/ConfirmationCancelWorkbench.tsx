'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import type { ConfirmationCancelDetail } from '@/modules/production/confirmation-cancel';
import { cancelConfirmationAction, type ConfirmationCancelActionState } from './actions';

const INITIAL: ConfirmationCancelActionState = { ok: false, message: '' };

function newRequestKey(): string {
  return `co13-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function ConfirmationCancelWorkbench({
  canCancel,
  detail,
}: {
  canCancel: boolean;
  detail: ConfirmationCancelDetail;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(cancelConfirmationAction, INITIAL);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [acknowledged, setAcknowledged] = useState(false);
  const succeeded = Boolean(state.ok && state.result);
  const cancellationNumber = succeeded ? state.result?.cancellationNumber ?? null : detail.cancellationNumber;
  const originalNumber = succeeded ? state.result?.confirmationNumber ?? detail.confirmationNumber : detail.confirmationNumber;
  const cancelled = detail.cancelled || succeeded;
  const blocked = !canCancel || !detail.eligible || detail.cancelled || succeeded;

  useEffect(() => {
    if (!state.ok || !state.result) return;
    if (!state.result.replayed) setRequestKey(newRequestKey());
    router.refresh();
  }, [state.ok, state.result, router]);

  return (
    <div className="space-y-4">
      <section className="rounded-card border border-line bg-surface p-4 text-sm shadow-card" data-co13-confirmation={detail.confirmationNumber}>
        <p>Confirmation {detail.confirmationNumber} · {detail.confirmationType} · {detail.confirmationLevel === 'HEADER' ? 'header' : `operation ${detail.operationNumber}`}</p>
        <p>Order {detail.orderNumber} · {detail.materialNumber} {detail.materialDescription} · plant {detail.plant}</p>
        <p>Posting date {detail.postingDate}. Entered by {detail.createdBy} at {detail.createdAt}. Those values are not changed here.</p>
        <p>Yield {detail.yieldQuantity} {detail.unit}. Scrap {detail.scrapQuantity}. Rework {detail.reworkQuantity}.</p>
        <p>Order status {detail.orderStatus}. Cancellation does not change it.</p>
        <p data-co13-status={cancelled ? 'cancelled' : 'open'} data-co13-original={originalNumber}>
          {cancelled
            ? `Cancelled by ${cancellationNumber}. Original confirmation ${originalNumber}.`
            : 'Not cancelled.'}
          {cancelled && detail.cancelledBy ? ` Entered by ${detail.cancelledBy}.` : ''}
          {cancelled && detail.cancelledAt ? ` At ${detail.cancelledAt}.` : ''}
        </p>
        {detail.cancellationReason && <p>Reason {detail.cancellationReason}</p>}
        {detail.activities.length > 0 ? (
          <ul data-co13-activities>
            {detail.activities.map((row) => (
              <li key={row.parameter}>{row.parameter} {row.quantity} {row.unit}</li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-soft">No activity is stored on this confirmation.</p>
        )}
        {detail.effects.length > 0 && (
          <ul data-co13-effects>
            {detail.effects.map((row) => (
              <li key={row.operationNumber}>Operation {row.operationNumber} · {row.confirmationType} · yield {row.yieldQuantity} {row.unit}</li>
            ))}
          </ul>
        )}
        <p className="text-ink-soft">A material document posted separately is not a confirmation record and is not reversed here.</p>
        <p>
          <Link href={`/production/production-order-display?order=${encodeURIComponent(detail.orderNumber)}`}>CO03</Link>
          {' '}shows the order. This screen does not change it.
        </p>
      </section>

      <form action={action} className="rounded-card border border-line bg-surface p-4 shadow-card">
        <input type="hidden" name="requestKey" value={requestKey} />
        <input type="hidden" name="confirmationNumber" value={detail.confirmationNumber} />
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Cancellation reason</span>
          <input name="reason" maxLength={200} className="input w-full" disabled={blocked} defaultValue={detail.cancellationReason ?? ''} />
        </label>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="confirmCancel"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            disabled={blocked}
          />
          <span>Cancel this confirmation. The original quantities are not changed. No goods movement is posted.</span>
        </label>
        <div className="mt-3">
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={blocked || !acknowledged || pending} data-co13-cancel>
            {pending ? 'Cancelling…' : cancelled ? 'Already cancelled' : 'Cancel confirmation'}
          </button>
        </div>
        {state.message && (
          <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`} data-co13-message>
            {state.message}{state.remedy ? ` ${state.remedy}` : ''}
          </p>
        )}
        {succeeded && state.result && (
          <p className="mt-2 text-sm" data-co13-cancellation={state.result.cancellationNumber} data-co13-original={state.result.confirmationNumber}>
            Cancellation {state.result.cancellationNumber} is linked to confirmation {state.result.confirmationNumber}.
            {' '}
            <Link href={`/production/production-order-display?order=${encodeURIComponent(state.result.orderNumber)}`}>
              Order {state.result.orderNumber}
            </Link>
            {' '}still has status {state.result.orderStatus}.
          </p>
        )}
      </form>
    </div>
  );
}
