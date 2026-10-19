import type { Metadata } from 'next';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import { CREDIT_RELEASE_CAPABILITY } from '@/modules/finance/credit';
import CreditReleaseShell from './CreditReleaseShell';

export const metadata: Metadata = { title: 'Release Credit-Blocked Documents' };

export default async function Page() {
  const session = await requireSession('/finance/credit-release');
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('finance.label')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{t('release.title')}</h1>
        <p className="text-sm text-ink-soft">{t('release.intro')}</p>
      </header>
      <CreditReleaseShell canUse={can(session, CREDIT_RELEASE_CAPABILITY)} determinations={[]} />
    </main>
  );
}
