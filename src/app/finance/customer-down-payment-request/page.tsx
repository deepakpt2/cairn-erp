
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CUSTOMER_DOWN_PAYMENT_REQUEST_CAPABILITY,
  getCustomerDownPaymentRequests,
} from '@/modules/finance/customer-down-payment-request';
import CustomerDownPaymentRequest from './CustomerDownPaymentRequest';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-down-payment-request';

/**
 * Customer down payment request (SCR-085 / F-37 as a search alias only).
 */
export default async function CustomerDownPaymentRequestPage() {
  const session = await requireSession(ROUTE);
  const requests = (await getCustomerDownPaymentRequests(session.user.client))
    .filter((r) => r.status === 'OPEN' || r.status === 'PARTIAL');
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('customerDownPaymentRequest.title')} code="FIN.AR.DOWNPAYMENT.REQUEST · F-37" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('customerDownPaymentRequest.subtitle')}
    >

      <CustomerDownPaymentRequest
        requests={requests}
        canEnter={can(session, CUSTOMER_DOWN_PAYMENT_REQUEST_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
