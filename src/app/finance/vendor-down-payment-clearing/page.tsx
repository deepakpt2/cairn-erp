
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY,
  VendorDownPaymentClearingError,
  getDownPaymentClearing,
  type DownPaymentClearingView,
} from '@/modules/finance/vendor-down-payment-clearing';
import VendorDownPaymentClearing from './VendorDownPaymentClearing';
import { Page } from '@/ui/kit';

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
  const client = session.user.client;
  let view: DownPaymentClearingView | null = null;
  let loadError: string | null = null;
  if (params.vendor && params.companyCode && params.indicator) {
    try {
      view = await getDownPaymentClearing(
        client, params.vendor.toUpperCase(), params.companyCode, params.indicator.toUpperCase(),
      );
    } catch (error) {
      if (error instanceof VendorDownPaymentClearingError) {
        loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      } else throw error;
    }
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('vendorDownPaymentClearing.title')} code="FIN.AP.DOWNPAYMENT.CLEAR · F-54" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('vendorDownPaymentClearing.subtitle')}
    >

      <VendorDownPaymentClearing
        view={view}
        loadError={loadError}
        canEnter={can(session, VENDOR_DOWN_PAYMENT_CLEARING_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
