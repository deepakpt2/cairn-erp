'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { BatchStatusRow } from '@/modules/inventory/batch-status';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import { saveBatchStatusAction, type BatchStatusActionState } from './actions';

const empty: BatchStatusActionState = { ok: false };

function Message({ state }: { state: BatchStatusActionState }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm text-ink">
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

export default function BatchStatusForm({
  client,
  current,
  canMaintain,
}: {
  client: string;
  current: BatchStatusRow;
  canMaintain: boolean;
}) {
  const router = useRouter();
  const lock = useChangeLock('BATCH_STATUS', client, 'OMCS', canMaintain);
  const displayOnly = lock?.mode === 'DISPLAY';
  const writable = canMaintain && !displayOnly;
  const opened = current.statusManagement === '1' ? '1' : current.version > 0 ? '' : undefined;
  const [selected, setSelected] = useState<string | undefined>(opened);
  const [requestKey, setRequestKey] = useState('');
  const [saveState, save, savePending] = useActionState(saveBatchStatusAction, empty);
  const version = saveState.version ?? current.version;

  useEffect(() => {
    setRequestKey((key) => key || crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (saveState.replaceRequestKey) setRequestKey(crypto.randomUUID());
    if (saveState.ok) router.refresh();
  }, [saveState.replaceRequestKey, saveState.ok, saveState.message, router]);

  return (
    <div className="space-y-4">
      {displayOnly && lock?.message && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink">{lock.message}</p>
      )}

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Batch level</h2>
        <p className="mt-2 text-sm text-ink">
          {current.batchLevel ? (
            <><span className="code">{current.batchLevel}</span><span className="ms-2">Read from OMCE. This screen does not change it.</span></>
          ) : (
            'Not set. Set it in OMCE before activating status management. An unset level is not plant level.'
          )}
        </p>
        <p className="mt-2 text-sm text-ink-soft">{current.scope.explanation}</p>
        <p className="mt-2 text-xs text-ink-faint">Version {current.version}. The lock is this configuration row, not the screen.</p>
      </section>

      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Indicator</h2>
        <fieldset className="space-y-2" disabled={!writable || savePending}>
          <legend className="sr-only">Batch status management</legend>
          <label className="flex gap-3 border border-line p-3 text-sm">
            <input
              type="radio"
              name="statusManagement"
              value="1"
              checked={selected === '1'}
              onChange={() => setSelected('1')}
              required
            />
            <span>
              <span className="code">1</span>
              <span className="ms-2 font-medium">Active</span>
              <span className="mt-1 block text-ink-soft">Batch status management is active. The code stored is the character 1.</span>
            </span>
          </label>
          <label className="flex gap-3 border border-line p-3 text-sm">
            <input
              type="radio"
              name="statusManagement"
              value=""
              checked={selected === ''}
              onChange={() => setSelected('')}
              required
            />
            <span>
              <span className="code">blank</span>
              <span className="ms-2 font-medium">Not active</span>
              <span className="mt-1 block text-ink-soft">Nothing is stored as a number. Blank means not active.</span>
            </span>
          </label>
        </fieldset>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="version" value={String(version)} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || savePending || selected === undefined}>
          {savePending ? 'Saving' : 'Save indicator'}
        </button>
        <Message state={saveState} />
      </form>
    </div>
  );
}
