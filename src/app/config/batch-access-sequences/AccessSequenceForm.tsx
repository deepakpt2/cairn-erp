'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { BatchAccessSequenceRow, BatchAccessStepRow } from '@/modules/inventory/batch-access-sequence';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import {
  deleteBatchAccessSequenceAction,
  deleteBatchAccessStepAction,
  saveBatchAccessSequenceAction,
  saveBatchAccessStepAction,
  type AccessSequenceActionState,
} from './actions';

const empty: AccessSequenceActionState = { ok: false };

export default function AccessSequenceForm({
  canMaintain,
  editing,
  creating,
  steps,
}: {
  canMaintain: boolean;
  editing: BatchAccessSequenceRow | null;
  creating: boolean;
  steps: BatchAccessStepRow[];
}) {
  const lock = useChangeLock('BATCH_ACCESS_SEQUENCE', editing?.accessSequence ?? null, 'OMCX', canMaintain && Boolean(editing));
  const writable = canMaintain && (creating || (Boolean(editing) && lock?.mode !== 'DISPLAY'));
  const [state, save, pending] = useActionState(saveBatchAccessSequenceAction, empty);
  const [deleted, remove, removing] = useActionState(deleteBatchAccessSequenceAction, empty);
  const [stepState, saveStep, savingStep] = useActionState(saveBatchAccessStepAction, empty);
  const [stepDeleted, removeStep, removingStep] = useActionState(deleteBatchAccessStepAction, empty);
  if (!creating && !editing) {
    return state.message || deleted.message
      ? <p role={(state.ok || deleted.ok) ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message || deleted.message}</p>
      : null;
  }

  return (
    <div className="space-y-3">
      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">{editing ? `Access sequence ${editing.accessSequence}` : 'New access sequence'}</h2>
        <p className="text-sm text-ink-soft">
          Usage H. Application ME. The key is four characters. The description is at most 30 characters.
          {editing ? ` Version ${editing.version}. Changed by ${editing.changedBy ?? 'nobody'}${editing.changedAt ? ` at ${editing.changedAt instanceof Date ? editing.changedAt.toISOString() : String(editing.changedAt)}` : ''}.` : ' Opening this screen did not create one.'}
        </p>
        {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
        <label className="block text-sm">
          Access sequence
          <input name="accessSequence" defaultValue={editing?.accessSequence ?? ''} readOnly={Boolean(editing)} required maxLength={4} className="code mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="block text-sm">
          Description
          <input name="description" defaultValue={editing?.description ?? ''} required maxLength={30} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
          <span>Confirm. This saves the access sequence only. It does not run an access, find a condition record, or post stock.</span>
        </label>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
        <input type="hidden" name="expectedVersion" value={editing?.version ?? ''} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save'}</button>
          <Link href="/config/batch-access-sequences" className="btn btn-default min-h-11">Cancel</Link>
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
          <h2 className="text-sm font-semibold">Delete {editing.accessSequence}</h2>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="deleteConfirmed" value="yes" className="mt-1" />
            <span>Confirm deletion. Its accesses are deleted with it. A strategy type that names this sequence blocks the deletion. A posted movement is not rewritten.</span>
          </label>
          <label className="block text-sm">
            Reason
            <input name="deleteReason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <input type="hidden" name="accessSequence" value={editing.accessSequence} />
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
      {editing && (
        <section className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Accesses</h2>
          <p className="text-sm text-ink-soft">An access names a condition table that already stands on OMA1. The number is two digits and need not follow the previous one. Naming a table does not search it and does not select a batch.</p>
          {steps.length === 0 && <p className="text-sm text-ink-soft">No access stands. Opening this screen did not create one.</p>}
          {steps.map((step) => (
            <form key={step.accessNumber} action={removeStep} className="flex flex-wrap items-end gap-2 border border-line p-3">
              <p className="code text-sm">{step.accessNumber} · table {step.conditionTable}</p>
              <input type="hidden" name="accessSequence" value={editing.accessSequence} />
              <input type="hidden" name="accessNumber" value={step.accessNumber} />
              <input type="hidden" name="expectedVersion" value={editing.version} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="deleteStepConfirmed" value="yes" />
                Confirm
              </label>
              <input name="deleteStepReason" required minLength={3} maxLength={500} placeholder="Reason" className="border border-line px-2 py-1 text-sm" />
              <button type="submit" className="btn btn-default min-h-11" disabled={!writable || removingStep}>Delete access</button>
            </form>
          ))}
          {stepDeleted.message && (
            <div role={stepDeleted.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
              <p>{stepDeleted.message}</p>
              {stepDeleted.remedy && <p className="mt-1 text-xs text-ink-soft">{stepDeleted.remedy}</p>}
            </div>
          )}
          <form action={saveStep} className="space-y-3 border border-line p-3">
            <h3 className="text-sm font-semibold">New access</h3>
            <label className="block text-sm">
              Access number
              <input name="accessNumber" required maxLength={2} className="code mt-1 w-full border border-line px-2 py-1" />
            </label>
            <label className="block text-sm">
              Condition table
              <input name="conditionTable" required maxLength={3} className="code mt-1 w-full border border-line px-2 py-1" />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="stepConfirmed" value="yes" className="mt-1" />
              <span>Confirm. This stores the access only. It does not run an access or post stock.</span>
            </label>
            <label className="block text-sm">
              Reason
              <input name="stepReason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
            </label>
            <input type="hidden" name="accessSequence" value={editing.accessSequence} />
            <input type="hidden" name="expectedVersion" value={editing.version} />
            <input type="hidden" name="stepMode" value="CREATE" />
            <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || savingStep}>{savingStep ? 'Saving' : 'Save access'}</button>
            {stepState.message && (
              <div role={stepState.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
                <p>{stepState.message}</p>
                {stepState.remedy && <p className="mt-1 text-xs text-ink-soft">{stepState.remedy}</p>}
              </div>
            )}
          </form>
        </section>
      )}
    </div>
  );
}
