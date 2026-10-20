import { sql } from 'drizzle-orm';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import {
  DEFAULT_MAX_HITS,
  WAREHOUSE_STOCK_CAPABILITY,
  WarehouseStockError,
  listWarehouseStocks,
  type WarehouseStockResult,
  type WarehouseStockSelection,
} from '@/modules/inventory/warehouse-stocks';
import WarehouseStocksShell from './WarehouseStocksShell';

export const dynamic = 'force-dynamic';

/**
 * SCR-127 / INV.STOCK.WAREHOUSE (MB52): warehouse stocks on hand. Read-only
 * snapshot of the stock master with its plant valuation.
 */
export default async function WarehouseStocksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  const initialSelection: WarehouseStockSelection = {
    scopeOfList: (get('scopeOfList') || 'ALV').toUpperCase(),
    materialFrom: get('materialFrom').toUpperCase(),
    materialTo: get('materialTo').toUpperCase(),
    plantFrom: get('plantFrom').toUpperCase(),
    plantTo: get('plantTo').toUpperCase(),
    storageLocationFrom: get('storageLocationFrom').toUpperCase(),
    storageLocationTo: get('storageLocationTo').toUpperCase(),
    stockType: get('stockType').toUpperCase(),
    specialStockIndicator: get('specialStockIndicator').toUpperCase(),
    valuationType: get('valuationType'),
    batch: get('batch'),
    displayZero: get('displayZero') === 'on' || get('displayZero') === '1',
    // The package defaults the valuation display on; the screen offers a switch to turn it off.
    valuationPriceDisplay: get('valuationPriceOff') !== '1',
    maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
  };

  let result: WarehouseStockResult | null = null;
  let reportError: string | null = null;
  if (can(session, WAREHOUSE_STOCK_CAPABILITY)) {
    try {
      // The tenant's own currency is the one the valuation is judged against.
      const currencyRows = await withTenant(session.user.client, (tx) => tx.execute(sql`
        select currency from client where client = ${session.user.client}
      `)) as unknown as Array<{ currency: string }>;
      result = await listWarehouseStocks({
        client: session.user.client,
        localCurrency: currencyRows[0]?.currency ?? 'KWD',
        selection: initialSelection,
      });
    } catch (error) {
      reportError = error instanceof WarehouseStockError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The warehouse stock snapshot could not be calculated.';
    }
  }

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.STOCK.WAREHOUSE · MB52</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('whStock.title')}</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('whStock.subtitle')}</p>
      </header>

      <WarehouseStocksShell
        canUse={can(session, WAREHOUSE_STOCK_CAPABILITY)}
        selection={initialSelection}
        result={result}
        reportError={reportError}
      />
    </div>
  );
}
