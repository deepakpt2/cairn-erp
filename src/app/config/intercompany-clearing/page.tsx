import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  INTERCOMPANY_CONFIG_CAPABILITY, listCompanyChoices, listIntercompanyConfigs,
} from '@/modules/finance/intercompany';
import { IntercompanyClearing } from './IntercompanyClearing';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/intercompany-clearing';

/**
 * OBYA — intercompany clearing configuration (SCR-122).
 *
 * One row per ordered company pair; the clearing accounts here override the
 * OBYA account each company already carries, and a pair that has posted
 * stands as history rather than being deleted.
 */
export default async function IntercompanyClearingPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const [pairs, companies] = await Promise.all([
    listIntercompanyConfigs(client),
    listCompanyChoices(client),
  ]);
  const canMaintain = can(session, INTERCOMPANY_CONFIG_CAPABILITY);
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{INTERCOMPANY_CONFIG_CAPABILITY} · OBYA</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('icCfg.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/finance/intercompany" className="btn btn-default min-h-11 sm:min-h-8">
              {t('icCfg.post')}
            </Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('icCfg.intro')}</p>
      </header>
      <IntercompanyClearing pairs={pairs} companies={companies} canMaintain={canMaintain} />
    </div>
  );
}
