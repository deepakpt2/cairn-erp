import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  DEFAULT_MAX_HITS,
  DEFAULT_STOCK_TYPE,
  STOCK_POSTINGDATE_CAPABILITY,
  StockPostingDateError,
  stockOnPostingDate,
  type StockPostingDateResult,
  type StockPostingDateSelection,
} from '@/modules/inventory/stock-posting-date';
import StockOnPostingDateShell from './StockOnPostingDateShell';

export const dynamic = 'force-dynamic';

/**
 * SCR-126 / INV.STOCK.POSTINGDATE (MB5B): stocks on posting date. Read-only
 * rollforward over the immutable ledger; the stock master is a control.
 */
export default async function StockPostingDatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  const initialSelection: StockPostingDateSelection = {
    materialFrom: get('materialFrom').toUpperCase(),
    materialTo: get('materialTo').toUpperCase(),
    plantFrom: get('plantFrom').toUpperCase(),
    plantTo: get('plantTo').toUpperCase(),
    storageLocationFrom: get('storageLocationFrom').toUpperCase(),
    storageLocationTo: get('storageLocationTo').toUpperCase(),
    dateFrom: get('dateFrom'),
    dateTo: get('dateTo'),
    stockType: (get('stockType') || DEFAULT_STOCK_TYPE).toUpperCase(),
    batch: get('batch').toUpperCase(),
    displayZero: get('displayZero') === 'on' || get('displayZero') === '1',
    maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
  };

  let result: StockPostingDateResult | null = null;
  let reportError: string | null = null;
  if (can(session, STOCK_POSTINGDATE_CAPABILITY)) {
    try {
      result = await stockOnPostingDate({ client: session.user.client, selection: initialSelection });
    } catch (error) {
      reportError = error instanceof StockPostingDateError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The stock rollforward could not be calculated.';
    }
  }

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.STOCK.POSTINGDATE · MB5B</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('stockDate.title')}</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('stockDate.subtitle')}</p>
      </header>

      <StockOnPostingDateShell
        canUse={can(session, STOCK_POSTINGDATE_CAPABILITY)}
        selection={initialSelection}
        result={result}
        reportError={reportError}
      />
    </div>
  );
}
