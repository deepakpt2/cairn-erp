import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ASSET_CREATE_CAPABILITY } from '@/modules/finance/asset-master';
import AssetCreate from './AssetCreate';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.ASSET.CREATE · AS01</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('assetCreate.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('assetCreate.subtitle')}</p>
      </header>

      <AssetCreate canCreate={can(session, ASSET_CREATE_CAPABILITY)} today={today} />
    </div>
  );
}
