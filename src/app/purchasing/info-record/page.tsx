
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
import { displayOnlyRemedy } from '@/ui/lock/remedy';
import { LinkButton, Page } from '@/ui/kit';

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
    ? await findPurchasingInfoRecord(session.user.client, supplier, materialNumber, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => null)
    : null;
  const number = requestedNumber || found || '';
  const record = number ? await getPurchasingInfoRecord(session.user.client, number, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => null) : null;
  const choices = await infoRecordChoices(session.user.client, { userId: session.user.userId, sessionId: session.sessionId ?? '' });
  const canMaintain = can(session, INFO_RECORD_CAPABILITY);
  const changeLock = record && canMaintain
    ? await openChangeForSession(session, {
        lockObject: 'INFO_RECORD',
        argument: record.infoRecordNumber,
        transactionCode: 'PROC.INFO.RECORD.MAINTAIN',
      })
    : null;

  return (
    <Page
      title={t('infoRecord.title')} code={t('infoRecord.code')} back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('infoRecord.subtitle')}</p>
        </>
      }
      actions={
        <>
          <LinkButton href="/purchasing/source-list">{t('sourceList.title')}</LinkButton>
          <LinkButton href="/purchasing/orders">{t('infoRecord.toOrders')}</LinkButton>
          <LinkButton href="/">{t('nav.launchpad')}</LinkButton>
        </>
      }
    >

      {changeLock?.mode === 'CHANGE' && record && (
        <ChangeLock lockObject="INFO_RECORD" argument={record.infoRecordNumber} />
      )}
      <LockNotice message={changeLock ? displayOnlyMessage(changeLock) : null} remedy={displayOnlyRemedy(changeLock)} />
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
    </Page>
  );
}
