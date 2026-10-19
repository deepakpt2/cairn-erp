import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ASSET_REPORT_CAPABILITY } from '@/modules/finance/asset-history';
import HistoryForm from './HistoryForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/assets/history';

/**
 * Asset history sheet (SCR-095 / S_ALR_87011990 as a search alias
 * only). Stage 1 shell: the aggregation service lands in stage 3
 * of R-143.
 */
export default async function AssetHistoryPage() {
  const session = await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.ASSET.REPORT · S_ALR_87011990</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('assetHistory.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('assetHistory.subtitle')}</p>
      </header>

      <HistoryForm canReport={can(session, ASSET_REPORT_CAPABILITY)} />
    </div>
  );
}
