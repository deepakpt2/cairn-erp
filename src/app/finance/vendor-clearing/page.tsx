import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VENDOR_CLEARING_CAPABILITY, VendorClearingError, getVendorClearing,
  type VendorClearingView,
} from '@/modules/finance/vendor-clearing';
import VendorClearing from './VendorClearing';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.CLEAR · F-44</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('vendorClearing.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('vendorClearing.subtitle')}</p>
      </header>

      <VendorClearing
        view={view}
        loadError={loadError}
        canClear={can(session, VENDOR_CLEARING_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
