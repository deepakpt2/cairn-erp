'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { AssignedReceiptRow, InternalAssignmentRow } from '@/modules/inventory/batch-number-assignment';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import {
  saveAssignedReceiptAction,
  saveInternalAssignmentAction,
  type AssignmentActionState,
} from './actions';

const empty: AssignmentActionState = { ok: false };

function Message({ state }: { state: AssignmentActionState }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm text-ink">
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

export default function BatchNumberAssignmentForm({
  client,
  current,
  plants,
  canMaintain,
}: {
  client: string;
  current: InternalAssignmentRow;
  plants: AssignedReceiptRow[];
  canMaintain: boolean;
}) {
  const router = useRouter();
  const lock = useChangeLock('BATCH_NUMBER_ASSIGNMENT', client, 'OMCZ', canMaintain);
  const displayOnly = lock?.mode === 'DISPLAY';
  const writable = canMaintain && !displayOnly;
  const opened = current.code === 'X' ? 'X' : current.version > 0 ? '' : undefined;
  const [selected, setSelected] = useState<string | undefined>(opened);
  const [requestKey, setRequestKey] = useState('');
  const [saveState, save, savePending] = useActionState(saveInternalAssignmentAction, empty);
  const version = saveState.version ?? current.version;

  const [plantCode, setPlantCode] = useState(plants[0]?.plant ?? '');
  const selectedPlant = plants.find((row) => row.plant === plantCode) ?? null;
  const plantOpened = selectedPlant?.code === 'X' ? 'X' : selectedPlant && selectedPlant.version > 0 ? '' : undefined;
  const [plantFlag, setPlantFlag] = useState<string | undefined>(plantOpened);
  const [plantKey, setPlantKey] = useState('');
  const [plantState, savePlant, plantPending] = useActionState(saveAssignedReceiptAction, empty);
  const plantLock = useChangeLock('BATCH_ASSIGNED_RECEIPT', plantCode || client, 'OMCZ', canMaintain && Boolean(plantCode));
  const plantWritable = canMaintain && plantLock?.mode !== 'DISPLAY';
  const plantVersion = plantState.ok && plantState.plant === plantCode
    ? (plantState.version ?? selectedPlant?.version ?? 0)
    : (selectedPlant?.version ?? 0);

  useEffect(() => {
    setRequestKey((key) => key || crypto.randomUUID());
    setPlantKey((key) => key || crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (saveState.replaceRequestKey) setRequestKey(crypto.randomUUID());
    if (saveState.ok) router.refresh();
  }, [saveState.replaceRequestKey, saveState.ok, saveState.message, router]);

  useEffect(() => {
    if (plantState.replaceRequestKey) setPlantKey(crypto.randomUUID());
    if (plantState.ok) router.refresh();
  }, [plantState.replaceRequestKey, plantState.ok, plantState.message, router]);

  function choosePlant(next: string) {
    const row = plants.find((item) => item.plant === next);
    setPlantCode(next);
    setPlantFlag(row?.code === 'X' ? 'X' : row && row.version > 0 ? '' : undefined);
  }

  return (
    <div className="space-y-4">
      {displayOnly && lock?.message && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink">{lock.message}</p>
      )}

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Client</h2>
        <p className="mt-2 text-sm text-ink">This client. The flag is not a plant and not a material type.</p>
        <p className="mt-2 text-sm text-ink-soft">
          {current.range.defined
            ? `BATCH_CLT interval 01 stands (${current.range.status ?? 'unknown'}${current.range.external ? ', external' : ''}${current.range.exhausted ? ', exhausted' : ''}). This screen does not change it.`
            : 'BATCH_CLT interval 01 is not defined. This screen does not create it.'}
        </p>
        <p className="mt-2 text-xs text-ink-faint">
          Version {current.version}.
          {current.changedBy ? ` Last changed by ${current.changedBy}.` : ' Not saved.'}
          {current.changedAt ? ` ${current.changedAt.toISOString()}` : ''}
        </p>
      </section>

      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Internal batch number assignment</h2>
        <fieldset className="space-y-2" disabled={!writable || savePending}>
          <legend className="sr-only">Internal batch number assignment</legend>
          <label className="flex gap-3 border border-line p-3 text-sm">
            <input type="radio" name="internalAssignment" value="X" checked={selected === 'X'} onChange={() => setSelected('X')} required />
            <span>
              <span className="code">X</span>
              <span className="ms-2 font-medium">Active</span>
              <span className="mt-1 block text-ink-soft">Internal assignment is active for this client. A blank batch number may draw interval 01.</span>
            </span>
          </label>
          <label className="flex gap-3 border border-line p-3 text-sm">
            <input type="radio" name="internalAssignment" value="" checked={selected === ''} onChange={() => setSelected('')} required />
            <span>
              <span className="code">blank</span>
              <span className="ms-2 font-medium">Not active</span>
              <span className="mt-1 block text-ink-soft">A batch number must be typed. This does not clear a plant flag.</span>
            </span>
          </label>
        </fieldset>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="version" value={String(version)} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || savePending || selected === undefined}>
            {savePending ? 'Saving' : 'Save activation'}
          </button>
          <button
            type="button"
            className="btn btn-default min-h-11"
            disabled={!writable || savePending}
            onClick={() => setSelected(opened)}
          >
            Cancel
          </button>
        </div>
        <Message state={saveState} />
      </form>

      <form action={savePlant} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Internal batch number assignment for assigned goods receipt</h2>
        <p className="text-sm text-ink-soft">
          Plant flag XCAUT. It permits a number only for an account-assigned goods receipt. That receipt is not posted here.
        </p>
        {plants.length === 0 ? (
          <p className="text-sm">No plant stands in this client.</p>
        ) : (
          <>
            <label className="block text-sm">
              Plant
              <select name="plant" value={plantCode} onChange={(event) => choosePlant(event.target.value)} disabled={!plantWritable || plantPending} className="mt-1 w-full border border-line px-2 py-1">
                {plants.map((row) => (
                  <option key={row.plant} value={row.plant}>{row.plant} — {row.name}</option>
                ))}
              </select>
            </label>
            <p className="text-sm text-ink-soft">
              {selectedPlant ? selectedPlant.name : 'Choose a plant.'}
              {selectedPlant?.changedBy ? ` Last changed by ${selectedPlant.changedBy}.` : ' Not saved for this plant.'}
            </p>
            <fieldset className="space-y-2" disabled={!plantWritable || plantPending}>
              <legend className="sr-only">Assigned goods receipt</legend>
              <label className="flex gap-3 border border-line p-3 text-sm">
                <input type="radio" name="assignedReceipt" value="X" checked={plantFlag === 'X'} onChange={() => setPlantFlag('X')} required />
                <span>
                  <span className="code">X</span>
                  <span className="ms-2 font-medium">Permitted</span>
                </span>
              </label>
              <label className="flex gap-3 border border-line p-3 text-sm">
                <input type="radio" name="assignedReceipt" value="" checked={plantFlag === ''} onChange={() => setPlantFlag('')} required />
                <span>
                  <span className="code">blank</span>
                  <span className="ms-2 font-medium">Not permitted</span>
                </span>
              </label>
            </fieldset>
          </>
        )}
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} disabled={!plantWritable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="version" value={String(plantVersion)} />
        <input type="hidden" name="requestKey" value={plantKey} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!plantWritable || plantPending || plants.length === 0 || plantFlag === undefined}>
            {plantPending ? 'Saving' : 'Save plant'}
          </button>
          <button
            type="button"
            className="btn btn-default min-h-11"
            disabled={!plantWritable || plantPending}
            onClick={() => setPlantFlag(selectedPlant?.code === 'X' ? 'X' : selectedPlant && selectedPlant.version > 0 ? '' : undefined)}
          >
            Cancel
          </button>
        </div>
        <Message state={plantState} />
      </form>
    </div>
  );
}
