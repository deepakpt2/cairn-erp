import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  SOURCE_LIST_CAPABILITY,
  SOURCE_LIST_ROUTE,
  getSourceList,
  getSourceListEntry,
  listRecentSourceEntries,
} from '@/modules/purchasing/source-list';
import SourceListWorkbench from './SourceList';

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

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('sourceList.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('sourceList.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/purchasing/info-record" className="btn btn-default min-h-11 sm:min-h-8">{t('sourceList.toInfoRecord')}</Link>
            <Link href="/purchasing/orders" className="btn btn-default min-h-11 sm:min-h-8">{t('sourceList.toOrders')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('sourceList.subtitle')}</p>
      </header>

      <SourceListWorkbench
        key={`${requestedSource}|${requestedMaterial}|${requestedPlant}|${requestedOrg}`}
        list={list}
        opened={opened}
        requestedSource={requestedSource}
        requestedMaterial={requestedMaterial}
        requestedPlant={requestedPlant}
        requestedOrg={requestedOrg}
        recent={recent}
        canMaintain={can(session, SOURCE_LIST_CAPABILITY)}
      />
    </div>
  );
}
