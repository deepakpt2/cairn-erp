'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { BatchSearchProcedureRow, BatchSearchProcedureStepRow } from '@/modules/inventory/batch-search-procedure';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import {
  deleteBatchSearchProcedureAction,
  deleteBatchSearchProcedureStepAction,
  saveBatchSearchProcedureAction,
  saveBatchSearchProcedureStepAction,
  type SearchProcedureActionState,
} from './actions';

const empty: SearchProcedureActionState = { ok: false };

export default function SearchProcedureForm({
  canMaintain,
  editing,
  creating,
  steps,
}: {
  canMaintain: boolean;
  editing: BatchSearchProcedureRow | null;
  creating: boolean;
  steps: BatchSearchProcedureStepRow[];
}) {
  const lock = useChangeLock('BATCH_SEARCH_PROCEDURE', editing?.searchProcedure ?? null, 'OMCY', canMaintain && Boolean(editing));
  const writable = canMaintain && (creating || (Boolean(editing) && lock?.mode !== 'DISPLAY'));
  const [state, save, pending] = useActionState(saveBatchSearchProcedureAction, empty);
  const [deleted, remove, removing] = useActionState(deleteBatchSearchProcedureAction, empty);
  const [stepState, saveStep, savingStep] = useActionState(saveBatchSearchProcedureStepAction, empty);
  const [stepDeleted, removeStep, removingStep] = useActionState(deleteBatchSearchProcedureStepAction, empty);
  if (!creating && !editing) {
    return state.message || deleted.message
      ? <p role={(state.ok || deleted.ok) ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm">{state.message || deleted.message}</p>
      : null;
  }

  return (
    <div className="space-y-3">
      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">{editing ? `Search procedure ${editing.searchProcedure}` : 'New search procedure'}</h2>
        <p className="text-sm text-ink-soft">
          Usage H. Application ME. The key is six characters. The description is at most 30 characters.
          {editing ? ` Version ${editing.version}. Changed by ${editing.changedBy ?? 'nobody'}${editing.changedAt ? ` at ${editing.changedAt instanceof Date ? editing.changedAt.toISOString() : String(editing.changedAt)}` : ''}.` : ' Opening this screen did not create one.'}
        </p>
        {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
        <label className="block text-sm">
          Search procedure
          <input name="searchProcedure" defaultValue={editing?.searchProcedure ?? ''} readOnly={Boolean(editing)} required maxLength={6} className="code mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="block text-sm">
          Description
          <input name="description" defaultValue={editing?.description ?? ''} required maxLength={30} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
          <span>Confirm. This saves the search procedure only. It does not select a batch, assign a movement type, or post stock.</span>
        </label>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
        <input type="hidden" name="expectedVersion" value={editing?.version ?? ''} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>{pending ? 'Saving' : 'Save'}</button>
          <Link href="/config/batch-search-procedures" className="btn btn-default min-h-11">Cancel</Link>
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
          <h2 className="text-sm font-semibold">Delete {editing.searchProcedure}</h2>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="deleteConfirmed" value="yes" className="mt-1" />
            <span>Confirm deletion. Its steps are deleted with it. A posted movement is not rewritten.</span>
          </label>
          <label className="block text-sm">
            Reason
            <input name="deleteReason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <input type="hidden" name="searchProcedure" value={editing.searchProcedure} />
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
          <h2 className="text-sm font-semibold">Steps</h2>
          <p className="text-sm text-ink-soft">A step names a strategy type that already stands on OMCW. The step number is three digits and the counter is two digits. Neither need follow the previous one. Naming a strategy type does not select a batch.</p>
          {steps.length === 0 && <p className="text-sm text-ink-soft">No step stands. Opening this screen did not create one.</p>}
          {steps.map((step) => (
            <form key={`${step.stepNumber}-${step.counter}`} action={removeStep} className="flex flex-wrap items-end gap-2 border border-line p-3">
              <p className="code text-sm">{step.stepNumber} / {step.counter} · {step.strategyType}</p>
              <input type="hidden" name="searchProcedure" value={editing.searchProcedure} />
              <input type="hidden" name="stepNumber" value={step.stepNumber} />
              <input type="hidden" name="counter" value={step.counter} />
              <input type="hidden" name="expectedVersion" value={editing.version} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="deleteStepConfirmed" value="yes" />
                Confirm
              </label>
              <input name="deleteStepReason" required minLength={3} maxLength={500} placeholder="Reason" className="border border-line px-2 py-1 text-sm" />
              <button type="submit" className="btn btn-default min-h-11" disabled={!writable || removingStep}>Delete step</button>
            </form>
          ))}
          {stepDeleted.message && (
            <div role={stepDeleted.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
              <p>{stepDeleted.message}</p>
              {stepDeleted.remedy && <p className="mt-1 text-xs text-ink-soft">{stepDeleted.remedy}</p>}
            </div>
          )}
          <form action={saveStep} className="space-y-3 border border-line p-3">
            <h3 className="text-sm font-semibold">New step</h3>
            <label className="block text-sm">
              Step
              <input name="stepNumber" required maxLength={3} className="code mt-1 w-full border border-line px-2 py-1" />
            </label>
            <label className="block text-sm">
              Counter
              <input name="counter" required maxLength={2} className="code mt-1 w-full border border-line px-2 py-1" />
            </label>
            <label className="block text-sm">
              Strategy type
              <input name="stepStrategyType" required maxLength={4} className="code mt-1 w-full border border-line px-2 py-1" />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="stepConfirmed" value="yes" className="mt-1" />
              <span>Confirm. This stores the step only. It does not select a batch or post stock.</span>
            </label>
            <label className="block text-sm">
              Reason
              <input name="stepReason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
            </label>
            <input type="hidden" name="searchProcedure" value={editing.searchProcedure} />
            <input type="hidden" name="expectedVersion" value={editing.version} />
            <input type="hidden" name="stepMode" value="CREATE" />
            <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || savingStep}>{savingStep ? 'Saving' : 'Save step'}</button>
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
