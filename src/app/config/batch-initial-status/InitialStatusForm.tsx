'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { InitialStatusRow } from '@/modules/inventory/initial-batch-status';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import { saveInitialBatchStatusAction, type InitialStatusActionState } from './actions';

const empty: InitialStatusActionState = { ok: false };

export default function InitialStatusForm({
  canMaintain,
  editing,
}: {
  canMaintain: boolean;
  editing: InitialStatusRow | null;
}) {
  const lock = useChangeLock('BATCH_INITIAL_STATUS', editing?.materialType ?? null, 'OMAB', canMaintain && Boolean(editing));
  const writable = canMaintain && Boolean(editing) && lock?.mode !== 'DISPLAY';
  const [state, save, pending] = useActionState(saveInitialBatchStatusAction, empty);
  if (!editing) return state.message ? <p role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message}</p> : null;

  return (
    <form action={save} className="space-y-3 border border-line bg-white p-4">
      <h2 className="text-sm font-semibold">Material type {editing.materialType}</h2>
      <p className="text-sm text-ink-soft">
        {editing.name}. The description is not edited here. Changed by {editing.changedBy ?? 'nobody'}
        {editing.changedAt ? ` at ${editing.changedAt instanceof Date ? editing.changedAt.toISOString() : String(editing.changedAt)}` : ''}.
      </p>
      {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="initialStatus" value="X" defaultChecked={editing.initialStatus === 'X'} disabled={!writable} className="mt-1" />
        <span>Initial status of a new batch. Checked is X, restricted for a future batch. Unchecked is blank, unrestricted.</span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
        <span>Confirm. This changes future batches only. It does not rewrite an existing batch and does not post stock.</span>
      </label>
      <label className="block text-sm">
        Reason
        <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <input type="hidden" name="materialType" value={editing.materialType} />
      <input type="hidden" name="expectedStatus" value={editing.initialStatus ?? ''} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save'}</button>
        <Link href="/config/batch-initial-status" className="btn btn-default min-h-11">Cancel</Link>
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
