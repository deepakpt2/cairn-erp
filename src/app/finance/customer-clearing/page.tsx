import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CUSTOMER_CLEARING_CAPABILITY, CustomerClearingError, getCustomerClearing,
  type CustomerClearingView,
} from '@/modules/finance/customer-clearing';
import CustomerClearing from './CustomerClearing';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AR.CLEAR · F-32</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('customerClearing.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('customerClearing.subtitle')}</p>
      </header>

      <CustomerClearing
        view={view}
        loadError={loadError}
        canClear={can(session, CUSTOMER_CLEARING_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
