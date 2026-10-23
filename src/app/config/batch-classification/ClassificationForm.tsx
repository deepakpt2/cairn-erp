'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import {
  CLASSIFICATION_CODES,
  CLASSIFICATION_MEANING,
  type BatchClassificationRow,
} from '@/modules/inventory/batch-classification';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import { saveBatchClassificationAction, type BatchClassificationActionState } from './actions';

const empty: BatchClassificationActionState = { ok: false };

export default function ClassificationForm({
  canMaintain,
  editing,
}: {
  canMaintain: boolean;
  editing: BatchClassificationRow | null;
}) {
  const lock = useChangeLock('BATCH_CLASSIFICATION', editing?.movementType ?? null, 'OMCV', canMaintain && Boolean(editing));
  const writable = canMaintain && Boolean(editing) && lock?.mode !== 'DISPLAY';
  const [state, save, pending] = useActionState(saveBatchClassificationAction, empty);
  if (!editing) return state.message ? <p role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message}</p> : null;

  return (
    <form action={save} className="space-y-3 border border-line bg-white p-4">
      <h2 className="text-sm font-semibold">Movement type {editing.movementType}</h2>
      <p className="text-sm text-ink-soft">
        {editing.description}. The description and the posting rules are not edited here.
        Changed by {editing.changedBy ?? 'nobody'}
        {editing.changedAt ? ` at ${editing.changedAt instanceof Date ? editing.changedAt.toISOString() : String(editing.changedAt)}` : ''}.
      </p>
      {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
      <label className="block text-sm">
        Batch classification
        <select name="classification" defaultValue={editing.classification === ' ' ? '' : editing.classification} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1">
          {CLASSIFICATION_CODES.map((code) => (
            <option key={code} value={code === ' ' ? '' : code}>
              {code === ' ' ? 'blank' : code} — {CLASSIFICATION_MEANING[code]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-ink-soft">
        Blank does not branch, and a goods movement posts as it does today. 1, 2, 3, and 4 ask for classification.
        Class type 023 is not active, so a goods movement with one of those codes is refused before stock or a journal.
        No characteristic is copied.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
        <span>Confirm. This changes the movement type only. A posted movement is not rewritten, and no stock is posted.</span>
      </label>
      <label className="block text-sm">
        Reason
        <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <input type="hidden" name="movementType" value={editing.movementType} />
      <input type="hidden" name="expectedClassification" value={editing.classification === ' ' ? '' : editing.classification} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save'}</button>
        <Link href="/config/batch-classification" className="btn btn-default min-h-11">Cancel</Link>
      </div>
      {state.message && (
        <div role={state.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
        </div>
      )}
    </form>
  );
}
