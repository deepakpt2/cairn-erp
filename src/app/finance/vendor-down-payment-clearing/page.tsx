import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY,
  type DownPaymentClearingView,
} from '@/modules/finance/vendor-down-payment-clearing';
import VendorDownPaymentClearing from './VendorDownPaymentClearing';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-down-payment-clearing';

/**
 * Vendor down payment clearing (SCR-082 / F-54 as a search alias only).
 */
export default async function VendorDownPaymentClearingPage({ searchParams }: {
  searchParams: Promise<{ vendor?: string; companyCode?: string; indicator?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  // The view service lands in stage 3; until then nothing loads.
  void params;
  const view: DownPaymentClearingView | null = null;
  const loadError: string | null = null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.DOWNPAYMENT.CLEAR · F-54</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('vendorDownPaymentClearing.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('vendorDownPaymentClearing.subtitle')}</p>
      </header>

      <VendorDownPaymentClearing
        view={view}
        loadError={loadError}
        canEnter={can(session, VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
