import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  PARKED_JOURNAL_CAPABILITY, getParkedJournal, listParkedJournals,
} from '@/modules/finance/parked-journal';
import ParkedJournal from './ParkedJournal';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/journal/park';

/**
 * Park a journal entry (SCR-087 / FV50 as a search alias only).
 */
export default async function ParkedJournalPage({ searchParams }: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const parked = await listParkedJournals(session.user.client);
  const editing = params.edit ? await getParkedJournal(session.user.client, params.edit) : null;
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
        key={editing?.parkedNumber ?? 'new'}
        parked={parked}
        editing={editing && (editing.status === 'PARKED' || editing.status === 'COMPLETED') ? editing : null}
        canPark={can(session, PARKED_JOURNAL_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
