import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import { listCompanyCodes } from '@/modules/foundation/services';
import { hasCompanyCodeAssignments } from '@/modules/foundation/company-code-assignments';
import { listStatementVersions } from '@/modules/finance/trial-balance';
import {
  BALANCE_SHEET_CAPABILITY, BALANCE_CALCULATION_TYPES, DEFAULT_BALANCE_CALCULATION_TYPE,
  DEFAULT_SUMMARY_LEVEL, type BalanceSheetSelection,
} from '@/modules/finance/balance-sheet';
import BalanceSheetShell from './BalanceSheetShell';

export const metadata: Metadata = { title: 'Balance Sheet / P&L Statement' };

export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession('/finance/balance-sheet');
  const params = await searchParams;
  const canUse = can(session, BALANCE_SHEET_CAPABILITY);
  const companies = (await listCompanyCodes(session.user.client))
    .filter((c) => c.isActive && hasCompanyCodeAssignments(c))
    .map((c) => ({ companyCode: c.companyCode, name: c.name }));
  const versions = canUse ? await listStatementVersions(session.user.client) : [];

  const calculationType = BALANCE_CALCULATION_TYPES.includes(params.calculationType as typeof BALANCE_CALCULATION_TYPES[number])
    ? (params.calculationType as BalanceSheetSelection['calculationType'])
    : DEFAULT_BALANCE_CALCULATION_TYPE;
  const selection: BalanceSheetSelection = {
    companyCode: params.companyCode ?? companies[0]?.companyCode ?? '',
    statementVersion: params.statementVersion ?? versions[0]?.version ?? '',
    fiscalYear: Number(params.fiscalYear ?? new Date().getFullYear()),
    periodFrom: Number(params.periodFrom ?? 1),
    periodTo: Number(params.periodTo ?? 12),
    includeSpecialPeriods: params.includeSpecialPeriods === 'true',
    comparisonFiscalYear: params.comparisonFiscalYear ? Number(params.comparisonFiscalYear) : undefined,
    comparisonPeriodFrom: params.comparisonPeriodFrom ? Number(params.comparisonPeriodFrom) : undefined,
    comparisonPeriodTo: params.comparisonPeriodTo ? Number(params.comparisonPeriodTo) : undefined,
    outputCurrency: params.outputCurrency?.toUpperCase() || undefined,
    ledger: '0L',
    calculationType,
    summaryLevel: Number(params.summaryLevel ?? DEFAULT_SUMMARY_LEVEL),
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('finance.label')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{t('bs.title')}</h1>
        <p className="text-sm text-ink-soft">{t('bs.intro')}</p>
        <Link href="/finance/trial-balance" className="mt-1 inline-block text-sm text-accent hover:underline">
          {t('bs.openTrialBalance')}
        </Link>
      </header>
      <BalanceSheetShell canUse={canUse} companies={companies} versions={versions} selection={selection} result={null} />
    </main>
  );
}
