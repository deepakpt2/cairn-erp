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
import { LinkButton, Page } from '@/ui/kit';

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
  const run = !refusal && runNumber ? await getMrpRun(session.user.client, runNumber, { userId: session.user.userId, sessionId: session.sessionId ?? '' }) : null;
  const runs = await listMrpRuns(session.user.client, { userId: session.user.userId, sessionId: session.sessionId ?? '' });

  return (
    <Page
      title={t('md01.title')} code={t('md01.code')} width="5xl" back={null}
      description={t('md01.subtitle')}
      actions={
        <>
          <LinkButton href="/production/stock-requirements">{t('md01.toList')}</LinkButton>
        </>
      }
    >
      {refusal && <p role="status" data-mrp-refused className="text-sm text-signal-error">{refusal}</p>}
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
    </Page>
  );
}
