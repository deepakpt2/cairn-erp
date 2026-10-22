'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { IndustrySectorRow } from '@/modules/inventory/industry-sector-definition';
import {
  deleteIndustrySectorAction,
  saveIndustrySectorAction,
  setIndustrySectorActiveAction,
  type IndustrySectorActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: IndustrySectorActionState }) {
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

export default function IndustrySectors({
  sectors,
  canMaintain,
}: {
  sectors: IndustrySectorRow[];
  canMaintain: boolean;
}) {
  const [selected, setSelected] = useState<IndustrySectorRow | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'active'; row: IndustrySectorRow }
    | { kind: 'delete'; row: IndustrySectorRow }
    | null
  >(null);

  const [saveState, saveAction, savePending] = useActionState<
    IndustrySectorActionState,
    FormData
  >(saveIndustrySectorAction, { ok: true });
  const [activeState, activeAction] = useActionState<IndustrySectorActionState, FormData>(
    setIndustrySectorActiveAction,
    { ok: true },
  );
  const [deleteState, deleteAction] = useActionState<IndustrySectorActionState, FormData>(
    deleteIndustrySectorAction,
    { ok: true },
  );
  const changeLock = useChangeLock('INDUSTRY_SECTOR', selected?.sector ?? '', 'CFG.INV.INDUSTRYSECTOR.DEFINE', Boolean(selected));
  const dialogLock = useChangeLock('INDUSTRY_SECTOR', dialog?.row.sector ?? '', 'CFG.INV.INDUSTRYSECTOR.DEFINE', Boolean(dialog));

  return (
    <div className="space-y-6">
      <section aria-labelledby="industry-sectors-grid" className="space-y-3">
        <h2 id="industry-sectors-grid" className="text-base font-semibold">
          Industry sectors
        </h2>
        {sectors.length === 0 ? (
          <p className="text-sm text-ink-faint">No industry sectors stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Sector</th>
                  <th className="py-2 pe-3">Name</th>
                  <th className="py-2 pe-3">Materials</th>
                  <th className="py-2 pe-3">Status</th>
                  {canMaintain && <th className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {sectors.map((row) => (
                  <tr key={row.sector} className="border-b border-line/60">
                    <td className="py-2 pe-3 font-medium">{row.sector}</td>
                    <td className="py-2 pe-3">{row.name}</td>
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
            key={selected ? selected.sector : 'new'}
            action={saveAction}
            className="space-y-3 border border-line bg-white p-4"
          >
            <h3 className="text-sm font-semibold">
              {selected ? `Change industry sector ${selected.sector}` : 'New industry sector'}
            </h3>
            <input type="hidden" name="mode" value={selected ? 'CHANGE' : 'CREATE'} />
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="is-key" className="text-sm font-medium">
                  Sector<RequiredMark />
                </label>
                <input
                  id="is-key"
                  name="sector"
                  required
                  maxLength={1}
                  defaultValue={selected?.sector ?? ''}
                  readOnly={!!selected}
                  className="input mt-1 w-full uppercase"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="is-name" className="text-sm font-medium">
                  Name<RequiredMark />
                </label>
                <input
                  id="is-name"
                  name="name"
                  required
                  maxLength={40}
                  defaultValue={selected?.name ?? ''}
                  className="input mt-1 w-full"
                />
              </div>
              <div className="sm:col-span-2">
                <ReasonInput id="is-reason" />
              </div>
            </div>
            <div className="flex gap-2">
              <LockNotice message={changeLock?.mode === 'DISPLAY' ? changeLock.message : null} />
              <button type="submit" className="btn btn-primary" disabled={savePending || (Boolean(selected) && changeLock?.mode !== 'CHANGE')}>
                {selected ? 'Save changes' : 'Define industry sector'}
              </button>
              {selected && (
                <button
                  type="button"
                  className="btn btn-default"
                  onClick={() => setSelected(null)}
                >
                  New industry sector
                </button>
              )}
            </div>
            <Message state={saveState} />
          </form>
        )}
      </section>

      {dialog?.kind === 'active' && (
        <DialogShell
          title={`${dialog.row.isActive ? 'Deactivate' : 'Reactivate'} industry sector ${dialog.row.sector}`}
          onClose={() => setDialog(null)}
        >
          <form action={activeAction} className="space-y-3">
            <input type="hidden" name="sector" value={dialog.row.sector} />
            <input type="hidden" name="active" value={dialog.row.isActive ? 'false' : 'true'} />
            <p className="text-sm text-ink-soft">
              {dialog.row.isActive
                ? 'A deactivated sector stops new materials; its standing materials keep it. Reactivate it here at any time.'
                : 'The sector becomes available to new materials again.'}
            </p>
            <ReasonInput id="dlg-sector-active-reason" />
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
          title={`Delete industry sector ${dialog.row.sector}`}
          onClose={() => setDialog(null)}
        >
          <form action={deleteAction} className="space-y-3">
            <input type="hidden" name="sector" value={dialog.row.sector} />
            <p className="text-sm text-ink-soft">
              Deletion is refused while materials carry the sector —{' '}
              {dialog.row.materialCount} stand against it now.
            </p>
            <ReasonInput id="dlg-sector-delete-reason" />
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
