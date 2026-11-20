import { describe, expect, it } from 'vitest';

import {
  DecimalError, divideRound, exactToScale, fromScaled, multiplyScaled, numberToDecimalText, roundToScale, toScaled,
} from '../src/platform/posting/decimal';
import { MoneyError, allocateUnits, assertStorableScale, moneyOf } from '../src/platform/posting/money';
import { fmt, fmtFlex, fmtIn } from '../src/ui/money';

describe('rounding: half away from zero, for either sign', () => {
  it('rounds exact halves away from zero at each scale', () => {
    expect(fromScaled(roundToScale('1.005', 2), 2)).toBe('1.01');
    expect(fromScaled(roundToScale('-1.005', 2), 2)).toBe('-1.01');
    expect(fromScaled(roundToScale('1.0005', 3), 3)).toBe('1.001');
    expect(fromScaled(roundToScale('-1.0005', 3), 3)).toBe('-1.001');
    expect(fromScaled(roundToScale('2.5', 0), 0)).toBe('3');
    expect(fromScaled(roundToScale('-2.5', 0), 0)).toBe('-3');
    expect(fromScaled(roundToScale('0.4999', 0), 0)).toBe('0');
  });

  it('keeps the digits a number was typed with (1.005 is 1.005, not its binary expansion)', () => {
    expect(fromScaled(roundToScale(1.005, 2), 2)).toBe('1.01');
    expect(fromScaled(roundToScale(1.255, 2), 2)).toBe('1.26');
    expect((1.005).toFixed(2)).toBe('1.00'); // what the old two-decimal code did
    expect(numberToDecimalText(1e-7)).toBe('0.0000001');
    expect(numberToDecimalText(1.5e21)).toBe('1500000000000000000000');
    expect(numberToDecimalText(-0.000123)).toBe('-0.000123');
    // Binary noise from a computed amount is not a typed digit: 0.1 + 0.2 is 0.3, and 3 × 1.1 is 3.3.
    expect(numberToDecimalText(0.1 + 0.2)).toBe('0.3');
    expect(exactToScale(3 * 1.1, 2)).toBe(330n);
    expect(exactToScale(1.2371, 3)).toBeNull();
  });

  it('handles small, large and zero values', () => {
    expect(fromScaled(roundToScale('0.0004', 3), 3)).toBe('0.000');
    expect(fromScaled(roundToScale('0.0005', 3), 3)).toBe('0.001');
    expect(fromScaled(roundToScale('9999999999999999999.9995', 3), 3)).toBe('10000000000000000000.000');
    expect(roundToScale('0', 3)).toBe(0n);
  });

  it('divides half away from zero and refuses a non-positive divisor', () => {
    expect(divideRound(5n, 2n)).toBe(3n);
    expect(divideRound(-5n, 2n)).toBe(-3n);
    expect(divideRound(4n, 3n)).toBe(1n);
    expect(divideRound(-4n, 3n)).toBe(-1n);
    expect(() => divideRound(1n, 0n)).toThrow(DecimalError);
  });
});

describe('multiplyScaled (the posting engine\'s translation): negative values round like positive ones', () => {
  it('rounds a negative half up in magnitude, as a positive half', () => {
    // 0.0001 × 0.5 = 0.00005, an exact half at four decimals: it rounds to 0.0001 for either sign.
    // The old code compared a signed remainder, so the negative half came out as -0.0000.
    expect(multiplyScaled(1n, '0.5')).toBe(1n);
    expect(multiplyScaled(-1n, '0.5')).toBe(-1n);
    expect(multiplyScaled(toScaled('-1.2345'), '0.5')).toBe(-6173n);
    expect(multiplyScaled(toScaled('1.2345'), '0.5')).toBe(6173n);
  });

  it('rounds to the requested scale instead of truncating', () => {
    // 1.237 KWD × 3.25 = 4.02025: two decimals give 4.02, three give 4.020 (half-up on the next digit)
    expect(multiplyScaled(toScaled('1.237'), '3.25', 2)).toBe(402n);
    expect(multiplyScaled(toScaled('1.237'), '3.25', 3)).toBe(4020n);
    expect(multiplyScaled(toScaled('1.237'), '487.5', 0)).toBe(603n);
    expect(multiplyScaled(toScaled('-1.237'), '487.5', 0)).toBe(-603n);
    expect(multiplyScaled(toScaled('1.5'), '1', 0)).toBe(2n);
    expect(multiplyScaled(toScaled('-1.5'), '1', 0)).toBe(-2n);
  });
});

describe('entry rule: exact at the currency scale, never silently altered', () => {
  it('accepts trailing zeros and refuses a lost non-zero digit', () => {
    expect(exactToScale('1.237', 3)).toBe(1237n);
    expect(exactToScale('1.2370', 3)).toBe(1237n);
    expect(exactToScale('1.23700000', 3)).toBe(1237n);
    expect(exactToScale('1.2371', 3)).toBeNull();
    expect(exactToScale('5.00', 0)).toBe(5n);
    expect(exactToScale('5.10', 0)).toBeNull();
    expect(exactToScale(1.237, 3)).toBe(1237n);
    expect(exactToScale(1.2371, 3)).toBeNull();
    expect(exactToScale('-0.5', 1)).toBe(-5n);
  });

  it('refuses text that is not a decimal', () => {
    for (const bad of ['', 'abc', '1,5', '1e3', '--1', '1.']) expect(() => exactToScale(bad, 2)).toThrow(DecimalError);
    expect(() => exactToScale(Number.NaN, 2)).toThrow(DecimalError);
  });
});

describe('Money: a currency\'s own decimals', () => {
  const kwd = moneyOf('kwd', 3);
  const usd = moneyOf('USD', 2);
  const jpy = moneyOf('JPY', 0);

  it('writes and rounds at the currency\'s scale', () => {
    expect(kwd.text(1.237)).toBe('1.237');
    expect(kwd.text(1.2375)).toBe('1.238');
    expect(kwd.text(-1.2375)).toBe('-1.238');
    expect(usd.text(1.237)).toBe('1.24');
    expect(jpy.text(1.5)).toBe('2');
    expect(jpy.text(1234)).toBe('1234');
    expect(kwd.round(0.1 + 0.2)).toBe(0.3);
    expect(kwd.code).toBe('KWD');
  });

  it('refuses an entered amount that would lose a digit, with an actionable message', () => {
    expect(kwd.entered('1.237')).toBe(1237n);
    expect(() => kwd.entered('1.2371', 'The net amount')).toThrow(/The net amount 1\.2371 has more decimal places than KWD allows \(3\)/);
    expect(() => usd.entered(1.237)).toThrow(MoneyError);
    expect(() => jpy.entered('10.5')).toThrow(/more decimal places than JPY allows \(0\)/);
    try { jpy.entered('10.5'); } catch (error) { expect((error as MoneyError).remedy).toMatch(/no minor unit: enter a whole amount/); }
    expect(jpy.entered('10.0')).toBe(10n);
  });

  it('calculates a percentage once, exactly', () => {
    expect(kwd.percentOf('1.237', 10)).toBe(124n); // 0.1237 → 0.124
    expect(kwd.percentOf('2.5', 10)).toBe(250n);
    expect(usd.percentOf('0.15', 10)).toBe(2n); // 0.015 → 0.02, half away from zero
    expect(usd.percentOf('-0.15', 10)).toBe(-2n);
    expect(jpy.percentOf('15', 10)).toBe(2n); // 1.5 → 2
    expect(kwd.percentOf('100000000000', 15)).toBe(15000000000000n);
  });

  it('extends quantity × price ÷ price unit without rounding the price first', () => {
    expect(kwd.extend('3', '1.2375', '1')).toBe(3713n); // 3.7125 → 3.713
    expect(kwd.extend('0.5', '1.237', '1')).toBe(619n); // 0.6185 → 0.619
    expect(kwd.extend('1000', '0.5', '100')).toBe(5000n);
    expect(usd.extend('3', '0.335', '1')).toBe(101n); // 1.005 → 1.01
    expect(() => kwd.extend('1', '1', '0')).toThrow(MoneyError);
  });

  it('refuses a currency the columns cannot store', () => {
    expect(assertStorableScale('KWD', 3)).toBe(3);
    expect(assertStorableScale('XYZ', 4)).toBe(4);
    expect(() => assertStorableScale('XYZ', 5)).toThrow(/stored with at most 4/);
    expect(() => assertStorableScale('XYZ', -1)).toThrow(MoneyError);
    expect(() => moneyOf('XYZ', 6)).toThrow(MoneyError);
  });
});

describe('allocation: the parts add up, the remainder lands in one place', () => {
  it('splits a total exactly and deterministically', () => {
    const parts = allocateUnits(1000n, [1n, 1n, 1n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1000n);
    expect(parts).toEqual([334n, 333n, 333n]); // 333.33 each: the 1 left over goes to the first of the largest weights
    expect(allocateUnits(1n, [1n, 1n])).toEqual([0n, 1n]); // each half rounds up to 1; the surplus 1 comes off the first part
    expect(allocateUnits(-1000n, [1n, 1n, 1n]).reduce((a, b) => a + b, 0n)).toBe(-1000n);
    expect(allocateUnits(100n, [70n, 20n, 10n])).toEqual([70n, 20n, 10n]);
  });

  it('refuses nothing to allocate across', () => {
    expect(() => allocateUnits(1n, [])).toThrow(MoneyError);
    expect(() => allocateUnits(1n, [0n, 0n])).toThrow(MoneyError);
  });
});

describe('display: decimals come from the server, formatting is exact', () => {
  it('writes the currency\'s decimals, not two', () => {
    expect(fmt(1.2, 3)).toBe('1.200');
    expect(fmt('1.237', 3)).toBe('1.237');
    expect(fmt(1.005, 2)).toBe('1.01');
    expect(fmt(1234, 0)).toBe('1234');
    expect(fmt(-0.0005, 3)).toBe('-0.001');
    expect(fmt(null, 2)).toBe('');
    expect(fmtIn(1.2, 'KWD', { KWD: 3, USD: 2 })).toBe('1.200');
    expect(fmtIn(1.2, 'USD', { KWD: 3, USD: 2 })).toBe('1.20');
    expect(fmtIn(1.2, 'ZZZ', { KWD: 3 })).toBe('1.20');
  });

  it('shows a running figure with at least two decimals and as many more as it carries', () => {
    expect(fmtFlex(1.237)).toBe('1.237');
    expect(fmtFlex(100)).toBe('100.00');
    expect(fmtFlex(1.5)).toBe('1.50');
    expect(fmtFlex(0.005)).toBe('0.005');
  });
});
