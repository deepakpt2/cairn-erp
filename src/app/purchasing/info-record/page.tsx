import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import {
  INFO_RECORD_CAPABILITY,
  INFO_RECORD_ROUTE,
  findPurchasingInfoRecord,
  getPurchasingInfoRecord,
  infoRecordChoices,
} from '@/modules/purchasing/info-record';
import InfoRecordWorkbench from './InfoRecord';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Purchasing info record — SCR-151.
 *
 * One screen creates the record and changes it. The search aliases stay in the catalogue.
 * A named organisation, and a plant when one is named, select the standing segment.
 * A missing segment is named, not created. Check writes nothing.
 */
export default async function PurchasingInfoRecordPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(INFO_RECORD_ROUTE);
  const params = await searchParams;
  const requestedNumber = last(params.record).toUpperCase();
  const supplier = last(params.supplier).toUpperCase();
  const materialNumber = last(params.material).toUpperCase();
  const requestedOrg = last(params.org).toUpperCase();
  const requestedPlant = last(params.plant).toUpperCase();
  const found = !requestedNumber && supplier && materialNumber
    ? await findPurchasingInfoRecord(session.user.client, supplier, materialNumber)
    : null;
  const number = requestedNumber || found || '';
  const record = number ? await getPurchasingInfoRecord(session.user.client, number) : null;
  const choices = await infoRecordChoices(session.user.client);
  const canMaintain = can(session, INFO_RECORD_CAPABILITY);
  const changeLock = record && canMaintain
    ? await openChangeForSession(session, {
        lockObject: 'INFO_RECORD',
        argument: record.infoRecordNumber,
        transactionCode: 'PROC.INFO.RECORD.MAINTAIN',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('infoRecord.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('infoRecord.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/purchasing/source-list" className="btn btn-default min-h-11 sm:min-h-8">{t('sourceList.title')}</Link>
            <Link href="/purchasing/orders" className="btn btn-default min-h-11 sm:min-h-8">{t('infoRecord.toOrders')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('infoRecord.subtitle')}</p>
      </header>

      {changeLock?.mode === 'CHANGE' && record && (
        <ChangeLock lockObject="INFO_RECORD" argument={record.infoRecordNumber} />
      )}
      <LockNotice message={changeLock ? displayOnlyMessage(changeLock) : null} />
      <InfoRecordWorkbench
        key={`${requestedNumber}|${supplier}|${materialNumber}|${requestedOrg}|${requestedPlant}`}
        record={record}
        requestedNumber={requestedNumber}
        requestedSupplier={supplier}
        requestedMaterial={materialNumber}
        requestedOrg={requestedOrg}
        requestedPlant={requestedPlant}
        namedExisting={found}
        choices={choices}
        canMaintain={canMaintain && changeLock?.mode !== 'DISPLAY'}
      />
    </div>
  );
}
