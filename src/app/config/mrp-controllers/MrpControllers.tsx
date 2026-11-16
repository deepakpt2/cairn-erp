'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import { ACTIVITY, LOCK_OBJECT, mrpControllerKey } from '@/modules/inventory/mrp-controller-key';
import type { MrpControllerRow } from '@/modules/inventory/mrp-controller-maintenance';
import {
  deleteMrpControllerAction,
  saveMrpControllerAction,
  setMrpControllerActiveAction,
  type MrpControllerActionState,
} from './actions';

function RequiredMark() {
  return <span className="ms-1 text-signal-error" aria-hidden="true">*</span>;
}

function Message({ state }: { state: MrpControllerActionState }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm text-ink">
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

function ReasonInput({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">Reason<RequiredMark /></label>
      <input id={id} name="reason" required className="input mt-1 w-full" />
    </div>
  );
}

function DialogShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md space-y-3 border border-line bg-white p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" className="btn btn-default" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function MrpControllers({
  controllers,
  plants,
  canMaintain,
  defaultPlant,
}: {
  controllers: MrpControllerRow[];
  plants: Array<{ plant: string; name: string }>;
  canMaintain: boolean;
  defaultPlant: string;
}) {
  const [selected, setSelected] = useState<MrpControllerRow | null>(null);
  const [dialog, setDialog] = useState<
    { kind: 'active'; row: MrpControllerRow } | { kind: 'delete'; row: MrpControllerRow } | null
  >(null);

  const [saveState, saveAction, savePending] = useActionState<MrpControllerActionState, FormData>(saveMrpControllerAction, { ok: true });
  const [activeState, activeAction] = useActionState<MrpControllerActionState, FormData>(setMrpControllerActiveAction, { ok: true });
  const [deleteState, deleteAction] = useActionState<MrpControllerActionState, FormData>(deleteMrpControllerAction, { ok: true });
  const selectedKey = selected ? mrpControllerKey(selected.plant, selected.controller) : '';
  const dialogKey = dialog ? mrpControllerKey(dialog.row.plant, dialog.row.controller) : '';
  const changeLock = useChangeLock(LOCK_OBJECT, selectedKey, ACTIVITY, Boolean(selected));
  const dialogLock = useChangeLock(LOCK_OBJECT, dialogKey, ACTIVITY, Boolean(dialog));

  return (
    <div className="space-y-6">
      <section aria-labelledby="mrp-controllers-grid" className="space-y-3">
        <h2 id="mrp-controllers-grid" className="text-base font-semibold">MRP controllers</h2>
        {controllers.length === 0 ? (
          <p className="text-sm text-ink-faint">No MRP controllers stand yet. Define one below, then name it on a material&apos;s MRP view.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-ink-soft">
                  <th className="pe-3">Plant</th>
                  <th className="pe-3">Controller</th>
                  <th className="pe-3">Planner</th>
                  <th className="pe-3">Materials</th>
                  <th className="pe-3">Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {controllers.map((row) => {
                  const key = mrpControllerKey(row.plant, row.controller);
                  return (
                    <tr key={key}>
                      <td className="pe-3"><span className="code">{row.plant}</span>{row.plantName && <span className="ms-2 text-ink-soft">{row.plantName}</span>}</td>
                      <td className="pe-3 code font-semibold">{row.controller}</td>
                      <td className="pe-3">{row.name}</td>
                      <td className="pe-3 tabular">{row.materialCount}</td>
                      <td className="pe-3">{row.isActive ? 'Active' : 'Inactive'}</td>
                      <td>
                        <div className="flex flex-wrap gap-2">
                          <Link className="btn btn-default" href={`/config/mrp-controllers?key=${encodeURIComponent(key)}&history=1`}>History</Link>
                          {canMaintain && (
                            <>
                              <button type="button" className="btn btn-default" onClick={() => setSelected(row)}>Change</button>
                              <button type="button" className="btn btn-default" onClick={() => setDialog({ kind: 'active', row })}>
                                {row.isActive ? 'Deactivate' : 'Reactivate'}
                              </button>
                              <button type="button" className="btn btn-default" onClick={() => setDialog({ kind: 'delete', row })}>Delete</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {canMaintain && (
          <form
            key={selected ? selectedKey : 'new'}
            action={saveAction}
            className="space-y-3 border border-line bg-white p-4"
          >
            <h3 className="text-sm font-semibold">
              {selected ? `Change MRP controller ${selected.controller} in plant ${selected.plant}` : 'New MRP controller'}
            </h3>
            <input type="hidden" name="mode" value={selected ? 'CHANGE' : 'CREATE'} />
            {selected && <input type="hidden" name="plant" value={selected.plant} />}
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="mc-plant" className="text-sm font-medium">Plant<RequiredMark /></label>
                {selected ? (
                  <input id="mc-plant" value={selected.plant} readOnly className="input mt-1 w-full code" />
                ) : (
                  <select id="mc-plant" name="plant" required defaultValue={plants.some((p) => p.plant === defaultPlant) ? defaultPlant : ''} className="input mt-1 w-full">
                    <option value="">Choose a plant</option>
                    {plants.map((p) => <option key={p.plant} value={p.plant}>{p.plant} · {p.name}</option>)}
                  </select>
                )}
              </div>
              <div>
                <label htmlFor="mc-code" className="text-sm font-medium">MRP controller<RequiredMark /></label>
                <input
                  id="mc-code"
                  name="controller"
                  required
                  maxLength={3}
                  defaultValue={selected?.controller ?? ''}
                  readOnly={!!selected}
                  className="input mt-1 w-full uppercase code"
                />
              </div>
              <div>
                <label htmlFor="mc-name" className="text-sm font-medium">Planner name<RequiredMark /></label>
                <input id="mc-name" name="name" required maxLength={100} defaultValue={selected?.name ?? ''} className="input mt-1 w-full" />
              </div>
              <div className="sm:col-span-2"><ReasonInput id="mc-reason" /></div>
            </div>
            <div className="flex gap-2">
              <LockNotice message={changeLock?.mode === 'DISPLAY' ? changeLock.message : null} remedy={changeLock?.remedy} />
              <button type="submit" className="btn btn-primary" disabled={savePending || (Boolean(selected) && changeLock?.mode !== 'CHANGE')}>
                {selected ? 'Save changes' : 'Define MRP controller'}
              </button>
              {selected && (
                <button type="button" className="btn btn-default" onClick={() => setSelected(null)}>New MRP controller</button>
              )}
            </div>
            <Message state={saveState} />
          </form>
        )}
      </section>

      {dialog?.kind === 'active' && (
        <DialogShell
          title={`${dialog.row.isActive ? 'Deactivate' : 'Reactivate'} MRP controller ${dialog.row.controller} in plant ${dialog.row.plant}`}
          onClose={() => setDialog(null)}
        >
          <form action={activeAction} className="space-y-3">
            <input type="hidden" name="key" value={dialogKey} />
            <input type="hidden" name="active" value={dialog.row.isActive ? 'false' : 'true'} />
            <p className="text-sm text-ink-soft">
              {dialog.row.isActive
                ? `Deactivation is refused while materials name the controller — ${dialog.row.materialCount} do now. A material cannot be saved with an inactive controller.`
                : 'The controller becomes available to the material master again.'}
            </p>
            <ReasonInput id="dlg-mrp-active-reason" />
            <LockNotice message={dialogLock?.mode === 'DISPLAY' ? dialogLock.message : null} remedy={dialogLock?.remedy} />
            <button type="submit" className="btn btn-primary" disabled={dialogLock?.mode !== 'CHANGE'}>
              {dialog.row.isActive ? 'Deactivate' : 'Reactivate'}
            </button>
            <Message state={activeState} />
          </form>
        </DialogShell>
      )}
      {dialog?.kind === 'delete' && (
        <DialogShell
          title={`Delete MRP controller ${dialog.row.controller} in plant ${dialog.row.plant}`}
          onClose={() => setDialog(null)}
        >
          <form action={deleteAction} className="space-y-3">
            <input type="hidden" name="key" value={dialogKey} />
            <p className="text-sm text-ink-soft">
              Deletion is refused while materials name the controller — {dialog.row.materialCount} do now.
            </p>
            <ReasonInput id="dlg-mrp-delete-reason" />
            <LockNotice message={dialogLock?.mode === 'DISPLAY' ? dialogLock.message : null} remedy={dialogLock?.remedy} />
            <button type="submit" className="btn btn-primary" disabled={dialogLock?.mode !== 'CHANGE'}>Delete</button>
            <Message state={deleteState} />
          </form>
        </DialogShell>
      )}
    </div>
  );
}
