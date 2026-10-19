import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { CUSTOMER_DOWN_PAYMENT_REQUEST_CAPABILITY } from '@/modules/finance/customer-down-payment-request';
import CustomerDownPaymentRequest from './CustomerDownPaymentRequest';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-down-payment-request';

/**
 * Customer down payment request (SCR-085 / F-37 as a search alias only).
 * Stage 1 shell: the request service lands in stage 3 of R-133.
 */
export default async function CustomerDownPaymentRequestPage() {
  const session = await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AR.DOWNPAYMENT.REQUEST · F-37</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('customerDownPaymentRequest.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('customerDownPaymentRequest.subtitle')}</p>
      </header>

      <CustomerDownPaymentRequest
        requests={[]}
        canEnter={can(session, CUSTOMER_DOWN_PAYMENT_REQUEST_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
