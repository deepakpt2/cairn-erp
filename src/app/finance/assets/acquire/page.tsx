import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ASSET_ACQUIRE_CAPABILITY } from '@/modules/finance/asset-acquisition';
import AcquireForm from './AcquireForm';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.ASSET.ACQUIRE · ABZON</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('assetAcquire.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('assetAcquire.subtitle')}</p>
      </header>

      <AcquireForm
        preview={null}
        canAcquire={can(session, ASSET_ACQUIRE_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
