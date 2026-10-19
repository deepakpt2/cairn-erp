import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { PARKED_JOURNAL_CAPABILITY } from '@/modules/finance/parked-journal';
import ParkedJournal from './ParkedJournal';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/journal/park';

/**
 * Park a journal entry (SCR-087 / FV50 as a search alias only).
 * Stage 1 shell: the parked-document service lands in stage 3 of R-135.
 */
export default async function ParkedJournalPage() {
  const session = await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.JOURNAL.PARK · FV50</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('parkedJournal.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('parkedJournal.subtitle')}</p>
      </header>

      <ParkedJournal
        parked={[]}
        canPark={can(session, PARKED_JOURNAL_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
