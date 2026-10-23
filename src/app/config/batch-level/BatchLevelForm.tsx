'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { BatchLevelCode, BatchLevelMeaning, BatchLevelRow, ConversionAttempt } from '@/modules/inventory/batch-level';
import { useChangeLock } from '@/ui/lock/ChangeLock';

import {
  prepareConversionAction,
  saveBatchLevelAction,
  type BatchLevelActionState,
} from './actions';

const empty: BatchLevelActionState = { ok: false };

function Message({ state }: { state: BatchLevelActionState }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm text-ink">
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

export default function BatchLevelForm({
  client,
  levels,
  current,
  conversion,
  canMaintain,
}: {
  client: string;
  levels: BatchLevelMeaning[];
  current: BatchLevelRow | null;
  conversion: ConversionAttempt | null;
  canMaintain: boolean;
}) {
  const router = useRouter();
  const lock = useChangeLock('BATCH_LEVEL', client, 'OMCE', canMaintain);
  const displayOnly = lock?.mode === 'DISPLAY';
  const writable = canMaintain && !displayOnly;
  const [selected, setSelected] = useState<BatchLevelCode | ''>(current?.batchLevel ?? '');
  const [requestKey, setRequestKey] = useState('');
  const [saveState, save, savePending] = useActionState(saveBatchLevelAction, empty);
  const [prepareState, prepare, preparePending] = useActionState(prepareConversionAction, empty);
  const version = saveState.version ?? current?.version ?? 0;

  useEffect(() => {
    setRequestKey((key) => key || crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (saveState.replaceRequestKey) setRequestKey(crypto.randomUUID());
    if (saveState.ok || prepareState.message) router.refresh();
  }, [saveState.replaceRequestKey, saveState.message, saveState.ok, prepareState.message, router]);

  return (
    <div className="space-y-4">
      {displayOnly && lock?.message && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink">{lock.message}</p>
      )}

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Current level</h2>
        {current ? (
          <p className="mt-2 text-sm text-ink">
            <span className="code">{current.batchLevel}</span>
            <span className="ms-2">{current.name}</span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink">Not set. An unset level is not plant level.</p>
        )}
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          {current ? current.uniqueness : 'Choose a level and save it. No batch is created by this screen.'}
        </p>
        <p className="mt-2 text-xs text-ink-faint">Version {current?.version ?? 0}. The lock is this configuration row, not the screen.</p>
      </section>

      {conversion && (
        <section className="border border-line bg-white p-4" aria-label="Last conversion attempt">
          <h2 className="text-sm font-semibold">Last conversion attempt</h2>
          <p className="mt-2 text-sm text-ink">{conversion.errorSummary}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {conversion.status}. The level stayed {conversion.sourceLevel}. Run {conversion.conversionRunId}.
          </p>
        </section>
      )}

      <form action={save} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Level</h2>
        <fieldset className="space-y-2" disabled={!writable || savePending}>
          <legend className="sr-only">Batch level</legend>
          {levels.map((level) => (
            <label key={level.code} className="flex gap-3 border border-line p-3 text-sm">
              <input
                type="radio"
                name="batchLevel"
                value={level.code}
                checked={selected === level.code}
                onChange={() => setSelected(level.code)}
                required
              />
              <span>
                <span className="code">{level.code}</span>
                <span className="ms-2 font-medium">{level.name}</span>
                <span className="mt-1 block text-ink-soft">{level.uniqueness}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="version" value={String(version)} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || savePending || selected === ''}>
          {savePending ? 'Saving' : 'Save level'}
        </button>
        <Message state={saveState} />
      </form>

      <form action={prepare} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Impact</h2>
        <p className="text-sm text-ink-soft">
          This reads what a change would touch. It does not change the level, and it is not a conversion.
        </p>
        <input type="hidden" name="targetLevel" value={selected} />
        <input type="hidden" name="version" value={String(version)} />
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <button type="submit" className="btn btn-default min-h-11" disabled={!writable || preparePending || !current || selected === ''}>
          {preparePending ? 'Reading' : 'Prepare impact'}
        </button>
        <Message state={prepareState} />
      </form>
    </div>
  );
}
