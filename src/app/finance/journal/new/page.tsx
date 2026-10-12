import Link from 'next/link';
import { requireSession, can } from '@/platform/auth/current';
import { listNumberRanges } from '@/modules/foundation/number-ranges';
import { hasCompanyCodeAssignments } from '@/modules/foundation/company-code-assignments';
import { JournalForm } from './JournalForm';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

export default async function PostJournalPage() {
  const session = await requireSession('/finance/journal/new');
  if (!can(session, 'FIN.JOURNAL.POST')) {
    return <div className="mx-auto max-w-5xl p-6"><div className="panel p-4 text-sm">{t('auth.missingAuthority', { authority: 'FIN.JOURNAL.POST' })}</div></div>;
  }
  const { companies, types, readiness } = await listNumberRanges(session.user.client);
  const active = companies.filter((company) => company.isActive && hasCompanyCodeAssignments(company));
  const incomplete = companies.some((company) => company.isActive && !hasCompanyCodeAssignments(company));
  return <>
    {!readiness.ready && <div className="mx-auto mt-5 max-w-5xl border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
      {t('nr.setupRequired')} <Link className="underline" href="/config/number-ranges">{t('nr.title')}</Link>
    </div>}
    {incomplete && active.length > 0 && <div className="mx-auto mt-3 max-w-5xl border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
      {t('cc.assignmentsPending')} <Link className="underline" href="/config/company-codes">{t('cc.title')}</Link>
    </div>}
    {active.length > 0 ? (
      <JournalForm companies={active.map(({ companyCode, name, currency }) => ({ companyCode, name, currency }))}
        types={types.map(({ documentType, name }) => ({ documentType, name }))} />
    ) : (
      <div className="mx-auto max-w-5xl p-6"><div className="panel p-5 text-sm text-ink-soft">
        {t('cc.assignmentsPending')} <Link className="text-accent underline" href="/config/company-codes">{t('cc.title')}</Link>
      </div></div>
    )}
  </>;
}
