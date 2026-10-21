import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  RFQ_CAPABILITY,
  RFQ_ROUTE,
  getRequestForQuotation,
  listRecentRequestsForQuotation,
} from '@/modules/purchasing/rfq';
import RequestForQuotation from './RequestForQuotation';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Request for quotation — SCR-155.
 *
 * One screen creates the event and one request per supplier. The search alias
 * stays in the catalogue. Check writes nothing. A change is not this screen.
 */
export default async function PurchasingRfqPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(RFQ_ROUTE);
  const params = await searchParams;
  const requestedEvent = last(params.event).toUpperCase();
  const opened = requestedEvent
    ? await getRequestForQuotation(session.user.client, requestedEvent)
    : null;
  const recent = await listRecentRequestsForQuotation(session.user.client);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('requestForQuotation.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('requestForQuotation.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/purchasing/quota-arrangement" className="btn btn-default min-h-11 sm:min-h-8">{t('requestForQuotation.toQuota')}</Link>
            <Link href="/purchasing/source-list" className="btn btn-default min-h-11 sm:min-h-8">{t('requestForQuotation.toSourceList')}</Link>
            <Link href="/purchasing/orders" className="btn btn-default min-h-11 sm:min-h-8">{t('requestForQuotation.toOrders')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('requestForQuotation.subtitle')}</p>
      </header>

      <RequestForQuotation
        key={requestedEvent}
        opened={opened}
        requestedEvent={requestedEvent}
        recent={recent}
        canMaintain={can(session, RFQ_CAPABILITY)}
      />
    </div>
  );
}
