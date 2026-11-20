
import { currencyDecimalsFor } from '@/platform/posting/money';
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  GL_BALANCE_CAPABILITY, GlBalanceError, getGlBalanceReport, getGlBalances,
  type GlBalanceView,
} from '@/modules/finance/gl-balances';
import BalancesForm from './BalancesForm';
import BalanceReportForm from './BalanceReportForm';
import type { GlBalanceReportSelection, GlBalanceReportView } from '@/modules/finance/gl-balances';
import { ReportExport } from '@/ui/output/ReportExport';
import { Page } from '@/ui/kit';

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
    outputCurrency: params.outputCurrency?.toUpperCase() || undefined,
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
    <Page
      title={t('glBalance.title')} code="FIN.GL.BALANCE · FS10N" back={{ href: '/', label: t('nav.launchpad') }}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('glBalance.subtitle')}</p>
          {report && <div className="mt-3"><ReportExport report="gl-balances" params={params} /></div>}
        </>
      }
    >

      <BalancesForm decimals={await currencyDecimalsFor(session.user.client)} view={view} error={error} canDisplay={canDisplay} />
      <BalanceReportForm decimals={await currencyDecimalsFor(session.user.client)}
        selection={reportSelection}
        report={report}
        reportError={reportError}
        canDisplay={canDisplay}
      />
    </Page>
  );
}
