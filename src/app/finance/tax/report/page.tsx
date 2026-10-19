import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { TAX_REPORT_CAPABILITY, type TaxReportResult } from '@/modules/finance/tax-report';
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
    testRun: params.testRun !== 'off',
    doNotUpdateDocuments: params.doNotUpdate === 'on',
    electronicReturn: params.electronic === 'on',
    correctedReturn: params.corrected === 'on',
    clearingAccount: get('clearingAccount'),
  };
  const result: TaxReportResult | null = null;

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
      <TaxReportForm
        canReport={can(session, TAX_REPORT_CAPABILITY)}
        defaults={defaults}
        result={result}
      />
    </div>
  );
}
