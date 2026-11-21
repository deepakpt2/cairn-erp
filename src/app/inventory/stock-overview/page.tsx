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
import { ReportExport } from '@/ui/output/ReportExport';
import { Page } from '@/ui/kit';

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
      result = await stockOverview({ client: session.user.client, selection: initialSelection,
        authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } });
    } catch (error) {
      reportError = error instanceof StockOverviewError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The stock overview could not be calculated.';
    }
  }

  return (
    <Page
      title={t('stockOvw.title')} code="INV.STOCK.VIEW · MMBE" width="80rem" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('stockOvw.subtitle')}</p>
          {result && <div className="mt-3"><ReportExport report="stock-overview" params={params} /></div>}
        </>
      }
    >

      <StockOverviewShell
        canUse={can(session, STOCK_OVERVIEW_CAPABILITY)}
        selection={initialSelection}
        result={result}
        reportError={reportError}
      />
    </Page>
  );
}
