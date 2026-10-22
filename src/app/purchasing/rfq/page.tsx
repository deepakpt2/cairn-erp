import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import {
  RFQ_CAPABILITY,
  RFQ_ROUTE,
  getRequestForQuotation,
  listRecentRequestsForQuotation,
  resolveRequestForQuotation,
} from '@/modules/purchasing/rfq';
import RequestForQuotation from './RequestForQuotation';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Request for quotation — SCR-155, and its change — SCR-156.
 *
 * One screen creates the event and changes a standing request. An event number
 * opens the event. A request number opens its event and selects that request.
 * Neither creates a document. Check writes nothing. The search aliases stay in
 * the catalogue.
 */
export default async function PurchasingRfqPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(RFQ_ROUTE);
  const params = await searchParams;
  const typed = last(params.event).toUpperCase();
  const requestedRequest = last(params.request).toUpperCase();
  const resolved = typed ? await resolveRequestForQuotation(session.user.client, typed) : null;
  const requestedEvent = resolved?.eventNumber ?? (typed && !resolved ? typed : '');
  const opened = resolved
    ? await getRequestForQuotation(session.user.client, resolved.eventNumber)
    : null;
  const selectedRequest = requestedRequest || resolved?.rfqNumber || '';
  const recent = await listRecentRequestsForQuotation(session.user.client);
  const canMaintain = can(session, RFQ_CAPABILITY);
  const changeLock = opened && canMaintain
    ? await openChangeForSession(session, {
        lockObject: 'RFQ_EVENT',
        argument: opened.eventNumber,
        transactionCode: 'ME42',
      })
    : null;

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
            <Link href="/purchasing/quotation" className="btn btn-default min-h-11 sm:min-h-8">{t('quotation.title')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('requestForQuotation.subtitle')}</p>
      </header>

      {/* The loaded time is not part of this key. A header save changes it, and
          remounting here would discard the result the user is waiting to read.
          The change form refreshes its own fields from that time. */}
      {changeLock?.mode === 'CHANGE' && opened && (
        <ChangeLock lockObject="RFQ_EVENT" argument={opened.eventNumber} />
      )}
      <RequestForQuotation
        key={`${requestedEvent}:${selectedRequest}`}
        opened={opened}
        requestedEvent={typed && !opened ? typed : requestedEvent}
        selectedRequest={selectedRequest}
        recent={recent}
        canMaintain={canMaintain && changeLock?.mode !== 'DISPLAY'}
        lockMessage={changeLock ? displayOnlyMessage(changeLock) : null}
      />
    </div>
  );
}
