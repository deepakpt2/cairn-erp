import {
  CONSOLIDATION_FOLDERS, type ConsolidationArea, type ConsolidationFolder,
  type ConsolidationWorkbenchView,
} from '@/modules/finance/consolidation-workbench';

const FOLDER_LABELS: Record<ConsolidationFolder, string> = {
  DATA_BASIS: 'Data Basis',
  MASTER_DATA: 'Master Data',
  CHART_MAPPINGS: 'Consolidation Chart & Mappings',
  METHODS: 'Methods',
  TASKS: 'Task Hierarchies',
};

/**
 * Consolidation workbench (SCR-116): the area context and the
 * five configuration folders; maintenance arrives in stage 3.
 */
export default function ConsolidationWorkbenchShell({ canUse, areas, area, folder, view }: {
  canUse: boolean;
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
          <p className="text-sm text-ink-soft">No consolidation area stands yet. Configuration maintenance arrives with the workbench service.</p>
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
            <p className="mt-2 text-sm text-ink-soft">
              Data basis {current?.dataBasis ?? '—'} binds the standing journal provider.
              Dimensions are the standing journal characteristics; BW providers are not carried.
            </p>
          )}
          {folder === 'MASTER_DATA' && (
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
          )}
          {folder === 'CHART_MAPPINGS' && (
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
          )}
          {folder === 'METHODS' && (
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
          )}
          {folder === 'TASKS' && (
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
          )}
        </section>
      </div>
    </div>
  );
}
