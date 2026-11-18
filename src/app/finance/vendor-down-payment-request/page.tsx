
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VENDOR_DOWN_PAYMENT_REQUEST_CAPABILITY,
  getVendorDownPaymentRequests,
} from '@/modules/finance/vendor-down-payment-request';
import VendorDownPaymentRequest from './VendorDownPaymentRequest';
import { Page } from '@/ui/kit';

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
    <Page
      title={t('vendorDownPaymentRequest.title')} code="FIN.AP.DOWNPAYMENT.REQUEST · F-47" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('vendorDownPaymentRequest.subtitle')}
    >

      <VendorDownPaymentRequest
        requests={requests}
        canEnter={can(session, VENDOR_DOWN_PAYMENT_REQUEST_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
