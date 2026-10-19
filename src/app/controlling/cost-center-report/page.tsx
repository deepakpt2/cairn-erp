import type { Metadata } from 'next';
import Link from 'next/link';
import { can, requireSession } from '@/platform/auth/current';
import { listControllingAreas } from '@/modules/foundation/controlling-area-maintenance';
import {
  COST_CENTER_REPORT_CAPABILITY, DEFAULT_PLAN_VERSION, type CostCenterReportSelection,
} from '@/modules/foundation/cost-center-report';
import CostCenterReportShell from './CostCenterReportShell';

export const metadata: Metadata = { title: 'Cost Centers: Actual / Plan / Variance' };
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession('/controlling/cost-center-report');
  const params = await searchParams;
  const canUse = can(session, COST_CENTER_REPORT_CAPABILITY);
  const areas = (await listControllingAreas(session.user.client))
    .map((a) => ({ controllingArea: a.controllingArea, currency: a.currency }));

  const selection: CostCenterReportSelection = {
    controllingArea: params.controllingArea ?? areas[0]?.controllingArea ?? '',
    fiscalYear: Number(params.fiscalYear ?? new Date().getFullYear()),
    periodFrom: Number(params.periodFrom ?? 1),
    periodTo: Number(params.periodTo ?? 12),
    planVersion: (params.planVersion || DEFAULT_PLAN_VERSION).toUpperCase(),
    costCenterFrom: params.costCenterFrom || undefined,
    costCenterTo: params.costCenterTo || undefined,
    costCenterGroup: params.costCenterGroup || undefined,
    costElementFrom: params.costElementFrom || undefined,
    costElementTo: params.costElementTo || undefined,
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">Controlling</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">Cost Centers: Actual / Plan / Variance</h1>
        <p className="text-sm text-ink-soft">
          Actual costs from the posted journal against planned costs for the selected version —
          missing plan is shown as missing, never as zero. Read-only.
        </p>
        <Link href="/finance/journal/items" className="mt-1 inline-block text-sm text-accent hover:underline">
          Line items…
        </Link>
      </header>
      <CostCenterReportShell canUse={canUse} areas={areas} selection={selection} result={null} />
    </main>
  );
}
