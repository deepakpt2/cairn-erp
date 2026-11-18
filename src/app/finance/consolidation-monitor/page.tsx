import { can, requireSession } from '@/platform/auth/current';
import {
  getConsolidationWorkbench, listConsolidationAreas,
} from '@/modules/finance/consolidation-workbench';
import {
  CONSOLIDATE_CAPABILITY, CONSOLIDATION_MONITOR_AUTHORITIES,
  ConsolidationMonitorError, getConsolidationMonitor,
  type ConsolidationMonitorOptions, type ConsolidationMonitorSelection,
  type ConsolidationMonitorView,
} from '@/modules/finance/consolidation-monitor';
import ConsolidationMonitorShell from './ConsolidationMonitorShell';
import { Page } from '@/ui/kit';

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

  const canUse = can(session, CONSOLIDATION_MONITOR_AUTHORITIES.view)
    || can(session, `${CONSOLIDATE_CAPABILITY}.read`);
  const canViewLogs = can(session, CONSOLIDATION_MONITOR_AUTHORITIES.logs)
    || can(session, CONSOLIDATE_CAPABILITY);

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
    warningPolicy: get('warningPolicy').toUpperCase() === 'ALLOW_WARNINGS' ? 'ALLOW_WARNINGS' : 'BLOCK_ON_WARNING',
  };

  const assignedUnits = workbench && selection.group
    ? workbench.units.filter((unit) => workbench.assignments.some((a) => a.group === selection.group && a.unit === unit.unit))
    : workbench?.units ?? [];
  const options: ConsolidationMonitorOptions = {
    areas,
    groups: workbench?.groups ?? [],
    versions: workbench?.versions ?? [],
    units: assignedUnits,
    rootTasks: (workbench?.tasks ?? [])
      .filter((task) => !task.parentTask)
      .map((task) => ({ task: task.task, taskType: task.taskType, sequence: task.sequence })),
  };

  let view: ConsolidationMonitorView | null = null;
  let monitorError: string | null = null;
  if (canUse && selection.area && selection.group && selection.version) {
    try {
      view = await getConsolidationMonitor(session.user.client, selection, canViewLogs);
    } catch (error) {
      monitorError = error instanceof ConsolidationMonitorError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The consolidation monitor could not be loaded.';
    }
  }

  return (
    <Page
      title="Consolidation Monitor" code="FIN.CONSOLIDATE · CX20 / UCMON" width="7xl" back={null}
      description="Execute and review configured consolidation tasks. UCWB owns the definitions; this monitor owns attempts, status and logs."
    >
      <ConsolidationMonitorShell
        canUse={canUse}
        canTest={can(session, CONSOLIDATION_MONITOR_AUTHORITIES.test)}
        canUpdate={can(session, CONSOLIDATION_MONITOR_AUTHORITIES.update)}
        canCancel={can(session, CONSOLIDATION_MONITOR_AUTHORITIES.update)}
        canViewLogs={canViewLogs}
        canMaintainPeriods={can(session, CONSOLIDATION_MONITOR_AUTHORITIES.periodControl)}
        options={options}
        selection={selection}
        view={view}
        monitorError={monitorError}
      />
    </Page>
  );
}
