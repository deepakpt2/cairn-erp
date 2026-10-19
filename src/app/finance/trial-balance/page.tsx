import type { Metadata } from 'next';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import { TRIAL_BALANCE_CAPABILITY } from '@/modules/finance/trial-balance';
import TrialBalanceShell from './TrialBalanceShell';

export const metadata: Metadata = { title: 'Trial Balance / F.01' };

export default async function Page() {
  const session = await requireSession('/finance/trial-balance');
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('finance.label')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{t('trial.title')}</h1>
        <p className="text-sm text-ink-soft">{t('trial.intro')}</p>
      </header>
      <TrialBalanceShell canUse={can(session, TRIAL_BALANCE_CAPABILITY)} result={null} />
    </main>
  );
}
