import Link from 'next/link';
import { requireSession, can } from '@/platform/auth/current';
import { listNumberRanges } from '@/modules/foundation/number-ranges';
import { JournalForm } from './JournalForm';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

export default async function PostJournalPage() {
  const session = await requireSession('/finance/journal/new');
  if (!can(session, 'FIN.JOURNAL.POST')) {
    return <div className="mx-auto max-w-5xl p-6"><div className="panel p-4 text-sm">{t('auth.missingAuthority', { authority: 'FIN.JOURNAL.POST' })}</div></div>;
  }
  const { companies, types, readiness } = await listNumberRanges(session.user.client);
  const active = companies.filter((c) => c.isActive);
  return <>
    {!readiness.ready && <div className="mx-auto mt-5 max-w-5xl border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
      {t('nr.setupRequired')} <Link className="underline" href="/config/number-ranges">{t('nr.title')}</Link>
    </div>}
    <JournalForm companies={active.map(({ companyCode, name, currency }) => ({ companyCode, name, currency }))}
      types={types.map(({ documentType, name }) => ({ documentType, name }))} />
  </>;
}
