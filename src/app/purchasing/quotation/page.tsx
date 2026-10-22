import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import {
  QUOTATION_CAPABILITY,
  QUOTATION_ROUTE,
  listRecentQuotationRequests,
  openQuotation,
} from '@/modules/purchasing/quotation';
import Quotation from './Quotation';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Quotation — SCR-157.
 *
 * One screen maintains a quotation against one standing request. A request
 * number opens the asked lines and the standing quotation, if one exists.
 * Neither the open nor a check creates a document. The search alias stays in
 * the catalogue. This screen does not compare.
 */
export default async function PurchasingQuotationPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(QUOTATION_ROUTE);
  const params = await searchParams;
  const requested = last(params.request).toUpperCase();
  const opened = requested ? await openQuotation(session.user.client, requested) : null;
  const recent = await listRecentQuotationRequests(session.user.client);
  const canMaintain = can(session, QUOTATION_CAPABILITY);
  const changeLock = opened && canMaintain
    ? await openChangeForSession(session, {
        lockObject: 'SUPPLIER_QUOTATION',
        argument: requested,
        transactionCode: 'PROC.RFQ.QUOTATION',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('quotation.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('quotation.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/purchasing/rfq" className="btn btn-default min-h-11 sm:min-h-8">{t('quotation.toRequest')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('quotation.subtitle')}</p>
      </header>

      {changeLock?.mode === 'CHANGE' && (
        <ChangeLock lockObject="SUPPLIER_QUOTATION" argument={requested} />
      )}
      <LockNotice message={changeLock ? displayOnlyMessage(changeLock) : null} />
      <Quotation
        key={requested}
        opened={opened}
        requested={requested}
        recent={recent}
        canMaintain={canMaintain && changeLock?.mode !== 'DISPLAY'}
      />
    </div>
  );
}
