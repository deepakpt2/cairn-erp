'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import {
  CONSOLIDATION_FOLDERS, METHOD_KINDS, TASK_TYPES,
  type ConsolidationArea, type ConsolidationFolder, type ConsolidationWorkbenchView,
} from '@/modules/finance/consolidation-vocabulary';
import {
  activateAreaAction, assignUnitAction, saveAreaAction, saveBasisAction,
  saveGroupAccountAction, saveGroupAction, saveMappingAction, saveMethodAction,
  saveTaskAction, saveUnitAction, saveVersionAction,
  type ConsolidationActionState,
} from './actions';

const FOLDER_LABELS: Record<ConsolidationFolder, string> = {
  DATA_BASIS: 'Data Basis',
  MASTER_DATA: 'Master Data',
  CHART_MAPPINGS: 'Consolidation Chart & Mappings',
  METHODS: 'Methods',
  TASKS: 'Task Hierarchies',
};

const INITIAL: ConsolidationActionState = { ok: false, message: '' };

function fieldValue(form: HTMLFormElement, name: string) {
  const value = new FormData(form).get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function SaveForm({ action, children, label, record }: {
  action: (state: ConsolidationActionState, form: FormData) => Promise<ConsolidationActionState>;
  children: React.ReactNode;
  label: string;
  record?: (form: HTMLFormElement) => { lockObject: string; argument: string; existing: boolean } | null;
}) {
  const [state, dispatch, pending] = useActionState(action, INITIAL);
  const [engaged, setEngaged] = useState(false);
  const [lockObject, setLockObject] = useState('CONSOLIDATION_AREA');
  const [argument, setArgument] = useState('');
  const [existing, setExisting] = useState(false);
  const sync = (form: HTMLFormElement) => {
    const next = record?.(form) ?? null;
    setLockObject(next?.lockObject ?? 'CONSOLIDATION_AREA');
    setArgument(next?.argument ?? '');
    setExisting(Boolean(next?.existing));
  };
  const lock = useChangeLock(lockObject, argument, 'FIN.RPT.CONSOLIDATE', engaged && existing && argument !== '');
  const blocked = existing && lock?.mode === 'DISPLAY';
  return (
    <form
      action={dispatch}
      className="mt-4 space-y-3 border-t border-line pt-3"
      onFocus={(event) => { setEngaged(true); sync(event.currentTarget); }}
      onChange={(event) => sync(event.currentTarget)}
      onSubmit={(event) => {
        if (existing && lock?.mode !== 'CHANGE') {
          event.preventDefault();
          setEngaged(true);
          sync(event.currentTarget);
        }
      }}
    >
      <div className="flex flex-wrap items-end gap-3">{children}</div>
      <div className="flex flex-wrap items-end gap-3">
        <F label="Change reason"><input name="reason" className="field-input w-72" required /></F>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending || blocked}>{label}</button>
      </div>
      <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
      {state.message && (
        <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
    </form>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

/**
 * Consolidation workbench (SCR-116): the area context, the five
 * configuration folders, and their maintenance forms.
 */
export default function ConsolidationWorkbenchShell({ canUse, canConfigure, areas, area, folder, view }: {
  canUse: boolean;
  canConfigure: boolean;
  areas: ConsolidationArea[];
  area: string;
  folder: ConsolidationFolder;
  view: ConsolidationWorkbenchView | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        You do not hold the consolidation workbench capability (FIN.RPT.CONSOLIDATE).
      </div>
    );
  }
  const current = view?.area;
  const same = (left: string, right: string) => left.trim().toUpperCase() === right.trim().toUpperCase();
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label="Consolidation area">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="field-label" htmlFor="area">Consolidation Area</label>
            <select id="area" name="area" className="field-input code w-44" defaultValue={area}>
              {areas.map((a) => (
                <option key={a.area} value={a.area}>{a.area} — {a.title} ({a.status})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="folder">Process View</label>
            <select id="folder" name="folder" className="field-input w-56" defaultValue={folder}>
              {CONSOLIDATION_FOLDERS.map((f) => (
                <option key={f} value={f}>{FOLDER_LABELS[f]}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Open</button>
        </div>
        {current ? (
          <p className="text-sm text-ink-soft">
            Data basis <strong>{current.dataBasis}</strong>
            {view?.dataBasisTitle ? ` — ${view.dataBasisTitle}` : ''} · Consolidation chart{' '}
            <strong>{current.consChart}</strong> · Fiscal year variant <strong>{current.fiscalYearVariant}</strong>{' '}
            · Status <strong>{current.status}</strong>
          </p>
        ) : (
          <p className="text-sm text-ink-soft">No consolidation area stands yet. Define a data basis and an area below.</p>
        )}
      </form>

      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <nav className="panel p-3" aria-label="Workbench folders">
          <ul className="space-y-1 text-sm">
            {CONSOLIDATION_FOLDERS.map((f) => (
              <li key={f}>
                <a
                  className={f === folder ? 'font-semibold text-ink' : 'text-ink-soft'}
                  href={`/config/consolidation?area=${encodeURIComponent(area)}&folder=${f}`}
                >
                  {FOLDER_LABELS[f]}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <section className="panel overflow-x-auto p-4" aria-label={FOLDER_LABELS[folder]}>
          <h2 className="text-sm font-semibold">{FOLDER_LABELS[folder]}</h2>

          {folder === 'DATA_BASIS' && (
            <>
              <p className="mt-2 text-sm text-ink-soft">
                Data basis {current?.dataBasis ?? '—'} binds the standing journal provider.
                Dimensions are the standing journal characteristics; BW providers are not carried.
              </p>
              {canConfigure && (
                <>
                  <SaveForm action={saveBasisAction} label="Save data basis" record={(form) => {
                    const basis = fieldValue(form, 'basis');
                    if (!basis) return null;
                    return {
                      lockObject: 'CONSOLIDATION_BASIS',
                      argument: basis,
                      existing: areas.some((entry) => same(entry.dataBasis, basis)) || same(current?.dataBasis ?? '', basis),
                    };
                  }}>
                    <F label="Basis"><input name="basis" className="field-input code w-44" required /></F>
                    <F label="Title"><input name="title" className="field-input w-64" required /></F>
                    <F label="Dimensions (comma-separated)"><input name="dimensions" className="field-input w-80" placeholder="COMPANY_CODE, GL_ACCOUNT" /></F>
                  </SaveForm>
                  <SaveForm action={saveAreaAction} label="Save consolidation area" record={(form) => {
                    const areaCode = fieldValue(form, 'area');
                    if (!areaCode) return null;
                    return { lockObject: 'CONSOLIDATION_AREA', argument: areaCode, existing: areas.some((entry) => same(entry.area, areaCode)) };
                  }}>
                    <F label="Area (4)"><input name="area" className="field-input code w-28" maxLength={4} required /></F>
                    <F label="Title"><input name="title" className="field-input w-64" required /></F>
                    <F label="Data basis"><input name="dataBasis" className="field-input code w-44" required /></F>
                    <F label="Consolidation chart (4)"><input name="consChart" className="field-input code w-36" maxLength={4} required /></F>
                    <F label="Fiscal year variant (2)"><input name="fiscalYearVariant" className="field-input code w-32" maxLength={2} required /></F>
                  </SaveForm>
                  {current && current.status !== 'ACTIVE' && (
                    <SaveForm action={activateAreaAction} label="Activate area" record={() => ({ lockObject: 'CONSOLIDATION_AREA', argument: current.area, existing: true })}>
                      <input type="hidden" name="area" value={current.area} />
                      <span className="text-sm text-ink-soft">Activation judges completeness; incomplete configuration never affects a run.</span>
                    </SaveForm>
                  )}
                </>
              )}
            </>
          )}

          {folder === 'MASTER_DATA' && (
            <>
              <table className="grid-table mt-2 min-w-[40rem]">
                <thead><tr><th>Unit</th><th>Title</th><th>Company</th><th>Group</th><th>Valid From</th><th>Valid To</th></tr></thead>
                <tbody>
                  {(view?.units ?? []).map((u) => {
                    const assignment = view?.assignments.find((a) => a.unit === u.unit);
                    return (
                      <tr key={u.unit}>
                        <td className="code">{u.unit}</td><td>{u.title}</td><td>{u.companyCode}</td>
                        <td>{assignment?.group ?? ''}</td><td>{assignment?.validFrom ?? ''}</td><td>{assignment?.validTo ?? ''}</td>
                      </tr>
                    );
                  })}
                  {(view?.units ?? []).length === 0 && (
                    <tr><td colSpan={6} className="text-ink-soft">No consolidation units stand.</td></tr>
                  )}
                </tbody>
              </table>
              {canConfigure && current && (
                <>
                  <SaveForm action={saveUnitAction} label="Save unit" record={(form) => {
                    const unit = fieldValue(form, 'unit');
                    if (!unit) return null;
                    return { lockObject: 'CONSOLIDATION_UNIT', argument: `${current.area}/${unit}`, existing: (view?.units ?? []).some((row) => same(row.unit, unit)) };
                  }}>
                    <input type="hidden" name="area" value={current.area} />
                    <F label="Unit"><input name="unit" className="field-input code w-36" required /></F>
                    <F label="Title"><input name="title" className="field-input w-64" required /></F>
                    <F label="Company code"><input name="companyCode" className="field-input code w-32" required /></F>
                  </SaveForm>
                  <SaveForm action={saveGroupAction} label="Save group" record={(form) => {
                    const group = fieldValue(form, 'group');
                    if (!group) return null;
                    return { lockObject: 'CONSOLIDATION_GROUP', argument: `${current.area}/${group}`, existing: (view?.groups ?? []).some((row) => same(row.group, group)) };
                  }}>
                    <input type="hidden" name="area" value={current.area} />
                    <F label="Group"><input name="group" className="field-input code w-44" required /></F>
                    <F label="Title"><input name="title" className="field-input w-64" required /></F>
                    <F label="Parent group"><input name="parentGroup" className="field-input code w-44" /></F>
                  </SaveForm>
                  <SaveForm action={assignUnitAction} label="Assign unit" record={(form) => {
                    const group = fieldValue(form, 'group');
                    const unit = fieldValue(form, 'unit');
                    const validFrom = fieldValue(form, 'validFrom');
                    if (!group || !unit || !validFrom) return null;
                    return {
                      lockObject: 'CONSOLIDATION_ASSIGNMENT',
                      argument: `${current.area}/${group}/${unit}/${validFrom}`,
                      existing: (view?.assignments ?? []).some((row) => same(row.group, group) && same(row.unit, unit) && row.validFrom === validFrom),
                    };
                  }}>
                    <input type="hidden" name="area" value={current.area} />
                    <F label="Group"><input name="group" className="field-input code w-44" required /></F>
                    <F label="Unit"><input name="unit" className="field-input code w-36" required /></F>
                    <F label="Valid from"><input name="validFrom" type="date" className="field-input" required /></F>
                    <F label="Valid to"><input name="validTo" type="date" className="field-input" required /></F>
                  </SaveForm>
                </>
              )}
            </>
          )}

          {folder === 'CHART_MAPPINGS' && (
            <>
              <table className="grid-table mt-2 min-w-[40rem]">
                <thead><tr><th>Group Account</th><th>Title</th><th>Source Chart</th><th>Source From</th><th>Source To</th></tr></thead>
                <tbody>
                  {(view?.mappings ?? []).map((m) => (
                    <tr key={`${m.sourceChart}|${m.sourceAccountFrom}|${m.sourceAccountTo}`}>
                      <td className="code">{m.groupAccount}</td>
                      <td>{view?.groupAccounts.find((g) => g.account === m.groupAccount)?.title ?? ''}</td>
                      <td>{m.sourceChart}</td><td className="code">{m.sourceAccountFrom}</td><td className="code">{m.sourceAccountTo}</td>
                    </tr>
                  ))}
                  {(view?.mappings ?? []).length === 0 && (
                    <tr><td colSpan={5} className="text-ink-soft">No account mappings stand.</td></tr>
                  )}
                </tbody>
              </table>
              {canConfigure && current && (
                <>
                  <SaveForm action={saveGroupAccountAction} label="Save group account" record={(form) => {
                    const consChart = fieldValue(form, 'consChart');
                    const account = fieldValue(form, 'account');
                    if (!consChart || !account) return null;
                    return {
                      lockObject: 'CONSOLIDATION_GROUP_ACCOUNT',
                      argument: `${consChart}/${account}`,
                      existing: (view?.groupAccounts ?? []).some((row) => same(row.consChart, consChart) && same(row.account, account)),
                    };
                  }}>
                    <F label="Consolidation chart"><input name="consChart" className="field-input code w-36" defaultValue={current.consChart} required /></F>
                    <F label="Group account"><input name="account" className="field-input code w-36" required /></F>
                    <F label="Title"><input name="title" className="field-input w-64" required /></F>
                  </SaveForm>
                  <SaveForm action={saveMappingAction} label="Save mapping" record={(form) => {
                    const sourceChart = fieldValue(form, 'sourceChart');
                    const sourceFrom = fieldValue(form, 'sourceFrom');
                    const sourceTo = fieldValue(form, 'sourceTo');
                    if (!sourceChart || !sourceFrom || !sourceTo) return null;
                    return {
                      lockObject: 'CONSOLIDATION_MAPPING',
                      argument: `${sourceChart}/${sourceFrom}/${sourceTo}`,
                      existing: (view?.mappings ?? []).some((row) => same(row.sourceChart, sourceChart) && same(row.sourceAccountFrom, sourceFrom) && same(row.sourceAccountTo, sourceTo)),
                    };
                  }}>
                    <F label="Consolidation chart"><input name="consChart" className="field-input code w-36" defaultValue={current.consChart} required /></F>
                    <F label="Source chart"><input name="sourceChart" className="field-input code w-32" required /></F>
                    <F label="Source from"><input name="sourceFrom" className="field-input code w-36" required /></F>
                    <F label="Source to"><input name="sourceTo" className="field-input code w-36" required /></F>
                    <F label="Group account"><input name="groupAccount" className="field-input code w-36" required /></F>
                  </SaveForm>
                </>
              )}
            </>
          )}

          {folder === 'METHODS' && (
            <>
              <table className="grid-table mt-2 min-w-[32rem]">
                <thead><tr><th>Method</th><th>Kind</th><th>Title</th></tr></thead>
                <tbody>
                  {(view?.methods ?? []).map((m) => (
                    <tr key={m.method}><td className="code">{m.method}</td><td>{m.kind}</td><td>{m.title}</td></tr>
                  ))}
                  {(view?.methods ?? []).length === 0 && (
                    <tr><td colSpan={3} className="text-ink-soft">No methods stand.</td></tr>
                  )}
                </tbody>
              </table>
              {canConfigure && current && (
                <SaveForm action={saveMethodAction} label="Save method" record={(form) => {
                  const method = fieldValue(form, 'method');
                  if (!method) return null;
                  return { lockObject: 'CONSOLIDATION_METHOD', argument: `${current.area}/${method}`, existing: (view?.methods ?? []).some((row) => same(row.method, method)) };
                }}>
                  <input type="hidden" name="area" value={current.area} />
                  <F label="Method"><input name="method" className="field-input code w-36" required /></F>
                  <F label="Kind">
                    <select name="kind" className="field-input w-64">
                      {METHOD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </F>
                  <F label="Title"><input name="title" className="field-input w-64" required /></F>
                </SaveForm>
              )}
            </>
          )}

          {folder === 'TASKS' && (
            <>
              <table className="grid-table mt-2 min-w-[48rem]">
                <thead><tr><th>Task</th><th>Parent</th><th>Seq</th><th>Type</th><th>Method</th><th>Unit / Group</th><th>Valid From</th><th>Valid To</th></tr></thead>
                <tbody>
                  {(view?.tasks ?? []).map((task) => (
                    <tr key={task.task}>
                      <td className="code">{task.task}</td><td className="code">{task.parentTask}</td>
                      <td>{task.sequence}</td><td>{task.taskType}</td><td className="code">{task.method}</td>
                      <td>{task.unit || task.group}</td><td>{task.validFrom}</td><td>{task.validTo}</td>
                    </tr>
                  ))}
                  {(view?.tasks ?? []).length === 0 && (
                    <tr><td colSpan={8} className="text-ink-soft">No tasks stand.</td></tr>
                  )}
                </tbody>
              </table>
              {canConfigure && current && (
                <>
                  <SaveForm action={saveVersionAction} label="Save version" record={(form) => {
                    const version = fieldValue(form, 'version');
                    if (!version) return null;
                    return { lockObject: 'CONSOLIDATION_VERSION', argument: `${current.area}/${version}`, existing: (view?.versions ?? []).some((row) => same(row.version, version)) };
                  }}>
                    <input type="hidden" name="area" value={current.area} />
                    <F label="Version (1–3)"><input name="version" className="field-input code w-32" maxLength={3} required /></F>
                    <F label="Title"><input name="title" className="field-input w-64" required /></F>
                  </SaveForm>
                  <SaveForm action={saveTaskAction} label="Save task" record={(form) => {
                    const task = fieldValue(form, 'task');
                    const version = fieldValue(form, 'version');
                    if (!task || !version) return null;
                    return { lockObject: 'CONSOLIDATION_TASK', argument: `${current.area}/${version}/${task}`, existing: (view?.tasks ?? []).some((row) => same(row.task, task)) };
                  }}>
                    <input type="hidden" name="area" value={current.area} />
                    <F label="Version"><input name="version" className="field-input code w-28" required /></F>
                    <F label="Task"><input name="task" className="field-input code w-40" required /></F>
                    <F label="Parent task"><input name="parentTask" className="field-input code w-40" /></F>
                    <F label="Sequence"><input name="sequence" type="number" className="field-input w-24" defaultValue={10} /></F>
                    <F label="Type">
                      <select name="taskType" className="field-input w-56">
                        {TASK_TYPES.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </F>
                    <F label="Method"><input name="method" className="field-input code w-36" /></F>
                    <F label="Unit"><input name="unit" className="field-input code w-32" /></F>
                    <F label="Group"><input name="group" className="field-input code w-40" /></F>
                    <F label="Valid from"><input name="validFrom" type="date" className="field-input" required /></F>
                    <F label="Valid to"><input name="validTo" type="date" className="field-input" required /></F>
                  </SaveForm>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
