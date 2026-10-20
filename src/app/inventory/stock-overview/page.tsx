import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  DEFAULT_MAX_HITS,
  STOCK_OVERVIEW_CAPABILITY,
  StockOverviewError,
  stockOverview,
  type StockOverviewResult,
  type StockOverviewSelection,
} from '@/modules/inventory/stock-overview';
import StockOverviewShell from './StockOverviewShell';

export const dynamic = 'force-dynamic';

/**
 * SCR-128 / INV.STOCK.VIEW (MMBE): the stock overview tree for one material.
 * Read-only; value stays in the warehouse stock list the nodes drill into.
 */
export default async function StockOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  const initialSelection: StockOverviewSelection = {
    material: get('material').toUpperCase(),
    plantFrom: get('plantFrom').toUpperCase(),
    plantTo: get('plantTo').toUpperCase(),
    storageLocationFrom: get('storageLocationFrom').toUpperCase(),
    storageLocationTo: get('storageLocationTo').toUpperCase(),
    batch: get('batch'),
    specialStockIndicator: get('specialStockIndicator').toUpperCase(),
    displayZero: get('displayZero') === 'on' || get('displayZero') === '1',
    expansionLevel: (get('expansionLevel') || 'STORAGE_LOCATION').toUpperCase(),
    maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
  };

  let result: StockOverviewResult | null = null;
  let reportError: string | null = null;
  if (can(session, STOCK_OVERVIEW_CAPABILITY)) {
    try {
      result = await stockOverview({ client: session.user.client, selection: initialSelection });
    } catch (error) {
      reportError = error instanceof StockOverviewError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The stock overview could not be calculated.';
    }
  }

  return (
    <div className="mx-auto max-w-[80rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.STOCK.VIEW · MMBE</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('stockOvw.title')}</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('stockOvw.subtitle')}</p>
      </header>

      <StockOverviewShell
        canUse={can(session, STOCK_OVERVIEW_CAPABILITY)}
        selection={initialSelection}
        result={result}
        reportError={reportError}
      />
    </div>
  );
}
