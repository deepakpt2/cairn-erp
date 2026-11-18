
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listCostCenterAreas,
  listHierarchy,
} from '@/modules/foundation/cost-center-hierarchy';
import CostCenterHierarchy from './CostCenterHierarchy';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/cost-center-hierarchy';

/**
 * Cost centre hierarchy (SCR-042 / KSH1 · OKEON).
 *
 * The standard hierarchy is the area's one tree, with cost centre periods
 * placed into nodes; alternative groups stand beside it, resolved from
 * their leaves. Rollups do not read either structure yet.
 */
export default async function CostCenterHierarchyPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const areas = await listCostCenterAreas(client);
  const selectedArea =
    params.area !== undefined && params.area !== ''
      ? params.area
      : (areas[0]?.controllingArea ?? '');
  const view = await listHierarchy(client, selectedArea);

  return (
    <Page
      title={t('costHierarchy.title')} code={<>{ACTIVITY} · KSH1/OKEON</>} back={null}
      description={t('costHierarchy.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <CostCenterHierarchy
        areas={areas}
        selectedArea={selectedArea}
        view={view}
        canMaintain={canMaintain}
      />
    </Page>
  );
}
