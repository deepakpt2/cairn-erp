import { currencyDecimalsFor } from '@/platform/posting/money';
import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import { listCompanyCodes } from '@/modules/foundation/services';
import { hasCompanyCodeAssignments } from '@/modules/foundation/company-code-assignments';
import { TrialBalanceError, listStatementVersions } from '@/modules/finance/trial-balance';
import { calculateBalanceSheet, type BalanceSheetResult } from '@/modules/finance/balance-sheet';
import {
  BALANCE_SHEET_CAPABILITY, BALANCE_CALCULATION_TYPES, DEFAULT_BALANCE_CALCULATION_TYPE,
  DEFAULT_SUMMARY_LEVEL, type BalanceSheetSelection,
} from '@/modules/finance/balance-sheet';
import BalanceSheetShell from './BalanceSheetShell';
import { ReportExport } from '@/ui/output/ReportExport';
import { Page } from '@/ui/kit';

export const metadata: Metadata = { title: 'Balance Sheet / P&L Statement' };

export default async function ScreenPage({ searchParams }: {
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

  let result: BalanceSheetResult | null = null;
  let error: string | null = null;
  if (canUse && params.companyCode) {
    try {
      result = await calculateBalanceSheet({ client: session.user.client, selection });
    } catch (caught) {
      error = caught instanceof TrialBalanceError ? caught.message : 'The statement could not be calculated.';
    }
  }

  return (
    <Page
      title={t('bs.title')} code={t('finance.label')} back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('bs.intro')}</p>
          <Link href="/finance/trial-balance" className="mt-1 inline-block text-sm text-accent hover:underline">
              {t('bs.openTrialBalance')}
            </Link>
          {error && <p className="mt-2 text-sm font-semibold text-signal-error">{error}</p>}
          {result && <div className="mt-3"><ReportExport report="balance-sheet" params={params} /></div>}
        </>
      }
    >
      <BalanceSheetShell decimals={await currencyDecimalsFor(session.user.client)} canUse={canUse} companies={companies} versions={versions} selection={selection} result={result} />
    </Page>
  );
}
