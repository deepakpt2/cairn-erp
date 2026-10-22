'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type {
  MaterialRangeGroupRow,
  UngroupedIntervalRow,
} from '@/modules/inventory/material-number-range-groups';
import {
  deleteMaterialRangeGroupAction,
  saveMaterialRangeGroupAction,
  type MaterialRangeGroupActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: MaterialRangeGroupActionState }) {
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

function ReasonInput({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        Reason<RequiredMark />
      </label>
      <input id={id} name="reason" required className="input mt-1 w-full" />
    </div>
  );
}

function DialogShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md space-y-3 border border-line bg-white p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" className="btn btn-default" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function nextPreview(current: number, to: number): string {
  return current + 1 <= to ? String(current + 1) : '—';
}

export default function MaterialNumberRanges({
  groups,
  ungrouped,
  canMaintain,
}: {
  groups: MaterialRangeGroupRow[];
  ungrouped: UngroupedIntervalRow[];
  canMaintain: boolean;
}) {
  const [selected, setSelected] = useState<MaterialRangeGroupRow | null>(null);
  const [deleting, setDeleting] = useState<MaterialRangeGroupRow | null>(null);
  const groupArgument = selected ? `${selected.internalKey.trim()}/${selected.externalKey.trim()}` : '';
  const groupLock = useChangeLock('MATERIAL_RANGE_GROUP', groupArgument, 'CFG.INV.MATERIALRANGE.DEFINE', Boolean(selected));
  const deleteLock = useChangeLock(
    'MATERIAL_RANGE_GROUP',
    deleting ? `${deleting.internalKey.trim()}/${deleting.externalKey.trim()}` : '',
    'CFG.INV.MATERIALRANGE.DEFINE',
    Boolean(deleting),
  );

  const [saveState, saveAction, savePending] = useActionState<
    MaterialRangeGroupActionState,
    FormData
  >(saveMaterialRangeGroupAction, { ok: true });
  const [deleteState, deleteAction] = useActionState<MaterialRangeGroupActionState, FormData>(
    deleteMaterialRangeGroupAction,
    { ok: true },
  );

  return (
    <div className="space-y-6">
      <section aria-labelledby="material-range-groups-grid" className="space-y-3">
        <h2 id="material-range-groups-grid" className="text-base font-semibold">
          Number range groups
        </h2>
        {groups.length === 0 ? (
          <p className="text-sm text-ink-faint">No number range groups stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Group</th>
                  <th className="py-2 pe-3">Internal interval</th>
                  <th className="py-2 pe-3">Bounds</th>
                  <th className="py-2 pe-3">Current</th>
                  <th className="py-2 pe-3">Next</th>
                  <th className="py-2 pe-3">External interval</th>
                  <th className="py-2 pe-3">Bounds</th>
                  <th className="py-2 pe-3">Current</th>
                  <th className="py-2 pe-3">Material types</th>
                  {canMaintain && <th className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {groups.map((row) => (
                  <tr
                    key={`${row.internalKey}/${row.externalKey}`}
                    className="border-b border-line/60"
                  >
                    <td className="py-2 pe-3 font-medium">{row.description}</td>
                    <td className="py-2 pe-3 font-mono">{row.internalKey}</td>
                    <td className="py-2 pe-3">
                      {row.internalFrom}–{row.internalTo} ({row.internalStatus})
                    </td>
                    <td className="py-2 pe-3">{row.internalCurrent}</td>
                    <td className="py-2 pe-3">
                      {nextPreview(row.internalCurrent, row.internalTo)}
                    </td>
                    <td className="py-2 pe-3 font-mono">{row.externalKey}</td>
                    <td className="py-2 pe-3">
                      {row.externalFrom}–{row.externalTo} ({row.externalStatus})
                    </td>
                    <td className="py-2 pe-3">{row.externalCurrent}</td>
                    <td className="py-2 pe-3">
                      {row.assignedTypes.length > 0 ? row.assignedTypes.join(', ') : '—'}
                    </td>
                    {canMaintain && (
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn btn-default"
                            onClick={() => setSelected(row)}
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            className="btn btn-default"
                            onClick={() => setDeleting(row)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canMaintain && (
          <form
            key={selected ? `${selected.internalKey}/${selected.externalKey}` : 'new'}
            action={saveAction}
            className="space-y-3 border border-line bg-white p-4"
          >
            <h3 className="text-sm font-semibold">
              {selected
                ? `Change number range group ${selected.internalKey}/${selected.externalKey}`
                : 'New number range group'}
            </h3>
            <input type="hidden" name="mode" value={selected ? 'CHANGE' : 'CREATE'} />
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="mrg-internal" className="text-sm font-medium">
                  Internal range key<RequiredMark />
                </label>
                <input
                  id="mrg-internal"
                  name="internalRangeKey"
                  required
                  maxLength={2}
                  defaultValue={selected?.internalKey ?? ''}
                  readOnly={!!selected}
                  className="input mt-1 w-full uppercase"
                />
              </div>
              <div>
                <label htmlFor="mrg-external" className="text-sm font-medium">
                  External range key<RequiredMark />
                </label>
                <input
                  id="mrg-external"
                  name="externalRangeKey"
                  required
                  maxLength={2}
                  defaultValue={selected?.externalKey ?? ''}
                  readOnly={!!selected}
                  className="input mt-1 w-full uppercase"
                />
              </div>
              <div>
                <label htmlFor="mrg-description" className="text-sm font-medium">
                  Group description<RequiredMark />
                </label>
                <input
                  id="mrg-description"
                  name="description"
                  required
                  maxLength={20}
                  defaultValue={selected?.description ?? ''}
                  className="input mt-1 w-full"
                />
              </div>
              <div className="sm:col-span-2">
                <ReasonInput id="mrg-reason" />
              </div>
            </div>
            {selected && (
              <p className="text-xs text-ink-soft">
                A group is its interval pair: to pair other intervals, delete this group
                and define a new one. The description changes freely.
              </p>
            )}
            <div className="flex gap-2">
              <LockNotice message={groupLock?.mode === 'DISPLAY' ? groupLock.message : null} />
              <button type="submit" className="btn btn-primary" disabled={savePending || (Boolean(selected) && groupLock?.mode !== 'CHANGE')}>
                {selected ? 'Save changes' : 'Define number range group'}
              </button>
              {selected && (
                <button
                  type="button"
                  className="btn btn-default"
                  onClick={() => setSelected(null)}
                >
                  New number range group
                </button>
              )}
            </div>
            <Message state={saveState} />
          </form>
        )}
      </section>

      <section aria-labelledby="material-range-ungrouped-grid" className="space-y-3">
        <h2 id="material-range-ungrouped-grid" className="text-base font-semibold">
          Ungrouped intervals
        </h2>
        {ungrouped.length === 0 ? (
          <p className="text-sm text-ink-faint">Every material interval stands in a group.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Range key</th>
                  <th className="py-2 pe-3">Assignment</th>
                  <th className="py-2 pe-3">Bounds</th>
                  <th className="py-2 pe-3">Current</th>
                  <th className="py-2 pe-3">Next</th>
                  <th className="py-2 pe-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {ungrouped.map((row) => (
                  <tr key={row.rangeKey} className="border-b border-line/60">
                    <td className="py-2 pe-3 font-mono">{row.rangeKey}</td>
                    <td className="py-2 pe-3">{row.isExternal ? 'External' : 'Internal'}</td>
                    <td className="py-2 pe-3">
                      {row.fromNumber}–{row.toNumber}
                    </td>
                    <td className="py-2 pe-3">{row.currentNumber}</td>
                    <td className="py-2 pe-3">{nextPreview(row.currentNumber, row.toNumber)}</td>
                    <td className="py-2 pe-3">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {deleting && (
        <DialogShell
          title={`Delete number range group ${deleting.internalKey}/${deleting.externalKey}`}
          onClose={() => setDeleting(null)}
        >
          <form action={deleteAction} className="space-y-3">
            <input type="hidden" name="internalRangeKey" value={deleting.internalKey} />
            <input type="hidden" name="externalRangeKey" value={deleting.externalKey} />
            <p className="text-sm text-ink-soft">
              Deletion is refused while material types carry this pair of intervals —{' '}
              {deleting.assignedTypes.length === 0
                ? 'no type carries it now.'
                : `${deleting.assignedTypes.join(', ')} carr${deleting.assignedTypes.length === 1 ? 'ies' : 'y'} it now.`}
            </p>
            <ReasonInput id="dlg-range-group-delete-reason" />
            <LockNotice message={deleteLock?.mode === 'DISPLAY' ? deleteLock.message : null} />
            <button type="submit" className="btn btn-primary" disabled={deleteLock?.mode !== 'CHANGE'}>
              Delete
            </button>
            <Message state={deleteState} />
          </form>
        </DialogShell>
      )}
    </div>
  );
}
