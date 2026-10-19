import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY } from '@/modules/finance/customer-down-payment-clearing';
import CustomerDownPaymentClearing from './CustomerDownPaymentClearing';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-down-payment-clearing';

/**
 * Customer down payment clearing (SCR-084 / F-39 as a search alias only).
 * Stage 1 shell: the open-item service lands in stage 3 of R-132.
 */
export default async function CustomerDownPaymentClearingPage() {
  const session = await requireSession(ROUTE);
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
        view={null}
        loadError={null}
        canEnter={can(session, CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
