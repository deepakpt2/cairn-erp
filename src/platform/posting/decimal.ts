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

/** Parse a decimal string into scaled BigInt. Throws on anything not exact. */
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

/** Multiply by a rate, rounding half-up at the given scale. */
export function multiplyScaled(value: bigint, rate: string, scale = MONEY_SCALE): bigint {
  const rateScaled = toScaled(rate, 8);
  const product = value * rateScaled;
  const divisor = 10n ** 8n;
  const quotient = product / divisor;
  const remainder = product % divisor;
  const rounded =
    remainder * 2n >= divisor
      ? quotient + (product < 0n ? -1n : 1n)
      : quotient;
  if (scale === MONEY_SCALE) return rounded;
  // Rescale to the requested precision.
  const delta = BigInt(scale) - BigInt(MONEY_SCALE);
  return delta >= 0n ? rounded * 10n ** delta : rounded / 10n ** -delta;
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
