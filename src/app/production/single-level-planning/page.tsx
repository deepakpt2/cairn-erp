import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  MRP_REGENERATE_CAPABILITY,
  MRP_RUN_CAPABILITY,
  MRP_SINGLE_LEVEL_CAPABILITY,
  MRP_SINGLE_LEVEL_ROUTE,
  getMrpRun,
  singleLevelRefusal,
} from '@/modules/production/mrp-run';
import SingleLevelWorkbench from './SingleLevelWorkbench';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default async function SingleLevelPlanningPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(MRP_SINGLE_LEVEL_ROUTE);
  const params = await searchParams;
  const refusal = singleLevelRefusal({
    mrpArea: one(params.mrpArea),
    scheduleLine: one(params.scheduleLine),
    mrpList: one(params.mrpList),
    createMrpList: one(params.createMrpList),
    md05: one(params.md05),
    proposalMode: one(params.proposalMode),
    planningDate: one(params.planningDate),
    openingPeriod: one(params.openingPeriod),
    leadTimeScheduling: one(params.leadTimeScheduling),
    calendar: one(params.calendar),
    period: one(params.period),
    deleteAndRecreate: one(params.deleteAndRecreate),
    companyCode: one(params.companyCode),
  }, one(params.planningMode));
  const runNumber = one(params.run);
  const run = !refusal && runNumber ? await getMrpRun(session.user.client, runNumber) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('md03.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('md03.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/production/single-item-planning" className="btn btn-default min-h-11 sm:min-h-8">MD02</Link>
            <Link href="/production/stock-requirements" className="btn btn-default min-h-11 sm:min-h-8">{t('md01.toList')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('md03.subtitle')}</p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft" data-md03-gaps>{t('md03.gaps')}</p>
      </header>
      {refusal && <p role="status" data-md03-refused className="text-sm text-red-700">{refusal}</p>}
      <SingleLevelWorkbench
        canPlan={can(session, MRP_SINGLE_LEVEL_CAPABILITY) && can(session, MRP_RUN_CAPABILITY)}
        canRegenerate={can(session, MRP_REGENERATE_CAPABILITY)}
        run={run}
        material={one(params.material)}
        plant={one(params.plant)}
      />
    </div>
  );
}
