import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, withTenant } from '../src/platform/db/client';
import { LeaveError } from '../src/modules/people/leave-access';
import {
  absenceAllocations, approveLeaveAbsence, cancelLeaveAbsence, planAbsence, previewAbsence, rejectLeaveAbsence, requestLeaveAbsence,
} from '../src/modules/people/leave-absence';
import { SYSTEM_ACCRUAL_ACCESS, accrueChunk } from '../src/modules/people/leave-accrual';
import { adjustLeaveBalance, balancesAsOf, projectionDrift } from '../src/modules/people/leave-ledger';
import { assignLeavePolicy, defineLeavePolicy } from '../src/modules/people/leave-policy';
import { defineTimeType, requestAbsence, decideAbsence, setLeaveQuota } from '../src/modules/people/time-leave';
import { assignStructure, defineSalaryStructure, setStructureComponent } from '../src/modules/people/payroll-structure';
import { PAYROLL_RUN_CAPABILITY, listResults, proposePayrollRun } from '../src/modules/people/payroll-run';
import { PAYROLL_ACTOR, PAYROLL_AUTH, buildPayrollFixture, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ADMIN = ['*'] as const;
const REQUESTER = ['PEOPLE.TIME.ENTER'] as const;
const APPROVER = ['PEOPLE.LEAVE.APPROVE'] as const;
const ACTOR = 'LEAVE_ABSENCE_TEST';
/** "Today" for these tests: March is the last complete month, so 6 annual days are earned. */
const NOW = new Date('2026-04-01T09:00:00Z');

let tenant: TestTenant;
let fx: PayrollFixture;
let keyN = 0;
const key = () => `leave-abs-${Date.now()}-${++keyN}`;

const LINES = [
  { timeTypeCode: 'ANNUAL', annualDays: '24', accrualMode: 'MONTHLY' as const, fallbackTypeCode: 'UNPAID' },
  { timeTypeCode: 'UNPAID', annualDays: '15', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
  { timeTypeCode: 'SICK', annualDays: '12', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
  { timeTypeCode: 'EMERG', annualDays: '20', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
];

async function worker(policy = true): Promise<string> {
  const pn = await payrollEmployee(fx, { positionFrom: '2025-12-01' });
  if (policy) {
    await assignLeavePolicy({ client: tenant.client, subjectKind: 'PERSON', subject: pn, policyCode: 'STD', validFrom: '2026-01-01', changedBy: ACTOR }, ADMIN);
    await accrueChunk(tenant.client, { access: SYSTEM_ACCRUAL_ACCESS, after: null, limit: 500, window: 'ALL', at: NOW });
  }
  return pn;
}

const req = (pn: string, type: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
  requestLeaveAbsence({ client: tenant.client, personnelNumber: pn, timeTypeCode: type, validFrom: from, validTo: to, requestKey: key(), changedBy: ACTOR, ...extra }, REQUESTER, NOW);
const approve = (id: string, extra: Record<string, unknown> = {}, access: Parameters<typeof approveLeaveAbsence>[1] = APPROVER) =>
  approveLeaveAbsence({ client: tenant.client, absenceId: id, changedBy: ACTOR, ...extra }, access, NOW);
const balance = async (pn: string, type: string, year = 2026) =>
  (await withTenant(tenant.client, (tx) => balancesAsOf(tx, tenant.client, pn, '2099-12-31'))).find((b) => b.timeTypeCode === type && b.year === year)?.remaining;

async function refusal(p: Promise<unknown>, code?: string): Promise<LeaveError> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(LeaveError);
    if (code) expect((e as LeaveError).code, (e as Error).message).toBe(code);
    return e as LeaveError;
  }
  throw new Error('expected a LeaveError');
}

beforeAll(async () => {
  tenant = await createTenant('leave-absence');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  for (const [code, paid, quota] of [['ANNUAL', true, true], ['UNPAID', false, true], ['SICK', true, true], ['EMERG', false, true], ['COMP', true, true]] as const) {
    await defineTimeType({ client: tenant.client, code, name: code, typeKind: 'ABSENCE', reducesQuota: quota, isPaid: paid, changedBy: ACTOR }, ADMIN);
  }
  await defineLeavePolicy({ client: tenant.client, code: 'STD', name: 'Standard', validFrom: '2026-01-01', partialMonthMode: 'PRORATE_DAYS', lines: LINES, changedBy: ACTOR }, ADMIN);
  await withTenant(tenant.client, (tx) => tx.execute(sql`update client set timezone = 'Asia/Kuwait' where client = ${tenant.client}`));
}, 180_000);

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('paid / unpaid split', () => {
  it('previews 6 paid annual days and 2 unpaid fallback days for an 8-day request, writing nothing', async () => {
    const pn = await worker();
    const plan = await previewAbsence({ client: tenant.client, personnelNumber: pn, timeTypeCode: 'ANNUAL', validFrom: '2026-04-06', validTo: '2026-04-13' }, REQUESTER, NOW);
    expect(plan).toMatchObject({ managed: true, paidDays: 6, unpaidDays: 2, requiresConfirmation: true, uncovered: [] });
    expect(plan.spans.map((s) => [s.typeCode, s.days, s.isPaid])).toEqual([['ANNUAL', 6, true], ['UNPAID', 2, false]]);
    expect(await balance(pn, 'ANNUAL')).toBe('6.00');
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`select 1 from absence where client = ${tenant.client} and personnel_number = ${pn}`)) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('refuses an unconfirmed unpaid split, then files it once confirmed, and the approval keeps the split', async () => {
    const pn = await worker();
    await refusal(req(pn, 'ANNUAL', '2026-04-06', '2026-04-13'), 'UNPAID_NOT_CONFIRMED');
    await refusal(req(pn, 'ANNUAL', '2026-04-06', '2026-04-13', { confirmUnpaidDays: 1 }), 'SPLIT_CHANGED');
    const filed = await req(pn, 'ANNUAL', '2026-04-06', '2026-04-13', { confirmUnpaidDays: 2 });
    expect(filed).toMatchObject({ status: 'REQUESTED', managed: true, unpaidDays: 2 });
    expect(await balance(pn, 'ANNUAL')).toBe('6.00'); // a request reserves nothing
    const done = await approve(filed.absenceId);
    expect(done).toMatchObject({ status: 'APPROVED', unpaidDays: 2 });
    expect(await balance(pn, 'ANNUAL')).toBe('0.00');
    expect(await balance(pn, 'UNPAID')).toBe('13.00');
    const split = await absenceAllocations(tenant.client, filed.absenceId, APPROVER);
    expect(split.map((s) => [s.typeCode, s.days, s.isPaid, s.reversed])).toEqual([['ANNUAL', '6.00', true, false], ['UNPAID', '2.00', false, false]]);
    expect(await withTenant(tenant.client, (tx) => projectionDrift(tx, tenant.client, pn))).toEqual([]);
  });

  it('a fully paid request needs no confirmation; sick and emergency never fall back', async () => {
    const pn = await worker();
    expect(await req(pn, 'ANNUAL', '2026-04-06', '2026-04-08')).toMatchObject({ managed: true, unpaidDays: 0 });
    await refusal(req(pn, 'SICK', '2026-05-04', '2026-05-16'), 'INSUFFICIENT_BALANCE'); // 13 > 12, no fallback
    await refusal(req(pn, 'EMERG', '2026-05-04', '2026-05-25'), 'INSUFFICIENT_BALANCE'); // 22 > 20
    expect(await req(pn, 'SICK', '2026-05-04', '2026-05-08')).toMatchObject({ status: 'REQUESTED' });
  });

  it('refuses days no balance covers (earned days only), and a type the policy does not grant', async () => {
    const pn = await worker();
    // 6 earned annual + 15 unpaid = 21 days; day 22 is covered by nothing, however much accrues later.
    const err = await refusal(req(pn, 'ANNUAL', '2026-06-01', '2026-06-22', { confirmUnpaidDays: 15 }), 'INSUFFICIENT_BALANCE');
    expect(err.message).toContain('1 day');
    await refusal(req(pn, 'COMP', '2026-06-01', '2026-06-02'), 'TYPE_NOT_IN_POLICY');
  });

  it('enforces the split on the server at approval: a changed split needs a new confirmation', async () => {
    const pn = await worker();
    const a = await req(pn, 'ANNUAL', '2026-04-06', '2026-04-13', { confirmUnpaidDays: 2 }); // 6 paid + 2 unpaid
    const b = await req(pn, 'ANNUAL', '2026-04-20', '2026-04-23');                            // 4 paid
    await approve(b.absenceId);                                                              // annual left: 2
    const err = await refusal(approve(a.absenceId), 'SPLIT_CHANGED');
    expect(err.message).toContain('6 unpaid');
    expect(await balance(pn, 'UNPAID')).toBe('15.00'); // nothing was posted by the refused approval
    const ok = await approve(a.absenceId, { confirmUnpaidDays: 6 });
    expect(ok).toMatchObject({ status: 'APPROVED', unpaidDays: 6 });
    expect(await balance(pn, 'ANNUAL')).toBe('0.00');
    expect(await balance(pn, 'UNPAID')).toBe('9.00');
  });

  it('two requests for the same sick balance cannot both be approved, even when concurrent and future-dated', async () => {
    const pn = await worker();
    const a = await req(pn, 'SICK', '2026-09-01', '2026-09-07'); // 7 days
    const b = await req(pn, 'SICK', '2026-10-01', '2026-10-07'); // 7 days, each alone fits 12
    const settled = await Promise.allSettled([approve(a.absenceId), approve(b.absenceId)]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as LeaveError).code).toBe('INSUFFICIENT_BALANCE');
    expect(await balance(pn, 'SICK')).toBe('5.00');
  });
});

describe('request integrity', () => {
  it('replays the same key to the same absence and refuses the key for a different request', async () => {
    const pn = await worker();
    const k = key();
    const first = await req(pn, 'ANNUAL', '2026-04-06', '2026-04-08', { requestKey: k });
    const again = await req(pn, 'ANNUAL', '2026-04-06', '2026-04-08', { requestKey: k });
    expect(again).toMatchObject({ absenceId: first.absenceId, replayed: true });
    await refusal(req(pn, 'ANNUAL', '2026-04-06', '2026-04-09', { requestKey: k }), 'REQUEST_KEY_REUSED');
  });

  it('refuses overlaps with open requests, frees the days on rejection, and names a reused start day', async () => {
    const pn = await worker();
    const a = await req(pn, 'ANNUAL', '2026-04-06', '2026-04-08');
    await refusal(req(pn, 'SICK', '2026-04-08', '2026-04-10'), 'OVERLAP');
    await rejectLeaveAbsence({ client: tenant.client, absenceId: a.absenceId, changedBy: ACTOR }, APPROVER, NOW);
    await refusal(req(pn, 'ANNUAL', '2026-04-06', '2026-04-07'), 'START_TAKEN');
    expect(await req(pn, 'SICK', '2026-04-07', '2026-04-08')).toMatchObject({ status: 'REQUESTED' });
    await refusal(approve(a.absenceId), 'NOT_REQUESTED');
  });

  it('keeps authority separate: a requester cannot approve, an approver cannot request', async () => {
    const pn = await worker();
    const a = await req(pn, 'ANNUAL', '2026-04-06', '2026-04-08');
    await refusal(approve(a.absenceId, {}, REQUESTER), 'LEAVE_AUTHORITY');
    await refusal(requestLeaveAbsence({ client: tenant.client, personnelNumber: pn, timeTypeCode: 'ANNUAL', validFrom: '2026-05-04', validTo: '2026-05-05' }, APPROVER, NOW), 'LEAVE_AUTHORITY');
    await refusal(approveLeaveAbsence({ client: tenant.client, absenceId: a.absenceId }, undefined, NOW), 'LEAVE_AUTHORITY');
    expect(await approve(a.absenceId)).toMatchObject({ status: 'APPROVED' });
  });
});

describe('cancellation', () => {
  it('reverses an approved absence exactly once and gives the days back', async () => {
    const pn = await worker();
    const a = await req(pn, 'ANNUAL', '2026-04-06', '2026-04-13', { confirmUnpaidDays: 2 });
    await approve(a.absenceId);
    const cancelled = await cancelLeaveAbsence({ client: tenant.client, absenceId: a.absenceId, changedBy: ACTOR }, APPROVER, NOW);
    expect(cancelled.status).toBe('CANCELLED');
    expect(await balance(pn, 'ANNUAL')).toBe('6.00');
    expect(await balance(pn, 'UNPAID')).toBe('15.00');
    expect((await absenceAllocations(tenant.client, a.absenceId, APPROVER)).every((s) => s.reversed)).toBe(true);
    await refusal(cancelLeaveAbsence({ client: tenant.client, absenceId: a.absenceId, changedBy: ACTOR }, APPROVER, NOW), 'NOT_REQUESTED');
    expect(await balance(pn, 'ANNUAL')).toBe('6.00');
    expect(await withTenant(tenant.client, (tx) => projectionDrift(tx, tenant.client, pn))).toEqual([]);
  });

  it('a requester may cancel a pending request, but only an approver may cancel an approved one', async () => {
    const pn = await worker();
    const a = await req(pn, 'ANNUAL', '2026-04-06', '2026-04-08');
    expect(await cancelLeaveAbsence({ client: tenant.client, absenceId: a.absenceId }, REQUESTER, NOW)).toMatchObject({ status: 'CANCELLED' });
    const b = await req(pn, 'ANNUAL', '2026-04-14', '2026-04-15');
    await approve(b.absenceId);
    await refusal(cancelLeaveAbsence({ client: tenant.client, absenceId: b.absenceId }, REQUESTER, NOW), 'LEAVE_AUTHORITY');
  });
});

describe('employees without a policy, and the old entry points', () => {
  it('keeps the legacy quota path (hand-set quota, is_paid) and marks the row not policy-managed', async () => {
    const pn = await worker(false);
    await setLeaveQuota({ client: tenant.client, personnelNumber: pn, timeTypeCode: 'ANNUAL', year: '2026', entitlement: '10', changedBy: ACTOR }, ADMIN);
    const filed = await req(pn, 'ANNUAL', '2026-04-06', '2026-04-08');
    expect(filed).toMatchObject({ managed: false, unpaidDays: 0 });
    await approve(filed.absenceId);
    const [q] = (await withTenant(tenant.client, (tx) => tx.execute(sql`select taken::text as taken, remaining::text as remaining, mode from leave_quota where client = ${tenant.client} and personnel_number = ${pn}`))) as unknown as Array<{ taken: string; remaining: string; mode: string }>;
    expect(q).toMatchObject({ taken: '3.00', remaining: '7.00', mode: 'LEGACY' });
    await refusal(req(pn, 'ANNUAL', '2026-05-04', '2026-05-20'), 'QUOTA_EXCEEDED');
  });

  it('the time-leave wrappers still work for trusted callers and report refusals in their own error type', async () => {
    const pn = await worker();
    const view = await requestAbsence({ client: tenant.client, personnelNumber: pn, timeTypeCode: 'SICK', validFrom: '2026-04-06', validTo: '2026-04-07', changedBy: ACTOR }, [...REQUESTER]);
    expect(view.status).toBe('REQUESTED');
    const done = await decideAbsence({ client: tenant.client, personnelNumber: pn, timeTypeCode: 'SICK', validFrom: '2026-04-06', status: 'APPROVED', changedBy: ACTOR }, [...APPROVER]);
    expect(done.status).toBe('APPROVED');
    await expect(decideAbsence({ client: tenant.client, personnelNumber: pn, timeTypeCode: 'SICK', validFrom: '2026-04-06', status: 'REJECTED', changedBy: ACTOR }, [...APPROVER])).rejects.toMatchObject({ name: 'TimeLeaveError', code: 'NOT_REQUESTED' });
  });

  it('a hand-set quota cannot overwrite a policy-owned balance', async () => {
    const pn = await worker();
    await expect(setLeaveQuota({ client: tenant.client, personnelNumber: pn, timeTypeCode: 'ANNUAL', year: '2026', entitlement: '99', changedBy: ACTOR }, ADMIN))
      .rejects.toMatchObject({ code: 'QUOTA_POLICY_OWNED' });
    await adjustLeaveBalance({ client: tenant.client, personnelNumber: pn, timeTypeCode: 'ANNUAL', year: 2026, days: '1', reason: 'goodwill day', requestKey: key() }, ADMIN);
  });
});

describe('payroll', () => {
  it('reads the unpaid allocation spans of an approved policy absence — and nothing for paid, requested or cancelled days', async () => {
    const pn = await worker();
    await defineSalaryStructure({ client: tenant.client, code: 'LEAVEST', name: 'Staff', currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    await setStructureComponent({ client: tenant.client, structureCode: 'LEAVEST', componentCode: 'BASIC', amountKind: 'PERCENT_OF_BASE', amountValue: '100', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    await assignStructure({ client: tenant.client, personnelNumber: pn, structureCode: 'LEAVEST', baseAmount: '3000', currency: fx.currency, validFrom: '2025-12-01', validTo: null, changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    // April 2026: 6 paid annual days then 2 unpaid; a cancelled unpaid request and a still-open one count for nothing.
    const a = await req(pn, 'ANNUAL', '2026-04-06', '2026-04-13', { confirmUnpaidDays: 2 });
    await approve(a.absenceId);
    const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: 2026, period: 4, changedBy: PAYROLL_ACTOR }, [PAYROLL_RUN_CAPABILITY]);
    const row = (await listResults(tenant.client, run.runId, pn, [PAYROLL_RUN_CAPABILITY]))[0]!;
    expect(row).toMatchObject({ unpaidLeaveDays: '2.00', payableDays: '28.00' });
    // The legacy rule is not applied on top: the ANNUAL type is paid, so the 8-day absence row adds nothing.
    expect(Number(row.totalDays)).toBe(30);
  });

  it('refuses to cancel unpaid leave once a released run covers it', async () => {
    const pn = await worker();
    const a = await req(pn, 'ANNUAL', '2026-04-14', '2026-04-23', { confirmUnpaidDays: 4 }); // 6 paid, 4 unpaid
    await approve(a.absenceId);
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update payroll_run set status = 'RELEASED', released_by = ${ACTOR}, released_at = now()
       where client = ${tenant.client} and company_code = ${fx.companyCode} and fiscal_year = 2026 and period = 4`));
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into payroll_result (client, result_id, run_id, personnel_number, currency, payable_days, total_days, covered_days, created_by)
      select ${tenant.client}, gen_random_uuid()::text, run_id, ${pn}, ${fx.currency}, 30, 30, 30, ${ACTOR}
        from payroll_run where client = ${tenant.client} and fiscal_year = 2026 and period = 4`));
    await refusal(cancelLeaveAbsence({ client: tenant.client, absenceId: a.absenceId }, APPROVER, NOW), 'PAYROLL_FROZEN');
  });
});

describe('plan', () => {
  it('a gap in policy coverage is refused, not silently split', async () => {
    const pn = await payrollEmployee(fx, { positionFrom: '2025-12-01' });
    await assignLeavePolicy({ client: tenant.client, subjectKind: 'PERSON', subject: pn, policyCode: 'STD', validFrom: '2026-07-01', changedBy: ACTOR }, ADMIN);
    await withTenant(tenant.client, async (tx) => {
      await expect(planAbsence(tx, tenant.client, pn, 'ANNUAL', '2026-06-29', '2026-07-02', '2026-04-01')).rejects.toMatchObject({ code: 'POLICY_GAP' });
    });
  });
});
