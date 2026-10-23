'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { BatchIntervalRow } from '@/modules/inventory/batch-number-range';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import {
  adjustBatchIntervalAction,
  deleteBatchIntervalAction,
  saveBatchIntervalAction,
  type BatchRangeActionState,
} from './actions';

const empty: BatchRangeActionState = { ok: false };

function Message({ state }: { state: BatchRangeActionState }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

export default function BatchNumberRangeForms({
  client,
  canMaintain,
  editing,
  adjusting,
}: {
  client: string;
  canMaintain: boolean;
  editing: BatchIntervalRow | null;
  adjusting: BatchIntervalRow | null;
}) {
  const lock = useChangeLock('BATCH_NUMBER_RANGE', editing?.interval || adjusting?.interval || client, 'OMAD', canMaintain);
  const writable = canMaintain && lock?.mode !== 'DISPLAY';
  const [saveState, save, savePending] = useActionState(saveBatchIntervalAction, empty);
  const [deleteState, remove, deletePending] = useActionState(deleteBatchIntervalAction, empty);
  const [adjustState, adjust, adjustPending] = useActionState(adjustBatchIntervalAction, empty);

  return (
    <div className="space-y-4">
      {lock?.mode === 'DISPLAY' && lock.message && (
        <p role="status" className="border border-line bg-white p-3 text-sm">{lock.message}</p>
      )}

      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">{editing ? `Change interval ${editing.interval}` : 'Create interval'}</h2>
        <p className="text-sm text-ink-soft">Object BATCH_CLT. From and to are digits. The screen pads them to 10. No sample interval is filled in.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            Interval
            <input name="interval" required pattern="[0-9]{2}" maxLength={2} defaultValue={editing?.interval ?? ''} readOnly={Boolean(editing)} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <label className="block text-sm">
            External
            <select name="external" defaultValue={editing?.external ? 'X' : ''} disabled={Boolean(editing)} className="mt-1 w-full border border-line px-2 py-1">
              <option value="">blank — internal</option>
              <option value="X">X — external check</option>
            </select>
          </label>
          <label className="block text-sm">
            From number
            <input name="fromNumber" required pattern="[0-9]{1,10}" maxLength={10} defaultValue={editing ? String(editing.fromValue) : ''} readOnly={Boolean(editing)} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <label className="block text-sm">
            To number
            <input name="toNumber" required pattern="[0-9]{1,10}" maxLength={10} defaultValue={editing ? String(editing.toValue) : ''} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          {editing && (
            <label className="block text-sm">
              Status
              <select name="status" defaultValue={editing.status} className="mt-1 w-full border border-line px-2 py-1">
                <option value="ACTIVE">ACTIVE</option>
                <option value="BLOCKED">BLOCKED</option>
              </select>
            </label>
          )}
        </div>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
        {editing && <input type="hidden" name="expectedTo" value={String(editing.toValue)} />}
        {editing && <input type="hidden" name="expectedCurrent" value={String(editing.currentValue)} />}
        {editing && <input type="hidden" name="external" value={editing.external ? 'X' : ''} />}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || savePending}>
            {savePending ? 'Saving' : 'Save interval'}
          </button>
          <Link href="/config/batch-number-ranges" className="btn btn-default min-h-11">Cancel</Link>
        </div>
        <Message state={saveState} />
      </form>

      {adjusting && (
        <form action={adjust} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Set current number for {adjusting.interval}</h2>
          <p className="text-sm text-ink-soft">
            Current status is {adjusting.currentDisplay ?? 'nothing issued'}. Next, not reserved, is {adjusting.nextDisplay ?? 'exhausted'}.
            This act cannot move the number backwards.
          </p>
          <label className="block text-sm">
            Current number
            <input name="currentNumber" required pattern="[0-9]{1,10}" maxLength={10} defaultValue={String(adjusting.currentValue)} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <label className="block text-sm">
            Reason
            <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <input type="hidden" name="interval" value={adjusting.interval} />
          <input type="hidden" name="expectedCurrent" value={String(adjusting.currentValue)} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || adjustPending}>Save status</button>
            <Link href="/config/batch-number-ranges" className="btn btn-default min-h-11">Cancel</Link>
          </div>
          <Message state={adjustState} />
        </form>
      )}

      {editing && !editing.currentDisplay && (
        <form action={remove} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Delete interval {editing.interval}</h2>
          <p className="text-sm text-ink-soft">Allowed only when nothing has been issued and no standing batch falls inside the interval.</p>
          <label className="block text-sm">
            Reason
            <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <input type="hidden" name="interval" value={editing.interval} />
          <button type="submit" className="btn btn-default min-h-11" disabled={!writable || deletePending}>Delete interval</button>
          <Message state={deleteState} />
        </form>
      )}
    </div>
  );
}
