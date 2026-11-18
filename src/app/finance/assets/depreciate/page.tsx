
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ASSET_DEPRECIATE_CAPABILITY, getDepreciationRunItems, listDepreciationRuns,
} from '@/modules/finance/asset-depreciation';
import DepreciateForm from './DepreciateForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/assets/depreciate';

/**
 * Depreciation run (SCR-094 / AFAB as a search alias only).
 * Stage 1 shell: the run service lands in stage 3 of R-142.
 */
export default async function DepreciatePage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);
  const params = await searchParams;
  const runs = can(session, ASSET_DEPRECIATE_CAPABILITY)
    ? await listDepreciationRuns(session.user.client)
    : [];
  const selectedItems = params.run
    ? await getDepreciationRunItems(session.user.client, params.run)
    : [];

  return (
    <Page
      title={t('assetDepreciate.title')} code="FIN.ASSET.DEPRECIATE · AFAB" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('assetDepreciate.subtitle')}
    >

      <DepreciateForm
        canRun={can(session, ASSET_DEPRECIATE_CAPABILITY)}
        today={today}
        runs={runs}
        selectedRunId={params.run ?? null}
        selectedItems={selectedItems}
      />
    </Page>
  );
}
