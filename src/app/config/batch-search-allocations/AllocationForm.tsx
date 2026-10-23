'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { BatchSearchAllocationRow } from '@/modules/inventory/batch-search-allocation';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import { deleteBatchSearchAllocationAction, saveBatchSearchAllocationAction, type AllocationActionState } from './actions';

const empty: AllocationActionState = { ok: false };

export default function AllocationForm({
  canMaintain,
  editing,
  creating,
  movements,
  procedures,
}: {
  canMaintain: boolean;
  editing: BatchSearchAllocationRow | null;
  creating: boolean;
  movements: Array<{ movementType: string; description: string }>;
  procedures: Array<{ searchProcedure: string; description: string }>;
}) {
  const lock = useChangeLock('BATCH_SEARCH_ALLOCATION', editing?.movementType ?? null, 'OMCG', canMaintain && Boolean(editing));
  const writable = canMaintain && (creating || (Boolean(editing) && lock?.mode !== 'DISPLAY'));
  const [state, save, pending] = useActionState(saveBatchSearchAllocationAction, empty);
  const [deleted, remove, removing] = useActionState(deleteBatchSearchAllocationAction, empty);
  if (!creating && !editing) {
    return state.message || deleted.message
      ? <p role={(state.ok || deleted.ok) ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message || deleted.message}</p>
      : null;
  }

  return (
    <div className="space-y-3">
      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">{editing ? `Movement type ${editing.movementType}` : 'New allocation'}</h2>
        <p className="text-sm text-ink-soft">
          Own stock. The procedure must already stand on OMCY. X records a check request and does not check a batch.
          {editing ? ` Version ${editing.version}. Changed by ${editing.changedBy ?? 'nobody'}${editing.changedAt ? ` at ${editing.changedAt instanceof Date ? editing.changedAt.toISOString() : String(editing.changedAt)}` : ''}.` : ' Opening this screen did not create one.'}
        </p>
        {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
        <label className="block text-sm">
          Movement type
          <input name="movementType" list="omcg-movements" defaultValue={editing?.movementType ?? ''} readOnly={Boolean(editing)} required maxLength={20} className="code mt-1 w-full border border-line px-2 py-1" />
        </label>
        <datalist id="omcg-movements">
          {movements.map((row) => <option key={row.movementType} value={row.movementType}>{row.description}</option>)}
        </datalist>
        <label className="block text-sm">
          Search procedure
          <input name="searchProcedure" list="omcg-procedures" defaultValue={editing?.searchProcedure ?? ''} required maxLength={6} disabled={!writable} className="code mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="block text-sm">
          Transfer procedure
          <input name="transferProcedure" list="omcg-procedures" defaultValue={editing?.transferProcedure ?? ''} maxLength={6} disabled={!writable} className="code mt-1 w-full border border-line px-2 py-1" />
        </label>
        <datalist id="omcg-procedures">
          {procedures.map((row) => <option key={row.searchProcedure} value={row.searchProcedure}>{row.description}</option>)}
        </datalist>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="checkBatch" value="X" defaultChecked={editing?.checkBatch === 'X'} disabled={!writable} className="mt-1" />
          <span>Check of the batch entered. X records the request. Selection criteria do not stand, so this does not accept or reject a batch.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
          <span>Confirm. This saves the allocation only. It does not select a batch or post stock.</span>
        </label>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
        <input type="hidden" name="expectedVersion" value={editing?.version ?? ''} />
        <input type="hidden" name="specialStock" value=" " />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save'}</button>
          <Link href="/config/batch-search-allocations" className="btn btn-default min-h-11">Cancel</Link>
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
          <h2 className="text-sm font-semibold">Delete the allocation for {editing.movementType}</h2>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="deleteConfirmed" value="yes" className="mt-1" />
            <span>Confirm deletion. The movement type and the search procedure remain. A posted movement is not rewritten.</span>
          </label>
          <label className="block text-sm">
            Reason
            <input name="deleteReason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <input type="hidden" name="movementType" value={editing.movementType} />
          <input type="hidden" name="specialStock" value=" " />
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
