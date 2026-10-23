'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { BatchSearchStrategyRow, KeyCombination } from '@/modules/inventory/batch-search-strategy';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import { deleteBatchSearchStrategyAction, saveBatchSearchStrategyAction, type StrategyActionState } from './actions';

const empty: StrategyActionState = { ok: false };

export default function StrategyForm({
  canMaintain,
  editing,
  creating,
  combination,
}: {
  canMaintain: boolean;
  editing: BatchSearchStrategyRow | null;
  creating: boolean;
  combination: KeyCombination | null;
}) {
  const lock = useChangeLock('BATCH_SEARCH_STRATEGY', editing?.recordNumber ?? null, 'MBC2', canMaintain && Boolean(editing));
  const writable = canMaintain && (creating || (Boolean(editing) && lock?.mode !== 'DISPLAY'));
  const [state, save, pending] = useActionState(saveBatchSearchStrategyAction, empty);
  const [deleted, remove, removing] = useActionState(deleteBatchSearchStrategyAction, empty);
  if (!creating && !editing) {
    return state.message || deleted.message
      ? <p role={(state.ok || deleted.ok) ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message || deleted.message}</p>
      : null;
  }
  const fields = editing?.keys ?? combination?.fields.map((field) => ({ ...field, value: '' })) ?? [];

  return (
    <div className="space-y-3">
      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">{editing ? `Search strategy ${editing.recordNumber}` : 'New search strategy'}</h2>
        <p className="text-sm text-ink-soft">
          Usage H. Application ME. The key fields come from the selected condition table. A selection class and a sort rule are not stored.
          {editing ? ` Version ${editing.version}.` : ' Opening this screen did not create a record.'}
        </p>
        {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
        <label className="block text-sm">
          Strategy type
          <input name="strategyType" defaultValue={editing?.strategyType ?? combination?.strategyType ?? ''} readOnly required maxLength={4} className="code mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="block text-sm">
          Key combination
          <input name="conditionTable" defaultValue={editing?.conditionTable ?? combination?.conditionTable ?? ''} readOnly required maxLength={3} className="code mt-1 w-full border border-line px-2 py-1" />
        </label>
        {fields.map((field) => (
          <label key={field.field} className="block text-sm">
            {field.title}
            <input name={`key_${field.field}`} defaultValue={field.value} readOnly={Boolean(editing)} required maxLength={40} disabled={!creating && !editing} className="code mt-1 w-full border border-line px-2 py-1" />
          </label>
        ))}
        <label className="block text-sm">
          Valid from
          <input name="validFrom" type="date" defaultValue={editing?.validFrom ?? ''} required disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="block text-sm">
          Valid to
          <input name="validTo" type="date" defaultValue={editing?.validTo ?? ''} required disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
          <span>Confirm. This saves the search strategy only. It does not select a batch or post stock.</span>
        </label>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
        <input type="hidden" name="recordNumber" value={editing?.recordNumber ?? ''} />
        <input type="hidden" name="expectedVersion" value={editing?.version ?? ''} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save'}</button>
          <Link href="/inventory/batch-search-strategies" className="btn btn-default min-h-11">Cancel</Link>
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
          <h2 className="text-sm font-semibold">Delete {editing.recordNumber}</h2>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="deleteConfirmed" value="yes" className="mt-1" />
            <span>Confirm deletion. The strategy type and the condition table remain. A posted movement is not rewritten.</span>
          </label>
          <label className="block text-sm">
            Reason
            <input name="deleteReason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <input type="hidden" name="recordNumber" value={editing.recordNumber} />
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
