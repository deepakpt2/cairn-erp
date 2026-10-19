import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY,
  CustomerDownPaymentClearingError,
  getCustomerDownPaymentClearing,
  type CustomerDownPaymentClearingView,
} from '@/modules/finance/customer-down-payment-clearing';
import CustomerDownPaymentClearing from './CustomerDownPaymentClearing';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-down-payment-clearing';

/**
 * Customer down payment clearing (SCR-084 / F-39 as a search alias only).
 */
export default async function CustomerDownPaymentClearingPage({ searchParams }: {
  searchParams: Promise<{ customer?: string; companyCode?: string; indicator?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  let view: CustomerDownPaymentClearingView | null = null;
  let loadError: string | null = null;
  if (params.customer && params.companyCode && params.indicator) {
    try {
      view = await getCustomerDownPaymentClearing(
        client, params.customer.toUpperCase(), params.companyCode, params.indicator.toUpperCase(),
      );
    } catch (error) {
      if (error instanceof CustomerDownPaymentClearingError) {
        loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      } else throw error;
    }
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AR.DOWNPAYMENT.CLEAR · F-39</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('customerDownPaymentClearing.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('customerDownPaymentClearing.subtitle')}</p>
      </header>

      <CustomerDownPaymentClearing
        view={view}
        loadError={loadError}
        canEnter={can(session, CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
