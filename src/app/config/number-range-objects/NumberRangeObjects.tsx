'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { NumberRangeObjectRow } from '@/modules/foundation/number-ranges';
import {
  saveNumberRangeObjectAction,
  type NumberRangeObjectActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: NumberRangeObjectActionState }) {
  if (!state.message) return null;
  return (
    <div
      role={state.ok ? 'status' : 'alert'}
      className="border border-line bg-white p-3 text-sm text-ink"
    >
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

export default function NumberRangeObjects({
  objects,
  canMaintain,
}: {
  objects: NumberRangeObjectRow[];
  canMaintain: boolean;
}) {
  const [selected, setSelected] = useState<NumberRangeObjectRow | null>(null);
  const objectLock = useChangeLock(
    'NUMBER_RANGE_OBJECT',
    selected?.objectCode ?? '',
    'CFG.PLT.NUMBERRANGE.DEFINE',
    Boolean(selected),
  );
  const [state, formAction, pending] = useActionState<
    NumberRangeObjectActionState,
    FormData
  >(saveNumberRangeObjectAction, { ok: true });

  return (
    <div className="space-y-6">
      <section aria-labelledby="number-range-objects-grid" className="space-y-3">
        <h2 id="number-range-objects-grid" className="text-base font-semibold">
          Number range objects
        </h2>
        {objects.length === 0 ? (
          <p className="text-sm text-ink-faint">No objects stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Object</th>
                  <th className="py-2 pe-3">Description</th>
                  <th className="py-2 pe-3">Number length</th>
                  <th className="py-2 pe-3">Warning at</th>
                  <th className="py-2 pe-3">Year relevance</th>
                  <th className="py-2 pe-3">Subobject</th>
                  <th className="py-2 pe-3">Intervals</th>
                  {canMaintain && <th className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {objects.map((row) => (
                  <tr key={row.objectCode} className="border-b border-line/60">
                    <td className="py-2 pe-3 font-medium">{row.objectCode}</td>
                    <td className="py-2 pe-3">{row.description}</td>
                    <td className="py-2 pe-3">{row.numberLength}</td>
                    <td className="py-2 pe-3">
                      {row.warningPercent ? `${row.warningPercent}%` : '—'}
                    </td>
                    <td className="py-2 pe-3">{row.yearRelevant ? 'Per fiscal year' : 'All years'}</td>
                    <td className="py-2 pe-3">{row.subobjectHint ?? '—'}</td>
                    <td className="py-2 pe-3">{row.intervalCount}</td>
                    {canMaintain && (
                      <td className="py-2">
                        <button
                          type="button"
                          className="btn btn-default"
                          onClick={() => setSelected(row)}
                        >
                          Change
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canMaintain && selected && (
          <form
            key={selected.objectCode}
            action={formAction}
            className="space-y-3 border border-line bg-white p-4"
          >
            <h3 className="text-sm font-semibold">
              Change number range object {selected.objectCode}
            </h3>
            <input type="hidden" name="objectCode" value={selected.objectCode} />
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label htmlFor="nro-description" className="text-sm font-medium">
                  Description<RequiredMark />
                </label>
                <input
                  id="nro-description"
                  name="description"
                  required
                  maxLength={60}
                  defaultValue={selected.description}
                  className="input mt-1 w-full"
                />
              </div>
              <div>
                <label htmlFor="nro-length" className="text-sm font-medium">
                  Number length<RequiredMark />
                </label>
                <input
                  id="nro-length"
                  name="numberLength"
                  type="number"
                  min={1}
                  max={40}
                  required
                  defaultValue={selected.numberLength}
                  className="input mt-1 w-full"
                />
              </div>
              <div>
                <label htmlFor="nro-warning" className="text-sm font-medium">
                  Consumption warning %
                </label>
                <input
                  id="nro-warning"
                  name="warningPercent"
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="99.9"
                  defaultValue={selected.warningPercent ?? ''}
                  className="input mt-1 w-full"
                />
              </div>
              <div>
                <label htmlFor="nro-subobject" className="text-sm font-medium">
                  Subobject means
                </label>
                <input
                  id="nro-subobject"
                  name="subobjectHint"
                  maxLength={30}
                  defaultValue={selected.subobjectHint ?? ''}
                  className="input mt-1 w-full"
                />
              </div>
              <div className="flex items-end gap-2 pb-1">
                <input
                  id="nro-year"
                  name="yearRelevant"
                  type="checkbox"
                  defaultChecked={selected.yearRelevant}
                  className="h-4 w-4"
                />
                <label htmlFor="nro-year" className="text-sm">
                  Intervals run per fiscal year
                </label>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="nro-reason" className="text-sm font-medium">
                  Reason<RequiredMark />
                </label>
                <input id="nro-reason" name="reason" required className="input mt-1 w-full" />
              </div>
            </div>
            <p className="max-w-3xl text-xs text-ink-soft">
              Object names belong to the application and are never created or deleted here;
              this form maintains the facts applications and interval screens read.
            </p>
            <div className="flex gap-2">
              <LockNotice message={objectLock?.mode === 'DISPLAY' ? objectLock.message : null} />
              <button type="submit" className="btn btn-primary" disabled={pending || objectLock?.mode !== 'CHANGE'}>
                Save changes
              </button>
              <button
                type="button"
                className="btn btn-default"
                onClick={() => setSelected(null)}
              >
                Close
              </button>
            </div>
            <Message state={state} />
          </form>
        )}
      </section>
    </div>
  );
}
