import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import {
  CREDIT_MONITOR_CAPABILITY, CreditError, listCreditMonitor,
  type CreditMonitorFilter, type CreditMonitorResult,
} from '@/modules/finance/credit';
import CreditMonitorShell from './CreditMonitorShell';
import { Page } from '@/ui/kit';

export const metadata: Metadata = { title: 'Credit Exposure Monitor' };

export default async function ScreenPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession('/finance/credit-monitor');
  const params = await searchParams;
  const canUse = can(session, CREDIT_MONITOR_CAPABILITY);
  const filter: CreditMonitorFilter = {
    areaFrom: params.areaFrom?.toUpperCase() || undefined,
    areaTo: params.areaTo?.toUpperCase() || undefined,
    companyCode: params.companyCode || undefined,
    customerFrom: params.customerFrom || undefined,
    customerTo: params.customerTo || undefined,
    riskCategory: params.riskCategory?.toUpperCase() || undefined,
    representativeGroup: params.representativeGroup?.toUpperCase() || undefined,
    limitExceededOnly: params.limitExceededOnly === 'true',
    blockedOnly: params.blockedOnly === 'true',
    reportingCurrency: params.reportingCurrency?.toUpperCase() || undefined,
    rateType: params.rateType?.toUpperCase() || undefined,
  };
  let result: CreditMonitorResult | null = null;
  let error: string | null = null;
  if (canUse && Object.keys(params).length > 0) {
    try {
      result = await listCreditMonitor(session.user.client, filter);
    } catch (caught) {
      error = caught instanceof CreditError ? caught.message : 'The overview could not be calculated.';
    }
  }
  return (
    <Page
      title={t('monitor.title')} code={t('finance.label')} back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('monitor.intro')}</p>
          <Link href="/finance/credit" className="mt-1 inline-block text-sm text-accent hover:underline">
              {t('monitor.openCredit')}
            </Link>
          {' · '}
          <Link href="/finance/credit-release" className="mt-1 inline-block text-sm text-accent hover:underline">
              {t('monitor.openRelease')}
            </Link>
        </>
      }
    >
      <CreditMonitorShell canUse={canUse} result={result} error={error} filter={filter} />
    </Page>
  );
}
