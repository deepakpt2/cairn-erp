'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { ReleaseConfiguration, ReleaseGroupRow, ReleaseStrategyRow } from '@/modules/foundation/release-strategy-definition';
import {
  deleteReleaseGroupAction,
  deleteReleaseStrategyAction,
  saveReleaseGroupAction,
  saveReleaseStrategyAction,
  setReleaseStrategyStatusAction,
  type ReleaseActionState,
} from './actions';

/**
 * Release strategies (SCR-059; inert in stage 1, live since stage 3).
 * Groups with their codes above, strategies below; activation,
 * blocking and deletion are their own reasoned acts. The release acts
 * on documents are the next round.
 */

const INITIAL: ReleaseActionState = { ok: false };
const OPERATORS = [
  { value: 'EQ', label: 'Equals' },
  { value: 'GE', label: 'At least' },
  { value: 'GT', label: 'Greater than' },
  { value: 'LE', label: 'At most' },
  { value: 'LT', label: 'Less than' },
  { value: 'BETWEEN', label: 'Between' },
];

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

interface GroupEditor {
  mode: 'CREATE' | 'CHANGE';
  groupCode: string;
  documentCategory: string;
  description: string;
  codes: Array<{ code: string; description: string }>;
}

interface StrategyEditor {
  mode: 'CREATE' | 'CHANGE';
  groupCode: string;
  strategyCode: string;
  description: string;
  className: string;
  priority: string;
  criteria: Array<{ characteristicName: string; operator: string; valueFrom: string; valueTo: string }>;
  steps: string[];
}

const EMPTY_GROUP: GroupEditor = {
  mode: 'CREATE', groupCode: '', documentCategory: 'PURCHASE_ORDER', description: '',
  codes: [{ code: '', description: '' }],
};

const EMPTY_STRATEGY: StrategyEditor = {
  mode: 'CREATE', groupCode: '', strategyCode: '', description: '', className: '', priority: '100',
  criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: '', valueTo: '' }],
  steps: [''],
};

export default function ReleaseStrategies({ data, canMaintain }: {
  data: ReleaseConfiguration;
  canMaintain: boolean;
}) {
  const [groupState, groupAction] = useActionState(saveReleaseGroupAction, INITIAL);
  const [groupDeleteState, groupDeleteAction] = useActionState(deleteReleaseGroupAction, INITIAL);
  const [strategyState, strategyAction] = useActionState(saveReleaseStrategyAction, INITIAL);
  const [statusState, statusAction] = useActionState(setReleaseStrategyStatusAction, INITIAL);
  const [deleteState, deleteAction] = useActionState(deleteReleaseStrategyAction, INITIAL);
  const [groupEditor, setGroupEditor] = useState<GroupEditor>(EMPTY_GROUP);
  const [strategyEditor, setStrategyEditor] = useState<StrategyEditor>(EMPTY_STRATEGY);
  const [dialog, setDialog] = useState<
    | { kind: 'status'; row: ReleaseStrategyRow; status: 'ACTIVE' | 'BLOCKED' }
    | { kind: 'delete-strategy'; row: ReleaseStrategyRow }
    | { kind: 'delete-group'; row: ReleaseGroupRow }
    | null
  >(null);

  const state = [deleteState, statusState, strategyState, groupDeleteState, groupState]
    .find((s) => s.message) ?? groupState;

  const groupLock = useChangeLock(
    'RELEASE_GROUP',
    groupEditor.groupCode,
    'CFG.PROC.RELEASE.DEFINE',
    canMaintain && groupEditor.mode === 'CHANGE',
  );
  const strategyLock = useChangeLock(
    'RELEASE_STRATEGY',
    strategyEditor.strategyCode,
    'CFG.PROC.RELEASE.DEFINE',
    canMaintain && strategyEditor.mode === 'CHANGE',
  );
  const dialogLock = useChangeLock(
    dialog?.kind === 'delete-group' ? 'RELEASE_GROUP' : 'RELEASE_STRATEGY',
    dialog?.kind === 'delete-group' ? dialog.row.groupCode : dialog?.row.strategyCode ?? '',
    'CFG.PROC.RELEASE.DEFINE',
    Boolean(dialog) && canMaintain,
  );
  const selectedGroup = data.groups.find((g) => g.groupCode === strategyEditor.groupCode);
  const classOptions = data.classes.filter(
    (c) => !selectedGroup || c.classType === selectedGroup.documentCategory,
  );
  const selectedClass = classOptions.find((c) => c.className === strategyEditor.className);

  return (
    <div className="space-y-4">
      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          You may view release strategies; maintaining them needs the definition capability.
        </p>
      )}
      {state.message && (
        <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}
          {state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}

      <section aria-labelledby="release-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="release-grid" className="text-sm font-semibold">Release groups and strategies</h2>
        {data.groups.length === 0 && data.strategies.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No release strategies stand yet. Define the first below.</p>
        ) : (
          <div className="mt-2 space-y-4">
            {data.groups.map((group) => (
              <div key={group.groupCode}>
                <p className="text-sm">
                  <strong>{group.groupCode}</strong> · {group.documentCategory === 'PURCHASE_ORDER' ? 'Purchase orders' : 'Purchase requisitions'} · {group.description}
                  {' — codes: '}{group.codes.map((c) => c.code).join(', ') || 'none'}
                  {canMaintain && (
                    <>
                      {' '}
                      <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                        onClick={() => setGroupEditor({
                          mode: 'CHANGE', groupCode: group.groupCode,
                          documentCategory: group.documentCategory, description: group.description,
                          codes: group.codes.length > 0 ? group.codes : [{ code: '', description: '' }],
                        })}>Change group</button>
                      {' '}
                      <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                        onClick={() => setDialog({ kind: 'delete-group', row: group })}>Delete group</button>
                    </>
                  )}
                </p>
                <table className="mt-1 w-full text-sm">
                  <tbody>
                    {data.strategies.filter((s) => s.groupCode === group.groupCode).map((strategy) => (
                      <tr key={strategy.strategyCode} className="border-b border-line/60">
                        <td className="px-2 py-2">{strategy.strategyCode}</td>
                        <td className="px-2 py-2">{strategy.description}</td>
                        <td className="px-2 py-2">{strategy.classType} / {strategy.className}</td>
                        <td className="px-2 py-2">
                          {strategy.criteria.map((c) => `${c.characteristicName} ${c.operator} ${c.valueFrom}`).join('; ') || '—'}
                        </td>
                        <td className="px-2 py-2">{strategy.steps.join(' → ') || '—'}</td>
                        <td className="px-2 py-2">{strategy.lifecycleStatus}</td>
                        {canMaintain && (
                          <td className="px-2 py-2">
                            <div className="flex flex-wrap gap-2">
                              <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                                onClick={() => setStrategyEditor({
                                  mode: 'CHANGE', groupCode: strategy.groupCode,
                                  strategyCode: strategy.strategyCode, description: strategy.description,
                                  className: strategy.className, priority: String(strategy.priority),
                                  criteria: strategy.criteria.length > 0
                                    ? strategy.criteria.map((c) => ({ ...c, valueTo: c.valueTo ?? '' }))
                                    : [{ characteristicName: '', operator: 'EQ', valueFrom: '', valueTo: '' }],
                                  steps: strategy.steps.length > 0 ? strategy.steps : [''],
                                })}>Change</button>
                              {strategy.lifecycleStatus !== 'ACTIVE' && (
                                <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                                  onClick={() => setDialog({ kind: 'status', row: strategy, status: 'ACTIVE' })}>Activate</button>
                              )}
                              {strategy.lifecycleStatus === 'ACTIVE' && (
                                <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                                  onClick={() => setDialog({ kind: 'status', row: strategy, status: 'BLOCKED' })}>Block</button>
                              )}
                              <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                                onClick={() => setDialog({ kind: 'delete-strategy', row: strategy })}>Delete</button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </section>

      {canMaintain && (
        <>
          <section aria-labelledby="release-group-editor" className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 id="release-group-editor" className="text-sm font-semibold">
              {groupEditor.mode === 'CREATE' ? 'New release group' : `Change group ${groupEditor.groupCode}`}
            </h2>
            <form action={groupAction}>
              <input type="hidden" name="mode" value={groupEditor.mode} />
              <input type="hidden" name="payload" value={JSON.stringify(groupEditor)} />
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Group code</span>
                  <input className="input w-full" value={groupEditor.groupCode} disabled={groupEditor.mode === 'CHANGE'}
                    onChange={(event) => setGroupEditor({ ...groupEditor, groupCode: event.target.value })} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document category</span>
                  <select className="input w-full" value={groupEditor.documentCategory} disabled={groupEditor.mode === 'CHANGE'}
                    onChange={(event) => setGroupEditor({ ...groupEditor, documentCategory: event.target.value })}>
                    <option value="PURCHASE_REQUISITION">Purchase requisition</option>
                    <option value="PURCHASE_ORDER">Purchase order</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Description</span>
                  <input className="input w-full" value={groupEditor.description}
                    onChange={(event) => setGroupEditor({ ...groupEditor, description: event.target.value })} />
                </label>
              </div>
              <fieldset className="mt-4 rounded-card border border-line p-3">
                <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Release codes</legend>
                <div className="space-y-2">
                  {groupEditor.codes.map((row, index) => (
                    <div key={index} className="grid gap-3 sm:grid-cols-2">
                      <input className="input w-full" placeholder="Code" value={row.code}
                        onChange={(event) => {
                          const codes = groupEditor.codes.slice();
                          codes[index] = { ...codes[index], code: event.target.value };
                          setGroupEditor({ ...groupEditor, codes });
                        }} />
                      <input className="input w-full" placeholder="Description" value={row.description}
                        onChange={(event) => {
                          const codes = groupEditor.codes.slice();
                          codes[index] = { ...codes[index], description: event.target.value };
                          setGroupEditor({ ...groupEditor, codes });
                        }} />
                    </div>
                  ))}
                </div>
                <button type="button" className="btn btn-default mt-2 min-h-11 sm:min-h-8"
                  onClick={() => setGroupEditor({
                    ...groupEditor, codes: [...groupEditor.codes, { code: '', description: '' }],
                  })}>
                  Add code
                </button>
              </fieldset>
              <label className="mt-4 block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
                <input name="reason" className="input w-full" required />
              </label>
              <LockNotice message={groupLock?.mode === 'DISPLAY' ? groupLock.message : null} remedy={groupLock?.remedy} />
              <div className="mt-4 flex justify-end gap-2">
                {groupEditor.mode === 'CHANGE' && (
                  <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                    onClick={() => setGroupEditor(EMPTY_GROUP)}>New group</button>
                )}
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={groupEditor.mode === 'CHANGE' && groupLock?.mode !== 'CHANGE'}>Save group</button>
              </div>
            </form>
          </section>

          <section aria-labelledby="release-editor" className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 id="release-editor" className="text-sm font-semibold">
              {strategyEditor.mode === 'CREATE' ? 'New release strategy' : `Change strategy ${strategyEditor.strategyCode}`}
            </h2>
            <form action={strategyAction}>
              <input type="hidden" name="mode" value={strategyEditor.mode} />
              <input type="hidden" name="payload" value={JSON.stringify({
                ...strategyEditor, priority: Number(strategyEditor.priority),
              })} />
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Release group</span>
                  <select className="input w-full" value={strategyEditor.groupCode} disabled={strategyEditor.mode === 'CHANGE'}
                    onChange={(event) => setStrategyEditor({ ...strategyEditor, groupCode: event.target.value, className: '' })}>
                    <option value="">—</option>
                    {data.groups.map((g) => (
                      <option key={g.groupCode} value={g.groupCode}>{g.groupCode} · {g.description}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Strategy</span>
                  <input className="input w-full" value={strategyEditor.strategyCode} disabled={strategyEditor.mode === 'CHANGE'}
                    onChange={(event) => setStrategyEditor({ ...strategyEditor, strategyCode: event.target.value })} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Description</span>
                  <input className="input w-full" value={strategyEditor.description}
                    onChange={(event) => setStrategyEditor({ ...strategyEditor, description: event.target.value })} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Class</span>
                  <select className="input w-full" value={strategyEditor.className}
                    onChange={(event) => setStrategyEditor({ ...strategyEditor, className: event.target.value })}>
                    <option value="">—</option>
                    {classOptions.map((c) => (
                      <option key={`${c.classType}/${c.className}`} value={c.className}>
                        {c.classType} / {c.className} · {c.lifecycleStatus}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Priority</span>
                  <input className="input w-full" value={strategyEditor.priority}
                    onChange={(event) => setStrategyEditor({ ...strategyEditor, priority: event.target.value })} />
                </label>
              </div>

              <fieldset className="mt-4 rounded-card border border-line p-3">
                <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Criteria</legend>
                <div className="space-y-2">
                  {strategyEditor.criteria.map((row, index) => (
                    <div key={index} className="grid gap-3 sm:grid-cols-4">
                      <select className="input w-full" value={row.characteristicName}
                        onChange={(event) => {
                          const criteria = strategyEditor.criteria.slice();
                          criteria[index] = { ...criteria[index], characteristicName: event.target.value };
                          setStrategyEditor({ ...strategyEditor, criteria });
                        }}>
                        <option value="">—</option>
                        {(selectedClass?.characteristics ?? []).map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                      <select className="input w-full" value={row.operator}
                        onChange={(event) => {
                          const criteria = strategyEditor.criteria.slice();
                          criteria[index] = { ...criteria[index], operator: event.target.value };
                          setStrategyEditor({ ...strategyEditor, criteria });
                        }}>
                        {OPERATORS.map((op) => (
                          <option key={op.value} value={op.value}>{op.label}</option>
                        ))}
                      </select>
                      <input className="input w-full" placeholder="Value" value={row.valueFrom}
                        onChange={(event) => {
                          const criteria = strategyEditor.criteria.slice();
                          criteria[index] = { ...criteria[index], valueFrom: event.target.value };
                          setStrategyEditor({ ...strategyEditor, criteria });
                        }} />
                      <input className="input w-full" placeholder="To (between)" value={row.valueTo}
                        onChange={(event) => {
                          const criteria = strategyEditor.criteria.slice();
                          criteria[index] = { ...criteria[index], valueTo: event.target.value };
                          setStrategyEditor({ ...strategyEditor, criteria });
                        }} />
                    </div>
                  ))}
                </div>
                <button type="button" className="btn btn-default mt-2 min-h-11 sm:min-h-8"
                  onClick={() => setStrategyEditor({
                    ...strategyEditor,
                    criteria: [...strategyEditor.criteria, { characteristicName: '', operator: 'EQ', valueFrom: '', valueTo: '' }],
                  })}>
                  Add criterion
                </button>
              </fieldset>

              <fieldset className="mt-4 rounded-card border border-line p-3">
                <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Release codes in sequence</legend>
                <div className="space-y-2">
                  {strategyEditor.steps.map((code, index) => (
                    <div key={index} className="flex items-center gap-3">
                      <span className="text-sm text-ink-faint">{index + 1}</span>
                      <select className="input w-full sm:w-60" value={code}
                        onChange={(event) => {
                          const steps = strategyEditor.steps.slice();
                          steps[index] = event.target.value;
                          setStrategyEditor({ ...strategyEditor, steps });
                        }}>
                        <option value="">—</option>
                        {(selectedGroup?.codes ?? []).map((c) => (
                          <option key={c.code} value={c.code}>{c.code} · {c.description}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <button type="button" className="btn btn-default mt-2 min-h-11 sm:min-h-8"
                  onClick={() => setStrategyEditor({ ...strategyEditor, steps: [...strategyEditor.steps, ''] })}>
                  Add release code
                </button>
              </fieldset>

              <label className="mt-4 block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
                <input name="reason" className="input w-full" required />
              </label>
              <LockNotice message={strategyLock?.mode === 'DISPLAY' ? strategyLock.message : null} remedy={strategyLock?.remedy} />
              <div className="mt-4 flex justify-end gap-2">
                {strategyEditor.mode === 'CHANGE' && (
                  <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                    onClick={() => setStrategyEditor(EMPTY_STRATEGY)}>New strategy</button>
                )}
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={strategyEditor.mode === 'CHANGE' && strategyLock?.mode !== 'CHANGE'}>Save strategy</button>
              </div>
            </form>
          </section>
        </>
      )}

      {dialog?.kind === 'status' && canMaintain && (
        <DialogShell
          title={`${dialog.status === 'ACTIVE' ? 'Activate' : 'Block'} strategy ${dialog.row.strategyCode}`}
          onClose={() => setDialog(null)}
        >
          <form action={statusAction}>
            <input type="hidden" name="groupCode" value={dialog.row.groupCode} />
            <input type="hidden" name="strategyCode" value={dialog.row.strategyCode} />
            <input type="hidden" name="status" value={dialog.status} />
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
              <input name="reason" className="input w-full" required />
            </label>
            <LockNotice message={dialogLock?.mode === 'DISPLAY' ? dialogLock.message : null} remedy={dialogLock?.remedy} />
            <div className="mt-3 flex justify-end">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={dialogLock?.mode !== 'CHANGE'}>
                {dialog.status === 'ACTIVE' ? 'Activate' : 'Block'}
              </button>
            </div>
          </form>
        </DialogShell>
      )}

      {dialog?.kind === 'delete-strategy' && canMaintain && (
        <DialogShell title={`Delete strategy ${dialog.row.strategyCode}`} onClose={() => setDialog(null)}>
          <form action={deleteAction}>
            <input type="hidden" name="groupCode" value={dialog.row.groupCode} />
            <input type="hidden" name="strategyCode" value={dialog.row.strategyCode} />
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
              <input name="reason" className="input w-full" required />
            </label>
            <LockNotice message={dialogLock?.mode === 'DISPLAY' ? dialogLock.message : null} remedy={dialogLock?.remedy} />
            <div className="mt-3 flex justify-end">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={dialogLock?.mode !== 'CHANGE'}>Delete</button>
            </div>
          </form>
        </DialogShell>
      )}

      {dialog?.kind === 'delete-group' && canMaintain && (
        <DialogShell title={`Delete group ${dialog.row.groupCode}`} onClose={() => setDialog(null)}>
          <form action={groupDeleteAction}>
            <input type="hidden" name="groupCode" value={dialog.row.groupCode} />
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
              <input name="reason" className="input w-full" required />
            </label>
            <LockNotice message={dialogLock?.mode === 'DISPLAY' ? dialogLock.message : null} remedy={dialogLock?.remedy} />
            <div className="mt-3 flex justify-end">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={dialogLock?.mode !== 'CHANGE'}>Delete</button>
            </div>
          </form>
        </DialogShell>
      )}
    </div>
  );
}
