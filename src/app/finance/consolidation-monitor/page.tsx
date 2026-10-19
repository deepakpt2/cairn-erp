import { can, requireSession } from '@/platform/auth/current';
import {
  getConsolidationWorkbench, listConsolidationAreas,
} from '@/modules/finance/consolidation-workbench';
import {
  CONSOLIDATE_CAPABILITY, CONSOLIDATION_MONITOR_AUTHORITIES,
  type ConsolidationExecutionMode, type ConsolidationMonitorOptions,
  type ConsolidationMonitorSelection, type ConsolidationMonitorView,
} from '@/modules/finance/consolidation-monitor-vocabulary';
import ConsolidationMonitorShell from './ConsolidationMonitorShell';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/consolidation-monitor';

export default async function ConsolidationMonitorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  const areas = await listConsolidationAreas(session.user.client);
  const area = get('area').toUpperCase() || areas.find((a) => a.status === 'ACTIVE')?.area || areas[0]?.area || '';
  const workbench = area ? await getConsolidationWorkbench(session.user.client, area) : null;

  const selection: ConsolidationMonitorSelection = {
    area,
    group: get('group').toUpperCase() || workbench?.groups[0]?.group || '',
    version: get('version').toUpperCase() || workbench?.versions[0]?.version || '',
    fiscalYear: Number(get('fiscalYear', String(new Date().getFullYear()))) || new Date().getFullYear(),
    period: Number(get('period', String(new Date().getMonth() + 1))) || 1,
    taskGroup: get('taskGroup').toUpperCase(),
    unit: get('unit').toUpperCase(),
    mode: get('mode', 'TEST').toUpperCase() === 'UPDATE' ? 'UPDATE' : 'TEST',
  };

  const assignedUnits = workbench && selection.group
    ? workbench.units.filter((unit) => workbench.assignments.some((a) => a.group === selection.group && a.unit === unit.unit))
    : workbench?.units ?? [];
  const tasks = workbench?.tasks ?? [];
  const options: ConsolidationMonitorOptions = {
    areas,
    groups: workbench?.groups ?? [],
    versions: workbench?.versions ?? [],
    units: assignedUnits,
    rootTasks: tasks.filter((task) => !task.parentTask),
  };

  const view: ConsolidationMonitorView | null = workbench ? {
    selection,
    areaTitle: workbench.area.title,
    areaStatus: workbench.area.status,
    fiscalYearVariant: workbench.area.fiscalYearVariant,
    periodLabel: `${selection.fiscalYear} / period ${selection.period} · variant ${workbench.area.fiscalYearVariant}`,
    rows: assignedUnits.flatMap((unit) => tasks
      .filter((task) => !task.unit || task.unit === unit.unit)
      .filter((task) => !task.group || task.group === selection.group)
      .filter((task) => !selection.unit || task.unit === selection.unit)
      .map((task) => ({
        unit: unit.unit,
        unitTitle: unit.title,
        companyCode: unit.companyCode,
        task: task.task,
        parentTask: task.parentTask,
        sequence: task.sequence,
        taskType: task.taskType,
        method: task.method,
        status: 'OPEN' as const,
        blockedReason: '',
        latestRunId: '',
        lastMode: '' as const,
        executedBy: '',
        executedAt: '',
        durationMs: null,
        resultSummary: '',
        warningCount: 0,
        errorCount: 0,
        attemptCount: 0,
      }))),
    executions: [],
  } : null;

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.CONSOLIDATE · CX20 / UCMON</span>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Consolidation Monitor</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Execute and review configured consolidation tasks. UCWB owns the definitions; this monitor owns attempts, status and logs.
        </p>
      </header>
      <ConsolidationMonitorShell
        canUse={can(session, CONSOLIDATION_MONITOR_AUTHORITIES.view) || can(session, `${CONSOLIDATE_CAPABILITY}.read`)}
        canViewLogs={can(session, CONSOLIDATION_MONITOR_AUTHORITIES.logs) || can(session, CONSOLIDATE_CAPABILITY)}
        options={options}
        selection={selection}
        view={view}
      />
    </div>
  );
}
