import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { JOURNAL_ITEMS_CAPABILITY } from '@/modules/finance/journal-items';
import ItemsForm from './ItemsForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/journal/items';

/**
 * G/L line item report (SCR-088 / FAGLL03 as a search alias only).
 * Stage 1 shell: the canonical-ledger query lands in stage 3 of R-136.
 */
export default async function JournalItemsPage() {
  const session = await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.JOURNAL.LIST · FAGLL03</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('journalItems.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('journalItems.subtitle')}</p>
      </header>

      <ItemsForm result={null} canList={can(session, JOURNAL_ITEMS_CAPABILITY)} />
    </div>
  );
}
