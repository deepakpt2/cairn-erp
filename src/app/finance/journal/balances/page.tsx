import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  GL_BALANCE_CAPABILITY, GlBalanceError, getGlBalanceReport, getGlBalances,
  type GlBalanceView,
} from '@/modules/finance/gl-balances';
import BalancesForm from './BalancesForm';
import BalanceReportForm from './BalanceReportForm';
import type { GlBalanceReportSelection, GlBalanceReportView } from '@/modules/finance/gl-balances';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/journal/balances';

/**
 * G/L account balances by period (SCR-089 / FS10N as a search
 * alias only).
 */
export default async function GlBalancesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const canDisplay = can(session, GL_BALANCE_CAPABILITY);
  let view: GlBalanceView | null = null;
  let error: string | null = null;
  if (params.account && canDisplay) {
    try {
      view = await getGlBalances(session.user.client, {
        glAccount: params.account,
        companyCode: params.companyCode ?? '',
        fiscalYear: Number(params.fiscalYear),
        currency: params.currency || undefined,
        includeSpecialPeriods: params.specialPeriods === '1',
      });
    } catch (caught) {
      error = caught instanceof GlBalanceError
        ? `${caught.message}${caught.remedy ? ` ${caught.remedy}` : ''}`
        : 'The balances could not be read.';
    }
  }

  const reportSelection: GlBalanceReportSelection = {
    companyCodes: (params.reportCompanies ?? '').split(',').map((c) => c.trim()).filter(Boolean),
    accountFrom: params.accountFrom ?? '',
    accountTo: params.accountTo ?? '',
    fiscalYear: Number(params.reportFiscalYear ?? new Date().getFullYear()),
    periodFrom: Number(params.periodFrom ?? 1),
    periodTo: Number(params.periodTo ?? 12),
    includeSpecialPeriods: params.reportSpecialPeriods === '1',
    ledger: '0L',
  };
  let report: GlBalanceReportView | null = null;
  let reportError: string | null = null;
  if (params.report && canDisplay) {
    try {
      report = await getGlBalanceReport(session.user.client, reportSelection);
    } catch (caught) {
      reportError = caught instanceof GlBalanceError
        ? `${caught.message}${caught.remedy ? ` ${caught.remedy}` : ''}`
        : 'The balance report could not be calculated.';
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.GL.BALANCE · FS10N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('glBalance.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('glBalance.subtitle')}</p>
      </header>

      <BalancesForm view={view} error={error} canDisplay={canDisplay} />
      <BalanceReportForm
        selection={reportSelection}
        report={report}
        reportError={reportError}
        canDisplay={canDisplay}
      />
    </div>
  );
}
