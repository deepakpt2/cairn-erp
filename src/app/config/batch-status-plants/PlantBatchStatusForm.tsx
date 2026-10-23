'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { PlantBatchStatusRow } from '@/modules/inventory/batch-status-plant';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import { savePlantBatchStatusAction, type PlantStatusActionState } from './actions';

const empty: PlantStatusActionState = { ok: false };

export default function PlantBatchStatusForm({
  client,
  canMaintain,
  editing,
}: {
  client: string;
  canMaintain: boolean;
  editing: PlantBatchStatusRow | null;
}) {
  const lock = useChangeLock('BATCH_STATUS_PLANT', editing?.plant || client, 'OMCU', canMaintain && Boolean(editing));
  const writable = canMaintain && Boolean(editing) && lock?.mode !== 'DISPLAY';
  const [state, save, pending] = useActionState(savePlantBatchStatusAction, empty);
  if (!editing) return state.message ? <p role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message}</p> : null;

  return (
    <form action={save} className="space-y-3 border border-line bg-white p-4">
      <h2 className="text-sm font-semibold">Plant {editing.plant}</h2>
      <p className="text-sm text-ink-soft">
        {editing.plantName}. The name is not edited here. Changed by {editing.changedBy ?? 'nobody'}
        {editing.changedAt ? ` at ${editing.changedAt instanceof Date ? editing.changedAt.toISOString() : String(editing.changedAt)}` : ''}.
      </p>
      {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
      <label className="block text-sm">
        Batch status management
        <select name="statusActive" defaultValue={editing.statusActive ?? ''} className="mt-1 w-full border border-line px-2 py-1">
          <option value="">blank — not selected</option>
          <option value="X">X — selected</option>
        </select>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
        <span>Confirm. This does not convert a batch and does not post movement 341 or 342.</span>
      </label>
      <label className="block text-sm">
        Reason
        <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <input type="hidden" name="plant" value={editing.plant} />
      <input type="hidden" name="version" value={String(editing.version)} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save plant'}</button>
        <Link href="/config/batch-status-plants" className="btn btn-default min-h-11">Cancel</Link>
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
