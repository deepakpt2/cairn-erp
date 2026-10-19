'use client';

import Link from 'next/link';

import {
  CONSOLIDATION_MONITOR_ROUTE, EXECUTION_MODES, EXECUTION_MODE_LABELS,
  type ConsolidationMonitorOptions, type ConsolidationMonitorSelection,
  type ConsolidationMonitorView,
} from '@/modules/finance/consolidation-monitor-vocabulary';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

function statusClass(status: string): string {
  if (status === 'COMPLETED') return 'text-emerald-700';
  if (status === 'ERROR') return 'text-red-700';
  if (status === 'WARNING' || status === 'BLOCKED') return 'text-amber-700';
  if (status === 'RUNNING') return 'text-sky-700';
  return 'text-ink-soft';
}

/**
 * CX20 consolidation monitor shell (SCR-117 stage 1): selection,
 * refresh and the unit/task matrix over UCWB configuration.
 * Execution controls arrive with the monitor service in stage 3.
 */
export default function ConsolidationMonitorShell({ canUse, canViewLogs, options, selection, view }: {
  canUse: boolean;
  canViewLogs: boolean;
  options: ConsolidationMonitorOptions;
  selection: ConsolidationMonitorSelection;
  view: ConsolidationMonitorView | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        You do not hold the consolidation monitor capability (FIN.CONSOLIDATE).
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label="Consolidation monitor selection">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Consolidation Area">
            <select name="area" className="field-input code w-52" defaultValue={selection.area}>
              {options.areas.map((a) => (
                <option key={a.area} value={a.area}>{a.area} — {a.title} ({a.status})</option>
              ))}
            </select>
          </Field>
          <Field label="Consolidation Group">
            <select name="group" className="field-input code w-52" defaultValue={selection.group}>
              {options.groups.map((g) => (
                <option key={g.group} value={g.group}>{g.group} — {g.title}</option>
              ))}
            </select>
          </Field>
          <Field label="Version">
            <select name="version" className="field-input code w-44" defaultValue={selection.version}>
              {options.versions.map((v) => (
                <option key={v.version} value={v.version}>{v.version} — {v.title}</option>
              ))}
            </select>
          </Field>
          <Field label="Fiscal Year">
            <input name="fiscalYear" type="number" className="field-input code w-28" defaultValue={selection.fiscalYear} required />
          </Field>
          <Field label="Posting Period">
            <input name="period" type="number" min={1} max={16} className="field-input code w-28" defaultValue={selection.period} required />
          </Field>
          <Field label="Task Group">
            <select name="taskGroup" className="field-input code w-48" defaultValue={selection.taskGroup}>
              <option value="">All configured tasks</option>
              {options.rootTasks.map((task) => (
                <option key={task.task} value={task.task}>{task.task} — {task.taskType}</option>
              ))}
            </select>
          </Field>
          <Field label="Consolidation Unit">
            <select name="unit" className="field-input code w-48" defaultValue={selection.unit}>
              <option value="">All units in group</option>
              {options.units.map((u) => (
                <option key={u.unit} value={u.unit}>{u.unit} — {u.title}</option>
              ))}
            </select>
          </Field>
          <Field label="Execution Mode">
            <select name="mode" className="field-input w-40" defaultValue={selection.mode}>
              {EXECUTION_MODES.map((mode) => (
                <option key={mode} value={mode}>{EXECUTION_MODE_LABELS[mode]}</option>
              ))}
            </select>
          </Field>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Refresh</button>
        </div>
        <p className="text-sm text-ink-soft">
          Task order and prerequisites come from the UCWB task hierarchy. Test Run is the default and commits no consolidation result or journal.
        </p>
      </form>

      <section className="panel overflow-x-auto" aria-label="Consolidation monitor matrix">
        <div className="panel-header flex flex-wrap items-center justify-between gap-2">
          <h2 className="panel-title">Monitor Matrix</h2>
          <span className="text-sm text-ink-soft">
            {view ? `${view.areaTitle} · ${view.periodLabel} · Area ${view.areaStatus}` : 'No monitor scope selected'}
          </span>
        </div>
        <table className="grid-table min-w-[76rem]">
          <thead>
            <tr>
              <th>Unit</th><th>Task</th><th>Prerequisite</th><th>Type</th><th>Status</th>
              <th>Last Mode</th><th>Execution User</th><th>Execution Time</th><th>Duration</th><th>Log</th>
            </tr>
          </thead>
          <tbody>
            {(view?.rows ?? []).map((row) => (
              <tr key={`${row.unit}|${row.task}`}>
                <td><span className="code">{row.unit}</span><span className="block text-xs text-ink-faint">{row.companyCode}</span></td>
                <td><span className="code">{row.sequence}. {row.task}</span><span className="block text-xs text-ink-faint">{row.method || 'No method'}</span></td>
                <td className="code">{row.parentTask || '—'}</td>
                <td>{row.taskType}</td>
                <td className={statusClass(row.status)} title={row.blockedReason}>{row.status}</td>
                <td>{row.lastMode || '—'}</td>
                <td>{row.executedBy || '—'}</td>
                <td>{row.executedAt || '—'}</td>
                <td>{row.durationMs == null ? '—' : `${row.durationMs} ms`}</td>
                <td>{canViewLogs && row.latestRunId ? <span className="code">{row.latestRunId}</span> : '—'}</td>
              </tr>
            ))}
            {(view?.rows ?? []).length === 0 && (
              <tr><td colSpan={10} className="text-ink-soft">No configured unit/task rows stand for this selection.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel p-4" aria-label="Execution log">
        <h2 className="panel-title">Execution History</h2>
        {(view?.executions ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No execution attempts stand for this scope yet.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {(view?.executions ?? []).map((execution) => (
              <article key={execution.runId} className="border-t border-line pt-3">
                <p className="text-sm">
                  <span className="code">{execution.runId}</span> · {execution.task} · {execution.mode} ·{' '}
                  <span className={statusClass(execution.status)}>{execution.status}</span> · {execution.resultSummary}
                </p>
                {canViewLogs && execution.logs.map((log) => (
                  <p key={log.sequence} className="mt-1 text-xs text-ink-soft">
                    {log.level}: {log.message}{log.reference ? ` (${log.reference})` : ''}
                  </p>
                ))}
              </article>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-ink-faint">
          Period standing is displayed from configuration; opening or closing FI periods remains in{' '}
          <Link className="text-accent underline" href="/config/posting-periods">Posting periods (OB52)</Link>.
        </p>
        <p className="mt-1 text-xs text-ink-faint">Route: {CONSOLIDATION_MONITOR_ROUTE}</p>
      </section>
    </div>
  );
}
