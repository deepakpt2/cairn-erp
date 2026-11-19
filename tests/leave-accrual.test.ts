import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, withTenant } from '../src/platform/db/client';
import { claimNext, runClaimed } from '../src/platform/job/execute';
import { clearJobRegistry } from '../src/platform/job/registry';
import { defineTimeType } from '../src/modules/people/time-leave';
import { LeaveError } from '../src/modules/people/leave-access';
import { assignLeavePolicy, defineLeavePolicy } from '../src/modules/people/leave-policy';
import {
  SYSTEM_ACCRUAL_ACCESS, accrueChunk, leaveAccrualStatus, requestLeaveAccrual,
} from '../src/modules/people/leave-accrual';
import {
  adjustLeaveBalance, applyLegacyConversion, balancesAsOf, previewLegacyConversion, projectionDrift,
} from '../src/modules/people/leave-ledger';
import { leaveAccrualJob, leaveBackfillJob } from '../src/modules/people/jobs/leave-accrual';
import { registerJob } from '../src/platform/job/registry';
import { buildPayrollFixture, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createFinanceActor } from './helpers/finance-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

async function resetJobs() {
  await withTenant(tenant.client, (tx) => tx.execute(sql`delete from job_run where client = ${tenant.client} and job_code like 'LEAVE.ACCRUAL.%' and status in ('QUEUED','RUNNING','BLOCKED')`));
}

const ADMIN = ['*'] as const;
const ACTOR = 'LEAVE_ACCRUAL_TEST';

let tenant: TestTenant;
let fx: PayrollFixture;

const LINES = [
  { timeTypeCode: 'ANNUAL', annualDays: '24', accrualMode: 'MONTHLY' as const, fallbackTypeCode: 'UNPAID' },
  { timeTypeCode: 'UNPAID', annualDays: '15', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
  { timeTypeCode: 'SICK', annualDays: '12', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
  { timeTypeCode: 'EMERG', annualDays: '20', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
];

async function worker(from = '2025-12-01'): Promise<string> {
  const pn = await payrollEmployee(fx, { positionFrom: from });
  await assignLeavePolicy({ client: tenant.client, subjectKind: 'PERSON', subject: pn, policyCode: 'STD', validFrom: '2026-01-01', changedBy: ACTOR }, ADMIN);
  return pn;
}

const accrue = (at: string, window: 'CATCH_UP' | 'ALL' = 'ALL', access: Parameters<typeof accrueChunk>[1]['access'] = SYSTEM_ACCRUAL_ACCESS, after: string | null = null) =>
  accrueChunk(tenant.client, { access, after, limit: 500, window, at: new Date(at) });

const balance = async (pn: string, type: string, year: number, asOf = '2099-12-31') =>
  (await withTenant(tenant.client, (tx) => balancesAsOf(tx, tenant.client, pn, asOf))).find((b) => b.timeTypeCode === type && b.year === year);

const ledgerCount = (pn: string) => withTenant(tenant.client, async (tx) =>
  Number(((await tx.execute(sql`select count(*)::int as n from leave_ledger where client = ${tenant.client} and personnel_number = ${pn}`)) as unknown as Array<{ n: number }>)[0]!.n));

async function refusal(p: Promise<unknown>): Promise<LeaveError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(LeaveError); return e as LeaveError; }
  throw new Error('expected a LeaveError');
}

beforeAll(async () => {
  tenant = await createTenant('leave-accrual');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  for (const [code, paid] of [['ANNUAL', true], ['UNPAID', false], ['SICK', true], ['EMERG', false]] as const) {
    await defineTimeType({ client: tenant.client, code, name: code, typeKind: 'ABSENCE', reducesQuota: true, isPaid: paid, changedBy: ACTOR }, ADMIN);
  }
  await defineLeavePolicy({ client: tenant.client, code: 'STD', name: 'Standard', validFrom: '2026-01-01', partialMonthMode: 'PRORATE_DAYS', lines: LINES, changedBy: ACTOR }, ADMIN);
  await withTenant(tenant.client, (tx) => tx.execute(sql`update client set timezone = 'Asia/Kuwait' where client = ${tenant.client}`));
}, 180_000);

afterEach(async () => {
  clearJobRegistry();
  await resetJobs();
});

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('monthly accrual', () => {
  it('credits 2 days per completed month, grants the upfront types once, and reconciles to the projection', async () => {
    const pn = await worker();
    const r = await accrue('2026-04-01T09:00:00Z');
    expect(r.exceptions).toBe(0);
    expect((await balance(pn, 'ANNUAL', 2026))!.remaining).toBe('6.00');
    expect((await balance(pn, 'UNPAID', 2026))!.remaining).toBe('15.00');
    expect((await balance(pn, 'SICK', 2026))!.remaining).toBe('12.00');
    expect((await balance(pn, 'EMERG', 2026))!.remaining).toBe('20.00');
    expect(await withTenant(tenant.client, (tx) => projectionDrift(tx, tenant.client, pn))).toEqual([]);
    // As-of semantics: at the end of February only two months were earned.
    expect((await balance(pn, 'ANNUAL', 2026, '2026-02-28'))!.remaining).toBe('4.00');
  });

  it('is idempotent, including two runs at the same moment', async () => {
    const pn = await worker();
    await Promise.all([accrue('2026-05-02T09:00:00Z'), accrue('2026-05-02T09:00:00Z')]);
    const first = await ledgerCount(pn);
    expect(first).toBe(7); // four monthly credits (Jan-Apr) and three upfront grants
    const again = await accrue('2026-05-02T09:00:00Z');
    expect(again.posted).toBe(0);
    expect(await ledgerCount(pn)).toBe(first);
    expect((await balance(pn, 'ANNUAL', 2026))!.remaining).toBe('8.00');
  });

  it('waits for the month to end in the TENANT zone, not the server clock', async () => {
    const pn = await worker();
    // 2026-06-30 23:30 in Kuwait (UTC+3) is 20:30Z: June is not complete yet.
    await accrue('2026-06-30T20:30:00Z');
    expect((await balance(pn, 'ANNUAL', 2026))!.remaining).toBe('10.00'); // Jan-May
    // 00:30 on 1 July in Kuwait (21:30Z): June completes although the UTC date is still 30 June.
    await accrue('2026-06-30T21:30:00Z');
    expect((await balance(pn, 'ANNUAL', 2026))!.remaining).toBe('12.00');
  });

  it('never funds a future month', async () => {
    const pn = await worker();
    await accrue('2026-02-10T09:00:00Z');
    expect((await balance(pn, 'ANNUAL', 2026))!.remaining).toBe('2.00');
  });

  it('prorates a mid-month join by calendar days and closes the year exactly', async () => {
    const pn = await worker('2026-03-16'); // assignment 2026-01-01 but employed from 16 March
    await accrue('2027-01-05T09:00:00Z');
    const b = (await balance(pn, 'ANNUAL', 2026, '2026-12-31'))!;
    // March: 2 * 16/31 = 1.03, April-December: 18  => 19.03 earned
    expect(b.accrued).toBe('19.03');
  });
});

describe('catch-up window and backfill', () => {
  it('the catch-up posts only the recent window and reports the older backlog; the backfill completes it', async () => {
    const pn = await worker();
    const c = await accrue('2026-09-02T09:00:00Z', 'CATCH_UP');
    expect(c.backlog).toBeGreaterThan(0);
    // Jan-Aug complete; the window is Jun, Jul, Aug.
    expect((await balance(pn, 'ANNUAL', 2026))!.remaining).toBe('6.00');
    const b = await accrue('2026-09-02T09:00:00Z', 'ALL');
    expect(b.backlog).toBe(0);
    expect((await balance(pn, 'ANNUAL', 2026))!.remaining).toBe('16.00');
  });
});

describe('year end', () => {
  it('expires the unused balance once, with no carry-over', async () => {
    const pn = await worker();
    await accrue('2027-01-05T09:00:00Z');
    const b = (await balance(pn, 'ANNUAL', 2026))!;
    expect(b.accrued).toBe('24.00');
    expect(b.expired).toBe('-24.00');
    expect(b.remaining).toBe('0.00');
    expect((await balance(pn, 'ANNUAL', 2027))).toBeUndefined();
    const n = await ledgerCount(pn);
    await accrue('2027-01-06T09:00:00Z');
    expect(await ledgerCount(pn)).toBe(n);
  });
});

describe('authority and failure', () => {
  it('refuses callers without PEOPLE.LEAVE.ACCRUE, including time-entry and approve holders', async () => {
    expect((await refusal(accrue('2026-04-01T09:00:00Z', 'ALL', ['PEOPLE.TIME.ENTER', 'PEOPLE.LEAVE.APPROVE']))).code).toBe('LEAVE_AUTHORITY');
    const actor = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW'] });
    expect((await refusal(accrue('2026-04-01T09:00:00Z', 'ALL', { authorization: actor.authorization }))).code).toBe('LEAVE_AUTHORITY');
    const noScope = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.ACCRUE'], companyScopes: [] });
    expect((await refusal(accrue('2026-04-01T09:00:00Z', 'ALL', { authorization: noScope.authorization }))).code).toBe('LEAVE_AUTHORITY');
  });

  it('a scoped user accrues only employees in their Company Code scope', async () => {
    const pn = await worker();
    const stranger = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.ACCRUE'], companyScopes: ['ZZZZ'] });
    const r = await accrue('2027-03-02T09:00:00Z', 'ALL', { authorization: stranger.authorization });
    expect(r.employees).toBe(0);
    expect(await balance(pn, 'ANNUAL', 2027)).toBeUndefined();
    const insider = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.ACCRUE'], companyScopes: [tenant.companyCode] });
    expect((await accrue('2027-03-02T09:00:00Z', 'ALL', { authorization: insider.authorization })).employees).toBeGreaterThan(0);
    expect((await balance(pn, 'ANNUAL', 2027))!.accrued).toBe('4.00');
  });

  it('refuses an invalid tenant time zone and posts nothing', async () => {
    const pn = await worker();
    await withTenant(tenant.client, (tx) => tx.execute(sql`update client set timezone = 'Mars/Olympus' where client = ${tenant.client}`));
    try {
      expect((await refusal(accrue('2026-04-01T09:00:00Z'))).code).toBe('INVALID_TIMEZONE');
      expect(await ledgerCount(pn)).toBe(0);
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`update client set timezone = 'Asia/Kuwait' where client = ${tenant.client}`));
    }
  });

  it('reports an inactive employee and credits nothing', async () => {
    const pn = await worker();
    await withTenant(tenant.client, (tx) => tx.execute(sql`update employee set is_active = false where client = ${tenant.client} and personnel_number = ${pn}`));
    const r = await accrue('2026-04-01T09:00:00Z');
    expect(r.exceptionDetail.some((e) => e.personnelNumber === pn && e.code === 'INACTIVE_EMPLOYEE')).toBe(true);
    expect(await ledgerCount(pn)).toBe(0);
  });

  it('a manual adjustment needs ADJUST, is idempotent by key, and cannot overdraw', async () => {
    const pn = await worker();
    await accrue('2026-04-01T09:00:00Z');
    const a = { client: tenant.client, personnelNumber: pn, timeTypeCode: 'ANNUAL', year: 2026, days: '1.5', reason: 'Goodwill', requestKey: `adj-${pn}-1`, changedBy: ACTOR };
    expect((await refusal(adjustLeaveBalance(a, ['PEOPLE.LEAVE.APPROVE']))).code).toBe('LEAVE_AUTHORITY');
    expect((await adjustLeaveBalance(a, ['PEOPLE.LEAVE.ADJUST'])).posted).toBe(true);
    expect((await adjustLeaveBalance(a, ['PEOPLE.LEAVE.ADJUST'])).posted).toBe(false);
    expect((await balance(pn, 'ANNUAL', 2026))!.remaining).toBe('7.50');
    expect((await refusal(adjustLeaveBalance({ ...a, days: '-50', requestKey: `adj-${pn}-2` }, ['PEOPLE.LEAVE.ADJUST']))).code).toBe('ADJUST_OVERDRAWS');
    expect((await balance(pn, 'ANNUAL', 2026))!.remaining).toBe('7.50');
  });
});

describe('legacy quotas and conversion', () => {
  it('skips a legacy quota, then converts it with a preview and accrues only from the cutover', async () => {
    const pn = await worker();
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into leave_quota (client, personnel_number, time_type_code, year, entitlement, taken, remaining, created_by)
      values (${tenant.client}, ${pn}, 'ANNUAL', 2026, 30, 10, 20, ${ACTOR})`));
    const r = await accrue('2026-04-01T09:00:00Z');
    expect(r.exceptionDetail.filter((e) => e.personnelNumber === pn).map((e) => e.code)).toContain('LEGACY_QUOTA');
    expect((await balance(pn, 'ANNUAL', 2026))).toMatchObject({ mode: 'LEGACY', remaining: '20.00' });

    const access = ['PEOPLE.LEAVE.ADJUST'];
    expect((await refusal(previewLegacyConversion({ client: tenant.client, personnelNumber: pn, cutover: '2026-03-01' }, ['PEOPLE.LEAVE.VIEW']))).code).toBe('LEAVE_AUTHORITY');
    const prev = await previewLegacyConversion({ client: tenant.client, personnelNumber: pn, cutover: '2026-03-01' }, access);
    expect(prev).toMatchObject({ convertible: 1, blocked: 0 });
    expect(prev.lines[0]).toMatchObject({ timeTypeCode: 'ANNUAL', remaining: '20.00' });
    expect((await balance(pn, 'ANNUAL', 2026))!.mode).toBe('LEGACY'); // preview wrote nothing

    expect((await applyLegacyConversion({ client: tenant.client, personnelNumber: pn, cutover: '2026-03-01', changedBy: ACTOR }, access)).converted).toBe(1);
    await accrue('2026-04-01T09:00:00Z');
    // 20 carried across + March only (Jan and Feb are before the cutover)
    expect((await balance(pn, 'ANNUAL', 2026))).toMatchObject({ mode: 'POLICY', remaining: '22.00' });
    expect(await withTenant(tenant.client, (tx) => projectionDrift(tx, tenant.client, pn))).toEqual([]);
  });

  it('the ledger refuses a posting into a legacy quota and a direct edit of a policy quota', async () => {
    const pn = await worker();
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into leave_quota (client, personnel_number, time_type_code, year, entitlement, taken, remaining, created_by)
      values (${tenant.client}, ${pn}, 'SICK', 2026, 5, 0, 5, ${ACTOR})`));
    await expect(adjustLeaveBalance({ client: tenant.client, personnelNumber: pn, timeTypeCode: 'SICK', year: 2026, days: '1', reason: 'try', requestKey: `legacy-${pn}`, changedBy: ACTOR }, ['PEOPLE.LEAVE.ADJUST']))
      .rejects.toMatchObject({ code: 'QUOTA_LEGACY' });
  });
});

describe('jobs and status', () => {
  const drive = async (queues: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const claimed = await claimNext('worker-test', queues);
      if (!claimed) break;
      out.push(await runClaimed('worker-test', claimed, {}));
    }
    return out;
  };

  it('a manual backfill runs on the INTENSIVE queue as the requesting user and is logged', async () => {
    const pn = await worker();
    const actor = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.ACCRUE'] });
    expect((await refusal(requestLeaveAccrual(tenant.client, 'BACKFILL', SYSTEM_ACCRUAL_ACCESS))).code).toBe('LEAVE_AUTHORITY');
    const a = await requestLeaveAccrual(tenant.client, 'BACKFILL', { authorization: actor.authorization });
    const b = await requestLeaveAccrual(tenant.client, 'BACKFILL', { authorization: actor.authorization });
    expect(b.jobRunId).toBe(a.jobRunId);
    registerJob(leaveBackfillJob);
    expect(await claimNext('worker-regular', ['DEFAULT', 'MAIL', 'OUTPUT'])).toBeNull();
    expect(await drive(['INTENSIVE'])).toEqual(['SUCCEEDED']);
    const run = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select kind, status, requested_by, entries_posted from leave_accrual_run where client = ${tenant.client} order by started_at desc limit 1`)) as unknown as Array<{ kind: string; status: string; requested_by: string; entries_posted: number }>);
    expect(run[0]).toMatchObject({ kind: 'BACKFILL', status: expect.stringMatching(/SUCCEEDED|PARTIAL/), requested_by: actor.username });
    expect(Number(run[0]!.entries_posted)).toBeGreaterThan(0);
    expect(await ledgerCount(pn)).toBeGreaterThan(0);
  });

  it('the status says "not processed" when the schedule is off, and clears when it is on', async () => {
    registerJob(leaveAccrualJob);
    await withTenant(tenant.client, (tx) => tx.execute(sql`update job_definition set is_enabled = false where code = 'LEAVE.ACCRUAL.RUN'`));
    try {
      const off = await leaveAccrualStatus(tenant.client, ['PEOPLE.LEAVE.ACCRUE']);
      expect(off.scheduleEnabled).toBe(false);
      expect(off.notProcessed.join(' ')).toMatch(/disabled/);
      expect((await refusal(leaveAccrualStatus(tenant.client, ['PEOPLE.LEAVE.VIEW']))).code).toBe('LEAVE_AUTHORITY');
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`update job_definition set is_enabled = true where code = 'LEAVE.ACCRUAL.RUN'`));
    }
    expect((await leaveAccrualStatus(tenant.client, ['PEOPLE.LEAVE.ACCRUE'])).scheduleEnabled).toBe(true);
  });
});
