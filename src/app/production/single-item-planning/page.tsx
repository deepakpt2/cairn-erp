import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  MRP_REGENERATE_CAPABILITY,
  MRP_RUN_CAPABILITY,
  MRP_SINGLE_ROUTE,
  getMrpRun,
  singleItemRefusal,
} from '@/modules/production/mrp-run';
import SingleItemWorkbench from './SingleItemWorkbench';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default async function SingleItemPlanningPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(MRP_SINGLE_ROUTE);
  const params = await searchParams;
  const refusal = singleItemRefusal({
    mrpArea: one(params.mrpArea),
    leadTimeScheduling: one(params.leadTimeScheduling),
    proposalMode: one(params.proposalMode),
    changeNumber: one(params.changeNumber),
    bomAlternative: one(params.bomAlternative),
    period: one(params.period),
  });
  const runNumber = one(params.run);
  const run = !refusal && runNumber ? await getMrpRun(session.user.client, runNumber) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('md02.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('md02.title')}</h1>
          <Link href="/production/stock-requirements" className="btn btn-default min-h-11 sm:min-h-8">{t('md01.toList')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('md02.subtitle')}</p>
      </header>
      {refusal && <p role="status" data-md02-refused className="text-sm text-red-700">{refusal}</p>}
      <SingleItemWorkbench
        canPlan={can(session, MRP_RUN_CAPABILITY)}
        canRegenerate={can(session, MRP_REGENERATE_CAPABILITY)}
        run={run}
        material={one(params.material)}
        plant={one(params.plant)}
      />
    </div>
  );
}
