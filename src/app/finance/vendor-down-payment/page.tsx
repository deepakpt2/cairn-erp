
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { VENDOR_DOWN_PAYMENT_CAPABILITY } from '@/modules/finance/vendor-down-payment';
import VendorDownPayment from './VendorDownPayment';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-down-payment';

/**
 * Vendor down payment entry (SCR-081 / F-48 as a search alias only).
 */
export default async function VendorDownPaymentPage() {
  const session = await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('vendorDownPayment.title')} code="FIN.AP.DOWNPAYMENT.POST · F-48" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('vendorDownPayment.subtitle')}
    >

      <VendorDownPayment
        canEnter={can(session, VENDOR_DOWN_PAYMENT_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
