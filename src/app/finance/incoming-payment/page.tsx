import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  INCOMING_PAYMENT_CAPABILITY, IncomingPaymentError, getReceivables,
  type IncomingPaymentView,
} from '@/modules/finance/incoming-payment';
import IncomingPayment from './IncomingPayment';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AR.PAYMENT.ENTER · F-28</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('incomingPayment.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('incomingPayment.subtitle')}</p>
      </header>

      <IncomingPayment
        view={view}
        loadError={loadError}
        canEnter={can(session, INCOMING_PAYMENT_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
