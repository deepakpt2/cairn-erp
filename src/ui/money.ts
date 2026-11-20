/**
 * Amount display. The server decides how many decimals a currency has (`currency.decimal_places`); screens receive
 * that as a `decimals` map and format with it. Formatting is exact (decimal text, half away from zero): it never goes
 * through binary floating-point rounding such as `toFixed`, which turns 1.005 into 1.00.
 */
import { fromScaled, roundToScale } from '@/platform/posting/decimal';

export type CurrencyDecimals = Record<string, number>;

/** `value` written with exactly `decimals` decimals (clamped to 0..4, the storage scale). */
export function fmt(value: number | string | null | undefined, decimals: number): string {
  if (value === null || value === undefined || value === '') return '';
  const places = Math.min(4, Math.max(0, Math.trunc(decimals)));
  const n = typeof value === 'string' ? value : value;
  return fromScaled(roundToScale(n, places), places);
}

/** `value` in the decimals of `currency` from the server's map; two when the map does not know the currency. */
export function fmtIn(value: number | string | null | undefined, currency: string | null | undefined, decimals: CurrencyDecimals): string {
  return fmt(value, decimals[(currency ?? '').trim()] ?? 2);
}

/**
 * For a running figure whose currency the screen does not know yet (typed into a form): at least two decimals, and
 * as many more (up to four) as the number actually carries, so 1.237 shows as 1.237 and 100 as 100.00.
 * Display only: the server judges the amount against the currency's own decimals.
 */
export function fmtFlex(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const full = fmt(value, 4);
  return full.replace(/(\.\d\d)(\d*?)0*$/, (_m, two: string, rest: string) => two + rest);
}
