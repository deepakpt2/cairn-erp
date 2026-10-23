'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { WipBatchRow } from '@/modules/production/wip-batch';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import { saveWipBatchAction, type WipActionState } from './actions';

const empty: WipActionState = { ok: false };

export default function WipForm({
  client,
  current,
  canMaintain,
}: {
  client: string;
  current: WipBatchRow;
  canMaintain: boolean;
}) {
  const router = useRouter();
  const lock = useChangeLock('WIP_BATCH', client, 'OMCWB', canMaintain && !current.irreversible);
  const writable = canMaintain && !current.irreversible && lock?.mode !== 'DISPLAY';
  const opened = current.code === 'X' ? 'X' : current.version > 0 ? '' : undefined;
  const [selected, setSelected] = useState<string | undefined>(opened);
  const [requestKey, setRequestKey] = useState('');
  const [state, save, pending] = useActionState(saveWipBatchAction, empty);
  const version = state.version ?? current.version;

  useEffect(() => {
    setRequestKey((key) => key || crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (state.replaceRequestKey) setRequestKey(crypto.randomUUID());
    if (state.ok) router.refresh();
  }, [state.replaceRequestKey, state.ok, state.message, router]);

  return (
    <form action={save} className="space-y-3 border border-line bg-white p-4">
      <h2 className="text-sm font-semibold">WIP batch</h2>
      <p className="text-sm text-ink-soft">
        Current state: {current.code === 'X' ? 'active' : 'not active'}. Version {current.version}.
        Batch level {current.batchLevel ?? 'not set'}.
      </p>
      {current.irreversible && (
        <p role="status" className="text-sm">
          WIP batch is active and cannot be revoked. Opening this screen did not initialize it again.
        </p>
      )}
      {lock?.mode === 'DISPLAY' && lock.message && <p role="status" className="text-sm">{lock.message}</p>}
      <fieldset className="space-y-2 text-sm" disabled={!writable}>
        <legend className="font-medium">WIP Batch Active</legend>
        {!current.irreversible && (
          <label className="flex items-start gap-2">
            <input type="radio" name="wipBatchActive" value="" checked={selected === ''} onChange={() => setSelected('')} />
            <span>Blank · Not active.</span>
          </label>
        )}
        <label className="flex items-start gap-2">
          <input type="radio" name="wipBatchActive" value="X" checked={selected === 'X'} onChange={() => setSelected('X')} />
          <span>X · Active. This cannot be revoked.</span>
        </label>
      </fieldset>
      {selected === 'X' && !current.irreversible && (
        <div className="border border-line p-3 text-sm">
          <p>Activation cannot be revoked. It does not create a WIP batch, a production order, or a material document.</p>
          <p className="mt-1 text-ink-soft">
            Business function LOG_PP_WIP_BATCH, original-batch reference material, a confirmation profile, and a control key are not set by this save.
          </p>
          <label className="mt-2 flex items-start gap-2">
            <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
            <span>I confirm this activation. It cannot be revoked.</span>
          </label>
        </div>
      )}
      {!current.irreversible && (
        <>
          <label className="block text-sm">
            Reason
            <input name="reason" required minLength={3} maxLength={500} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <input type="hidden" name="version" value={version} />
          <input type="hidden" name="requestKey" value={requestKey} />
          <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending || selected === undefined}>
            {pending ? 'Saving' : 'Save indicator'}
          </button>
        </>
      )}
      {state.message && (
        <div role={state.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
        </div>
      )}
    </form>
  );
}
