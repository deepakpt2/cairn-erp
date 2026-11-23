/**
 * Exchange-rate resolution for posting.
 *
 * One place decides what a foreign amount becomes in the company's local currency. The rule the
 * product settled on (OB08): the newest AVERAGE row for the tenant and currency pair whose
 * `valid_from` is on or before the posting date. The date filter belongs in the query — selecting
 * the newest row first and rejecting it when it is future-dated refuses a posting although an
 * older, valid rate stands.
 *
 * A row is quoted as `1 from = rate × ratioTo / ratioFrom to`, and `is_indirect_quote` inverts it
 * (the row is stated as units of `from` per one `to`). An exact rational (numerator/denominator)
 * is carried rather than a rounded number, so `amount × rate` is one exact calculation rounded
 * once at the destination currency's decimals.
 */
import { and, eq, sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { divideRound, fromScaled, toScaled } from '../../platform/posting/decimal';
import { exchangeRate } from '../foundation/schema';

export const RATE_TYPES = ['AVERAGE', 'BUYING', 'SELLING'] as const;
export type RateType = (typeof RATE_TYPES)[number];

export type RateSource = 'IDENTITY' | 'EXCHANGE_RATE_MASTER' | 'INVERSE_PAIR' | 'SUPPLIED';

export interface ResolvedExchangeRate {
  fromCurrency: string;
  toCurrency: string;
  rateType: string;
  source: RateSource;
  /** The row's validity date, null for an identity rate. */
  validFrom: string | null;
  /** The row's entered rate, null for an identity rate. */
  rawRate: string | null;
  ratioFrom: number;
  ratioTo: number;
  isIndirectQuote: boolean;
  /** local = foreign × numerator / denominator. Exact. */
  numerator: bigint;
  denominator: bigint;
  /** The effective rate rendered at the ledger's 8 decimals, for the journal snapshot. */
  effectiveRate: string;
}

export class ExchangeRateLookupError extends Error {
  readonly code = 'CAIRN_EXCHANGE_RATE';

  constructor(message: string, readonly remedy: string) {
    super(message);
    this.name = 'ExchangeRateLookupError';
  }
}

const RATE_SCALE = 8;
const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);

function normalizeCurrency(code: string): string {
  return code.trim().toUpperCase();
}

function effectiveRateText(numerator: bigint, denominator: bigint): string {
  return fromScaled(divideRound(numerator * RATE_FACTOR, denominator), RATE_SCALE);
}

export function identityRate(fromCurrency: string, toCurrency = fromCurrency): ResolvedExchangeRate {
  return {
    fromCurrency: normalizeCurrency(fromCurrency),
    toCurrency: normalizeCurrency(toCurrency),
    rateType: 'AVERAGE',
    source: 'IDENTITY',
    validFrom: null,
    rawRate: null,
    ratioFrom: 1,
    ratioTo: 1,
    isIndirectQuote: false,
    numerator: 1n,
    denominator: 1n,
    effectiveRate: fromScaled(1n * RATE_FACTOR, RATE_SCALE),
  };
}

/** A rate the caller already resolved (a previously posted document's snapshot, or a mirror). */
export function suppliedRate(
  fromCurrency: string,
  toCurrency: string,
  effectiveRate: string,
  options: Partial<Pick<ResolvedExchangeRate, 'rateType' | 'source' | 'validFrom' | 'rawRate' | 'ratioFrom' | 'ratioTo' | 'isIndirectQuote'>> = {},
): ResolvedExchangeRate {
  const units = toScaled(effectiveRate, RATE_SCALE);
  if (units <= 0n) throw new ExchangeRateLookupError(`Exchange rate ${effectiveRate} is not positive.`, 'Correct the rate.');
  return {
    fromCurrency: normalizeCurrency(fromCurrency),
    toCurrency: normalizeCurrency(toCurrency),
    rateType: options.rateType ?? 'AVERAGE',
    source: options.source ?? 'SUPPLIED',
    validFrom: options.validFrom ?? null,
    rawRate: options.rawRate ?? null,
    ratioFrom: options.ratioFrom ?? 1,
    ratioTo: options.ratioTo ?? 1,
    isIndirectQuote: options.isIndirectQuote ?? false,
    numerator: units,
    denominator: RATE_FACTOR,
    effectiveRate: fromScaled(units, RATE_SCALE),
  };
}

interface RateRow {
  rateType: string;
  fromCurrency: string;
  toCurrency: string;
  validFrom: string;
  rate: string;
  ratioFrom: number;
  ratioTo: number;
  isIndirectQuote: boolean;
}

function fromRow(row: RateRow, source: 'EXCHANGE_RATE_MASTER' | 'INVERSE_PAIR'): ResolvedExchangeRate {
  const rawUnits = toScaled(row.rate, RATE_SCALE);
  const ratioFrom = row.ratioFrom > 0 ? row.ratioFrom : 1;
  const ratioTo = row.ratioTo > 0 ? row.ratioTo : 1;

  // Direct: 1 from = raw × ratioTo / ratioFrom to.
  let numerator = rawUnits * BigInt(ratioTo);
  let denominator = RATE_FACTOR * BigInt(ratioFrom);
  if (row.isIndirectQuote) {
    // The row is stated the other way round: units of from per one to.
    [numerator, denominator] = [RATE_FACTOR * BigInt(ratioFrom), rawUnits * BigInt(ratioTo)];
  }
  if (source === 'INVERSE_PAIR') {
    // The master holds the opposite pair; its value is the reciprocal here.
    [numerator, denominator] = [denominator, numerator];
  }
  if (numerator <= 0n || denominator <= 0n) {
    throw new ExchangeRateLookupError(
      `Exchange rate ${row.rateType} ${row.fromCurrency} → ${row.toCurrency} from ${row.validFrom} is not a usable positive rate.`,
      'Correct the rate in exchange-rate maintenance.',
    );
  }
  return {
    fromCurrency: source === 'INVERSE_PAIR' ? normalizeCurrency(row.toCurrency) : normalizeCurrency(row.fromCurrency),
    toCurrency: source === 'INVERSE_PAIR' ? normalizeCurrency(row.fromCurrency) : normalizeCurrency(row.toCurrency),
    rateType: row.rateType,
    source,
    validFrom: row.validFrom,
    rawRate: row.rate,
    ratioFrom,
    ratioTo,
    isIndirectQuote: row.isIndirectQuote,
    numerator,
    denominator,
    effectiveRate: effectiveRateText(numerator, denominator),
  };
}

async function findRow(
  tx: Tx, client: string, rateType: string, fromCurrency: string, toCurrency: string, onDate: string,
): Promise<RateRow | null> {
  const [row] = await tx
    .select({
      rateType: exchangeRate.rateType,
      fromCurrency: exchangeRate.fromCurrency,
      toCurrency: exchangeRate.toCurrency,
      validFrom: exchangeRate.validFrom,
      rate: exchangeRate.rate,
      ratioFrom: exchangeRate.ratioFrom,
      ratioTo: exchangeRate.ratioTo,
      isIndirectQuote: exchangeRate.isIndirectQuote,
    })
    .from(exchangeRate)
    .where(and(
      eq(exchangeRate.client, client),
      eq(exchangeRate.rateType, rateType),
      eq(exchangeRate.fromCurrency, fromCurrency),
      eq(exchangeRate.toCurrency, toCurrency),
      sql`${exchangeRate.validFrom} <= ${onDate}`,
    ))
    .orderBy(sql`${exchangeRate.validFrom} desc`)
    .limit(1);
  return row ? { ...row, validFrom: String(row.validFrom) } : null;
}

/**
 * Resolve the rate that translates `fromCurrency` into `toCurrency` on `onDate`.
 *
 * The newest valid row for the direct pair wins. When the tenant stores only the opposite pair,
 * its reciprocal is used and the source says so. A currency is its own identity and needs no row.
 */
export async function resolveExchangeRate(
  tx: Tx,
  client: string,
  fromCurrency: string,
  toCurrency: string,
  onDate: string,
  rateType: string = 'AVERAGE',
): Promise<ResolvedExchangeRate | null> {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  if (from === to) return identityRate(from, to);

  const direct = await findRow(tx, client, rateType, from, to, onDate);
  if (direct) return fromRow(direct, 'EXCHANGE_RATE_MASTER');

  const inverse = await findRow(tx, client, rateType, to, from, onDate);
  if (inverse) return fromRow(inverse, 'INVERSE_PAIR');

  return null;
}

/** Resolve or refuse. Callers that own a service error re-wrap it; the engine throws PostingError. */
export async function requireExchangeRate(
  tx: Tx,
  client: string,
  fromCurrency: string,
  toCurrency: string,
  onDate: string,
  rateType: string = 'AVERAGE',
): Promise<ResolvedExchangeRate> {
  const resolved = await resolveExchangeRate(tx, client, fromCurrency, toCurrency, onDate, rateType);
  if (resolved) return resolved;
  throw new ExchangeRateLookupError(
    `No ${rateType} exchange rate stands from ${normalizeCurrency(fromCurrency)} to ${normalizeCurrency(toCurrency)} on or before ${onDate}.`,
    `Maintain the ${rateType} rate in Exchange Rates (CFG.FIN.EXRATE.MAINTAIN) with a Valid From date on or before ${onDate}. A missing rate is never translated at 1.`,
  );
}

/**
 * Translate an amount held in scaled units at `inputScale` into scaled units at `resultScale`.
 * One exact rational multiplication, then one rounding at the destination scale.
 */
export function translateAmount(
  units: bigint,
  inputScale: number,
  resultScale: number,
  rate: ResolvedExchangeRate,
): bigint {
  if (units === 0n) return 0n;
  return divideRound(
    units * rate.numerator * 10n ** BigInt(resultScale),
    rate.denominator * 10n ** BigInt(inputScale),
  );
}

/** The rate as a number, for display or for callers that already use numeric rates. */
export function rateToLocalNumber(rate: ResolvedExchangeRate): number {
  return Number(rate.effectiveRate);
}
