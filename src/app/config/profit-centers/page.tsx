
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listCostCenterAreas,
  listProfitCenters,
  listResponsibleUsers,
} from '@/modules/foundation/profit-center-definition';
import ProfitCenters from './ProfitCenters';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/profit-centers';

/**
 * Profit centre definition (SCR-045 / KE51; inert since stage 1).
 *
 * The master-detail shape shared with the controlling masters: a
 * controlling-area selector over the tenant's areas, then that area's
 * profit centres one row per validity period. Hierarchy placement
 * arrives with the profit centre hierarchy activity, as it did for
 * cost centres; the segment is free text until a segment master stands.
 */
export default async function ProfitCentersPage({
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
  const [rows, users] = await Promise.all([
    listProfitCenters(client, selectedArea),
    listResponsibleUsers(client),
  ]);

  return (
    <Page
      title={t('profitCenter.title')} code={<>{ACTIVITY} · KE51</>} back={null}
      description={t('profitCenter.subtitle')}
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

      <ProfitCenters
        areas={areas}
        selectedArea={selectedArea}
        rows={rows}
        users={users}
        canMaintain={canMaintain}
      />
    </Page>
  );
}
