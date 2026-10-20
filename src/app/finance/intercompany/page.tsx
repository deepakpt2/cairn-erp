import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  INTERCOMPANY_CAPABILITY, listCompanyChoices, listIntercompanyConfigs,
} from '@/modules/finance/intercompany';
import { IntercompanyPosting } from './IntercompanyPosting';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/intercompany';

/**
 * Intercompany posting (SCR-122; FB01 as a search alias only).
 *
 * One submission posts the sending journal and its receiving mirror in one
 * transaction; the OBYA clearing lines are generated, never typed.
 */
export default async function IntercompanyPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const [companies, pairs] = await Promise.all([
    listCompanyChoices(client),
    listIntercompanyConfigs(client),
  ]);
  const canPost = can(session, INTERCOMPANY_CAPABILITY);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{INTERCOMPANY_CAPABILITY} · FB01</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('icPost.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config/intercompany-clearing" className="btn btn-default min-h-11 sm:min-h-8">
              {t('icCfg.title')}
            </Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('icPost.intro')}</p>
      </header>
      <IntercompanyPosting companies={companies} pairs={pairs} canPost={canPost} today={today} />
    </div>
  );
}
