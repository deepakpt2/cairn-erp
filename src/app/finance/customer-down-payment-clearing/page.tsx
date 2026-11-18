
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY,
  CustomerDownPaymentClearingError,
  getCustomerDownPaymentClearing,
  type CustomerDownPaymentClearingView,
} from '@/modules/finance/customer-down-payment-clearing';
import CustomerDownPaymentClearing from './CustomerDownPaymentClearing';
import { Page } from '@/ui/kit';

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
    <Page
      title={t('customerDownPaymentClearing.title')} code="FIN.AR.DOWNPAYMENT.CLEAR · F-39" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('customerDownPaymentClearing.subtitle')}
    >

      <CustomerDownPaymentClearing
        view={view}
        loadError={loadError}
        canEnter={can(session, CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
