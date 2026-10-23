'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { BatchConditionTableRow } from '@/modules/inventory/batch-condition-table';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import {
  deleteBatchConditionTableAction,
  saveBatchConditionTableAction,
  type ConditionTableActionState,
} from './actions';

const empty: ConditionTableActionState = { ok: false };

export default function ConditionTableForm({
  canMaintain,
  editing,
  creating,
}: {
  canMaintain: boolean;
  editing: BatchConditionTableRow | null;
  creating: boolean;
}) {
  const lock = useChangeLock('BATCH_CONDITION_TABLE', editing?.conditionTable ?? null, 'OMA1', canMaintain && Boolean(editing));
  const writable = canMaintain && (creating || (Boolean(editing) && lock?.mode !== 'DISPLAY'));
  const [state, save, pending] = useActionState(saveBatchConditionTableAction, empty);
  const [deleted, remove, removing] = useActionState(deleteBatchConditionTableAction, empty);
  if (!creating && !editing) {
    return state.message || deleted.message
      ? <p role={(state.ok || deleted.ok) ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message || deleted.message}</p>
      : null;
  }

  return (
    <div className="space-y-3">
      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">{editing ? `Condition table ${editing.conditionTable}` : 'New condition table'}</h2>
        <p className="text-sm text-ink-soft">
          Usage H. Application ME. The number is 501 to 999. Name the key fields in order, separated by commas.
          {editing ? ` Version ${editing.version}. Changed by ${editing.changedBy ?? 'nobody'}${editing.changedAt ? ` at ${editing.changedAt instanceof Date ? editing.changedAt.toISOString() : String(editing.changedAt)}` : ''}.` : ' Opening this screen did not create one.'}
        </p>
        {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
        <label className="block text-sm">
          Condition table
          <input name="conditionTable" defaultValue={editing?.conditionTable ?? ''} readOnly={Boolean(editing)} required maxLength={3} className="code mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="block text-sm">
          Key fields
          <input name="fields" defaultValue={editing?.fields.join(', ') ?? ''} required disabled={!writable} className="code mt-1 w-full border border-line px-2 py-1" />
          <span className="mt-1 block text-xs text-ink-soft">The order is the key order. A field outside the allowed list is refused. No physical table is generated.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
          <span>Confirm. This saves the number and the key fields only. It does not generate a table, store a condition record, or post stock.</span>
        </label>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
        <input type="hidden" name="expectedVersion" value={editing?.version ?? ''} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save'}</button>
          <Link href="/config/batch-condition-tables" className="btn btn-default min-h-11">Cancel</Link>
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
          <h2 className="text-sm font-semibold">Delete {editing.conditionTable}</h2>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="deleteConfirmed" value="yes" className="mt-1" />
            <span>Confirm deletion. A posted movement is not rewritten, and no access runs.</span>
          </label>
          <label className="block text-sm">
            Reason
            <input name="deleteReason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <input type="hidden" name="conditionTable" value={editing.conditionTable} />
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
