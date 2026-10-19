import { can, requireSession } from '@/platform/auth/current';
import {
  getConsolidationWorkbench, listConsolidationAreas,
} from '@/modules/finance/consolidation-workbench';
import {
  CONSOLIDATED_STATEMENTS_CAPABILITY, ConsolidatedStatementsError,
  calculateConsolidatedStatements,
  type ConsolidatedStatementsResult, type ConsolidatedStatementsSelection,
} from '@/modules/finance/consolidated-statements';
import ConsolidatedStatementsShell, {
  type ConsolidatedStatementsOptions,
} from './ConsolidatedStatementsShell';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/consolidated-statements';

export default async function ConsolidatedStatementsPage({
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

  const selection: ConsolidatedStatementsSelection = {
    area,
    group: get('group').toUpperCase() || workbench?.groups[0]?.group || '',
    version: get('version').toUpperCase() || workbench?.versions[0]?.version || '',
    fiscalYear: Number(get('fiscalYear', String(new Date().getFullYear()))) || new Date().getFullYear(),
    period: Number(get('period', '12')) || 12,
    view: get('view').toUpperCase() === 'INCOME_STATEMENT' ? 'INCOME_STATEMENT' : 'BALANCE_SHEET',
    unit: get('unit').toUpperCase(),
    comparative: get('comparative') === '1',
  };

  const assignedUnits = workbench && selection.group
    ? workbench.units.filter((unit) => workbench.assignments.some((a) => a.group === selection.group && a.unit === unit.unit))
    : workbench?.units ?? [];
  const options: ConsolidatedStatementsOptions = {
    areas,
    groups: workbench?.groups ?? [],
    versions: workbench?.versions ?? [],
    units: assignedUnits,
  };

  const canUse = can(session, CONSOLIDATED_STATEMENTS_CAPABILITY)
    || can(session, `${CONSOLIDATED_STATEMENTS_CAPABILITY}.read`);
  let result: ConsolidatedStatementsResult | null = null;
  let reportError: string | null = null;
  if (canUse && selection.area && selection.group && selection.version) {
    try {
      result = await calculateConsolidatedStatements({ client: session.user.client, selection });
    } catch (error) {
      reportError = error instanceof ConsolidatedStatementsError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The consolidated statement could not be calculated.';
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.RPT.CONSOLIDATE.STMT</span>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Consolidated Statements</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Consolidated balance sheet and income statement over the UCWB consolidation chart, read from the reported journal data of the group units.
        </p>
      </header>
      <ConsolidatedStatementsShell
        canUse={canUse}
        options={options}
        selection={selection}
        result={result}
        reportError={reportError}
      />
    </div>
  );
}
