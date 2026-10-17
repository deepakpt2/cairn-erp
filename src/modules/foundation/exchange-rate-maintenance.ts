import { asc, desc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { currency as currencyReference } from '../../platform/tables/reference';
import { exchangeRate } from './schema';

/**
 * OB08 Maintain Exchange Rates — the read side (SCR-034 stage 1).
 *
 * The exchange_rate table has existed since the first schema, written once by the standard
 * package's builder and read by nothing: the posting engine carries the rate on the journal
 * itself, so this table is the reference a configurator maintains and a future lookup reads.
 * This module exists before the writes for the same reason the OBBP reader does: the screen
 * has to render what the tenant holds before it is worth writing to.
 *
 * Two package hedges the owner settled shape what the screen must say. The rate types are
 * the product's own — BUYING, SELLING, AVERAGE — because reference keywords live in search
 * aliases and never in codes or the database; and the translation ratios the package
 * attributes to TCURF arrive with stage 2 as columns of their own, so the rate a row
 * effectively carries is rate × ratioTo / ratioFrom, computed where the row is read.
 */
export const ACTIVITY = 'CFG.FIN.EXRATE.MAINTAIN';

export const RATE_TYPES = ['AVERAGE', 'BUYING', 'SELLING'] as const;
export type RateType = (typeof RATE_TYPES)[number];

export interface ExchangeRateRow {
  rateType: string;
  fromCurrency: string;
  toCurrency: string;
  /** ISO date (YYYY-MM-DD): the rate is effective from this date until a newer one. */
  validFrom: string;
  /** As entered: 1 unit of fromCurrency = rate units of toCurrency. */
  rate: string;
}

export interface CurrencyChoice {
  code: string;
  name: string;
}

/** Every rate the tenant holds, newest validity first within each type and pair. */
export async function listExchangeRates(client: string): Promise<ExchangeRateRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        rateType: exchangeRate.rateType,
        fromCurrency: exchangeRate.fromCurrency,
        toCurrency: exchangeRate.toCurrency,
        validFrom: exchangeRate.validFrom,
        rate: exchangeRate.rate,
      })
      .from(exchangeRate)
      .where(eq(exchangeRate.client, client))
      .orderBy(
        asc(exchangeRate.rateType),
        asc(exchangeRate.fromCurrency),
        asc(exchangeRate.toCurrency),
        desc(exchangeRate.validFrom),
      );
    return rows.map((row) => ({ ...row, validFrom: String(row.validFrom) }));
  });
}

/** The currencies a rate may translate between: the active rows of the currency master. */
export async function listCurrencyChoices(client: string): Promise<CurrencyChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ code: currencyReference.code, name: currencyReference.name })
      .from(currencyReference)
      .where(eq(currencyReference.isActive, true))
      .orderBy(asc(currencyReference.code));
    return rows.map((row) => ({ code: row.code.trim(), name: row.name }));
  });
}
