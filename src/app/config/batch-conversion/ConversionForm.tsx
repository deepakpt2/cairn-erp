'use client';

import { useActionState } from 'react';

import type { ConversionSnapshot } from '@/modules/inventory/batch-conversion';

import { checkConversionAction, executeConversionAction, type ConversionActionState } from './actions';

const empty: ConversionActionState = { ok: false };

export default function ConversionForm({
  canMaintain,
  snapshot,
}: {
  canMaintain: boolean;
  snapshot: ConversionSnapshot;
}) {
  const [state, check, pending] = useActionState(checkConversionAction, empty);
  const [executed, run, running] = useActionState(executeConversionAction, empty);
  const conflicts = state.conflicts ?? [];

  return (
    <div className="space-y-3">
      <form action={check} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Conversion check</h2>
        <p className="text-sm text-ink-soft">
          Current level {snapshot.batchLevel ?? 'not set'} {snapshot.levelName}. Status management is {snapshot.statusManagement === '1' ? 'active' : 'inactive'}.
          A dry run writes nothing. A confirmed check records the finding and does not convert.
        </p>
        <label className="block text-sm">
          Proposed level
          <select name="targetLevel" defaultValue="" disabled={!canMaintain} className="mt-1 w-full border border-line px-2 py-1">
            <option value="">No level change</option>
            <option value="0">0 · Plant level</option>
            <option value="1">1 · Material level</option>
            <option value="2">2 · Client level</option>
          </select>
        </label>
        <label className="block text-sm">
          Proposed status
          <select name="targetStatus" defaultValue="" disabled={!canMaintain} className="mt-1 w-full border border-line px-2 py-1">
            <option value="">No status change</option>
            <option value="1">1 · Active</option>
            <option value="BLANK">Blank · Inactive</option>
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="dryRun" value="yes" className="mt-1" />
          <span>Dry run. Write nothing, including this finding.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirmed" value="yes" className="mt-1" />
          <span>Confirm the check. This still does not change the level, the status, or a batch.</span>
        </label>
        <label className="block text-sm">
          Reason
          <input name="reason" required minLength={3} maxLength={500} disabled={!canMaintain} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
        <input type="hidden" name="expectedLevelVersion" value={snapshot.levelVersion} />
        <button type="submit" className="btn btn-primary min-h-11" disabled={!canMaintain || pending}>{pending ? 'Checking' : 'Run check'}</button>
        {state.message && (
          <div role={state.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
            <p>{state.message}</p>
            {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
          </div>
        )}
        {conflicts.length > 0 && (
          <ul className="space-y-1 text-sm">
            {conflicts.map((item) => (
              <li key={`${item.position}-${item.objectKey}`}>
                <span className="code">{item.conflictCode}</span> · {item.objectKey}. {item.detail}
              </li>
            ))}
          </ul>
        )}
      </form>
      <form action={run} className="space-y-3 border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Execute conversion</h2>
        <p className="text-sm text-ink-soft">Execution is refused. The button proves the refusal. It does not merge a batch or post.</p>
        <button type="submit" className="btn btn-default min-h-11" disabled={!canMaintain || running}>{running ? 'Refusing' : 'Execute conversion'}</button>
        {executed.message && (
          <p role="alert" className="text-sm">{executed.message} {executed.remedy}</p>
        )}
      </form>
    </div>
  );
}
