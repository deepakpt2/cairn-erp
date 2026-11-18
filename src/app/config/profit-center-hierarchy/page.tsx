
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listCostCenterAreas,
  listHierarchy,
} from '@/modules/foundation/profit-center-hierarchy';
import ProfitCenterHierarchy from './ProfitCenterHierarchy';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/profit-center-hierarchy';

/**
 * Cost centre hierarchy (SCR-047a / KCH1 · KCH5N).
 *
 * The standard hierarchy is the area's one tree, with profit centre periods
 * placed into nodes; alternative groups stand beside it, resolved from
 * their leaves. Rollups do not read either structure yet.
 */
export default async function ProfitCenterHierarchyPage({
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
      title={t('profitHierarchy.title')} code={<>{ACTIVITY} · KCH1/KCH5N</>} back={null}
      description={t('profitHierarchy.subtitle')}
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

      <ProfitCenterHierarchy
        areas={areas}
        selectedArea={selectedArea}
        view={view}
        canMaintain={canMaintain}
      />
    </Page>
  );
}
