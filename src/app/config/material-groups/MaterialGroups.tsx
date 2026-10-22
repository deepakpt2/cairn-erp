'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { MaterialGroupRow } from '@/modules/inventory/material-group-definition';
import {
  deleteMaterialGroupAction,
  saveMaterialGroupAction,
  setMaterialGroupActiveAction,
  type MaterialGroupActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: MaterialGroupActionState }) {
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

export default function MaterialGroups({
  groups,
  canMaintain,
}: {
  groups: MaterialGroupRow[];
  canMaintain: boolean;
}) {
  const [selected, setSelected] = useState<MaterialGroupRow | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'active'; row: MaterialGroupRow }
    | { kind: 'delete'; row: MaterialGroupRow }
    | null
  >(null);

  const [saveState, saveAction, savePending] = useActionState<
    MaterialGroupActionState,
    FormData
  >(saveMaterialGroupAction, { ok: true });
  const [activeState, activeAction] = useActionState<MaterialGroupActionState, FormData>(
    setMaterialGroupActiveAction,
    { ok: true },
  );
  const [deleteState, deleteAction] = useActionState<MaterialGroupActionState, FormData>(
    deleteMaterialGroupAction,
    { ok: true },
  );
  const changeLock = useChangeLock('MATERIAL_GROUP', selected?.materialGroup ?? '', 'CFG.INV.MATERIALGROUP.DEFINE', Boolean(selected));
  const dialogLock = useChangeLock('MATERIAL_GROUP', dialog?.row.materialGroup ?? '', 'CFG.INV.MATERIALGROUP.DEFINE', Boolean(dialog));

  return (
    <div className="space-y-6">
      <section aria-labelledby="material-groups-grid" className="space-y-3">
        <h2 id="material-groups-grid" className="text-base font-semibold">
          Material groups
        </h2>
        {groups.length === 0 ? (
          <p className="text-sm text-ink-faint">No material groups stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Group</th>
                  <th className="py-2 pe-3">Short description</th>
                  <th className="py-2 pe-3">Long description</th>
                  <th className="py-2 pe-3">Materials</th>
                  <th className="py-2 pe-3">Status</th>
                  {canMaintain && <th className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {groups.map((row) => (
                  <tr key={row.materialGroup} className="border-b border-line/60">
                    <td className="py-2 pe-3 font-medium">{row.materialGroup}</td>
                    <td className="py-2 pe-3">{row.name}</td>
                    <td className="py-2 pe-3">{row.longDescription ?? '—'}</td>
                    <td className="py-2 pe-3">{row.materialCount}</td>
                    <td className="py-2 pe-3">{row.isActive ? 'Active' : 'Inactive'}</td>
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
                            onClick={() => setDialog({ kind: 'active', row })}
                          >
                            {row.isActive ? 'Deactivate' : 'Reactivate'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-default"
                            onClick={() => setDialog({ kind: 'delete', row })}
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
            key={selected ? selected.materialGroup : 'new'}
            action={saveAction}
            className="space-y-3 border border-line bg-white p-4"
          >
            <h3 className="text-sm font-semibold">
              {selected ? `Change material group ${selected.materialGroup}` : 'New material group'}
            </h3>
            <input type="hidden" name="mode" value={selected ? 'CHANGE' : 'CREATE'} />
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="mg-key" className="text-sm font-medium">
                  Material group<RequiredMark />
                </label>
                <input
                  id="mg-key"
                  name="materialGroup"
                  required
                  maxLength={9}
                  defaultValue={selected?.materialGroup ?? ''}
                  readOnly={!!selected}
                  className="input mt-1 w-full uppercase"
                />
              </div>
              <div>
                <label htmlFor="mg-name" className="text-sm font-medium">
                  Short description<RequiredMark />
                </label>
                <input
                  id="mg-name"
                  name="name"
                  required
                  maxLength={20}
                  defaultValue={selected?.name ?? ''}
                  className="input mt-1 w-full"
                />
              </div>
              <div>
                <label htmlFor="mg-long" className="text-sm font-medium">
                  Long description
                </label>
                <input
                  id="mg-long"
                  name="longDescription"
                  maxLength={60}
                  defaultValue={selected?.longDescription ?? ''}
                  className="input mt-1 w-full"
                />
              </div>
              <div className="sm:col-span-2">
                <ReasonInput id="mg-reason" />
              </div>
            </div>
            <div className="flex gap-2">
              <LockNotice message={changeLock?.mode === 'DISPLAY' ? changeLock.message : null} />
              <button type="submit" className="btn btn-primary" disabled={savePending || (Boolean(selected) && changeLock?.mode !== 'CHANGE')}>
                {selected ? 'Save changes' : 'Define material group'}
              </button>
              {selected && (
                <button
                  type="button"
                  className="btn btn-default"
                  onClick={() => setSelected(null)}
                >
                  New material group
                </button>
              )}
            </div>
            <Message state={saveState} />
          </form>
        )}
      </section>

      {dialog?.kind === 'active' && (
        <DialogShell
          title={`${dialog.row.isActive ? 'Deactivate' : 'Reactivate'} material group ${dialog.row.materialGroup}`}
          onClose={() => setDialog(null)}
        >
          <form action={activeAction} className="space-y-3">
            <input type="hidden" name="materialGroup" value={dialog.row.materialGroup} />
            <input type="hidden" name="active" value={dialog.row.isActive ? 'false' : 'true'} />
            <p className="text-sm text-ink-soft">
              {dialog.row.isActive
                ? 'A deactivated group stops new materials; its standing materials keep it. Reactivate it here at any time.'
                : 'The group becomes available to new materials again.'}
            </p>
            <ReasonInput id="dlg-group-active-reason" />
            <LockNotice message={dialogLock?.mode === 'DISPLAY' ? dialogLock.message : null} />
            <button type="submit" className="btn btn-primary" disabled={dialogLock?.mode !== 'CHANGE'}>
              {dialog.row.isActive ? 'Deactivate' : 'Reactivate'}
            </button>
            <Message state={activeState} />
          </form>
        </DialogShell>
      )}
      {dialog?.kind === 'delete' && (
        <DialogShell
          title={`Delete material group ${dialog.row.materialGroup}`}
          onClose={() => setDialog(null)}
        >
          <form action={deleteAction} className="space-y-3">
            <input type="hidden" name="materialGroup" value={dialog.row.materialGroup} />
            <p className="text-sm text-ink-soft">
              Deletion is refused while materials carry the group —{' '}
              {dialog.row.materialCount} stand against it now.
            </p>
            <ReasonInput id="dlg-group-delete-reason" />
            <LockNotice message={dialogLock?.mode === 'DISPLAY' ? dialogLock.message : null} />
            <button type="submit" className="btn btn-primary" disabled={dialogLock?.mode !== 'CHANGE'}>
              Delete
            </button>
            <Message state={deleteState} />
          </form>
        </DialogShell>
      )}
    </div>
  );
}
