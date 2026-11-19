/**
 * The leave ledger: the one place balances change, and the reads that explain them.
 *
 * `leave_ledger` rows are immutable (a trigger refuses UPDATE and DELETE). `leave_quota` is a projection a
 * trigger rewrites on every insert; this module never writes it directly. A correction is a new row:
 * ADJUSTMENT (signed), or REVERSAL of an ABSENCE_DEBIT.
 *
 * Every posting carries a `source_key`, unique per tenant, so a retried or concurrent run cannot credit twice:
 *   ACCR/<pn>/<type>/<yyyy-mm>      monthly accrual
 *   GRANT/<pn>/<type>/<year>        annual upfront grant
 *   EXP/<pn>/<type>/<year>          year-end expiry (no carry-over)
 *   OPEN/<pn>/<type>/<year>         opening balance of a converted legacy quota
 *   ADJ/<request key>               a manual adjustment (the caller's own idempotency key)
 *   ABS/<absence id>/<span id>      an absence debit, REV/... its reversal
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  LEAVE_ADJUST, LEAVE_VIEW, type LeaveAccess, type LeaveGrant, actorOf, assertReachesEmployee, judgeLeave, refuse,
} from './leave-access';
import { fromScaled, isValidTimezone, localDate, toScaled } from './leave-math';

export type EntryKind = 'OPENING' | 'MONTHLY_ACCRUAL' | 'ANNUAL_GRANT' | 'ADJUSTMENT' | 'EXPIRY' | 'ABSENCE_DEBIT' | 'REVERSAL';
export type SourceKind = 'ACCRUAL' | 'CONVERSION' | 'ADJUSTMENT' | 'ABSENCE' | 'YEAR_END';

export interface LedgerPosting {
  client: string;
  personnelNumber: string;
  timeTypeCode: string;
  year: number;
  entryKind: EntryKind;
  effectiveDate: string;
  /** Days ×100, signed per the entry kind (the table's check enforces the sign). */
  quantity: bigint;
  policyCode?: string | null;
  policyVersion?: number | null;
  sourceKind: SourceKind;
  sourceKey: string;
  absenceId?: string | null;
  note?: string | null;
  createdBy: string;
}

/** Per-employee lock shared by accrual, absence approval, adjustment and conversion. */
export async function lockEmployeeLeave(tx: Tx, client: string, personnelNumber: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/leave/${personnelNumber}`}, 0))`);
}

/** Post one entry. Returns false when the source key already exists (the posting is a no-op). */
export async function postLedgerEntry(tx: Tx, p: LedgerPosting): Promise<boolean> {
  const rows = (await tx.execute(sql`
    insert into leave_ledger (client, id, personnel_number, time_type_code, year, entry_kind, effective_date, quantity,
                              policy_code, policy_version, source_kind, source_key, absence_id, note, created_by)
    values (${p.client}, ${randomUUID()}, ${p.personnelNumber}, ${p.timeTypeCode}, ${p.year}, ${p.entryKind}, ${p.effectiveDate}::date,
            ${fromScaled(p.quantity)}::numeric, ${p.policyCode ?? null}, ${p.policyVersion ?? null}, ${p.sourceKind}, ${p.sourceKey},
            ${p.absenceId ?? null}, ${p.note ?? null}, ${p.createdBy})
    on conflict (client, source_key) do nothing
    returning id
  `)) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

// ── reads ────────────────────────────────────────────────────────────────────
export interface QuotaBalance {
  personnelNumber: string;
  timeTypeCode: string;
  year: number;
  mode: 'LEGACY' | 'POLICY';
  /** Ledger sums ×100 as decimal strings; for a LEGACY quota these are the hand-set quota figures. */
  accrued: string;
  adjusted: string;
  expired: string;
  taken: string;
  remaining: string;
}

/**
 * Balances as of a date, straight from the ledger (never from the projection), so an as-of figure and the
 * current figure come from the same rows. LEGACY quotas have no ledger: their stored figures are returned
 * as they are, whatever the as-of date, and labelled LEGACY.
 */
export async function balancesAsOf(
  tx: Tx, client: string, personnelNumber: string, asOf: string,
): Promise<QuotaBalance[]> {
  const rows = (await tx.execute(sql`
    select time_type_code as type, year,
           coalesce(sum(quantity) filter (where entry_kind in ('OPENING', 'MONTHLY_ACCRUAL', 'ANNUAL_GRANT')), 0) as accrued,
           coalesce(sum(quantity) filter (where entry_kind = 'ADJUSTMENT'), 0) as adjusted,
           coalesce(sum(quantity) filter (where entry_kind = 'EXPIRY'), 0) as expired,
           coalesce(-sum(quantity) filter (where entry_kind in ('ABSENCE_DEBIT', 'REVERSAL')), 0) as taken,
           coalesce(sum(quantity), 0) as remaining
      from leave_ledger
     where client = ${client} and personnel_number = ${personnelNumber} and effective_date <= ${asOf}::date
     group by time_type_code, year
  `)) as unknown as Array<{ type: string; year: number; accrued: string; adjusted: string; expired: string; taken: string; remaining: string }>;
  const legacy = (await tx.execute(sql`
    select time_type_code as type, year, entitlement::text as entitlement, taken::text as taken, remaining::text as remaining
      from leave_quota
     where client = ${client} and personnel_number = ${personnelNumber} and mode = 'LEGACY'
  `)) as unknown as Array<{ type: string; year: number; entitlement: string; taken: string; remaining: string }>;
  const out: QuotaBalance[] = rows.map((r) => ({
    personnelNumber, timeTypeCode: r.type, year: Number(r.year), mode: 'POLICY',
    accrued: String(r.accrued), adjusted: String(r.adjusted), expired: String(r.expired),
    taken: String(r.taken), remaining: String(r.remaining),
  }));
  for (const l of legacy) {
    out.push({
      personnelNumber, timeTypeCode: l.type, year: Number(l.year), mode: 'LEGACY',
      accrued: l.entitlement, adjusted: '0', expired: '0', taken: l.taken, remaining: l.remaining,
    });
  }
  return out.sort((a, b) => a.year - b.year || a.timeTypeCode.localeCompare(b.timeTypeCode));
}

/** What the projection says now, to prove it equals the ledger (reconciliation in the report). */
export async function projectionDrift(tx: Tx, client: string, personnelNumber: string): Promise<Array<{ type: string; year: number; ledger: string; projection: string }>> {
  return (await tx.execute(sql`
    select l.time_type_code as type, l.year, l.sum::text as ledger, q.remaining::text as projection
      from (select time_type_code, year, sum(quantity) from leave_ledger
             where client = ${client} and personnel_number = ${personnelNumber} group by 1, 2) l
      left join leave_quota q on q.client = ${client} and q.personnel_number = ${personnelNumber}
                             and q.time_type_code = l.time_type_code and q.year = l.year
     where q.remaining is distinct from l.sum
  `)) as unknown as Array<{ type: string; year: number; ledger: string; projection: string }>;
}

export async function tenantToday(tx: Tx, client: string, at: Date = new Date()): Promise<{ timezone: string; today: string }> {
  const rows = (await tx.execute(sql`select timezone from client where client = ${client}`)) as unknown as Array<{ timezone: string | null }>;
  const timezone = rows[0]?.timezone ?? 'UTC';
  if (!isValidTimezone(timezone)) {
    refuse('INVALID_TIMEZONE', `The tenant time zone "${timezone}" is not a valid IANA zone, so month end cannot be determined.`, 'Correct the client time zone, then run the accrual again. Nothing was credited.');
  }
  return { timezone, today: localDate(at, timezone) };
}

/** The tenant-local day, clamped into the quota year, so an as-of balance picks the adjustment up on the right date. */
function effectiveWithin(today: string, year: number): string {
  return today < `${year}-01-01` ? `${year}-01-01` : today > `${year}-12-31` ? `${year}-12-31` : today;
}

// ── manual adjustment ────────────────────────────────────────────────────────
const adjustSchema = z.object({
  client: z.string().min(1),
  personnelNumber: z.string().min(1),
  timeTypeCode: z.string().min(1),
  year: z.number().int().min(1901).max(2099),
  /** Signed days, up to two decimals. */
  days: z.string().regex(/^-?\d{1,4}(\.\d{1,2})?$/, 'Days must be a number with at most two decimals, for example 1.5 or -2.'),
  reason: z.string().trim().min(3, 'A reason of at least 3 characters is required.').max(200),
  /** The caller's own key; submitting the same key again changes nothing. */
  requestKey: z.string().min(8).max(80),
  changedBy: z.string().optional(),
});
export type AdjustInput = z.input<typeof adjustSchema>;

export async function adjustLeaveBalance(input: AdjustInput, access?: LeaveAccess): Promise<{ posted: boolean }> {
  const p = adjustSchema.parse(input);
  return withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_ADJUST]);
    await assertReachesEmployee(tx, p.client, grant, p.personnelNumber, `${p.year}-01-01`, `${p.year}-12-31`);
    const qty = toScaled(p.days);
    if (qty === 0n) refuse('ADJUST_ZERO', 'An adjustment of zero days changes nothing.');
    await lockEmployeeLeave(tx, p.client, p.personnelNumber);
    const type = (await tx.execute(sql`select reduces_quota from time_type where client = ${p.client} and code = ${p.timeTypeCode}`)) as unknown as Array<{ reduces_quota: boolean }>;
    if (!type[0]?.reduces_quota) refuse('TIME_TYPE_NO_QUOTA', `Time type ${p.timeTypeCode} does not keep a balance.`);
    const quota = (await tx.execute(sql`select mode from leave_quota where client = ${p.client} and personnel_number = ${p.personnelNumber} and time_type_code = ${p.timeTypeCode} and year = ${p.year}`)) as unknown as Array<{ mode: string }>;
    if (quota[0]?.mode === 'LEGACY') {
      refuse('QUOTA_LEGACY', `The ${p.year} ${p.timeTypeCode} balance of ${p.personnelNumber} is a legacy quota.`, 'Convert it to a policy balance first, then adjust.');
    }
    const actor = actorOf(grant, p.changedBy);
    const cur = (await tx.execute(sql`select coalesce(sum(quantity), 0)::text as r from leave_ledger where client = ${p.client} and personnel_number = ${p.personnelNumber} and time_type_code = ${p.timeTypeCode} and year = ${p.year}`)) as unknown as Array<{ r: string }>;
    if (qty < 0n && toScaled(cur[0]?.r ?? '0') + qty < 0n) {
      refuse('ADJUST_OVERDRAWS', `This adjustment would leave ${p.timeTypeCode} ${p.year} at ${fromScaled(toScaled(cur[0]?.r ?? '0') + qty)} days.`, 'Adjust by a smaller amount, or reverse the absences that used the balance.');
    }
    const posted = await postLedgerEntry(tx, {
      client: p.client, personnelNumber: p.personnelNumber, timeTypeCode: p.timeTypeCode, year: p.year,
      entryKind: 'ADJUSTMENT', effectiveDate: effectiveWithin((await tenantToday(tx, p.client)).today, p.year),
      quantity: qty, sourceKind: 'ADJUSTMENT', sourceKey: `ADJ/${p.requestKey}`, note: p.reason, createdBy: actor,
    });
    if (posted) {
      await recordChange(tx, {
        client: p.client, objectClass: 'leave_ledger', objectKey: `${p.personnelNumber}/${p.timeTypeCode}/${p.year}`,
        changeType: 'CREATE', changedBy: actor, after: { days: p.days, reason: p.reason },
      });
    }
    return { posted };
  });
}

// ── legacy → policy conversion (previewed cutover) ──────────────────────────
export interface ConversionLine {
  personnelNumber: string;
  timeTypeCode: string;
  year: number;
  /** The hand-set balance carried across, days. */
  entitlement: string;
  taken: string;
  remaining: string;
  /** Why this line will not convert, or null when it will. */
  blocker: string | null;
}
export interface ConversionPreview { cutover: string; lines: ConversionLine[]; convertible: number; blocked: number }

const convertSchema = z.object({
  client: z.string().min(1),
  personnelNumber: z.string().min(1),
  /** First day policy accrual counts for the converted quotas; must be a month start, in the year converted. */
  cutover: z.string().regex(/^\d{4}-\d{2}-01$/, 'The cutover must be the first day of a month.'),
  changedBy: z.string().optional(),
});
export type ConvertInput = z.input<typeof convertSchema>;

async function legacyLines(tx: Tx, client: string, pn: string, year: number): Promise<ConversionLine[]> {
  const rows = (await tx.execute(sql`
    select personnel_number as pn, time_type_code as type, year, entitlement::text as ent, taken::text as tak, remaining::text as rem
      from leave_quota
     where client = ${client} and personnel_number = ${pn} and year = ${year} and mode = 'LEGACY'
     order by time_type_code
  `)) as unknown as Array<{ pn: string; type: string; year: number; ent: string; tak: string; rem: string }>;
  const out: ConversionLine[] = [];
  for (const r of rows) {
    let blocker: string | null = null;
    const open = (await tx.execute(sql`
      select count(*)::int as n from absence
       where client = ${client} and personnel_number = ${pn} and time_type_code = ${r.type}
         and status = 'REQUESTED' and extract(year from valid_from) = ${year}
    `)) as unknown as Array<{ n: number }>;
    if (Number(open[0]?.n) > 0) blocker = 'Pending absence requests exist for this type and year; decide them before converting.';
    if (Number(r.rem) < 0) blocker = 'The legacy balance is negative; correct it before converting.';
    out.push({ personnelNumber: r.pn, timeTypeCode: r.type, year: Number(r.year), entitlement: r.ent, taken: r.tak, remaining: r.rem, blocker });
  }
  return out;
}

/** Preview only: nothing is written. */
export async function previewLegacyConversion(input: ConvertInput, access?: LeaveAccess): Promise<ConversionPreview> {
  const p = convertSchema.parse(input);
  const year = Number(p.cutover.slice(0, 4));
  return withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_ADJUST]);
    await assertReachesEmployee(tx, p.client, grant, p.personnelNumber, `${year}-01-01`, `${year}-12-31`);
    const lines = await legacyLines(tx, p.client, p.personnelNumber, year);
    return { cutover: p.cutover, lines, convertible: lines.filter((l) => !l.blocker).length, blocked: lines.filter((l) => l.blocker).length };
  });
}

/**
 * Convert the person's legacy quotas of the cutover year: the remaining legacy balance becomes one OPENING entry
 * and the quota turns POLICY with `accrual_from` = cutover, so accrual counts only months from the cutover on.
 * Taken days already approved under the legacy rules stay in the absence history (policy_managed = false) and
 * in `taken` only as far as the opening is net of them. The caller must pass the previewed cutover back, and a
 * blocked line refuses the whole conversion.
 */
export async function applyLegacyConversion(input: ConvertInput, access?: LeaveAccess): Promise<{ converted: number }> {
  const p = convertSchema.parse(input);
  const year = Number(p.cutover.slice(0, 4));
  return withTenant(p.client, async (tx) => {
    const grant = await judgeLeave(tx, p.client, access, [LEAVE_ADJUST]);
    await assertReachesEmployee(tx, p.client, grant, p.personnelNumber, `${year}-01-01`, `${year}-12-31`);
    await lockEmployeeLeave(tx, p.client, p.personnelNumber);
    const lines = await legacyLines(tx, p.client, p.personnelNumber, year);
    const blocked = lines.filter((l) => l.blocker);
    if (blocked.length) refuse('CONVERSION_BLOCKED', `${blocked.length} balance(s) cannot be converted: ${blocked[0]!.blocker}`, 'Resolve the blocked lines in the preview, then convert.');
    const actor = actorOf(grant, p.changedBy);
    let converted = 0;
    for (const l of lines) {
      const remaining = toScaled(l.remaining);
      await tx.execute(sql`select set_config('cairn.leave_conversion', 'on', true)`);
      await tx.execute(sql`select set_config('cairn.leave_ledger_write', 'on', true)`);
      await tx.execute(sql`
        update leave_quota set accrual_from = ${p.cutover}::date, mode = 'POLICY', changed_by = ${actor}, changed_at = now()
         where client = ${p.client} and personnel_number = ${l.personnelNumber} and time_type_code = ${l.timeTypeCode} and year = ${l.year}`);
      if (remaining > 0n) {
        await postLedgerEntry(tx, {
          client: p.client, personnelNumber: l.personnelNumber, timeTypeCode: l.timeTypeCode, year: l.year,
          entryKind: 'OPENING', effectiveDate: p.cutover, quantity: remaining, sourceKind: 'CONVERSION',
          sourceKey: `OPEN/${l.personnelNumber}/${l.timeTypeCode}/${l.year}`, note: `Converted from legacy quota (entitlement ${l.entitlement}, taken ${l.taken})`, createdBy: actor,
        });
      }
      await tx.execute(sql`select set_config('cairn.leave_conversion', 'off', true)`);
      await tx.execute(sql`select set_config('cairn.leave_ledger_write', 'off', true)`);
      await recordChange(tx, {
        client: p.client, objectClass: 'leave_quota', objectKey: `${l.personnelNumber}/${l.timeTypeCode}/${l.year}`,
        changeType: 'CHANGE', changedBy: actor, before: { mode: 'LEGACY', remaining: l.remaining }, after: { mode: 'POLICY', accrualFrom: p.cutover },
      });
      converted += 1;
    }
    return { converted };
  });
}

/** Ledger history of one person (newest first) for drill-down. Judged for LEAVE.VIEW and employee scope. */
export async function listLedger(
  client: string, personnelNumber: string, access?: LeaveAccess, year?: number,
): Promise<Array<{ id: string; timeTypeCode: string; year: number; entryKind: string; effectiveDate: string; quantity: string; policyCode: string | null; policyVersion: number | null; sourceKey: string; note: string | null; createdBy: string }>> {
  return withTenant(client, async (tx) => {
    const grant: LeaveGrant = await judgeLeave(tx, client, access, [LEAVE_VIEW]);
    await assertReachesEmployee(tx, client, grant, personnelNumber, `${year ?? 1901}-01-01`, `${year ?? 2099}-12-31`);
    const rows = (await tx.execute(sql`
      select id, time_type_code as "timeTypeCode", year, entry_kind as "entryKind", effective_date::text as "effectiveDate",
             quantity::text as quantity, policy_code as "policyCode", policy_version as "policyVersion",
             source_key as "sourceKey", note, created_by as "createdBy"
        from leave_ledger
       where client = ${client} and personnel_number = ${personnelNumber}
         and (${year ?? null}::int is null or year = ${year ?? null}::int)
       order by effective_date desc, created_at desc limit 500
    `)) as unknown as Array<{ id: string; timeTypeCode: string; year: number; entryKind: string; effectiveDate: string; quantity: string; policyCode: string | null; policyVersion: number | null; sourceKey: string; note: string | null; createdBy: string }>;
    return rows.map((r) => ({ ...r, year: Number(r.year) }));
  });
}
