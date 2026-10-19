import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import { listCompanyCodes } from '@/modules/foundation/services';
import { hasCompanyCodeAssignments } from '@/modules/foundation/company-code-assignments';
import {
  CARRYFORWARD_CAPABILITY, listCarryforwardResults, listCarryforwardRuns,
} from '@/modules/finance/carryforward';
import CarryforwardShell from './CarryforwardShell';

export const metadata: Metadata = { title: 'Balance Carryforward' };

export default async function Page() {
  const session = await requireSession('/finance/carryforward');
  const canUse = can(session, CARRYFORWARD_CAPABILITY);
  const companies = (await listCompanyCodes(session.user.client))
    .filter((c) => c.isActive && hasCompanyCodeAssignments(c))
    .map((c) => ({ companyCode: c.companyCode, name: c.name }));
  const runs = canUse ? await listCarryforwardRuns(session.user.client) : [];
  const results = canUse && runs[0] ? await listCarryforwardResults(session.user.client, runs[0].runId) : [];
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('finance.label')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{t('carry.title')}</h1>
        <p className="text-sm text-ink-soft">{t('carry.intro')}</p>
        <Link href="/finance/close-cockpit" className="mt-1 inline-block text-sm text-accent hover:underline">
          {t('carry.openCockpit')}
        </Link>
      </header>
      <CarryforwardShell canUse={canUse} companies={companies} runs={runs} results={results} />
    </main>
  );
}
