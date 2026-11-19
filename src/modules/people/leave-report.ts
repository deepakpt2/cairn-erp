/**
 * Leave balance report for chosen employees, and its CSV.
 *
 * Authority is judged before anything is read: PEOPLE.LEAVE.VIEW for the report, PEOPLE.LEAVE.EXPORT for the
 * CSV, then the employee's company reach over the report year. An employee the caller cannot reach never
 * contributes a row, a total, a count, a group member or an absence. A requested number that is not available
 * is answered with the same wording whether it does not exist or lies outside scope.
 *
 * Figures come from the immutable ledger only (never from the leave_quota projection), so every row
 * reconciles: accrued + adjusted + expired − taken = available. The projection is compared separately.
 *
 * As-of semantics: a posting counts when its business effective date is on or before the as-of day. Postings
 * recorded after the as-of day but effective on or before it are counted and reported as `lateEntries`, so a
 * restated historical figure is never presented as what was known then. A future as-of is refused: projected
 * days are never shown as earned and never feed an approval.
 */
import { sql } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import {
  LEAVE_EXPORT, LEAVE_VIEW, type LeaveAccess, type LeaveGrant, judgeLeave, reachesEmployee, refuse,
} from './leave-access';
import { tenantToday } from './leave-accrual';
import { fromScaled, nextCreditMonthEnd, toScaled } from './leave-math';
import { resolveLeaveSegments } from './leave-policy';

export const REPORT_MAX_EMPLOYEES = 100;
export const REPORT_MAX_LINES = 3000;

export interface LeaveReportInput {
  client: string;
  /** Personnel numbers chosen by the user. */
  personnelNumbers?: readonly string[];
  /** Optional: everyone who is a member of this leave group during the year. */
  groupCode?: string;
  /** Report year; defaults to the year of the as-of day. */
  year?: number;
  /** Business day (YYYY-MM-DD); defaults to today in the tenant time zone. */
  asOf?: string;
}

export interface ReportLine {
  id: string;
  entryKind: string;
  effectiveDate: string;
  quantity: string;
  cumulative: string;
  policyCode: string | null;
  policyVersion: number | null;
  absenceId: string | null;
  sourceKey: string;
  recordedAt: string;
  /** Recorded after the as-of day although effective on or before it. */
  late: boolean;
  note: string | null;
}

export interface ReportRow {
  personnelNumber: string;
  fullName: string;
  timeTypeCode: string;
  year: number;
  mode: 'POLICY' | 'LEGACY';
  policyCode: string | null;
  policyVersion: number | null;
  policySource: 'PERSON' | 'GROUP' | null;
  /** The yearly allowance of the policy line: a target, never spendable. */
  annualTarget: string | null;
  opening: string;
  accrued: string;
  granted: string;
  adjusted: string;
  taken: string;
  expired: string;
  available: string;
  /** Requested but not yet approved days. Pending requests reserve nothing, so this is information only. */
  pending: string;
  lastCredit: string | null;
  nextCredit: string | null;
  /** accrued-to-date + opening + granted + adjusted + expired − taken, as text, for the reader. */
  formula: string;
  /** Ledger total equals the figure shown; false is a defect to report. */
  reconciled: boolean;
  limitation: string | null;
  lateEntries: number;
  lines: ReportLine[];
}

export interface LeaveReport {
  asOf: string;
  year: number;
  timezone: string;
  generatedAt: string;
  rows: ReportRow[];
  /** Numbers the caller asked for that are not available to them. One wording for every cause. */
  unavailable: string[];
  /** Employees included (after authority). */
  employeeCount: number;
  truncated: { employees: boolean; lines: boolean };
  /** Projection (leave_quota) disagreements found among the reported rows. */
  projectionDrift: Array<{ personnelNumber: string; timeTypeCode: string; year: number; ledger: string; projection: string }>;
  basis: string;
}

const BASIS = 'Figures come from the immutable leave ledger. A posting counts when its effective date is on or before the as-of day; '
  + 'postings recorded later but effective on or before it are counted and marked late. Annual allowance is a target, not a balance. '
  + 'Pending requests reserve nothing. Legacy quotas have no ledger history before conversion.';

function dec(scaled: bigint): string {
  return fromScaled(scaled);
}
function sum(values: readonly string[]): bigint {
  return values.reduce((a, v) => a + toScaled(v), 0n);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The people asked for (numbers and/or group), then only those the caller reaches, at most `max`. */
async function selectPeople(
  tx: Tx, grant: LeaveGrant, input: LeaveReportInput, yearFrom: string, yearTo: string, max: number,
): Promise<{ people: string[]; unavailable: string[]; employeesTruncated: boolean }> {
  const client = input.client;
  const requested = [...new Set((input.personnelNumbers ?? []).map((n) => n.trim()).filter(Boolean))];
  if (requested.length === 0 && !input.groupCode) {
    refuse('NO_SELECTION', 'No employee or group was chosen.', 'Choose one or more employees, or a leave group.');
  }
  if (requested.length > max) {
    refuse('TOO_MANY_EMPLOYEES', `${requested.length} employees were chosen; the report takes at most ${max}.`, 'Narrow the selection or run it in parts.');
  }
  const candidates = new Set<string>();
  const unavailable: string[] = [];
  if (requested.length > 0) {
    const known = (await tx.execute(sql`
      select personnel_number as pn from employee
       where client = ${client} and personnel_number in (${sql.join(requested.map((n) => sql`${n}`), sql`, `)})
    `)) as unknown as Array<{ pn: string }>;
    const exist = new Set(known.map((k) => k.pn));
    for (const n of requested) {
      if (exist.has(n) && (await reachesEmployee(tx, client, grant, n, yearFrom, yearTo))) candidates.add(n);
      else unavailable.push(n);
    }
  }
  let employeesTruncated = false;
  if (input.groupCode) {
    const members = (await tx.execute(sql`
      select distinct personnel_number as pn from leave_group_member
       where client = ${client} and group_code = ${input.groupCode}
         and valid_from <= ${yearTo}::date and coalesce(valid_to, date '9999-12-31') >= ${yearFrom}::date
       order by 1
    `)) as unknown as Array<{ pn: string }>;
    for (const m of members) {
      if (candidates.has(m.pn)) continue;
      if (!(await reachesEmployee(tx, client, grant, m.pn, yearFrom, yearTo))) continue; // silently out of scope
      if (candidates.size >= max) { employeesTruncated = true; break; }
      candidates.add(m.pn);
    }
  }
  return { people: [...candidates], unavailable, employeesTruncated };
}

async function buildReport(
  tx: Tx, grant: LeaveGrant, input: LeaveReportInput, at: Date,
): Promise<LeaveReport> {
  const client = input.client;
  const { timezone, today } = await tenantToday(tx, client, at);
  const asOf = input.asOf ?? today;
  if (!validDate(asOf)) refuse('INVALID_AS_OF', `"${asOf}" is not a valid date.`, 'Use the form YYYY-MM-DD.');
  if (asOf > today) {
    refuse('AS_OF_IN_FUTURE', `The as-of day ${asOf} is after today (${today}, ${timezone}).`,
      'Choose today or an earlier day. Projected days are never shown as earned.');
  }
  const year = input.year ?? Number(asOf.slice(0, 4));
  if (!Number.isInteger(year) || year < 1901 || year > 2099) refuse('INVALID_YEAR', `"${input.year}" is not a valid year.`, 'Enter a year between 1901 and 2099.');
  if (year > Number(asOf.slice(0, 4))) {
    refuse('YEAR_AFTER_AS_OF', `Year ${year} starts after the as-of day ${asOf}.`, 'Choose a year that has begun by the as-of day.');
  }
  const yearFrom = `${year}-01-01`;
  const yearTo = `${year}-12-31`;

  const picked = await selectPeople(tx, grant, input, yearFrom, yearTo, REPORT_MAX_EMPLOYEES);
  const { unavailable, employeesTruncated } = picked;
  const candidates = new Set(picked.people);
  const people = [...candidates].sort();
  const base: Omit<LeaveReport, 'rows' | 'employeeCount' | 'truncated' | 'projectionDrift'> = {
    asOf, year, timezone, generatedAt: at.toISOString(), unavailable, basis: BASIS,
  };
  if (people.length === 0) {
    return { ...base, rows: [], employeeCount: 0, truncated: { employees: false, lines: false }, projectionDrift: [] };
  }
  const list = sql.join(people.map((n) => sql`${n}`), sql`, `);

  // 2. Ledger lines for the year up to the as-of day, with a running total per person/type/year.
  type L = {
    id: string; pn: string; type: string; kind: string; eff: string; qty: string; cum: string; policy: string | null;
    version: number | null; absence: string | null; source: string; created: string; late: boolean; note: string | null;
  };
  const lines = (await tx.execute(sql`
    select id, personnel_number as pn, time_type_code as type, entry_kind as kind, effective_date::text as eff,
           quantity::text as qty,
           (sum(quantity) over (partition by personnel_number, time_type_code order by effective_date, created_at, id))::text as cum,
           policy_code as policy, policy_version as version, absence_id as absence, source_key as source,
           created_at::text as created,
           ((created_at at time zone ${timezone})::date > ${asOf}::date) as late, note
      from leave_ledger
     where client = ${client} and personnel_number in (${list}) and year = ${year} and effective_date <= ${asOf}::date
     order by personnel_number, time_type_code, effective_date, created_at, id
  `)) as unknown as L[];

  // 3. Names, pending requests and legacy quotas.
  const names = (await tx.execute(sql`
    select personnel_number as pn, full_name as name from employee where client = ${client} and personnel_number in (${list})
  `)) as unknown as Array<{ pn: string; name: string }>;
  const nameOf = new Map(names.map((n) => [n.pn, n.name]));
  const pendingRows = (await tx.execute(sql`
    select a.personnel_number as pn, a.time_type_code as type, coalesce(sum((least(coalesce(a.valid_to, a.valid_from), ${yearTo}::date) - greatest(a.valid_from, ${yearFrom}::date) + 1)), 0)::numeric(9,2)::text as days
      from absence a
     where a.client = ${client} and a.personnel_number in (${list}) and a.status = 'REQUESTED'
       and a.valid_from <= ${yearTo}::date and coalesce(a.valid_to, a.valid_from) >= ${yearFrom}::date
     group by 1, 2
  `)) as unknown as Array<{ pn: string; type: string; days: string }>;
  const pending = new Map(pendingRows.map((p) => [`${p.pn}|${p.type}`, p.days]));
  const legacy = (await tx.execute(sql`
    select personnel_number as pn, time_type_code as type, entitlement::text as entitlement, taken::text as taken, remaining::text as remaining
      from leave_quota
     where client = ${client} and personnel_number in (${list}) and year = ${year} and mode = 'LEGACY'
  `)) as unknown as Array<{ pn: string; type: string; entitlement: string; taken: string; remaining: string }>;

  // 4. One row per person/type with its ledger lines.
  const rows: ReportRow[] = [];
  let lineBudget = REPORT_MAX_LINES;
  let linesTruncated = false;
  const groups = new Map<string, L[]>();
  for (const l of lines) {
    const k = `${l.pn}|${l.type}`;
    const arr = groups.get(k);
    if (arr) arr.push(l); else groups.set(k, [l]);
  }
  const typeKeys = new Set<string>([...groups.keys(), ...legacy.map((l) => `${l.pn}|${l.type}`)]);
  const policyAt = asOf < yearTo ? asOf : yearTo;
  const segmentsByPerson = new Map<string, Awaited<ReturnType<typeof resolveLeaveSegments>>>();
  for (const pn of people) segmentsByPerson.set(pn, await resolveLeaveSegments(tx, client, pn, yearFrom, policyAt));

  for (const key of [...typeKeys].sort()) {
    const [pn, type] = key.split('|') as [string, string];
    const ledger = groups.get(key) ?? [];
    const leg = legacy.find((l) => l.pn === pn && l.type === type);
    const segs = segmentsByPerson.get(pn) ?? [];
    // The segment in force on the as-of day (or the last one of the year so far).
    const seg = [...segs].reverse().find((s) => s.from <= policyAt && s.to >= (ledger.at(-1)?.eff ?? yearFrom)) ?? segs.at(-1);
    const line = seg?.lines.get(type);
    const kinds = (k: string) => ledger.filter((l) => l.kind === k).map((l) => l.qty);
    const opening = sum(kinds('OPENING'));
    const accrued = sum(kinds('MONTHLY_ACCRUAL'));
    const granted = sum(kinds('ANNUAL_GRANT'));
    const adjusted = sum(kinds('ADJUSTMENT'));
    const expired = sum(kinds('EXPIRY'));
    const taken = -sum([...kinds('ABSENCE_DEBIT'), ...kinds('REVERSAL')]);
    const available = opening + accrued + granted + adjusted + expired - taken;
    const total = sum(ledger.map((l) => l.qty));
    const credits = ledger.filter((l) => l.kind === 'MONTHLY_ACCRUAL');
    const isLegacyOnly = ledger.length === 0 && !!leg;
    const keep = Math.max(0, Math.min(ledger.length, lineBudget));
    if (keep < ledger.length) linesTruncated = true;
    lineBudget -= keep;
    const lateCount = ledger.filter((l) => l.late).length;
    const row: ReportRow = {
      personnelNumber: pn,
      fullName: nameOf.get(pn) ?? '',
      timeTypeCode: type,
      year,
      mode: isLegacyOnly ? 'LEGACY' : 'POLICY',
      policyCode: seg?.policyCode ?? ledger.find((l) => l.policy)?.policy ?? null,
      policyVersion: seg?.version ?? ledger.find((l) => l.version)?.version ?? null,
      policySource: seg?.source ?? null,
      annualTarget: line ? dec(line.annualScaled) : null,
      opening: dec(isLegacyOnly ? toScaled(leg.entitlement) : opening),
      accrued: dec(accrued),
      granted: dec(granted),
      adjusted: dec(adjusted),
      taken: dec(isLegacyOnly ? toScaled(leg.taken) : taken),
      expired: dec(-expired),
      available: dec(isLegacyOnly ? toScaled(leg.remaining) : available),
      pending: pending.get(key) ?? '0.00',
      lastCredit: credits.at(-1)?.eff ?? null,
      nextCredit: line?.accrualMode === 'MONTHLY' && asOf < yearTo ? nextCreditMonthEnd(asOf) : null,
      formula: isLegacyOnly
        ? 'Hand-set entitlement − taken = available'
        : 'opening + accrued + granted + adjusted − expired − taken = available',
      reconciled: isLegacyOnly ? true : available === total,
      limitation: isLegacyOnly
        ? 'Legacy quota: a hand-set figure with no ledger history. It does not depend on the as-of day and cannot be reconciled to events.'
        : null,
      lateEntries: lateCount,
      lines: ledger.slice(0, keep).map((l) => ({
        id: l.id, entryKind: l.kind, effectiveDate: l.eff, quantity: l.qty, cumulative: l.cum,
        policyCode: l.policy, policyVersion: l.version === null ? null : Number(l.version), absenceId: l.absence,
        sourceKey: l.source, recordedAt: l.created, late: l.late, note: l.note,
      })),
    };
    rows.push(row);
  }

  // 5. Projection check, only for what is shown.
  const drift = (await tx.execute(sql`
    select l.personnel_number as pn, l.time_type_code as type, l.year, l.sum::text as ledger, q.remaining::text as projection
      from (select personnel_number, time_type_code, year, sum(quantity) from leave_ledger
             where client = ${client} and personnel_number in (${list}) and year = ${year} group by 1, 2, 3) l
      left join leave_quota q on q.client = ${client} and q.personnel_number = l.personnel_number
                             and q.time_type_code = l.time_type_code and q.year = l.year
     where q.remaining is distinct from l.sum
  `)) as unknown as Array<{ pn: string; type: string; year: number; ledger: string; projection: string }>;

  return {
    ...base,
    rows,
    employeeCount: people.length,
    truncated: { employees: employeesTruncated, lines: linesTruncated },
    projectionDrift: drift.map((d) => ({ personnelNumber: d.pn, timeTypeCode: d.type, year: Number(d.year), ledger: d.ledger, projection: d.projection })),
  };
}

export async function leaveBalanceReport(input: LeaveReportInput, access?: LeaveAccess, at: Date = new Date()): Promise<LeaveReport> {
  return withTenant(input.client, async (tx) => {
    const grant = await judgeLeave(tx, input.client, access, [LEAVE_VIEW]);
    return buildReport(tx, grant, input, at);
  });
}

// ── CSV ──────────────────────────────────────────────────────────────────────
/** A text cell: quoted, and neutralised when a spreadsheet could read it as a formula. */
export function csvText(value: string | null | undefined): string {
  let v = (value ?? '').replace(/\r\n|\r|\n|\t/g, ' ');
  if (/^[\s]*[=+\-@\u0009\u000d]/.test(v) || /^[\s]*[|%]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}
/** A number cell: only a plain decimal is written as it is; anything else becomes safe text. */
export function csvNumber(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return /^-?\d{1,9}(\.\d{1,2})?$/.test(value) ? value : csvText(value);
}

const HEADER = [
  'Personnel number', 'Name', 'Type', 'Year', 'Source', 'Policy', 'Version', 'Policy from', 'As of', 'Annual target',
  'Opening', 'Accrued', 'Granted', 'Adjusted', 'Taken', 'Expired', 'Available', 'Pending (not reserved)',
  'Last credit', 'Next credit', 'Reconciled', 'Late entries', 'Limitation',
];

/** Header and one line per row, as CSV text lines. */
function csvLines(report: LeaveReport): string[] {
  const out: string[] = [HEADER.map(csvText).join(',')];
  for (const r of report.rows) {
    out.push([
      csvText(r.personnelNumber), csvText(r.fullName), csvText(r.timeTypeCode), csvNumber(String(r.year)), csvText(r.mode),
      csvText(r.policyCode), csvNumber(r.policyVersion === null ? '' : String(r.policyVersion)), csvText(r.policySource ?? ''),
      csvText(report.asOf), csvNumber(r.annualTarget),
      csvNumber(r.opening), csvNumber(r.accrued), csvNumber(r.granted), csvNumber(r.adjusted), csvNumber(r.taken),
      csvNumber(r.expired), csvNumber(r.available), csvNumber(r.pending),
      csvText(r.lastCredit), csvText(r.nextCredit), csvText(r.reconciled ? 'yes' : 'NO'), csvNumber(String(r.lateEntries)),
      csvText(r.limitation),
    ].join(','));
  }
  return out;
}

/** The same report as the screen, as UTF-8 CSV text. Judged for PEOPLE.LEAVE.EXPORT as well as the selection's reach. */
export async function leaveBalanceCsv(input: LeaveReportInput, access?: LeaveAccess, at: Date = new Date()): Promise<{ filename: string; body: string; rows: number }> {
  const report = await withTenant(input.client, async (tx) => {
    const grant = await judgeLeave(tx, input.client, access, [LEAVE_VIEW]);
    await judgeLeave(tx, input.client, access, [LEAVE_EXPORT]);
    return buildReport(tx, grant, input, at);
  });
  const out = csvLines(report);
  if (report.unavailable.length > 0 || report.truncated.employees) {
    out.push('');
    if (report.unavailable.length > 0) out.push(csvText(`Not available to you: ${report.unavailable.join(', ')}`));
    if (report.truncated.employees) out.push(csvText(`Partial: the selection was cut at ${REPORT_MAX_EMPLOYEES} employees.`));
  }
  const body = `﻿${out.join('\r\n')}\r\n`;
  return { filename: `leave-balances-${report.asOf}.csv`, body, rows: report.rows.length };
}

// ── large export (runs in the INTENSIVE worker, see leave-export.ts) ─────────
export const EXPORT_MAX_EMPLOYEES = 5000;
const EXPORT_BATCH = 100;

/**
 * The CSV for a selection too large for the synchronous path: the same people-resolution and authority rules,
 * built in batches of 100 so no single report is large. The caller has judged VIEW and EXPORT.
 */
export async function buildLargeCsv(
  tx: Tx, grant: LeaveGrant, input: LeaveReportInput, at: Date,
): Promise<{ filename: string; body: string; rows: number; asOf: string; unavailable: string[]; truncated: boolean }> {
  const { today } = await tenantToday(tx, input.client, at);
  const asOf = input.asOf ?? today;
  // The first batch call validates dates; resolve the people here with the same checks by reading year.
  const year = input.year ?? Number(asOf.slice(0, 4));
  const picked = await selectPeople(tx, grant, input, `${year}-01-01`, `${year}-12-31`, EXPORT_MAX_EMPLOYEES);
  const people = picked.people.sort();
  let out: string[] = [];
  let rows = 0;
  let first: LeaveReport | null = null;
  for (let i = 0; i < Math.max(people.length, 1); i += EXPORT_BATCH) {
    const slice = people.slice(i, i + EXPORT_BATCH);
    if (slice.length === 0 && i > 0) break;
    const report = slice.length === 0
      ? await buildReport(tx, grant, { client: input.client, personnelNumbers: ['-'], year, asOf }, at)
      : await buildReport(tx, grant, { client: input.client, personnelNumbers: slice, year, asOf }, at);
    first ??= report;
    const lines = csvLines(report);
    out = out.length === 0 ? lines : out.concat(lines.slice(1));
    rows += report.rows.length;
  }
  if (picked.unavailable.length > 0 || picked.employeesTruncated) {
    out.push('');
    if (picked.unavailable.length > 0) out.push(csvText(`Not available to you: ${picked.unavailable.join(', ')}`));
    if (picked.employeesTruncated) out.push(csvText(`Partial: the selection was cut at ${EXPORT_MAX_EMPLOYEES} employees.`));
  }
  return {
    filename: `leave-balances-${first?.asOf ?? asOf}.csv`, body: `\uFEFF${out.join('\r\n')}\r\n`, rows,
    asOf: first?.asOf ?? asOf, unavailable: picked.unavailable, truncated: picked.employeesTruncated,
  };
}
