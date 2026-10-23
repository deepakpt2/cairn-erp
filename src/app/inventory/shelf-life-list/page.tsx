import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  SLED_LIST_ALIAS,
  SLED_LIST_CAPABILITY,
  SLED_LIST_ROUTE,
  ShelfLifeListError,
  businessDate,
  listShelfLife,
  type ShelfLifeResult,
  type ShelfLifeSelection,
} from '@/modules/inventory/shelf-life-list';
import ShelfLifeListShell from './ShelfLifeListShell';

export const dynamic = 'force-dynamic';

/**
 * INV.SLED.LIST (MB5M): shelf life list. Read-only. The key date is the
 * business date in Asia/Kuwait. It is not a user expiration-date range.
 */
export default async function ShelfLifeListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(SLED_LIST_ROUTE);
  const params = await searchParams;
  const get = (name: string) => (typeof params[name] === 'string' ? (params[name] as string) : '').trim();
  const remaining = get('remainingShelfLifeDays');
  const selection: ShelfLifeSelection = {
    materialFrom: get('materialFrom').toUpperCase(),
    materialTo: get('materialTo').toUpperCase(),
    plantFrom: get('plantFrom').toUpperCase(),
    plantTo: get('plantTo').toUpperCase(),
    storageLocationFrom: get('storageLocationFrom').toUpperCase(),
    storageLocationTo: get('storageLocationTo').toUpperCase(),
    batchFrom: get('batchFrom').toUpperCase(),
    batchTo: get('batchTo').toUpperCase(),
    remainingShelfLifeDays: remaining === '' ? null : Number(remaining),
    scope: (get('scope') || 'TOTAL').toUpperCase(),
    includeZeroStock: get('includeZeroStock') === '1',
    display: (get('display') || 'DAYS').toUpperCase(),
    layout: (get('layout') || 'ALV').toUpperCase(),
    layoutVariant: get('layoutVariant'),
    keyDate: businessDate('Asia/Kuwait'),
  };
  const canUse = can(session, SLED_LIST_CAPABILITY);
  let result: ShelfLifeResult | null = null;
  let reportError: string | null = null;
  if (canUse && get('run') === '1') {
    try {
      result = await listShelfLife({ client: session.user.client, selection, timeZone: 'Asia/Kuwait' });
    } catch (caught) {
      reportError = caught instanceof ShelfLifeListError ? `${caught.message} ${caught.remedy}` : t('mb5m.failed');
    }
  }
  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{SLED_LIST_CAPABILITY} · {SLED_LIST_ALIAS}</span>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{t('mb5m.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mb5m.subtitle')}</p>
      </header>
      <ShelfLifeListShell canUse={canUse} selection={selection} result={result} reportError={reportError} />
    </div>
  );
}
