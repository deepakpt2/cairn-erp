import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
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
  const loaded = params.edit ? await getParkedJournal(session.user.client, params.edit) : null;
  const editing = loaded && (loaded.status === 'PARKED' || loaded.status === 'COMPLETED') ? loaded : null;
  const canPark = can(session, PARKED_JOURNAL_CAPABILITY);
  const changeLock = editing && canPark
    ? await openChangeForSession(session, {
        lockObject: 'PARKED_JOURNAL',
        argument: editing.parkedNumber,
        transactionCode: 'FIN.JOURNAL.PARK',
      })
    : null;
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

      {changeLock?.mode === 'CHANGE' && editing && (
        <ChangeLock lockObject="PARKED_JOURNAL" argument={editing.parkedNumber} />
      )}
      <LockNotice message={changeLock ? displayOnlyMessage(changeLock) : null} />
      <ParkedJournal
        key={editing?.parkedNumber ?? 'new'}
        parked={parked}
        editing={editing}
        canPark={canPark && changeLock?.mode !== 'DISPLAY'}
        today={today}
      />
    </div>
  );
}
