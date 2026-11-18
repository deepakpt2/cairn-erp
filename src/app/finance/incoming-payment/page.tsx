
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  INCOMING_PAYMENT_CAPABILITY, IncomingPaymentError, getReceivables,
  type IncomingPaymentView,
} from '@/modules/finance/incoming-payment';
import IncomingPayment from './IncomingPayment';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/incoming-payment';

/**
 * Incoming payment entry and allocation (SCR-068 / F-28 as a search alias only).
 */
export default async function IncomingPaymentPage({ searchParams }: {
  searchParams: Promise<{ customer?: string; companyCode?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  let view: IncomingPaymentView | null = null;
  let loadError: string | null = null;
  if (params.customer && params.companyCode) {
    try {
      view = await getReceivables(client, params.customer.toUpperCase(), params.companyCode);
    } catch (error) {
      if (error instanceof IncomingPaymentError) loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      else throw error;
    }
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('incomingPayment.title')} code="FIN.AR.PAYMENT.ENTER · F-28" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('incomingPayment.subtitle')}
    >

      <IncomingPayment
        view={view}
        loadError={loadError}
        canEnter={can(session, INCOMING_PAYMENT_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
