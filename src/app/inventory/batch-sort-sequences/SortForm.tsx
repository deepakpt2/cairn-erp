'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { SortSequenceChoices, SortSequenceRow } from '@/modules/inventory/batch-sort-sequence';
import { SORT_STATUS } from '@/modules/inventory/batch-sort-sequence';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import { deleteSortSequenceAction, saveSortSequenceAction, type SortActionState } from './actions';

const empty: SortActionState = { ok: false };

export default function SortForm({
  canMaintain,
  editing,
  creating,
  displayOnly,
  choices,
}: {
  canMaintain: boolean;
  editing: SortSequenceRow | null;
  creating: boolean;
  displayOnly: boolean;
  choices: SortSequenceChoices;
}) {
  const lock = useChangeLock(
    'BATCH_SORT_SEQUENCE',
    editing?.sortSequence ?? null,
    'CU71',
    canMaintain && Boolean(editing) && !displayOnly,
  );
  const writable = canMaintain && !displayOnly && (creating || (Boolean(editing) && lock?.mode !== 'DISPLAY'));
  const [state, save, pending] = useActionState(saveSortSequenceAction, empty);
  const [deleted, remove, removing] = useActionState(deleteSortSequenceAction, empty);
  if (!creating && !editing) {
    return state.message || deleted.message
      ? <p role={(state.ok || deleted.ok) ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message || deleted.message}</p>
      : null;
  }
  const assigned = editing?.criteria ?? [];
  const slots = Array.from({ length: Math.max(6, assigned.length + 2) }, (_, index) => index + 1);

  return (
    <div className="space-y-3">
      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">{editing ? `Sort sequence ${editing.sortSequence}` : 'New sort sequence'}</h2>
        <p className="text-sm text-ink-soft">
          The row order is the sort priority. Each characteristic is ascending or descending. A weighting factor is not stored.
          {editing ? ` Version ${editing.version}. Status ${editing.status} ${editing.statusTitle}.` : ' Opening this screen did not create a sequence.'}
        </p>
        {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
        <label className="block text-sm">
          Sort sequence
          <input name="sortSequence" defaultValue={editing?.sortSequence ?? ''} readOnly={Boolean(editing)} required maxLength={18} className="code mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="block text-sm">
          Description
          <input name="description" defaultValue={editing?.description ?? ''} required maxLength={40} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="block text-sm">
          Status
          <select name="status" defaultValue={editing?.status ?? '0'} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1">
            {SORT_STATUS.map((item) => (
              <option key={item.code} value={item.code}>{item.code} · {item.title}</option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Characteristics</legend>
          <p className="text-sm text-ink-soft">LOBM_LGORT and LOBM_MENGE sort stock. They must not stand in a batch class. Any other characteristic must already stand.</p>
          {slots.map((slot) => (
            <div key={slot} className="grid gap-2 sm:grid-cols-[1fr_10rem]">
              <label className="text-sm">
                Characteristic {slot}
                <select name={`characteristic_${slot}`} defaultValue={assigned[slot - 1]?.characteristicName ?? ''} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1">
                  <option value="">—</option>
                  {choices.characteristics.map((item) => (
                    <option key={item.characteristicName} value={item.characteristicName}>
                      {item.characteristicName} · {item.description}{item.stockException ? ' · stock exception' : ''}{item.batchClassAssigned ? ' · in a batch class' : ''}{item.lifecycleStatus ? ` · ${item.lifecycleStatus}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Direction
                <select name={`direction_${slot}`} defaultValue={assigned[slot - 1]?.direction ?? ''} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1">
                  <option value="">—</option>
                  <option value="A">Ascending</option>
                  <option value="D">Descending</option>
                </select>
              </label>
            </div>
          ))}
        </fieldset>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirmed" value="yes" disabled={!writable} className="mt-1" />
          <span>Confirm. This saves the sort sequence only. It does not select a batch or post stock.</span>
        </label>
        <label className="block text-sm">
          Reason
          <input name="reason" required={writable} minLength={3} maxLength={500} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
        <input type="hidden" name="expectedVersion" value={editing?.version ?? ''} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save'}</button>
          <Link href="/inventory/batch-sort-sequences" className="btn btn-default min-h-11">Cancel</Link>
        </div>
        {state.message && (
          <div role={state.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
            <p>{state.message}</p>
            {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
          </div>
        )}
      </form>
      {editing && !displayOnly && (
        <form action={remove} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Delete {editing.sortSequence}</h2>
          <p className="text-sm text-ink-soft">A search strategy does not store this sequence. Deleting it does not change a strategy or a goods movement.</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="deleteConfirmed" value="yes" className="mt-1" />
            <span>Confirm deletion.</span>
          </label>
          <label className="block text-sm">
            Reason
            <input name="deleteReason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <input type="hidden" name="sortSequence" value={editing.sortSequence} />
          <input type="hidden" name="expectedVersion" value={editing.version} />
          <button type="submit" className="btn btn-default min-h-11" disabled={!writable || removing}>{removing ? 'Deleting' : 'Delete'}</button>
          {deleted.message && <p role={deleted.ok ? 'status' : 'alert'} className="text-sm">{deleted.message}</p>}
        </form>
      )}
    </div>
  );
}
