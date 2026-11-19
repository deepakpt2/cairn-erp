import { describe, expect, it } from 'vitest';

import {
  allocate, annualGrant, fromScaled, isValidTimezone, lastCompleteMonth, localDate, monthIsComplete,
  monthlyCredit, toScaled, type LineSegment,
} from '../src/modules/people/leave-math';

const seg = (annual: string, from: string, to: string | null = null, mode: LineSegment['mode'] = 'PRORATE_DAYS'): LineSegment =>
  ({ from, to, annualScaled: toScaled(annual), mode });

function yearCredits(segments: LineSegment[], year: number): bigint[] {
  return Array.from({ length: 12 }, (_, i) => monthlyCredit(segments, year, i + 1));
}
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe('monthly accrual', () => {
  it('24 days a year credits 2 per completed month and exactly 24 at year end', () => {
    const credits = yearCredits([seg('24', '2026-01-01')], 2026);
    expect(credits.every((c) => c === 200n)).toBe(true);
    expect(fromScaled(sum(credits))).toBe('24.00');
  });

  it('a non-divisible 25 a year closes at exactly 25 without a year-end bonus', () => {
    const credits = yearCredits([seg('25', '2026-01-01')], 2026);
    expect(fromScaled(sum(credits))).toBe('25.00');
    const biggest = credits.reduce((a, b) => (a > b ? a : b));
    expect(biggest - credits.reduce((a, b) => (a < b ? a : b))).toBeLessThanOrEqual(1n);
  });

  it('prorates a mid-month join by calendar days, including a leap February', () => {
    // joins 2028-02-15: 15 of 29 days of February at 2 days/month
    const c = monthlyCredit([seg('24', '2028-02-15')], 2028, 2);
    expect(c).toBe(103n); // 200 * 15/29 = 103.4 → 1.03
    expect(monthlyCredit([seg('24', '2028-02-15')], 2028, 1)).toBe(0n);
  });

  it('FULL_IF_ANY gives a whole month for any eligible day, once', () => {
    expect(monthlyCredit([seg('24', '2026-03-31', null, 'FULL_IF_ANY')], 2026, 3)).toBe(200n);
  });

  it('a leaver is prorated and later months credit nothing', () => {
    const s = [seg('24', '2026-01-01', '2026-06-10')];
    expect(monthlyCredit(s, 2026, 6)).toBe(67n); // 200 * 10/30
    expect(monthlyCredit(s, 2026, 7)).toBe(0n);
  });

  it('a policy change inside a month sums the two segments and never doubles', () => {
    const s = [seg('24', '2026-01-01', '2026-04-14'), seg('36', '2026-04-15')];
    // April: 24/12*14/30 + 36/12*16/30 = 0.9333 + 1.6 = 2.5333 days
    const credits = yearCredits(s, 2026);
    expect(fromScaled(credits[3]!)).toBe('2.53');
    expect(fromScaled(sum(credits))).toBe('32.53'); // Jan-Mar 6 + Apr 2.5333 + May-Dec 24
  });

  it('is independent of when it is run (catch-up equals on-time)', () => {
    const s = [seg('25', '2026-01-01')];
    const onTime = yearCredits(s, 2026);
    const again = yearCredits(s, 2026);
    expect(again).toEqual(onTime);
  });
});

describe('annual upfront', () => {
  it('grants the full amount from January, prorated from a mid-year start', () => {
    expect(annualGrant(seg('12', '2026-01-01'), 2026)).toEqual({ amount: 1200n, effective: '2026-01-01' });
    const g = annualGrant(seg('12', '2026-07-02'), 2026)!;
    expect(g.effective).toBe('2026-07-02');
    expect(g.amount).toBe(602n); // 183/365 * 12 = 6.0164
  });
});

describe('tenant-local month end', () => {
  it('rejects an unknown zone', () => {
    expect(isValidTimezone('Asia/Kuwait')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
  it('credits only after the local month has ended', () => {
    // 2026-02-28 23:30 UTC is already 2026-03-01 in Kuwait (UTC+3) but still Feb 28 in UTC.
    const at = new Date('2026-02-28T23:30:00Z');
    expect(localDate(at, 'Asia/Kuwait')).toBe('2026-03-01');
    expect(localDate(at, 'UTC')).toBe('2026-02-28');
    expect(monthIsComplete(2026, 2, localDate(at, 'Asia/Kuwait'))).toBe(true);
    expect(monthIsComplete(2026, 2, localDate(at, 'UTC'))).toBe(false);
    expect(monthIsComplete(2028, 2, '2028-02-28')).toBe(false); // leap year: Feb 29 still to come
    expect(monthIsComplete(2028, 2, '2028-02-29')).toBe(false);
    expect(monthIsComplete(2028, 2, '2028-03-01')).toBe(true);
    expect(lastCompleteMonth('2026-01-15')).toEqual([2025, 12]);
  });
});

describe('allocation', () => {
  const chain = [{ typeCode: 'ANNUAL', isPaid: true }, { typeCode: 'UNPAID', isPaid: false }];
  const range = { from: '2026-05-01', to: '2026-05-08', policyCode: 'P', policyVersion: 1, chain };

  it('3 paid annual days then 5 days from the shared unpaid balance', () => {
    const r = allocate([range], new Map([['ANNUAL/2026', 300n], ['UNPAID/2026', 1500n]]));
    expect(r.uncovered).toEqual([]);
    expect(r.spans.map((s) => [s.typeCode, s.days, s.isPaid])).toEqual([['ANNUAL', 3, true], ['UNPAID', 5, false]]);
  });

  it('reports uncovered days instead of overdrawing', () => {
    const r = allocate([range], new Map([['ANNUAL/2026', 300n], ['UNPAID/2026', 200n]]));
    expect(r.uncovered).toHaveLength(3);
  });

  it('charges each year to its own quota across New Year', () => {
    const r = allocate(
      [{ ...range, from: '2026-12-30', to: '2027-01-02', chain: [chain[0]!] }],
      new Map([['ANNUAL/2026', 200n], ['ANNUAL/2027', 200n]]),
    );
    expect(r.spans.map((s) => [s.year, s.days])).toEqual([[2026, 2], [2027, 2]]);
  });

  it('a fractional leftover cannot fund a calendar day', () => {
    const r = allocate([{ ...range, to: '2026-05-01', chain: [chain[0]!] }], new Map([['ANNUAL/2026', 99n]]));
    expect(r.uncovered).toEqual(['2026-05-01']);
  });
});
