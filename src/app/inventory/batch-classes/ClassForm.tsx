'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { BatchClassChoices, BatchClassRow } from '@/modules/inventory/batch-class';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import { saveBatchClassAction, type BatchClassActionState } from './actions';

const empty: BatchClassActionState = { ok: false };

export default function ClassForm({
  canMaintain,
  editing,
  creating,
  displayOnly,
  choices,
}: {
  canMaintain: boolean;
  editing: BatchClassRow | null;
  creating: boolean;
  displayOnly: boolean;
  choices: BatchClassChoices;
}) {
  const lock = useChangeLock(
    'BATCH_CLASS',
    editing ? `${editing.classType}/${editing.className}` : null,
    'BMC2',
    canMaintain && Boolean(editing) && !displayOnly,
  );
  const writable = canMaintain && !displayOnly && (creating || (Boolean(editing) && editing?.currentType && lock?.mode !== 'DISPLAY'));
  const [state, save, pending] = useActionState(saveBatchClassAction, empty);
  if (!creating && !editing) {
    return state.message
      ? <p role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message}</p>
      : null;
  }
  const assigned = editing?.assignments ?? [];
  const slots = Array.from({ length: Math.max(6, assigned.length + 2) }, (_, index) => index + 1);

  return (
    <form action={save} className="space-y-3 border border-line bg-white p-4">
      <h2 className="text-sm font-semibold">
        {editing ? `Class ${editing.classType} / ${editing.className}` : 'New batch class'}
      </h2>
      <p className="text-sm text-ink-soft">
        Class type {choices.classType} comes from batch level {choices.batchLevel}. It is not typed.
        {editing ? ` Version ${editing.version}.` : ' Opening this screen did not create a class.'}
        {' '}Saving does not assign the class to a material or a batch.
      </p>
      {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
      {editing && !editing.currentType && (
        <p role="status" className="text-sm">This class is not the current batch type. It is shown only. It is not converted here.</p>
      )}
      <label className="block text-sm">
        Class type
        <input name="classType" defaultValue={editing?.classType ?? choices.classType} readOnly className="code mt-1 w-full border border-line px-2 py-1" />
      </label>
      <label className="block text-sm">
        Class name
        <input name="className" defaultValue={editing?.className ?? ''} readOnly={Boolean(editing)} required maxLength={18} disabled={!creating && !editing} className="code mt-1 w-full border border-line px-2 py-1" />
      </label>
      <label className="block text-sm">
        Description
        <input name="description" defaultValue={editing?.description ?? ''} required maxLength={40} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <fieldset className="space-y-2" disabled={!writable && Boolean(editing)}>
        <legend className="text-sm font-semibold">Characteristics</legend>
        <p className="text-sm text-ink-soft">The row order is the assignment order. A blank row is skipped. A characteristic is not created here.</p>
        {slots.map((slot) => (
          <div key={slot} className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <label className="text-sm">
              Characteristic {slot}
              <select name={`characteristic_${slot}`} defaultValue={assigned[slot - 1]?.characteristicName ?? ''} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1">
                <option value="">—</option>
                {choices.characteristics.map((item) => (
                  <option key={item.characteristicName} value={item.characteristicName}>
                    {item.characteristicName} · {item.description} · {item.lifecycleStatus}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm sm:mt-6">
              <input type="checkbox" name={`required_${slot}`} value="yes" defaultChecked={assigned[slot - 1]?.requiredForClassification === true} disabled={!writable} />
              Required
            </label>
          </div>
        ))}
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmed" value="yes" disabled={!writable} className="mt-1" />
        <span>Confirm. This saves the class only. It does not assign the class, store a batch value, or select a batch.</span>
      </label>
      <label className="block text-sm">
        Reason
        <input name="reason" required={writable} minLength={3} maxLength={500} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
      <input type="hidden" name="expectedVersion" value={editing?.version ?? ''} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save'}</button>
        <Link href="/inventory/batch-classes" className="btn btn-default min-h-11">Cancel</Link>
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
