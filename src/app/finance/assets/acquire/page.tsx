
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ASSET_ACQUIRE_CAPABILITY } from '@/modules/finance/asset-acquisition';
import AcquireForm from './AcquireForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/assets/acquire';

/**
 * Asset acquisition with automatic offsetting (SCR-092 / ABZON
 * as a search alias only). Stage 1 shell: the acquisition service
 * lands in stage 3 of R-140.
 */
export default async function AcquireAssetPage() {
  const session = await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('assetAcquire.title')} code="FIN.ASSET.ACQUIRE · ABZON" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('assetAcquire.subtitle')}
    >

      <AcquireForm
        preview={null}
        canAcquire={can(session, ASSET_ACQUIRE_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
