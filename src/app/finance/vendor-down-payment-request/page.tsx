import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VENDOR_DOWN_PAYMENT_REQUEST_CAPABILITY,
  getVendorDownPaymentRequests,
} from '@/modules/finance/vendor-down-payment-request';
import VendorDownPaymentRequest from './VendorDownPaymentRequest';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-down-payment-request';

/**
 * Vendor down payment request (SCR-086 / F-47 as a search alias only).
 */
export default async function VendorDownPaymentRequestPage() {
  const session = await requireSession(ROUTE);
  const requests = (await getVendorDownPaymentRequests(session.user.client))
    .filter((r) => r.status === 'OPEN' || r.status === 'PARTIAL');
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.DOWNPAYMENT.REQUEST · F-47</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('vendorDownPaymentRequest.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('vendorDownPaymentRequest.subtitle')}</p>
      </header>

      <VendorDownPaymentRequest
        requests={requests}
        canEnter={can(session, VENDOR_DOWN_PAYMENT_REQUEST_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
