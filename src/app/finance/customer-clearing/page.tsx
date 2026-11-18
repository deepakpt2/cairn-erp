
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CUSTOMER_CLEARING_CAPABILITY, CustomerClearingError, getCustomerClearing,
  type CustomerClearingView,
} from '@/modules/finance/customer-clearing';
import CustomerClearing from './CustomerClearing';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-clearing';

/**
 * Customer open-item clearing (SCR-073 / F-32 as a search alias only).
 */
export default async function CustomerClearingPage({ searchParams }: {
  searchParams: Promise<{ customer?: string; companyCode?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  let view: CustomerClearingView | null = null;
  let loadError: string | null = null;
  if (params.customer && params.companyCode) {
    try {
      view = await getCustomerClearing(client, params.customer.toUpperCase(), params.companyCode);
    } catch (error) {
      if (error instanceof CustomerClearingError) loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      else throw error;
    }
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('customerClearing.title')} code="FIN.AR.CLEAR · F-32" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('customerClearing.subtitle')}
    >

      <CustomerClearing
        view={view}
        loadError={loadError}
        canClear={can(session, CUSTOMER_CLEARING_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
