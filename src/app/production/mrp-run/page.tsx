import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  MRP_REGENERATE_CAPABILITY,
  MRP_RUN_CAPABILITY,
  MRP_RUN_ROUTE,
  getMrpRun,
  listMrpRuns,
  mrpNamedRefusal,
} from '@/modules/production/mrp-run';
import MrpRunWorkbench from './MrpRunWorkbench';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default async function MrpRunPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(MRP_RUN_ROUTE);
  const params = await searchParams;
  const refusal = mrpNamedRefusal({
    mrpArea: one(params.mrpArea),
    companyCode: one(params.companyCode),
    bom: one(params.bom),
    background: one(params.background),
    scheduleLine: one(params.scheduleLine),
  });
  const runNumber = one(params.run);
  const run = !refusal && runNumber ? await getMrpRun(session.user.client, runNumber) : null;
  const runs = await listMrpRuns(session.user.client);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('md01.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('md01.title')}</h1>
          <Link href="/production/stock-requirements" className="btn btn-default min-h-11 sm:min-h-8">{t('md01.toList')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('md01.subtitle')}</p>
      </header>
      {refusal && <p role="status" data-mrp-refused className="text-sm text-red-700">{refusal}</p>}
      <MrpRunWorkbench
        canPlan={can(session, MRP_RUN_CAPABILITY)}
        canRegenerate={can(session, MRP_REGENERATE_CAPABILITY)}
        run={run}
      />
      {runs.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-sm" data-mrp-runs>
          {runs.map((row) => (
            <li key={row.runNumber}>
              <Link className="link" href={`${MRP_RUN_ROUTE}?run=${encodeURIComponent(row.runNumber)}`}>
                {row.runNumber} {row.status}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
