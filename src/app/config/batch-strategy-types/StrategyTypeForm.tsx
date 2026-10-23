'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { BatchStrategyTypeRow } from '@/modules/inventory/batch-strategy-type';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import {
  deleteBatchStrategyTypeAction,
  saveBatchStrategyTypeAction,
  type StrategyTypeActionState,
} from './actions';

const empty: StrategyTypeActionState = { ok: false };

export default function StrategyTypeForm({
  canMaintain,
  editing,
  creating,
}: {
  canMaintain: boolean;
  editing: BatchStrategyTypeRow | null;
  creating: boolean;
}) {
  const lock = useChangeLock('BATCH_STRATEGY_TYPE', editing?.strategyType ?? null, 'OMCW', canMaintain && Boolean(editing));
  const writable = canMaintain && (creating || (Boolean(editing) && lock?.mode !== 'DISPLAY'));
  const [state, save, pending] = useActionState(saveBatchStrategyTypeAction, empty);
  const [deleted, remove, removing] = useActionState(deleteBatchStrategyTypeAction, empty);
  if (!creating && !editing) {
    return state.message || deleted.message
      ? <p role={(state.ok || deleted.ok) ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message || deleted.message}</p>
      : null;
  }

  return (
    <div className="space-y-3">
      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">{editing ? `Strategy type ${editing.strategyType}` : 'New strategy type'}</h2>
        <p className="text-sm text-ink-soft">
          Usage H. Application ME. The key is the condition type. The description is at most 20 characters.
          {editing ? ` Version ${editing.version}. Changed by ${editing.changedBy ?? 'nobody'}${editing.changedAt ? ` at ${editing.changedAt instanceof Date ? editing.changedAt.toISOString() : String(editing.changedAt)}` : ''}.` : ' Opening this screen did not create one.'}
        </p>
        {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
        <label className="block text-sm">
          Strategy type
          <input name="strategyType" defaultValue={editing?.strategyType ?? ''} readOnly={Boolean(editing)} required maxLength={4} className="code mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="block text-sm">
          Description
          <input name="description" defaultValue={editing?.description ?? ''} required maxLength={20} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="block text-sm">
          Access sequence
          <input name="accessSequence" defaultValue={editing?.accessSequence ?? ''} maxLength={4} disabled={!writable} className="code mt-1 w-full border border-line px-2 py-1" />
          <span className="mt-1 block text-xs text-ink-soft">Blank is no sequence. A name must already stand on OMCX. Naming it does not run an access and does not select a batch.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
          <span>Confirm. This saves the strategy type only. It does not select a batch and does not post stock.</span>
        </label>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
        <input type="hidden" name="expectedVersion" value={editing?.version ?? ''} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save'}</button>
          <Link href="/config/batch-strategy-types" className="btn btn-default min-h-11">Cancel</Link>
        </div>
        {state.message && (
          <div role={state.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
            <p>{state.message}</p>
            {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
          </div>
        )}
      </form>
      {editing && (
        <form action={remove} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Delete {editing.strategyType}</h2>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="deleteConfirmed" value="yes" className="mt-1" />
            <span>Confirm deletion. A posted movement is not rewritten.</span>
          </label>
          <label className="block text-sm">
            Reason
            <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <input type="hidden" name="strategyType" value={editing.strategyType} />
          <input type="hidden" name="expectedVersion" value={editing.version} />
          <button type="submit" className="btn btn-default min-h-11" disabled={!writable || removing}>{removing ? 'Deleting' : 'Delete'}</button>
          {deleted.message && (
            <div role={deleted.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
              <p>{deleted.message}</p>
              {deleted.remedy && <p className="mt-1 text-xs text-ink-soft">{deleted.remedy}</p>}
            </div>
          )}
        </form>
      )}
    </div>
  );
}
