import { sql } from 'drizzle-orm';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import {
  DEFAULT_AGE_BUCKETS,
  DEFAULT_MAX_HITS,
  DEFAULT_NON_MOVING_DAYS,
  DEFAULT_SLOW_MOVING_DAYS,
  STOCK_AGEING_CAPABILITY,
  StockAgeingError,
  stockAgeing,
  type StockAgeingResult,
  type StockAgeingSelection,
} from '@/modules/inventory/stock-ageing';
import StockAgeingShell from './StockAgeingShell';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * INV.STOCK.AGEING.DISPLAY (MC46 / MC50): the age of the stock on hand and the slow-moving
 * classification. Read-only; recomputed from the material ledger on every run.
 */
export default async function StockAgeingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  // The bucket bounds travel as one comma-separated field; an untouched form posts the default.
  const bucketText = get('ageBuckets', DEFAULT_AGE_BUCKETS.join(','));
  const ageBuckets = bucketText === '' ? [] : bucketText.split(',').map((part) => Number(part.trim()));
  const selection: StockAgeingSelection = {
    materialFrom: get('materialFrom').toUpperCase(),
    materialTo: get('materialTo').toUpperCase(),
    plantFrom: get('plantFrom').toUpperCase(),
    plantTo: get('plantTo').toUpperCase(),
    stockType: get('stockType').toUpperCase(),
    asOf: get('asOf'),
    ageBuckets,
    slowMovingDays: Number(get('slowMovingDays', String(DEFAULT_SLOW_MOVING_DAYS))),
    nonMovingDays: Number(get('nonMovingDays', String(DEFAULT_NON_MOVING_DAYS))),
    displayZero: get('displayZero') === 'on' || get('displayZero') === '1',
    valuationPriceDisplay: get('valuationPriceOff') !== '1',
    maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
  };

  let result: StockAgeingResult | null = null;
  let reportError: string | null = null;
  const canUse = can(session, STOCK_AGEING_CAPABILITY);
  if (canUse) {
    try {
      const currencyRows = await withTenant(session.user.client, (tx) => tx.execute(sql`
        select currency from client where client = ${session.user.client}
      `)) as unknown as Array<{ currency: string }>;
      result = await stockAgeing({
        client: session.user.client,
        localCurrency: currencyRows[0]?.currency ?? 'KWD',
        selection,
        authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
      });
    } catch (error) {
      reportError = error instanceof StockAgeingError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The stock ageing report could not be calculated.';
    }
  }

  return (
    <Page
      title={t('stockAgeing.title')} code="INV.STOCK.AGEING.DISPLAY · MC46 · MC50" width="100rem" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('stockAgeing.subtitle')}</p>
        </>
      }
    >

      <StockAgeingShell
        canUse={canUse}
        bucketText={bucketText}
        selection={selection}
        result={result}
        reportError={reportError}
      />
    </Page>
  );
}
