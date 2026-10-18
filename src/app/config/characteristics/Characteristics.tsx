'use client';

import { useActionState, useState } from 'react';

import type { CharacteristicRow } from '@/modules/foundation/characteristic-definition';
import {
  deleteCharacteristicAction,
  saveCharacteristicAction,
  setCharacteristicStatusAction,
  type CharacteristicActionState,
} from './actions';

/**
 * Characteristics for classification (SCR-057 / CT04; inert in
 * stage 1, live since stage 3). The standing grid beside the editor;
 * activation, blocking and deletion are their own reasoned acts.
 */

const FORMATS = ['CHAR', 'NUM', 'DATE', 'TIME', 'CURR'] as const;
const INITIAL: CharacteristicActionState = { ok: false };

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
  characteristicName: string;
  description: string;
  dataFormat: string;
  valueLength: string;
  decimalPlaces: string;
  unit: string;
  currency: string;
  negativeValuesAllowed: boolean;
  caseSensitive: boolean;
  intervalsAllowed: boolean;
  additionalValuesAllowed: boolean;
  valueAssignment: string;
  requiredEntry: boolean;
  values: string[];
}

const EMPTY_EDITOR: EditorState = {
  mode: 'CREATE',
  characteristicName: '',
  description: '',
  dataFormat: 'CHAR',
  valueLength: '30',
  decimalPlaces: '0',
  unit: '',
  currency: '',
  negativeValuesAllowed: false,
  caseSensitive: false,
  intervalsAllowed: false,
  additionalValuesAllowed: false,
  valueAssignment: 'SINGLE',
  requiredEntry: false,
  values: [''],
};

function editorFromRow(row: CharacteristicRow): EditorState {
  return {
    mode: 'CHANGE',
    characteristicName: row.characteristicName,
    description: row.description,
    dataFormat: row.dataFormat,
    valueLength: String(row.valueLength),
    decimalPlaces: String(row.decimalPlaces),
    unit: row.unit ?? '',
    currency: row.currency ?? '',
    negativeValuesAllowed: row.negativeValuesAllowed,
    caseSensitive: row.caseSensitive,
    intervalsAllowed: row.intervalsAllowed,
    additionalValuesAllowed: row.additionalValuesAllowed,
    valueAssignment: row.valueAssignment,
    requiredEntry: row.requiredEntry,
    values: row.values.length > 0 ? row.values : [''],
  };
}

export default function Characteristics({ rows, canMaintain }: {
  rows: CharacteristicRow[];
  canMaintain: boolean;
}) {
  const [saveState, saveAction, saving] = useActionState(saveCharacteristicAction, INITIAL);
  const [statusState, statusAction] = useActionState(setCharacteristicStatusAction, INITIAL);
  const [deleteState, deleteAction] = useActionState(deleteCharacteristicAction, INITIAL);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [dialog, setDialog] = useState<
    | { kind: 'status'; row: CharacteristicRow; status: 'ACTIVE' | 'BLOCKED' }
    | { kind: 'delete'; row: CharacteristicRow }
    | null
  >(null);

  const state = deleteState.message ? deleteState : statusState.message ? statusState : saveState;

  function patch(next: Partial<EditorState>) {
    setEditor({ ...editor, ...next });
  }

  const checkboxes: Array<{ key: 'negativeValuesAllowed' | 'caseSensitive' | 'intervalsAllowed' | 'additionalValuesAllowed' | 'requiredEntry'; label: string }> = [
    { key: 'negativeValuesAllowed', label: 'Negative values allowed' },
    { key: 'caseSensitive', label: 'Case-sensitive values' },
    { key: 'intervalsAllowed', label: 'Interval values allowed' },
    { key: 'additionalValuesAllowed', label: 'Additional values allowed' },
    { key: 'requiredEntry', label: 'Required entry' },
  ];

  return (
    <div className="space-y-4">
      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          You may view characteristics; maintaining them needs the definition capability.
        </p>
      )}
      {state.message && (
        <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}
          {state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}

      <section aria-labelledby="characteristic-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="characteristic-grid" className="text-sm font-semibold">Characteristics</h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No characteristics stand yet. Define the first below.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Characteristic</th>
                <th className="px-2 py-2">Description</th>
                <th className="px-2 py-2">Format</th>
                <th className="px-2 py-2">Length</th>
                <th className="px-2 py-2">Assignment</th>
                <th className="px-2 py-2">Values</th>
                <th className="px-2 py-2">Status</th>
                {canMaintain && <th className="px-2 py-2">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.characteristicName} className="border-b border-line/60">
                  <td className="px-2 py-2">{row.characteristicName}</td>
                  <td className="px-2 py-2">{row.description}</td>
                  <td className="px-2 py-2">{row.dataFormat}</td>
                  <td className="px-2 py-2">{row.valueLength}{row.decimalPlaces > 0 ? `.${row.decimalPlaces}` : ''}</td>
                  <td className="px-2 py-2">{row.valueAssignment === 'MULTIPLE' ? 'Multiple' : 'Single'}</td>
                  <td className="px-2 py-2">{row.values.join(', ') || '—'}</td>
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
        <section aria-labelledby="characteristic-editor" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="characteristic-editor" className="text-sm font-semibold">
            {editor.mode === 'CREATE' ? 'New characteristic' : `Change ${editor.characteristicName}`}
          </h2>
          <form action={saveAction}>
            <input type="hidden" name="mode" value={editor.mode} />
            <input
              type="hidden"
              name="payload"
              value={JSON.stringify({
                ...editor,
                valueLength: Number(editor.valueLength),
                decimalPlaces: Number(editor.decimalPlaces),
              })}
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Characteristic name</span>
                <input className="input w-full" value={editor.characteristicName} disabled={editor.mode === 'CHANGE'}
                  onChange={(event) => patch({ characteristicName: event.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Description</span>
                <input className="input w-full" value={editor.description}
                  onChange={(event) => patch({ description: event.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Data format</span>
                <select className="input w-full" value={editor.dataFormat}
                  onChange={(event) => patch({ dataFormat: event.target.value })}>
                  {FORMATS.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Length</span>
                <input className="input w-full" value={editor.valueLength}
                  onChange={(event) => patch({ valueLength: event.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Decimal places</span>
                <input className="input w-full" value={editor.decimalPlaces}
                  onChange={(event) => patch({ decimalPlaces: event.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Value assignment</span>
                <select className="input w-full" value={editor.valueAssignment}
                  onChange={(event) => patch({ valueAssignment: event.target.value })}>
                  <option value="SINGLE">Single value</option>
                  <option value="MULTIPLE">Multiple values</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Unit (NUM/CURR)</span>
                <input className="input w-full" value={editor.unit}
                  onChange={(event) => patch({ unit: event.target.value })} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency (CURR)</span>
                <input className="input w-full" value={editor.currency}
                  onChange={(event) => patch({ currency: event.target.value })} />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap gap-4 text-sm">
              {checkboxes.map((box) => (
                <label key={box.key} className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={editor[box.key]}
                    onChange={(event) => patch({ [box.key]: event.target.checked })} />
                  {box.label}
                </label>
              ))}
            </div>

            <fieldset className="mt-4 rounded-card border border-line p-3">
              <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Allowed values</legend>
              <div className="space-y-2">
                {editor.values.map((value, index) => (
                  <input
                    key={index}
                    className="input w-full sm:w-80"
                    value={value}
                    onChange={(event) => {
                      const next = editor.values.slice();
                      next[index] = event.target.value;
                      patch({ values: next });
                    }}
                  />
                ))}
              </div>
              <button type="button" className="btn btn-default mt-2 min-h-11 sm:min-h-8"
                onClick={() => patch({ values: [...editor.values, ''] })}>
                Add value
              </button>
            </fieldset>

            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
              <input name="reason" className="input w-full" required />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              {editor.mode === 'CHANGE' && (
                <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                  onClick={() => setEditor(EMPTY_EDITOR)}>New characteristic</button>
              )}
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={saving}>
                Save characteristic
              </button>
            </div>
          </form>
        </section>
      )}

      {dialog?.kind === 'status' && canMaintain && (
        <DialogShell
          title={`${dialog.status === 'ACTIVE' ? 'Activate' : 'Block'} ${dialog.row.characteristicName}`}
          onClose={() => setDialog(null)}
        >
          <form action={statusAction}>
            <input type="hidden" name="characteristicName" value={dialog.row.characteristicName} />
            <input type="hidden" name="status" value={dialog.status} />
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
              <input name="reason" className="input w-full" required />
            </label>
            <div className="mt-3 flex justify-end">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">
                {dialog.status === 'ACTIVE' ? 'Activate' : 'Block'}
              </button>
            </div>
          </form>
        </DialogShell>
      )}

      {dialog?.kind === 'delete' && canMaintain && (
        <DialogShell title={`Delete ${dialog.row.characteristicName}`} onClose={() => setDialog(null)}>
          <form action={deleteAction}>
            <input type="hidden" name="characteristicName" value={dialog.row.characteristicName} />
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
              <input name="reason" className="input w-full" required />
            </label>
            <div className="mt-3 flex justify-end">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Delete</button>
            </div>
          </form>
        </DialogShell>
      )}
    </div>
  );
}
