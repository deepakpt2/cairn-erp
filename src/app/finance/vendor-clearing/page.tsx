
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VENDOR_CLEARING_CAPABILITY, VendorClearingError, getVendorClearing,
  type VendorClearingView,
} from '@/modules/finance/vendor-clearing';
import VendorClearing from './VendorClearing';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-clearing';

/**
 * Vendor open-item clearing (SCR-064 / F-44 as a search alias only).
 */
export default async function VendorClearingPage({ searchParams }: {
  searchParams: Promise<{ supplier?: string; companyCode?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  let view: VendorClearingView | null = null;
  let loadError: string | null = null;
  if (params.supplier && params.companyCode) {
    try {
      view = await getVendorClearing(client, params.supplier.toUpperCase(), params.companyCode);
    } catch (error) {
      if (error instanceof VendorClearingError) loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      else throw error;
    }
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('vendorClearing.title')} code="FIN.AP.CLEAR · F-44" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('vendorClearing.subtitle')}
    >

      <VendorClearing
        view={view}
        loadError={loadError}
        canClear={can(session, VENDOR_CLEARING_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
