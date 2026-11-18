
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
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title={t('md02.title')} code={t('md02.code')} width="5xl" back={null}
      description={t('md02.subtitle')}
      actions={
        <>
          <LinkButton href="/production/stock-requirements">{t('md01.toList')}</LinkButton>
        </>
      }
    >
      {refusal && <p role="status" data-md02-refused className="text-sm text-signal-error">{refusal}</p>}
      <SingleItemWorkbench
        canPlan={can(session, MRP_RUN_CAPABILITY)}
        canRegenerate={can(session, MRP_REGENERATE_CAPABILITY)}
        run={run}
        material={one(params.material)}
        plant={one(params.plant)}
      />
    </Page>
  );
}
