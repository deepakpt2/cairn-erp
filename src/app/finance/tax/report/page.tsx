import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  TAX_REPORT_CAPABILITY, TaxReportError, executeTaxReport, type TaxReportResult,
} from '@/modules/finance/tax-report';
import TaxReportForm from './TaxReportForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/tax/report';

/**
 * Advance return for tax on sales/purchases (SCR-097 /
 * S_ALR_87012357 as a search alias only).
 */
export default async function TaxReportPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const get = (name: string) => params[name]?.trim() ?? '';
  const defaults = {
    companyCode: get('companyCode'),
    taxGroup: get('taxGroup'),
    postingDateFrom: get('postingDateFrom'),
    postingDateTo: get('postingDateTo'),
    taxReturnCountry: get('taxReturnCountry'),
    testRun: params.run === '1' ? params.testRun === 'on' : true,
    doNotUpdateDocuments: params.doNotUpdate === 'on',
    electronicReturn: params.electronic === 'on',
    correctedReturn: params.corrected === 'on',
    clearingAccount: get('clearingAccount'),
  };
  let result: TaxReportResult | null = null;
  let error: string | null = null;
  if (can(session, TAX_REPORT_CAPABILITY) && params.run === '1' && defaults.companyCode && defaults.postingDateFrom && defaults.postingDateTo && defaults.taxReturnCountry) {
    try {
      result = await executeTaxReport({
        client: session.user.client, changedBy: session.user.username,
        selection: {
          companyCode: defaults.companyCode,
          taxGroup: defaults.taxGroup || undefined,
          postingDateFrom: defaults.postingDateFrom,
          postingDateTo: defaults.postingDateTo,
          taxReturnCountry: defaults.taxReturnCountry,
          testRun: defaults.testRun,
          doNotUpdateDocuments: defaults.doNotUpdateDocuments,
          electronicReturn: defaults.electronicReturn,
          correctedReturn: defaults.correctedReturn,
          clearingAccount: defaults.clearingAccount || undefined,
        },
      });
    } catch (e) {
      if (e instanceof TaxReportError) error = e.message;
      else throw e;
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.TAX.REPORT · S_ALR_87012357</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('taxReport.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('taxReport.subtitle')}</p>
      </header>
      {error && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
      )}
      <TaxReportForm
        canReport={can(session, TAX_REPORT_CAPABILITY)}
        defaults={defaults}
        result={result}
      />
    </div>
  );
}
