import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import {
  QUOTA_CAPABILITY,
  QUOTA_ROUTE,
  getQuotaArrangement,
  listQuotaArrangements,
  listRecentQuotaArrangements,
} from '@/modules/purchasing/quota-arrangement';
import QuotaWorkbench from './QuotaArrangement';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Purchasing quota arrangement — SCR-154.
 *
 * One screen creates an arrangement and changes it. The search alias stays in
 * the catalogue. Material, plant, supplier and purchasing organisation are not
 * retargeted. Check writes nothing.
 */
export default async function PurchasingQuotaPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(QUOTA_ROUTE);
  const params = await searchParams;
  const requestedQuota = last(params.quota).toUpperCase();
  const requestedMaterial = last(params.material).toUpperCase();
  const requestedPlant = last(params.plant).toUpperCase();
  const opened = requestedQuota
    ? await getQuotaArrangement(session.user.client, requestedQuota)
    : null;
  const materialNumber = opened?.materialNumber ?? requestedMaterial;
  const plantCode = opened?.plant ?? requestedPlant;
  const arrangements = materialNumber && plantCode
    ? await listQuotaArrangements(session.user.client, materialNumber, plantCode)
    : [];
  const recent = await listRecentQuotaArrangements(session.user.client);
  const canMaintain = can(session, QUOTA_CAPABILITY);
  const changeLock = opened && canMaintain
    ? await openChangeForSession(session, {
        lockObject: 'QUOTA_ARRANGEMENT',
        argument: opened.quotaNumber,
        transactionCode: 'PROC.QUOTA.MAINTAIN',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('quotaArrangement.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('quotaArrangement.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/purchasing/rfq" className="btn btn-default min-h-11 sm:min-h-8">{t('requestForQuotation.title')}</Link>
            <Link href="/purchasing/source-list" className="btn btn-default min-h-11 sm:min-h-8">{t('quotaArrangement.toSourceList')}</Link>
            <Link href="/purchasing/orders" className="btn btn-default min-h-11 sm:min-h-8">{t('quotaArrangement.toOrders')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('quotaArrangement.subtitle')}</p>
      </header>

      {changeLock?.mode === 'CHANGE' && opened && (
        <ChangeLock lockObject="QUOTA_ARRANGEMENT" argument={opened.quotaNumber} />
      )}
      <LockNotice message={changeLock ? displayOnlyMessage(changeLock) : null} />
      <QuotaWorkbench
        key={`${requestedQuota}|${requestedMaterial}|${requestedPlant}`}
        opened={opened}
        arrangements={arrangements}
        requestedQuota={requestedQuota}
        requestedMaterial={requestedMaterial}
        requestedPlant={requestedPlant}
        recent={recent}
        canMaintain={canMaintain && changeLock?.mode !== 'DISPLAY'}
      />
    </div>
  );
}
