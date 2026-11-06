'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

import type { ProductionCogiDetail } from '@/modules/production/production-cogi';
import {
  correctProductionCogiAction,
  discardProductionCogiAction,
  retryProductionCogiAction,
  type ProductionCogiActionState,
} from './actions';

const initial: ProductionCogiActionState = { ok: false, message: '' };

function stamp(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function quantity(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}

export default function ProductionCogiWorkbench({ detail }: { detail: ProductionCogiDetail }) {
  const router = useRouter();
  const [correctionState, correctAction, correcting] = useActionState(correctProductionCogiAction, initial);
  const [retryState, retryAction, retrying] = useActionState(retryProductionCogiAction, initial);
  const [discardState, discardAction, discarding] = useActionState(discardProductionCogiAction, initial);
  const failure = detail.failure;
  const effectiveLines = detail.effectivePayload.lines;
  const editable = failure.status === 'PENDING' || failure.status === 'FAILED';
  const discardable = failure.status !== 'POSTED' && failure.status !== 'PROCESSING' && failure.status !== 'DISCARDED';
  const retryable = failure.status === 'PENDING' || failure.status === 'FAILED';

  useEffect(() => {
    if (correctionState.message || retryState.message || discardState.message) router.refresh();
  }, [correctionState.message, retryState.message, discardState.message, router]);

  return (
    <section className="space-y-4 rounded border border-line bg-surface p-3 sm:p-4" data-cogi-detail>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
        <div>
          <span className="code text-ink-faint">COGI record · {failure.id}</span>
          <h2 className="mt-1 text-lg font-semibold">{failure.movementKind} · confirmation {failure.confirmationNumber}</h2>
          <p className="text-sm text-ink-soft">Order {failure.orderNumber} · operation {failure.operationNumber} · plant {failure.plant} · status <strong>{failure.status}</strong></p>
        </div>
        <div className="text-right text-sm text-ink-soft">Attempted {failure.attemptCount} time(s)<br />Current correction revision {detail.currentRevision}</div>
      </header>

      {failure.errorText && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="status"><strong>{failure.failureCode ?? 'Posting error'}</strong><br />{failure.errorText}</div>}
      {failure.status === 'POSTED' && <p className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900">Material document {failure.materialDocumentNumber}/{failure.documentYear} stands. Reprocessing will not create another document.</p>}
      {failure.status === 'BLOCKED' && <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm">The source confirmation was cancelled. This movement cannot be posted; retain it for review or discard it with a reason.</p>}
      {failure.status === 'DISCARDED' && <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm">Discarded by {failure.discardedBy} at {stamp(failure.discardedAt)}. Reason: {failure.dispositionReason}. The failed record and reservation state were retained.</p>}

      <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <p><span className="text-ink-faint">Posting date</span><br />{failure.postingDate}</p>
        <p><span className="text-ink-faint">Document date</span><br />{failure.documentDate}</p>
        <p><span className="text-ink-faint">Movement type</span><br />SAP {detail.sapMovementType} · <span className="code">{failure.movementType}</span></p>
        <p><span className="text-ink-faint">Original request key</span><br /><span className="code break-all">{failure.originalRequestKey}</span></p>
        <p className="sm:col-span-2"><span className="text-ink-faint">Immutable source fingerprint</span><br /><span className="code break-all">{failure.idempotencyFingerprint}</span></p>
        <p className="sm:col-span-2"><span className="text-ink-faint">Source confirmation request</span><br /><span className="code break-all">{failure.confirmationRequestKey}</span></p>
      </div>

      <div className="overflow-x-auto rounded border border-line">
        <table className="grid-table min-w-[780px] text-left text-sm">
          <thead className="bg-surface-2 text-xs uppercase text-ink-faint">
            <tr><th>Line</th><th>Material</th><th>Original CO11N snapshot</th><th>Effective posting details</th><th>Reservation / special stock</th></tr>
          </thead>
          <tbody>
            {detail.lines.map((line, index) => {
              const current = effectiveLines[index] as { quantity: number | string; storageLocation: string | null; batch: string | null; entryUnit?: string | null } | undefined;
              return (
                <tr key={line.lineNumber} className="align-top">
                  <td>{line.lineNumber}</td>
                  <td>{line.materialNumber}<br />{line.plant}{line.productionOrderItem ? ` · item ${line.productionOrderItem}` : ''}</td>
                  <td>{line.quantity} {line.unit}<br />SLoc {line.storageLocation ?? '—'}<br />Batch {line.batchNumber || '—'}</td>
                  <td>{current ? <>{quantity(current.quantity)} {current.entryUnit ?? line.unit}<br />SLoc {current.storageLocation ?? '—'}<br />Batch {current.batch ?? '—'}</> : 'Stored source details unavailable'}</td>
                  <td>Reservation {line.reservationNumber ? `${line.reservationNumber}/${line.reservationItem ?? ''}` : '—'}<br />Special stock {line.specialStockType ? `${line.specialStockType} · ${line.specialStockNumber ?? ''}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editable && (
        <form action={correctAction} className="space-y-3 rounded border border-line p-3" data-cogi-correct>
          <div>
            <h3 className="font-semibold">Correct movement details</h3>
            <p className="text-sm text-ink-soft">Only quantity (never above the original confirmed quantity), storage location, and batch can change. Material, plant, source dates, movement type, confirmation, and request key stay fixed. A saved revision does not post until you reprocess it.</p>
          </div>
          <input type="hidden" name="failureId" value={failure.id} />
          <input type="hidden" name="expectedRevision" value={detail.currentRevision} />
          <input type="hidden" name="lineCount" value={detail.lines.length} />
          <div className="space-y-3">
            {detail.lines.map((line, index) => {
              const current = effectiveLines[index] as { quantity: number | string; storageLocation: string | null; batch: string | null } | undefined;
              return (
                <fieldset key={line.lineNumber} className="grid gap-2 rounded border border-line p-2 sm:grid-cols-4">
                  <legend className="px-1 text-xs text-ink-faint">Line {line.lineNumber} · {line.materialNumber}</legend>
                  <label className="text-xs text-ink-soft">Quantity
                    <input className="input mt-1" name={`quantity_${line.lineNumber}`} defaultValue={quantity(current?.quantity ?? line.quantity)} inputMode="decimal" maxLength={24} required />
                  </label>
                  <label className="text-xs text-ink-soft">Storage location
                    <input className="input mt-1" name={`storageLocation_${line.lineNumber}`} defaultValue={current?.storageLocation ?? ''} maxLength={10} />
                  </label>
                  <label className="text-xs text-ink-soft">Batch
                    <input className="input mt-1" name={`batch_${line.lineNumber}`} defaultValue={current?.batch ?? ''} maxLength={40} />
                  </label>
                  <div className="self-end text-xs text-ink-faint">Confirmed {line.quantity} {line.unit}<br />Current revision {detail.currentRevision}</div>
                </fieldset>
              );
            })}
          </div>
          <label className="block text-xs text-ink-soft">Reason for correction
            <input className="input mt-1" name="reason" maxLength={200} required placeholder="For example: storage location corrected after stock review" />
          </label>
          <button className="btn" type="submit" disabled={correcting}>{correcting ? 'Saving correction…' : 'Save correction revision'}</button>
          {correctionState.message && <p role="status" className={correctionState.ok ? 'text-sm text-green-800' : 'text-sm text-red-700'}>{correctionState.message}{correctionState.remedy ? ` ${correctionState.remedy}` : ''}</p>}
        </form>
      )}

      {retryable && (
        <form action={retryAction} className="space-y-3 rounded border border-amber-300 bg-amber-50 p-3" data-cogi-retry>
          <h3 className="font-semibold">Reprocess this movement</h3>
          <p className="text-sm">This uses the original request key and the latest saved correction revision. Posting may create a material document and related stock/accounting effects; the posting is atomic and will not be duplicated by retrying an already posted record.</p>
          <input type="hidden" name="failureId" value={failure.id} />
          <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" name="confirmReprocess" required />I have reviewed the movement and confirm it should now be posted.</label>
          <button className="btn" type="submit" disabled={retrying}>{retrying ? 'Reprocessing…' : 'Reprocess goods movement'}</button>
          {retryState.message && <p role="status" className={retryState.ok ? 'text-sm text-green-900' : 'text-sm text-red-800'}>{retryState.message}</p>}
        </form>
      )}

      {discardable && (
        <form action={discardAction} className="space-y-3 rounded border border-line p-3" data-cogi-discard>
          <h3 className="font-semibold">Discard the incorrect movement</h3>
          <p className="text-sm text-ink-soft">This retains a DISCARDED audit record and does not post a movement. SAP notes that reservations are not automatically adjusted; Cairn likewise leaves reservation and order quantities unchanged.</p>
          <input type="hidden" name="failureId" value={failure.id} />
          <label className="block text-xs text-ink-soft">Discard reason
            <input className="input mt-1" name="reason" maxLength={200} required placeholder="Why must this movement not be posted?" />
          </label>
          <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" name="confirmDiscard" required />I confirm this movement must not be posted and understand reservations will not be adjusted.</label>
          <button className="btn btn-default" type="submit" disabled={discarding}>{discarding ? 'Discarding…' : 'Retain as discarded'}</button>
          {discardState.message && <p role="status" className={discardState.ok ? 'text-sm text-green-800' : 'text-sm text-red-700'}>{discardState.message}</p>}
        </form>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded border border-line p-3">
          <h3 className="font-semibold">Correction history</h3>
          {detail.revisions.length === 0 ? <p className="mt-2 text-sm text-ink-soft">No corrections. Attempt revision 0 uses the immutable CO11N payload.</p> : (
            <ol className="mt-2 space-y-2 text-sm">
              {detail.revisions.map((revision) => <li key={revision.revisionNumber} className="border-t border-line pt-2"><strong>Revision {revision.revisionNumber}</strong> · {revision.createdBy} · {stamp(revision.createdAt)}<br />Reason: {revision.changeReason}<br /><span className="code break-all text-xs">Fingerprint {revision.payloadFingerprint}</span></li>)}
            </ol>
          )}
        </div>
        <div className="rounded border border-line p-3">
          <h3 className="font-semibold">Posting attempts</h3>
          {detail.attempts.length === 0 ? <p className="mt-2 text-sm text-ink-soft">No posting attempt has been recorded.</p> : (
            <ol className="mt-2 space-y-2 text-sm">
              {[...detail.attempts].reverse().map((attempt) => <li key={attempt.id} className="border-t border-line pt-2"><strong>Attempt {attempt.attemptNumber} · {attempt.status}</strong> · revision {attempt.payloadRevision}<br />{attempt.attemptedBy} · started {stamp(attempt.startedAt)} · finished {stamp(attempt.finishedAt)}{attempt.materialDocumentNumber ? <><br />Material document {attempt.materialDocumentNumber}/{attempt.documentYear}</> : null}{attempt.errorText ? <><br /><span className="text-red-700">{attempt.failureCode}: {attempt.errorText}</span></> : null}</li>)}
            </ol>
          )}
        </div>
      </section>
    </section>
  );
}
