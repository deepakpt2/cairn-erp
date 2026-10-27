'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { IndustryRow } from '@/modules/foundation/industry-definition';
import {
  deleteIndustryAction,
  saveIndustryAction,
  setIndustryActiveAction,
  type IndustryActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: IndustryActionState }) {
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

export default function Industries({
  industries,
  canMaintain,
}: {
  industries: IndustryRow[];
  canMaintain: boolean;
}) {
  const [selected, setSelected] = useState<IndustryRow | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'active'; row: IndustryRow }
    | { kind: 'delete'; row: IndustryRow }
    | null
  >(null);

  const [saveState, saveAction, savePending] = useActionState<
    IndustryActionState,
    FormData
  >(saveIndustryAction, { ok: true });
  const [activeState, activeAction] = useActionState<IndustryActionState, FormData>(
    setIndustryActiveAction,
    { ok: true },
  );
  const [deleteState, deleteAction] = useActionState<IndustryActionState, FormData>(
    deleteIndustryAction,
    { ok: true },
  );
  const changeLock = useChangeLock('INDUSTRY', selected?.code ?? '', 'CFG.ORG.INDUSTRY.DEFINE', Boolean(selected));
  const dialogLock = useChangeLock('INDUSTRY', dialog?.row.code ?? '', 'CFG.ORG.INDUSTRY.DEFINE', Boolean(dialog));

  return (
    <div className="space-y-6">
      <section aria-labelledby="industries-grid" className="space-y-3">
        <h2 id="industries-grid" className="text-base font-semibold">
          Industries
        </h2>
        {industries.length === 0 ? (
          <p className="text-sm text-ink-faint">No industries stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Industry</th>
                  <th className="py-2 pe-3">Description</th>
                  <th className="py-2 pe-3">Languages</th>
                  <th className="py-2 pe-3">Partners</th>
                  <th className="py-2 pe-3">Status</th>
                  {canMaintain && <th className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {industries.map((row) => (
                  <tr key={row.code} className="border-b border-line/60">
                    <td className="py-2 pe-3 font-medium">{row.code}</td>
                    <td className="py-2 pe-3">{row.description}</td>
                    <td className="py-2 pe-3">{Object.keys(row.texts).join(', ')}</td>
                    <td className="py-2 pe-3">{row.partnerCount}</td>
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
            key={selected ? selected.code : 'new'}
            action={saveAction}
            className="space-y-3 border border-line bg-white p-4"
          >
            <h3 className="text-sm font-semibold">
              {selected ? `Change industry ${selected.code}` : 'New industry'}
            </h3>
            <input type="hidden" name="mode" value={selected ? 'CHANGE' : 'CREATE'} />
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <label htmlFor="ind-key" className="text-sm font-medium">
                  Industry<RequiredMark />
                </label>
                <input
                  id="ind-key"
                  name="industry"
                  required
                  maxLength={4}
                  defaultValue={selected?.code ?? ''}
                  readOnly={!!selected}
                  className="input mt-1 w-full uppercase"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="ind-desc" className="text-sm font-medium">
                  Description<RequiredMark />
                </label>
                <input
                  id="ind-desc"
                  name="description"
                  required
                  maxLength={20}
                  defaultValue={selected?.description ?? ''}
                  className="input mt-1 w-full"
                />
              </div>
              <div>
                <label htmlFor="ind-lang" className="text-sm font-medium">
                  Language<RequiredMark />
                </label>
                <input
                  id="ind-lang"
                  name="language"
                  required
                  maxLength={5}
                  defaultValue="en"
                  className="input mt-1 w-full"
                />
              </div>
              <div className="sm:col-span-3">
                <ReasonInput id="ind-reason" />
              </div>
            </div>
            <div className="flex gap-2">
              <LockNotice message={changeLock?.mode === 'DISPLAY' ? changeLock.message : null} remedy={changeLock?.remedy} />
              <button type="submit" className="btn btn-primary" disabled={savePending || (Boolean(selected) && changeLock?.mode !== 'CHANGE')}>
                {selected ? 'Save changes' : 'Create industry'}
              </button>
              {selected && (
                <button
                  type="button"
                  className="btn btn-default"
                  onClick={() => setSelected(null)}
                >
                  New industry
                </button>
              )}
            </div>
            <Message state={saveState} />
          </form>
        )}
      </section>

      {dialog?.kind === 'active' && (
        <DialogShell
          title={`${dialog.row.isActive ? 'Deactivate' : 'Reactivate'} industry ${dialog.row.code}`}
          onClose={() => setDialog(null)}
        >
          <form action={activeAction} className="space-y-3">
            <input type="hidden" name="industry" value={dialog.row.code} />
            <input type="hidden" name="active" value={dialog.row.isActive ? 'false' : 'true'} />
            <p className="text-sm text-ink-soft">
              {dialog.row.isActive
                ? 'A deactivated industry stops new assignments; its standing partners keep it. Reactivate it here at any time.'
                : 'The industry becomes available to partners again.'}
            </p>
            <ReasonInput id="dlg-industry-active-reason" />
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
          title={`Delete industry ${dialog.row.code}`}
          onClose={() => setDialog(null)}
        >
          <form action={deleteAction} className="space-y-3">
            <input type="hidden" name="industry" value={dialog.row.code} />
            <p className="text-sm text-ink-soft">
              Deletion is refused while business partners carry the industry —{' '}
              {dialog.row.partnerCount} stand against it now.
            </p>
            <ReasonInput id="dlg-industry-delete-reason" />
            <LockNotice message={dialogLock?.mode === 'DISPLAY' ? dialogLock.message : null} remedy={dialogLock?.remedy} />
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
