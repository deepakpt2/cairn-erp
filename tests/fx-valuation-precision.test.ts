import { describe, expect, it } from 'vitest';

import { valuationRequiredUnits } from '../src/modules/finance/fx-valuation';
import type { ResolvedExchangeRate } from '../src/modules/finance/exchange-rate-lookup';

const rate = (numerator: bigint, denominator: bigint) => ({ numerator, denominator } as ResolvedExchangeRate);

describe('valuation required amount at configured local precision', () => {
  it('rounds once at 0, 2, 3 and 4 decimal places', () => {
    // USD 100.01 at 0.32 = 32.0032, carried at the four-decimal storage scale.
    const foreign = 1_000_100n; // 100.0100
    expect(valuationRequiredUnits(foreign, rate(32n, 100n), 3)).toBe(320_030n); // KWD 32.003
    expect(valuationRequiredUnits(foreign, rate(32n, 100n), 2)).toBe(320_000n); // USD 32.00
    expect(valuationRequiredUnits(foreign, rate(32n, 100n), 0)).toBe(320_000n); // JPY 32
    expect(valuationRequiredUnits(foreign, rate(32n, 100n), 4)).toBe(320_032n); // 32.0032
  });

  it('is symmetric for negative positions and rounds a sub-minor value to zero', () => {
    expect(valuationRequiredUnits(-1_000_100n, rate(32n, 100n), 3)).toBe(-320_030n);
    expect(valuationRequiredUnits(100n, rate(32n, 100n), 0)).toBe(0n);
    expect(valuationRequiredUnits(12_345n, rate(1n, 1n), 4)).toBe(12_345n);
  });
});
