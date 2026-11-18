
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ASSET_RETIRE_CAPABILITY, listRetireableAssets } from '@/modules/finance/asset-retirement';
import RetireForm from './RetireForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/assets/retire';

/**
 * Asset retirement by scrapping (SCR-093 / ABAVN as a search
 * alias only). Stage 1 shell: the retirement service lands in
 * stage 3 of R-141.
 */
export default async function RetireAssetPage() {
  const session = await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);
  const assets = await listRetireableAssets(session.user.client);

  return (
    <Page
      title={t('assetRetire.title')} code="FIN.ASSET.RETIRE · ABAVN" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('assetRetire.subtitle')}
    >

      <RetireForm
        canRetire={can(session, ASSET_RETIRE_CAPABILITY)}
        today={today}
        assets={assets}
      />
    </Page>
  );
}
