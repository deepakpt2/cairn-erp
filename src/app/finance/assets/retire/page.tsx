import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ASSET_RETIRE_CAPABILITY, listRetireableAssets } from '@/modules/finance/asset-retirement';
import RetireForm from './RetireForm';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.ASSET.RETIRE · ABAVN</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('assetRetire.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('assetRetire.subtitle')}</p>
      </header>

      <RetireForm
        canRetire={can(session, ASSET_RETIRE_CAPABILITY)}
        today={today}
        assets={assets}
      />
    </div>
  );
}
