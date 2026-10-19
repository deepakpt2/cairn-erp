import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import { listCompanyCodes } from '@/modules/foundation/services';
import { hasCompanyCodeAssignments } from '@/modules/foundation/company-code-assignments';
import {
  TRIAL_BALANCE_CAPABILITY, TrialBalanceError, calculateTrialBalance,
  listStatementVersions, type TrialBalanceResult, type TrialBalanceSelection,
} from '@/modules/finance/trial-balance';
import TrialBalanceShell from './TrialBalanceShell';

export const metadata: Metadata = { title: 'Trial Balance / F.01' };

export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession('/finance/trial-balance');
  const params = await searchParams;
  const canUse = can(session, TRIAL_BALANCE_CAPABILITY);
  const companies = (await listCompanyCodes(session.user.client))
    .filter((c) => c.isActive && hasCompanyCodeAssignments(c))
    .map((c) => ({ companyCode: c.companyCode, name: c.name }));
  const versions = canUse ? await listStatementVersions(session.user.client) : [];

  const selection: TrialBalanceSelection = {
    companyCode: params.companyCode ?? companies[0]?.companyCode ?? '',
    statementVersion: params.statementVersion ?? versions[0]?.version ?? '',
    fiscalYear: Number(params.fiscalYear ?? new Date().getFullYear()),
    periodFrom: Number(params.periodFrom ?? 1),
    periodTo: Number(params.periodTo ?? 12),
    includeSpecialPeriods: params.includeSpecialPeriods === 'true',
    comparisonFiscalYear: params.comparisonFiscalYear ? Number(params.comparisonFiscalYear) : undefined,
    outputCurrency: params.outputCurrency?.toUpperCase() || undefined,
    ledger: '0L',
  };
  let result: TrialBalanceResult | null = null;
  let error: string | null = null;
  if (canUse && params.companyCode) {
    try {
      result = await calculateTrialBalance({ client: session.user.client, selection });
    } catch (caught) {
      error = caught instanceof TrialBalanceError ? caught.message : 'The statement could not be calculated.';
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('finance.label')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{t('trial.title')}</h1>
        <p className="text-sm text-ink-soft">{t('trial.intro')}</p>
        <Link href="/finance/journal/balances" className="mt-1 inline-block text-sm text-accent hover:underline">
          {t('trial.openBalances')}
        </Link>
        {error && <p className="mt-2 text-sm font-semibold text-signal-error">{error}</p>}
      </header>
      <TrialBalanceShell canUse={canUse} companies={companies} versions={versions} selection={selection} result={result} />
    </main>
  );
}
