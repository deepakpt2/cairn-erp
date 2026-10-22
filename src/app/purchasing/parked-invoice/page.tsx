import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import { listInvoiceTaxCodes } from '@/modules/purchasing/invoice-verification';
import {
  PARKED_INVOICE_CAPABILITY,
  PARKED_INVOICE_ROUTE,
  getParkedInvoice,
  listRecentParkedInvoices,
  openOrderForPark,
} from '@/modules/purchasing/parked-invoice';
import ParkedInvoice from './ParkedInvoice';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Park supplier invoice — SCR-160.
 *
 * One screen parks an invoice against one purchase order. A check writes
 * nothing, including the number. The search alias stays in the catalogue.
 * This screen does not post.
 */
export default async function ParkedInvoicePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PARKED_INVOICE_ROUTE);
  const params = await searchParams;
  const requestedOrder = last(params.order).toUpperCase();
  const requestedPark = last(params.parked).toUpperCase();
  const standing = requestedPark ? await getParkedInvoice(session.user.client, requestedPark) : null;
  const orderNumber = standing?.orderNumber ?? requestedOrder;
  const opened = orderNumber ? await openOrderForPark(session.user.client, orderNumber) : null;
  const taxCodes = opened ? await listInvoiceTaxCodes(session.user.client, opened.companyCode) : [];
  const recent = await listRecentParkedInvoices(session.user.client);
  const today = new Date().toISOString().slice(0, 10);
  const canPark = can(session, PARKED_INVOICE_CAPABILITY);
  const changeLock = standing && canPark
    ? await openChangeForSession(session, {
        lockObject: 'PARKED_INVOICE',
        argument: standing.parkedNumber,
        transactionCode: 'PROC.INV.PARK',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('parkedInvoice.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('parkedInvoice.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/purchasing/invoice-verification" className="btn btn-default min-h-11 sm:min-h-8">{t('parkedInvoice.toPost')}</Link>
            <Link href="/purchasing/invoice-overview" className="btn btn-default min-h-11 sm:min-h-8">{t('invoiceOverview.title')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('parkedInvoice.subtitle')}</p>
      </header>

      {changeLock?.mode === 'CHANGE' && standing && (
        <ChangeLock lockObject="PARKED_INVOICE" argument={standing.parkedNumber} />
      )}
      <LockNotice message={changeLock ? displayOnlyMessage(changeLock) : null} />
      <ParkedInvoice
        key={`${orderNumber}:${requestedPark}`}
        opened={opened}
        standing={standing}
        requestedOrder={requestedOrder}
        requestedPark={requestedPark}
        recent={recent}
        taxCodes={taxCodes}
        today={today}
        canPark={canPark && changeLock?.mode !== 'DISPLAY'}
      />
    </div>
  );
}
