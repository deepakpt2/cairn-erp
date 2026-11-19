/**
 * Leave arithmetic — pure, exact, no database.
 *
 * Quantities are integers scaled by 100 (two decimals, the precision of leave_ledger). Fractions of a
 * month are exact rationals (BigInt numerator/denominator), rounded ONCE, half up, when a cumulative
 * entitlement is turned into a posted amount. A month's credit is
 *
 *     round(E_m) − round(E_{m−1})        with E_m = Σ exact entitlement of months 1..m of the year
 *
 * so a fully eligible year always credits exactly the configured annual allowance (the residual lands
 * in the month where rounding closes it, never as a year-end bonus), and a catch-up run computes the
 * same credits as on-time runs because each month depends only on the segments, never on the ledger.
 *
 * Day counting is CALENDAR days only. Nothing here reads a work schedule or a factory calendar.
 */

export type PartialMonthMode = 'PRORATE_DAYS' | 'FULL_IF_ANY';
export const SCALE = 100n;

// ── dates (plain YYYY-MM-DD arithmetic, never through a timezone) ─────────────
export function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}
export function isoOf(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
  return isoOf(dayNumber(day) + n);
}
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export function monthStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}
export function monthEnd(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
}
export function daysInYear(year: number): number {
  return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
}
/** Inclusive calendar days of a closed span. */
export function spanDays(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from) + 1;
}

// ── time zone ────────────────────────────────────────────────────────────────
/** Is this a real IANA zone the runtime knows? */
export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return zone.trim().length > 0;
  } catch {
    return false;
  }
}
/** The calendar day it is in `zone` at instant `at`. */
export function localDate(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
/** A month is complete — and its credit due — only once the local date is past its last day. */
export function monthIsComplete(year: number, month: number, today: string): boolean {
  return today > monthEnd(year, month);
}
/** The last month that is complete on a local day, as [year, month]. */
export function lastCompleteMonth(today: string): [number, number] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? [y - 1, 12] : [y, m - 1];
}
/** The month end whose passing will trigger the next credit: the end of the current local month. */
export function nextCreditMonthEnd(today: string): string {
  return monthEnd(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
}

// ── rationals ────────────────────────────────────────────────────────────────
export interface Rational { n: bigint; d: bigint }
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b) [a, b] = [b, a % b];
  return a;
}
export function rat(n: bigint, d = 1n): Rational {
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}
export function addRat(a: Rational, b: Rational): Rational {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}
export function mulRat(a: Rational, b: Rational): Rational {
  return rat(a.n * b.n, a.d * b.d);
}
/** Round a non-negative rational (already ×100-scaled) half up to an integer. */
export function roundHalfUp(r: Rational): bigint {
  return (2n * r.n + r.d) / (2n * r.d);
}
/** "12.5" → 1250n. Refuses more than two decimals. */
export function toScaled(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`Not a quantity with at most two decimals: ${value}`);
  const v = BigInt(m[2]!) * SCALE + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -v : v;
}
export function fromScaled(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / SCALE}.${String(a % SCALE).padStart(2, '0')}`;
}

// ── accrual ──────────────────────────────────────────────────────────────────
/** One stretch of eligibility under one policy line. `to` null = open. Quantities are annual days ×100. */
export interface LineSegment {
  from: string;
  to: string | null;
  annualScaled: bigint;
  mode: PartialMonthMode;
}

function clip(seg: LineSegment, from: string, to: string): [string, string] | null {
  const a = seg.from > from ? seg.from : from;
  const b = seg.to !== null && seg.to < to ? seg.to : to;
  return a <= b ? [a, b] : null;
}

/** The exact entitlement (×100, rational) a segment list earns in one calendar month. */
export function monthEntitlement(segments: readonly LineSegment[], year: number, month: number): Rational {
  const from = monthStart(year, month);
  const to = monthEnd(year, month);
  const dim = BigInt(daysInMonth(year, month));
  let total = rat(0n);
  let lastEligible: { day: string; seg: LineSegment } | null = null;
  for (const seg of segments) {
    const c = clip(seg, from, to);
    if (!c) continue;
    if (!lastEligible || c[1] >= lastEligible.day) lastEligible = { day: c[1], seg };
    if (seg.mode === 'PRORATE_DAYS') {
      total = addRat(total, rat(seg.annualScaled * BigInt(spanDays(c[0], c[1])), 12n * dim));
    }
  }
  // FULL_IF_ANY: one full month's credit from the line in effect on the last eligible day (never summed twice).
  if (lastEligible && lastEligible.seg.mode === 'FULL_IF_ANY') {
    total = addRat(total, rat(lastEligible.seg.annualScaled, 12n));
  }
  return total;
}

/** Σ exact entitlement of months 1..through of the year. */
export function cumulativeEntitlement(segments: readonly LineSegment[], year: number, through: number): Rational {
  let total = rat(0n);
  for (let m = 1; m <= through; m++) total = addRat(total, monthEntitlement(segments, year, m));
  return total;
}

/** The credit (×100) for one completed month: round(E_m) − round(E_{m−1}). Never negative. */
export function monthlyCredit(segments: readonly LineSegment[], year: number, month: number): bigint {
  const now = roundHalfUp(cumulativeEntitlement(segments, year, month));
  const before = month === 1 ? 0n : roundHalfUp(cumulativeEntitlement(segments, year, month - 1));
  const credit = now - before;
  return credit > 0n ? credit : 0n;
}

/**
 * One upfront annual grant (×100) for a year: from the first eligible day in the year, prorated by
 * calendar days of the year when PRORATE_DAYS, the full annual amount when FULL_IF_ANY.
 */
export function annualGrant(
  seg: LineSegment, year: number,
): { amount: bigint; effective: string } | null {
  const c = clip(seg, `${year}-01-01`, `${year}-12-31`);
  if (!c) return null;
  const amount = seg.mode === 'FULL_IF_ANY'
    ? seg.annualScaled
    : roundHalfUp(rat(seg.annualScaled * BigInt(spanDays(c[0], `${year}-12-31`)), BigInt(daysInYear(year))));
  return { amount, effective: c[0] };
}

// ── allocation of an absence across quotas ───────────────────────────────────
export interface ChainStep { typeCode: string; isPaid: boolean }
export interface AllocRange {
  from: string;
  to: string;
  policyCode: string;
  policyVersion: number;
  /** chain[0] is the requested type; the rest are its configured fallbacks, in order. */
  chain: readonly ChainStep[];
}
export interface AllocSpan {
  from: string;
  to: string;
  days: number;
  typeCode: string;
  year: number;
  isPaid: boolean;
  policyCode: string;
  policyVersion: number;
}
export interface AllocResult {
  spans: AllocSpan[];
  /** Calendar days no quota in the chain could cover. The request must be refused when this is not empty. */
  uncovered: string[];
}

/**
 * Charge each calendar day, in date order, to the first quota in its chain with a whole day left, per
 * year. `remaining` maps `${type}/${year}` to the available ×100 and is NOT modified (a copy is used).
 * Paid days therefore come first and the fallback's days follow; a type's balance is one bucket, so
 * annual overflow and a separate request for the same fallback type consume the same number.
 */
export function allocate(ranges: readonly AllocRange[], remaining: ReadonlyMap<string, bigint>): AllocResult {
  const left = new Map(remaining);
  const spans: AllocSpan[] = [];
  const uncovered: string[] = [];
  for (const range of ranges) {
    for (let n = dayNumber(range.from); n <= dayNumber(range.to); n++) {
      const day = isoOf(n);
      const year = Number(day.slice(0, 4));
      const step = range.chain.find((s) => (left.get(`${s.typeCode}/${year}`) ?? 0n) >= SCALE);
      if (!step) {
        uncovered.push(day);
        continue;
      }
      const key = `${step.typeCode}/${year}`;
      left.set(key, left.get(key)! - SCALE);
      const last = spans[spans.length - 1];
      if (last && last.typeCode === step.typeCode && last.year === year && last.isPaid === step.isPaid
        && last.policyCode === range.policyCode && last.policyVersion === range.policyVersion
        && dayNumber(last.to) + 1 === n) {
        last.to = day;
        last.days += 1;
      } else {
        spans.push({
          from: day, to: day, days: 1, typeCode: step.typeCode, year, isPaid: step.isPaid,
          policyCode: range.policyCode, policyVersion: range.policyVersion,
        });
      }
    }
  }
  return { spans, uncovered };
}
