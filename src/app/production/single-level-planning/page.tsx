
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
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title={t('md03.title')} code={t('md03.code')} width="5xl" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('md03.subtitle')}</p>
          <p className="max-w-3xl text-sm text-ink-soft" data-md03-gaps>{t('md03.gaps')}</p>
        </>
      }
      actions={
        <>
          <LinkButton href="/production/single-item-planning">MD02</LinkButton>
          <LinkButton href="/production/stock-requirements">{t('md01.toList')}</LinkButton>
        </>
      }
    >
      {refusal && <p role="status" data-md03-refused className="text-sm text-signal-error">{refusal}</p>}
      <SingleLevelWorkbench
        canPlan={can(session, MRP_SINGLE_LEVEL_CAPABILITY) && can(session, MRP_RUN_CAPABILITY)}
        canRegenerate={can(session, MRP_REGENERATE_CAPABILITY)}
        run={run}
        material={one(params.material)}
        plant={one(params.plant)}
      />
    </Page>
  );
}
