
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ASSET_CREATE_CAPABILITY } from '@/modules/finance/asset-master';
import AssetCreate from './AssetCreate';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/assets/new';

/**
 * Create asset master (SCR-091 / AS01 as a search alias only).
 * Stage 1 shell: the asset service lands in stage 3 of R-139.
 */
export default async function CreateAssetPage() {
  const session = await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('assetCreate.title')} code="FIN.ASSET.CREATE · AS01" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('assetCreate.subtitle')}
    >

      <AssetCreate canCreate={can(session, ASSET_CREATE_CAPABILITY)} today={today} />
    </Page>
  );
}
