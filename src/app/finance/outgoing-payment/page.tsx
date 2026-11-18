
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  OUTGOING_PAYMENT_CAPABILITY, OutgoingPaymentError, getPayables,
  type OutgoingPaymentView,
} from '@/modules/finance/outgoing-payment';
import OutgoingPayment from './OutgoingPayment';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/outgoing-payment';

/**
 * Outgoing payment entry and allocation (SCR-078 / F-53 as a search alias only).
 */
export default async function OutgoingPaymentPage({ searchParams }: {
  searchParams: Promise<{ vendor?: string; companyCode?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  let view: OutgoingPaymentView | null = null;
  let loadError: string | null = null;
  if (params.vendor && params.companyCode) {
    try {
      view = await getPayables(client, params.vendor.toUpperCase(), params.companyCode);
    } catch (error) {
      if (error instanceof OutgoingPaymentError) loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      else throw error;
    }
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('outgoingPayment.title')} code="FIN.AP.PAYMENT.POST · F-53" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('outgoingPayment.subtitle')}
    >

      <OutgoingPayment
        view={view}
        loadError={loadError}
        canEnter={can(session, OUTGOING_PAYMENT_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
