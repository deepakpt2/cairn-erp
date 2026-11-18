
import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import {
  PARKED_JOURNAL_CAPABILITY, getParkedJournal, listParkedJournals,
} from '@/modules/finance/parked-journal';
import { JOURNAL_RELEASE_CAPABILITY, getParkedJournalRelease } from '@/modules/finance/parked-journal-release';
import ParkedJournal from './ParkedJournal';
import { displayOnlyRemedy } from '@/ui/lock/remedy';
import { Page } from '@/ui/kit';

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
  const release = editing ? await getParkedJournalRelease(session.user.client, editing.parkedNumber) : null;
  const changeLock = editing && canPark
    ? await openChangeForSession(session, {
        lockObject: 'PARKED_JOURNAL',
        argument: editing.parkedNumber,
        transactionCode: 'FIN.JOURNAL.PARK',
      })
    : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('parkedJournal.title')} code="FIN.JOURNAL.PARK · FV50" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('parkedJournal.subtitle')}
    >

      {changeLock?.mode === 'CHANGE' && editing && (
        <ChangeLock lockObject="PARKED_JOURNAL" argument={editing.parkedNumber} />
      )}
      <LockNotice message={changeLock ? displayOnlyMessage(changeLock) : null} remedy={displayOnlyRemedy(changeLock)} />
      <ParkedJournal
        key={editing?.parkedNumber ?? 'new'}
        parked={parked}
        editing={editing}
        canPark={canPark && changeLock?.mode !== 'DISPLAY'}
        release={release}
        canRelease={can(session, JOURNAL_RELEASE_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
