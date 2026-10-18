import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  OUTGOING_PAYMENT_CAPABILITY, OutgoingPaymentError, getPayables,
  type OutgoingPaymentView,
} from '@/modules/finance/outgoing-payment';
import OutgoingPayment from './OutgoingPayment';

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
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.PAYMENT.POST · F-53</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('outgoingPayment.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('outgoingPayment.subtitle')}</p>
      </header>

      <OutgoingPayment
        view={view}
        loadError={loadError}
        canEnter={can(session, OUTGOING_PAYMENT_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
