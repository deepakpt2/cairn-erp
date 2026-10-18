import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ACTIVITY, listReleaseConfiguration } from '@/modules/foundation/release-strategy-definition';
import ReleaseStrategies from './ReleaseStrategies';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/release-strategies';

/**
 * Release strategies (SCR-059; inert in stage 1, live since stage 3).
 * The activity has stood in the seed since the platform round; this
 * is its page.
 */
export default async function ReleaseStrategiesPage() {
  const session = await requireSession(ROUTE);
  const data = await listReleaseConfiguration(session.user.client);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">CFG.PROC.RELEASE.DEFINE</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('releaseStrategy.title')}</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.workbench')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('releaseStrategy.subtitle')}</p>
      </header>

      <ReleaseStrategies data={data} canMaintain={can(session, ACTIVITY)} />
    </div>
  );
}
