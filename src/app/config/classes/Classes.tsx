'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { ClassChoices, ClassRow } from '@/modules/foundation/class-definition';
import {
  deleteClassAction,
  saveClassAction,
  setClassStatusAction,
  type ClassActionState,
} from './actions';

/**
 * Classes for classification (SCR-058 / CL02; inert in stage 1, live
 * since stage 3). The standing grid beside the editor; activation,
 * blocking and deletion are their own reasoned acts.
 */

const INITIAL: ClassActionState = { ok: false };

function DialogShell({ title, children, onClose }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
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

interface EditorState {
  mode: 'CREATE' | 'CHANGE';
  classType: string;
  className: string;
  description: string;
  assignments: Array<{ characteristicName: string; requiredForClassification: boolean }>;
}

const EMPTY_EDITOR: EditorState = {
  mode: 'CREATE',
  classType: 'PURCHASE_ORDER',
  className: '',
  description: '',
  assignments: [{ characteristicName: '', requiredForClassification: false }],
};

function editorFromRow(row: ClassRow): EditorState {
  return {
    mode: 'CHANGE',
    classType: row.classType,
    className: row.className,
    description: row.description,
    assignments: row.assignments.length > 0
      ? row.assignments.map((a) => ({
          characteristicName: a.characteristicName,
          requiredForClassification: a.requiredForClassification,
        }))
      : [{ characteristicName: '', requiredForClassification: false }],
  };
}

export default function Classes({ data, canMaintain }: {
  data: ClassChoices;
  canMaintain: boolean;
}) {
  const [saveState, saveAction, saving] = useActionState(saveClassAction, INITIAL);
  const [statusState, statusAction] = useActionState(setClassStatusAction, INITIAL);
  const [deleteState, deleteAction] = useActionState(deleteClassAction, INITIAL);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [dialog, setDialog] = useState<
    | { kind: 'status'; row: ClassRow; status: 'ACTIVE' | 'BLOCKED' }
    | { kind: 'delete'; row: ClassRow }
    | null
  >(null);
  const changing = editor.mode === 'CHANGE';
  const changeLock = useChangeLock('CLASS', `${editor.classType.trim()}/${editor.className.trim()}`, 'CFG.PROC.CLASS.DEFINE', changing);
  const dialogLock = useChangeLock(
    'CLASS',
    dialog ? `${dialog.row.classType.trim()}/${dialog.row.className.trim()}` : '',
    'CFG.PROC.CLASS.DEFINE',
    Boolean(dialog),
  );

  const state = deleteState.message ? deleteState : statusState.message ? statusState : saveState;

  function patch(next: Partial<EditorState>) {
    setEditor({ ...editor, ...next });
  }

  return (
    <div className="space-y-4">
      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          You may view classes; maintaining them needs the definition capability.
        </p>
      )}
      {state.message && (
        <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}
          {state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}

      <section aria-labelledby="class-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="class-grid" className="text-sm font-semibold">Classes</h2>
        {data.classes.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No classes stand yet. Define the first below.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Class type</th>
                <th className="px-2 py-2">Class</th>
                <th className="px-2 py-2">Description</th>
                <th className="px-2 py-2">Characteristics</th>
                <th className="px-2 py-2">Status</th>
                {canMaintain && <th className="px-2 py-2">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {data.classes.map((row) => (
                <tr key={`${row.classType}/${row.className}`} className="border-b border-line/60">
                  <td className="px-2 py-2">{row.classType}</td>
                  <td className="px-2 py-2">{row.className}</td>
                  <td className="px-2 py-2">{row.description}</td>
                  <td className="px-2 py-2">
                    {row.assignments.map((a) => a.characteristicName).join(', ') || '—'}
                  </td>
                  <td className="px-2 py-2">{row.lifecycleStatus}</td>
                  {canMaintain && (
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                          onClick={() => setEditor(editorFromRow(row))}>Change</button>
                        {row.lifecycleStatus !== 'ACTIVE' && (
                          <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                            onClick={() => setDialog({ kind: 'status', row, status: 'ACTIVE' })}>Activate</button>
                        )}
                        {row.lifecycleStatus === 'ACTIVE' && (
                          <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                            onClick={() => setDialog({ kind: 'status', row, status: 'BLOCKED' })}>Block</button>
                        )}
                        <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                          onClick={() => setDialog({ kind: 'delete', row })}>Delete</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canMaintain && (
        <section aria-labelledby="class-editor" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="class-editor" className="text-sm font-semibold">
            {editor.mode === 'CREATE' ? 'New class' : `Change ${editor.classType} / ${editor.className}`}
          </h2>
          <form action={saveAction}>
            <input type="hidden" name="mode" value={editor.mode} />
            <input type="hidden" name="payload" value={JSON.stringify(editor)} />
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Class type</span>
                <select className="input w-full" value={editor.classType} disabled={editor.mode === 'CHANGE'}
                  onChange={(event) => patch({ classType: event.target.value })}>
                  {data.classTypes.map((type) => (
                    <option key={type.classType} value={type.classType}>
                      {type.classType} · {type.description}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Class name</span>
                <input className="input w-full" value={editor.className} disabled={editor.mode === 'CHANGE'}
                  onChange={(event) => patch({ className: event.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Description</span>
                <input className="input w-full" value={editor.description}
                  onChange={(event) => patch({ description: event.target.value })} />
              </label>
            </div>

            <fieldset className="mt-4 rounded-card border border-line p-3">
              <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Characteristics</legend>
              <div className="space-y-2">
                {editor.assignments.map((row, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-3">
                    <span className="text-sm text-ink-faint">{String(index + 1).padStart(3, '0')}</span>
                    <input
                      className="input w-full sm:w-80"
                      list="class-characteristics"
                      value={row.characteristicName}
                      onChange={(event) => {
                        const next = editor.assignments.slice();
                        next[index] = { ...next[index], characteristicName: event.target.value };
                        patch({ assignments: next });
                      }}
                    />
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={row.requiredForClassification}
                        onChange={(event) => {
                          const next = editor.assignments.slice();
                          next[index] = { ...next[index], requiredForClassification: event.target.checked };
                          patch({ assignments: next });
                        }}
                      />
                      Required
                    </label>
                  </div>
                ))}
              </div>
              <datalist id="class-characteristics">
                {data.characteristics.map((c) => (
                  <option key={c.characteristicName} value={c.characteristicName}>
                    {c.description} · {c.dataFormat} · {c.lifecycleStatus}
                  </option>
                ))}
              </datalist>
              <button type="button" className="btn btn-default mt-2 min-h-11 sm:min-h-8"
                onClick={() => patch({
                  assignments: [...editor.assignments, { characteristicName: '', requiredForClassification: false }],
                })}>
                Add characteristic
              </button>
            </fieldset>

            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
              <input name="reason" className="input w-full" required />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              {editor.mode === 'CHANGE' && (
                <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                  onClick={() => setEditor(EMPTY_EDITOR)}>New class</button>
              )}
              <LockNotice message={changeLock?.mode === 'DISPLAY' ? changeLock.message : null} remedy={changeLock?.remedy} />
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={saving || (changing && changeLock?.mode !== 'CHANGE')}>
                Save class
              </button>
            </div>
          </form>
        </section>
      )}

      {dialog?.kind === 'status' && canMaintain && (
        <DialogShell
          title={`${dialog.status === 'ACTIVE' ? 'Activate' : 'Block'} ${dialog.row.className}`}
          onClose={() => setDialog(null)}
        >
          <form action={statusAction}>
            <input type="hidden" name="classType" value={dialog.row.classType} />
            <input type="hidden" name="className" value={dialog.row.className} />
            <input type="hidden" name="status" value={dialog.status} />
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
              <input name="reason" className="input w-full" required />
            </label>
            <div className="mt-3 flex justify-end">
              <LockNotice message={dialogLock?.mode === 'DISPLAY' ? dialogLock.message : null} remedy={dialogLock?.remedy} />
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={dialogLock?.mode !== 'CHANGE'}>
                {dialog.status === 'ACTIVE' ? 'Activate' : 'Block'}
              </button>
            </div>
          </form>
        </DialogShell>
      )}

      {dialog?.kind === 'delete' && canMaintain && (
        <DialogShell title={`Delete ${dialog.row.className}`} onClose={() => setDialog(null)}>
          <form action={deleteAction}>
            <input type="hidden" name="classType" value={dialog.row.classType} />
            <input type="hidden" name="className" value={dialog.row.className} />
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
              <input name="reason" className="input w-full" required />
            </label>
            <div className="mt-3 flex justify-end">
              <LockNotice message={dialogLock?.mode === 'DISPLAY' ? dialogLock.message : null} remedy={dialogLock?.remedy} />
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={dialogLock?.mode !== 'CHANGE'}>Delete</button>
            </div>
          </form>
        </DialogShell>
      )}
    </div>
  );
}
