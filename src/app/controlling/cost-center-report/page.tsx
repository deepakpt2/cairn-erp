import { redirect } from 'next/navigation';
import { can, requireSession } from '@/platform/auth/current';
import { listControllingAreas } from '@/modules/foundation/controlling-area-maintenance';
import { calculateCostCenterReport, CostCenterReportError, type CostCenterReportSelection } from '@/modules/foundation/cost-center-report';
import CostCenterReportShell from './CostCenterReportShell';

export const dynamic = 'force-dynamic';

const READ_PERMISSION = 'FIN.RPT.COSTCENTER.ACTUAL.read';

export default async function CostCenterReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  if (!can(session, READ_PERMISSION)) {
    return (
      <main className="mx-auto w-full max-w-[1500px] px-4 py-10 sm:px-6">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          You are signed in, but report access is required before the cost center report can be displayed.
        </p>
      </main>
    );
  }
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();
  const controllingAreas = await listControllingAreas(session.user.client);
  const initialSelection: CostCenterReportSelection = {
    controllingArea: (get('controllingArea') || controllingAreas[0]?.controllingArea || '').toUpperCase(),
    costCenterGroup: get('costCenterGroup').toUpperCase(),
    costCenterFrom: get('costCenterFrom').toUpperCase(),
    costCenterTo: get('costCenterTo').toUpperCase(),
    costElementFrom: get('costElementFrom'),
    costElementTo: get('costElementTo'),
    fiscalYear: Number(get('fiscalYear', String(new Date().getFullYear()))) || new Date().getFullYear(),
    periodFrom: Number(get('periodFrom', '1')) || 1,
    periodTo: Number(get('periodTo', '12')) || 12,
    planVersion: (get('planVersion', '000') || '000').toUpperCase(),
  };

  let result = null;
  let reportError: string | null = null;
  if (params.controllingArea !== undefined || controllingAreas.length > 0) {
    try {
      result = await calculateCostCenterReport({ client: session.user.client, selection: initialSelection });
    } catch (error) {
      reportError = error instanceof CostCenterReportError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The report could not be calculated.';
    }
  }

  return (
    <CostCenterReportShell
      canUse
      areas={controllingAreas}
      selection={initialSelection}
      result={result}
      reportError={reportError}
    />
  );
}
