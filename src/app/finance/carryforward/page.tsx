import type { Metadata } from 'next';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import { CARRYFORWARD_CAPABILITY } from '@/modules/finance/carryforward';
import CarryforwardShell from './CarryforwardShell';

export const metadata: Metadata = { title: 'Balance Carryforward' };

export default async function Page() {
  const session = await requireSession('/finance/carryforward');
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('finance.label')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{t('carry.title')}</h1>
        <p className="text-sm text-ink-soft">{t('carry.intro')}</p>
      </header>
      <CarryforwardShell canUse={can(session, CARRYFORWARD_CAPABILITY)} runs={[]} results={[]} />
    </main>
  );
}
