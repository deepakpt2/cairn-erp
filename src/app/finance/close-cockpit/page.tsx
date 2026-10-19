import type { Metadata } from 'next';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import { CLOSE_COCKPIT_CAPABILITY } from '@/modules/finance/close-cockpit';
import CloseCockpitShell from './CloseCockpitShell';

export const metadata: Metadata = { title: 'Close Cockpit' };

export default async function Page() {
  const session = await requireSession('/finance/close-cockpit');
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('finance.label')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{t('close.title')}</h1>
        <p className="text-sm text-ink-soft">{t('close.intro')}</p>
      </header>
      <CloseCockpitShell canUse={can(session, CLOSE_COCKPIT_CAPABILITY)} lists={[]} tasks={[]} />
    </main>
  );
}
