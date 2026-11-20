/**
 * Exact decimal arithmetic for money.
 *
 * Amounts are never floating point (CAIRN.md §7.4) — 0.1 + 0.2 must equal 0.3
 * when a trial balance depends on it. These helpers work on scaled BigInt, so
 * comparisons and sums are exact at the stored precision of numeric(23,4).
 */

/** Scale of every monetary column in the schema. */
export const MONEY_SCALE = 4;
const MONEY_FACTOR = 10n ** BigInt(MONEY_SCALE);

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Parse a decimal string into scaled BigInt. Throws on text that is not a decimal.
 * Digits beyond `scale` are DROPPED, not rounded: use `exactToScale` to refuse them or `roundToScale` to round.
 */
export function toScaled(value: string | number, scale = MONEY_SCALE): bigint {
  const text = typeof value === 'number' ? formatPlain(value, scale) : value.trim();
  if (!DECIMAL_PATTERN.test(text)) {
    throw new DecimalError(`"${value}" is not a valid decimal amount.`);
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
  const scaled = BigInt(whole) * 10n ** BigInt(scale) + BigInt(padded === '' ? '0' : padded);
  return negative ? -scaled : scaled;
}

/** Render scaled BigInt back to a fixed-scale decimal string. */
export function fromScaled(scaled: bigint, scale = MONEY_SCALE): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const factor = 10n ** BigInt(scale);
  const whole = absolute / factor;
  // A zero-decimal currency has no fraction at all: "3", never "3.0" (padStart(0) would have written one digit).
  if (scale === 0) return `${negative ? '-' : ''}${whole}`;
  const fraction = absolute % factor;
  const fractionText = fraction.toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole}.${fractionText}`;
}

/** Exact sum. */
export function sumScaled(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

/** Exact comparison. Returns true when the values are equal at stored precision. */
export function equalsScaled(a: bigint, b: bigint): boolean {
  return a === b;
}

/**
 * Multiply a MONEY_SCALE amount by a rate and round to `scale` decimals.
 *
 * Rounding is half away from zero, so +x and -x round symmetrically (an exact half rounds to the larger
 * magnitude). The previous version compared a signed remainder, which never rounded a negative product up
 * in magnitude, so -0.00005 × 1 came out as 0.0000 while +0.00005 came out as 0.0001.
 * The result is expressed at `scale` (default MONEY_SCALE); a smaller `scale` is rounded, never truncated.
 */
export function multiplyScaled(value: bigint, rate: string, scale = MONEY_SCALE): bigint {
  const rateScaled = toScaled(rate, 8);
  // value has MONEY_SCALE decimals and the rate has 8, so the product has MONEY_SCALE + 8.
  return divideRound(value * rateScaled, 10n ** BigInt(MONEY_SCALE + 8 - scale));
}

/** Integer division rounding half away from zero. `divisor` must be positive. */
export function divideRound(numerator: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new DecimalError('The divisor must be positive.');
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / divisor;
  const rounded = (magnitude % divisor) * 2n >= divisor ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Expand a JS number to plain decimal text from its shortest round-trip form ("1.005", not the binary
 * expansion 1.00499999…), so a figure the user typed keeps the digits they typed. Exponent forms are expanded.
 */
export function numberToDecimalText(value: number): string {
  if (!Number.isFinite(value)) throw new DecimalError(`"${value}" is not finite.`);
  // A double carries 15 trustworthy significant digits; anything beyond is binary noise (0.1 + 0.2 is
  // 0.30000000000000004). Dropping it keeps a computed amount from being refused as "too precise" while
  // a digit the user really typed (1.2371) is, with at most 15 significant digits, still kept.
  const text = String(Number(value.toPrecision(15)));
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/i.exec(text);
  if (!match) throw new DecimalError(`"${value}" is not a valid decimal amount.`);
  const [, sign, whole, fraction = '', exponent] = match;
  if (!exponent) return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
  const shift = Number(exponent);
  const digits = whole + fraction;
  const point = whole.length + shift;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Round decimal text (or a number, through its shortest form) to `scale` decimals, half away from zero,
 * and return the scaled integer. Unlike `toScaled`, extra digits round rather than vanish.
 */
export function roundToScale(value: string | number, scale: number): bigint {
  const text = typeof value === 'number' ? numberToDecimalText(value) : value.trim();
  if (!DECIMAL_PATTERN.test(text)) throw new DecimalError(`"${value}" is not a valid decimal amount.`);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const kept = (fraction + '0'.repeat(scale)).slice(0, scale);
  const dropped = fraction.slice(scale);
  let scaled = BigInt(whole) * 10n ** BigInt(scale) + BigInt(kept === '' ? '0' : kept);
  if (dropped !== '' && dropped.charCodeAt(0) >= 53) scaled += 1n; // first dropped digit 5..9 rounds away from zero
  return negative ? -scaled : scaled;
}

/**
 * Parse decimal text to a scaled integer only when it is exact at `scale`: digits beyond the scale must all be
 * zero (harmless trailing zeros), otherwise null. This is the entry rule — an amount is refused, never altered.
 */
export function exactToScale(value: string | number, scale: number): bigint | null {
  const text = typeof value === 'number' ? numberToDecimalText(value) : value.trim();
  if (!DECIMAL_PATTERN.test(text)) throw new DecimalError(`"${value}" is not a valid decimal amount.`);
  const fraction = text.split('.')[1] ?? '';
  if (/[1-9]/.test(fraction.slice(scale))) return null;
  return roundToScale(text, scale);
}

/** Format a JS number as a plain decimal string without exponent notation. */
function formatPlain(value: number, scale: number): string {
  if (!Number.isFinite(value)) throw new DecimalError(`"${value}" is not finite.`);
  return value.toFixed(scale);
}

export class DecimalError extends Error {
  readonly code = 'CAIRN_DECIMAL';
  constructor(message: string) {
    super(message);
    this.name = 'DecimalError';
  }
}
