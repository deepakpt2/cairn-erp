/**
 * Currency-aware money: the one place that knows how many decimals a currency has and how an amount is
 * rounded, refused or written.
 *
 * Authoritative precision is `currency.decimal_places` (a global table: 2 for USD, 3 for KWD, 0 for JPY).
 * Nothing here defaults an unknown currency to two decimals.
 *
 * Rules (the same everywhere that uses this module):
 * - Storage: every monetary column is numeric(23,4), so a currency may have at most MONEY_SCALE (4) decimals.
 *   A currency configured with more is refused with an actionable error instead of being truncated.
 * - Entry: a directly entered amount with a non-zero digit beyond the currency's decimals is REFUSED, never
 *   changed. Trailing zeros are harmless: "1.2370" is fine in KWD and "5.00" in JPY, while "5.10" in JPY and
 *   "1.2371" in KWD are refused because a non-zero digit would be lost.
 * - Calculation: a calculated amount (tax, a discount, an allocated share) is rounded HALF AWAY FROM ZERO at
 *   the currency's decimals, once, at the point it becomes a posted amount. Unit prices, rates and
 *   quantities keep their own precision and are never rounded to minor units.
 * - Equality and tolerances are exact integer comparisons at the currency's scale; a configured business
 *   tolerance is a stated amount, never an implicit "half a cent".
 * - Document-currency amounts use the document currency's decimals and local-currency amounts the local
 *   currency's; the two are never interchanged merely because their decimal counts match.
 */
import { sql } from 'drizzle-orm';

import { type Tx, withTenant } from '../db/client';
import { MONEY_SCALE, divideRound, exactToScale, fromScaled, roundToScale } from './decimal';

export class MoneyError extends Error {
  readonly code = 'CAIRN_MONEY';
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Resolve a currency's decimals. Unknown, inactive-by-absence or unstorable currencies are refused. */
export async function currencyScale(tx: Tx, currencyCode: string): Promise<number> {
  const code = currencyCode.trim().toUpperCase();
  const rows = (await tx.execute(sql`select decimal_places from currency where code = ${code} limit 1`)) as unknown as Array<{ decimal_places: number }>;
  if (!rows[0]) {
    throw new MoneyError(`Currency ${code} is not defined, so its decimal places are unknown.`, 'Maintain the currency (with its decimal places) in the currency table, or use a defined currency.');
  }
  return assertStorableScale(code, Number(rows[0].decimal_places));
}

export function assertStorableScale(code: string, scale: number): number {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new MoneyError(`Currency ${code} has an invalid number of decimal places (${scale}).`, 'Correct the decimal places on the currency.');
  }
  if (scale > MONEY_SCALE) {
    throw new MoneyError(
      `Currency ${code} has ${scale} decimal places, but amounts are stored with at most ${MONEY_SCALE}.`,
      `Use a currency with ${MONEY_SCALE} decimals or fewer, or widen the monetary columns before posting in ${code}.`,
    );
  }
  return scale;
}

/** Money in one currency: rounding, strict entry, text and exact comparisons at that currency's decimals. */
export interface Money {
  readonly code: string;
  readonly scale: number;
  /** Scaled integer (at `scale`) of a calculated amount, rounded half away from zero. */
  units(value: string | number): bigint;
  /** A calculated amount rounded to the currency, as a number (for the number-typed service interfaces). */
  round(value: string | number): number;
  /** A calculated amount rounded and written with exactly `scale` decimals. */
  text(value: string | number): string;
  /** A directly entered amount: refused (MoneyError) when a non-zero digit lies beyond the currency's decimals. */
  entered(value: string | number, label?: string): bigint;
  /** Scaled integer → text with exactly `scale` decimals. */
  fromUnits(units: bigint): string;
  /** `value × percent / 100` as an exact calculation, rounded once to the currency. */
  percentOf(value: string | number, percent: string | number): bigint;
  /** `quantity × price ÷ perUnit` (an order-price value) as one exact calculation, rounded once to the currency. */
  extend(quantity: string | number, price: string | number, perUnit: string | number): bigint;
}

export function moneyOf(code: string, scale: number): Money {
  const currency = code.trim().toUpperCase();
  assertStorableScale(currency, scale);
  const units = (value: string | number) => roundToScale(value, scale);
  return {
    code: currency,
    scale,
    units,
    round: (value) => Number(fromScaled(units(value), scale)),
    text: (value) => fromScaled(units(value), scale),
    entered(value, label = 'The amount') {
      const exact = exactToScale(value, scale);
      if (exact === null) {
        throw new MoneyError(
          `${label} ${typeof value === 'number' ? String(value) : value.trim()} has more decimal places than ${currency} allows (${scale}).`,
          scale === 0
            ? `${currency} has no minor unit: enter a whole amount.`
            : `Enter at most ${scale} decimal place${scale === 1 ? '' : 's'} for ${currency}.`,
        );
      }
      return exact;
    },
    fromUnits: (u) => fromScaled(u, scale),
    percentOf(value, percent) {
      // value (at 8 working decimals) × percent (at 8 working decimals) / 100, then rounded once to `scale`.
      const WORK = 8;
      const v = roundToScale(value, WORK);
      const p = roundToScale(percent, WORK);
      return divideRound(v * p, 10n ** BigInt(WORK + WORK - scale + 2));
    },
    extend(quantity, price, perUnit) {
      // (q/1e8) × (p/1e8) ÷ (u/1e8) = q·p / (u·1e8), expressed in units of 10^-scale.
      const WORK = 8;
      const q = roundToScale(quantity, WORK);
      const p = roundToScale(price, WORK);
      const u = roundToScale(perUnit, WORK);
      if (u <= 0n) throw new MoneyError('The price unit must be positive.');
      return divideRound(q * p * 10n ** BigInt(scale), u * 10n ** BigInt(WORK));
    },
  };
}

/**
 * The same Money, whose refusals are the caller's own error type: a service hands its screen one kind of error
 * (message + remedy), never a MoneyError it would have to know about.
 */
export function refusing(money: Money, refuse: (error: MoneyError) => Error): Money {
  const guard = <T extends unknown[], R>(fn: (...args: T) => R) => (...args: T): R => {
    try { return fn(...args); } catch (error) {
      if (error instanceof MoneyError) throw refuse(error);
      throw error;
    }
  };
  return { ...money, entered: guard(money.entered), percentOf: guard(money.percentOf), extend: guard(money.extend) };
}

/** The Money for a currency, resolved from the authoritative configuration. */
export async function moneyFor(tx: Tx, currencyCode: string): Promise<Money> {
  return moneyOf(currencyCode, await currencyScale(tx, currencyCode));
}

/**
 * Split `total` (scaled units) across weights so the parts add up to the total exactly. Each part is the
 * weighted share rounded half away from zero; the remainder lands on the largest-weight part (ties: the
 * earliest), so the outcome is deterministic and the rounding difference is always one place: auditable.
 */
export function allocateUnits(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new MoneyError('There is nothing to allocate across.');
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum <= 0n) throw new MoneyError('The weights to allocate across must add up to more than zero.');
  const parts = weights.map((w) => divideRound(total * w, sum));
  const remainder = total - parts.reduce((a, b) => a + b, 0n);
  if (remainder !== 0n) {
    let target = 0;
    weights.forEach((w, i) => { if (w > weights[target]!) target = i; });
    parts[target] = parts[target]! + remainder;
  }
  return parts;
}

/** Decimals of every active currency, for screens that format amounts (the server resolves, the client only formats). */
export async function currencyDecimalsMap(tx: Tx): Promise<Record<string, number>> {
  const rows = (await tx.execute(sql`select code, decimal_places from currency where is_active = true`)) as unknown as Array<{ code: string; decimal_places: number }>;
  const map: Record<string, number> = {};
  for (const r of rows) map[String(r.code).trim()] = Number(r.decimal_places);
  return map;
}

/** The decimals map for a tenant's screen, in one call from a page. */
export async function currencyDecimalsFor(client: string): Promise<Record<string, number>> {
  return withTenant(client, (tx) => currencyDecimalsMap(tx));
}
