
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { CUSTOMER_DOWN_PAYMENT_CAPABILITY } from '@/modules/finance/customer-down-payment';
import CustomerDownPayment from './CustomerDownPayment';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-down-payment';

/**
 * Customer down payment entry (SCR-083 / F-29 as a search alias only).
 */
export default async function CustomerDownPaymentPage() {
  const session = await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('customerDownPayment.title')} code="FIN.AR.DOWNPAYMENT.POST · F-29" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('customerDownPayment.subtitle')}
    >

      <CustomerDownPayment
        canEnter={can(session, CUSTOMER_DOWN_PAYMENT_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
