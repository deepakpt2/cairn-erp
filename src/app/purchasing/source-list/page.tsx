
import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import {
  SOURCE_LIST_CAPABILITY,
  SOURCE_LIST_ROUTE,
  getSourceList,
  getSourceListEntry,
  listRecentSourceEntries,
} from '@/modules/purchasing/source-list';
import SourceListWorkbench from './SourceList';
import { displayOnlyRemedy } from '@/ui/lock/remedy';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * Purchasing source list — SCR-153.
 *
 * One screen creates an entry and changes it. The search alias stays in the catalogue.
 * Material, plant, supplier and purchasing organisation are not retargeted.
 * Check writes nothing.
 */
export default async function PurchasingSourceListPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(SOURCE_LIST_ROUTE);
  const params = await searchParams;
  const requestedSource = last(params.source).toUpperCase();
  const requestedMaterial = last(params.material).toUpperCase();
  const requestedPlant = last(params.plant).toUpperCase();
  const requestedOrg = last(params.org).toUpperCase();
  const opened = requestedSource
    ? await getSourceListEntry(session.user.client, requestedSource)
    : null;
  const materialNumber = opened?.materialNumber ?? requestedMaterial;
  const plantCode = opened?.plant ?? requestedPlant;
  const list = materialNumber && plantCode
    ? await getSourceList(session.user.client, materialNumber, plantCode)
    : null;
  const recent = await listRecentSourceEntries(session.user.client);
  const canMaintain = can(session, SOURCE_LIST_CAPABILITY);
  const changeLock = opened && canMaintain
    ? await openChangeForSession(session, {
        lockObject: 'SOURCE_LIST',
        argument: opened.sourceNumber,
        transactionCode: 'PROC.SOURCE.LIST.MAINTAIN',
      })
    : null;

  return (
    <Page
      title={t('sourceList.title')} code={t('sourceList.code')} back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('sourceList.subtitle')}</p>
        </>
      }
      actions={
        <>
          <LinkButton href="/purchasing/info-record">{t('sourceList.toInfoRecord')}</LinkButton>
          <LinkButton href="/purchasing/quota-arrangement">{t('sourceList.toQuota')}</LinkButton>
          <LinkButton href="/purchasing/orders">{t('sourceList.toOrders')}</LinkButton>
          <LinkButton href="/">{t('nav.launchpad')}</LinkButton>
        </>
      }
    >

      {changeLock?.mode === 'CHANGE' && opened && (
        <ChangeLock lockObject="SOURCE_LIST" argument={opened.sourceNumber} />
      )}
      <LockNotice message={changeLock ? displayOnlyMessage(changeLock) : null} remedy={displayOnlyRemedy(changeLock)} />
      <SourceListWorkbench
        key={`${requestedSource}|${requestedMaterial}|${requestedPlant}|${requestedOrg}`}
        list={list}
        opened={opened}
        requestedSource={requestedSource}
        requestedMaterial={requestedMaterial}
        requestedPlant={requestedPlant}
        requestedOrg={requestedOrg}
        recent={recent}
        canMaintain={canMaintain && changeLock?.mode !== 'DISPLAY'}
      />
    </Page>
  );
}
