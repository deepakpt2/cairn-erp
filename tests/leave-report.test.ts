import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { closeDb, withTenant } from '../src/platform/db/client';
import { defineTimeType } from '../src/modules/people/time-leave';
import { LeaveError } from '../src/modules/people/leave-access';
import { addGroupMember, assignLeavePolicy, defineLeaveGroup, defineLeavePolicy } from '../src/modules/people/leave-policy';
import { SYSTEM_ACCRUAL_ACCESS, accrueChunk } from '../src/modules/people/leave-accrual';
import { adjustLeaveBalance } from '../src/modules/people/leave-ledger';
import { csvNumber, csvText, leaveBalanceCsv, leaveBalanceReport } from '../src/modules/people/leave-report';
import { buildPayrollFixture, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { revokeAllSessions } from '../src/platform/auth/session';
import { createFinanceActor } from './helpers/finance-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ADMIN = ['*'] as const;
const ACTOR = 'LEAVE_REPORT_TEST';
let tenant: TestTenant;
let fx: PayrollFixture;
let a: string; // reachable, in group
let b: string; // no company assignment: unreachable for a scoped caller

const LINES = [
  { timeTypeCode: 'ANNUAL', annualDays: '24', accrualMode: 'MONTHLY' as const, fallbackTypeCode: 'UNPAID' },
  { timeTypeCode: 'UNPAID', annualDays: '15', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
  { timeTypeCode: 'SICK', annualDays: '12', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
];

async function refusal(p: Promise<unknown>): Promise<LeaveError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(LeaveError); return e as LeaveError; }
  throw new Error('expected a LeaveError');
}
const live = (actor: { authorization: { userId: string; sessionId: string } }) => ({ authorization: actor.authorization });

beforeAll(async () => {
  tenant = await createTenant('leave-report');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  for (const [code, paid] of [['ANNUAL', true], ['UNPAID', false], ['SICK', true]] as const) {
    await defineTimeType({ client: tenant.client, code, name: code, typeKind: 'ABSENCE', reducesQuota: true, isPaid: paid, changedBy: ACTOR }, ADMIN);
  }
  await defineLeavePolicy({ client: tenant.client, code: 'STD', name: 'Standard', validFrom: '2026-01-01', partialMonthMode: 'PRORATE_DAYS', lines: LINES, changedBy: ACTOR }, ADMIN);
  await withTenant(tenant.client, (tx) => tx.execute(sql`update client set timezone = 'Asia/Kuwait' where client = ${tenant.client}`));
  a = await payrollEmployee(fx, { positionFrom: '2025-12-01' });
  b = await payrollEmployee(fx, { positionFrom: null });
  for (const pn of [a, b]) {
    await assignLeavePolicy({ client: tenant.client, subjectKind: 'PERSON', subject: pn, policyCode: 'STD', validFrom: '2026-01-01', changedBy: ACTOR }, ADMIN);
  }
  await defineLeaveGroup({ client: tenant.client, code: 'OPS', name: 'Operations', changedBy: ACTOR }, ADMIN);
  await addGroupMember({ client: tenant.client, groupCode: 'OPS', personnelNumber: a, validFrom: '2026-01-01', changedBy: ACTOR }, ADMIN);
  await addGroupMember({ client: tenant.client, groupCode: 'OPS', personnelNumber: b, validFrom: '2026-01-01', changedBy: ACTOR }, ADMIN);
  await accrueChunk(tenant.client, { access: SYSTEM_ACCRUAL_ACCESS, after: null, limit: 500, window: 'ALL', at: new Date('2026-03-02T09:00:00Z') });
}, 180_000);

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

const NOW = new Date('2026-03-02T09:00:00Z');
const row = (r: Awaited<ReturnType<typeof leaveBalanceReport>>, pn: string, type: string) => r.rows.find((x) => x.personnelNumber === pn && x.timeTypeCode === type)!;

describe('leave balance report', () => {
  it('shows target 24 against 2 earned after one month, month by month, and reconciles', async () => {
    // January only: 2 of 24 earned; the other 22 are not available.
    const r = await leaveBalanceReport({ client: tenant.client, personnelNumbers: [a], asOf: '2026-01-31' }, ADMIN, NOW);
    const annual = row(r, a, 'ANNUAL');
    expect(annual.annualTarget).toBe('24.00');
    expect(annual.accrued).toBe('2.00');
    expect(annual.available).toBe('2.00');
    expect(annual.reconciled).toBe(true);
    expect(annual.lines.map((l) => l.effectiveDate)).toEqual(['2026-01-31']);
    expect(annual.nextCredit).toBe('2026-01-31'.slice(0, 8) + '31');
    // Through today: Jan and Feb credited, with a running total.
    const t = await leaveBalanceReport({ client: tenant.client, personnelNumbers: [a] }, ADMIN, NOW);
    const full = row(t, a, 'ANNUAL');
    expect(full.available).toBe('4.00');
    expect(full.lines.map((l) => [l.effectiveDate, l.quantity, l.cumulative])).toEqual([['2026-01-31', '2.00', '2.00'], ['2026-02-28', '2.00', '4.00']]);
    expect(full.lastCredit).toBe('2026-02-28');
    expect(row(t, a, 'SICK').available).toBe('12.00');
    expect(t.projectionDrift).toEqual([]);
  });

  it('refuses a future as-of and a year that has not begun, and a missing selection', async () => {
    expect((await refusal(leaveBalanceReport({ client: tenant.client, personnelNumbers: [a], asOf: '2026-12-31' }, ADMIN, NOW))).code).toBe('AS_OF_IN_FUTURE');
    expect((await refusal(leaveBalanceReport({ client: tenant.client, personnelNumbers: [a], year: 2027 }, ADMIN, NOW))).code).toBe('YEAR_AFTER_AS_OF');
    expect((await refusal(leaveBalanceReport({ client: tenant.client }, ADMIN, NOW))).code).toBe('NO_SELECTION');
    expect((await refusal(leaveBalanceReport({ client: tenant.client, personnelNumbers: [a], asOf: '2026-02-30' }, ADMIN, NOW))).code).toBe('INVALID_AS_OF');
  });

  it('counts adjustments and flags postings recorded after the as-of day as late', async () => {
    await adjustLeaveBalance({ client: tenant.client, personnelNumber: a, timeTypeCode: 'SICK', year: 2026, days: '-1', reason: 'Correction', requestKey: `rep-adj-${a}`, changedBy: ACTOR }, ADMIN);
    const t = await leaveBalanceReport({ client: tenant.client, personnelNumbers: [a] }, ADMIN, new Date());
    const sick = row(t, a, 'SICK');
    expect(sick.adjusted).toBe('-1.00');
    expect(sick.available).toBe('11.00');
    expect(sick.reconciled).toBe(true);
    // As of January the adjustment (effective today) is not counted.
    const past = await leaveBalanceReport({ client: tenant.client, personnelNumbers: [a], asOf: '2026-01-31' }, ADMIN, new Date());
    expect(row(past, a, 'SICK').adjusted).toBe('0.00');
  });

  it('selects several employees and by group, and scoped callers never see an unreachable one', async () => {
    const all = await leaveBalanceReport({ client: tenant.client, personnelNumbers: [a, b] }, ADMIN, NOW);
    expect(all.employeeCount).toBe(2);
    const actor = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW', 'PEOPLE.LEAVE.EXPORT'] });
    const scoped = await leaveBalanceReport({ client: tenant.client, personnelNumbers: [a, b, 'NOSUCH1'] }, live(actor), NOW);
    expect(scoped.rows.every((r) => r.personnelNumber === a)).toBe(true);
    expect(scoped.employeeCount).toBe(1);
    // Same wording for "outside scope" and "does not exist".
    expect(scoped.unavailable.sort()).toEqual([b, 'NOSUCH1'].sort());
    // By group: the unreachable member is neither shown nor counted.
    const grp = await leaveBalanceReport({ client: tenant.client, groupCode: 'OPS' }, live(actor), NOW);
    expect(grp.employeeCount).toBe(1);
    expect(grp.rows.map((r) => r.personnelNumber)).toEqual(expect.arrayContaining([a]));
    expect(JSON.stringify(grp)).not.toContain(b);
    const wide = await leaveBalanceReport({ client: tenant.client, groupCode: 'OPS' }, ADMIN, NOW);
    expect(wide.employeeCount).toBe(2);
  });

  it('refuses without VIEW, with a revoked session, and with a company scope that does not reach', async () => {
    const noView = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.EXPORT'] });
    expect((await refusal(leaveBalanceReport({ client: tenant.client, personnelNumbers: [a] }, live(noView), NOW))).code).toBe('LEAVE_AUTHORITY');
    const elsewhere = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW'], companyScopes: ['ZZZ9'] });
    const r = await leaveBalanceReport({ client: tenant.client, personnelNumbers: [a] }, live(elsewhere), NOW);
    expect(r.rows).toEqual([]);
    expect(r.employeeCount).toBe(0);
    const gone = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW'] });
    await withTenant(tenant.client, (tx) => revokeAllSessions(tx, { client: tenant.client, userId: gone.userId, reason: 'test' }));
    expect((await refusal(leaveBalanceReport({ client: tenant.client, personnelNumbers: [a] }, live(gone), NOW))).code).toBe('LEAVE_AUTHORITY');
  });

  it('labels a legacy quota and gives it no ledger history', async () => {
    const legacy = await payrollEmployee(fx, { positionFrom: '2025-12-01' });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into leave_quota (client, personnel_number, time_type_code, year, entitlement, taken, remaining, mode, created_by)
      values (${tenant.client}, ${legacy}, 'ANNUAL', 2026, 20, 5, 15, 'LEGACY', ${ACTOR})
    `));
    const r = await leaveBalanceReport({ client: tenant.client, personnelNumbers: [legacy] }, ADMIN, NOW);
    const l = row(r, legacy, 'ANNUAL');
    expect(l.mode).toBe('LEGACY');
    expect(l.available).toBe('15.00');
    expect(l.lines).toEqual([]);
    expect(l.limitation).toMatch(/no ledger history/);
  });
});

describe('leave balance CSV', () => {
  it('neutralises formulas and keeps numbers numeric', () => {
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=x', '  =x', '|calc']) {
      expect(csvText(evil)).toMatch(/^"'/);
    }
    expect(csvText('Ann "A" Lee')).toBe('"Ann ""A"" Lee"');
    expect(csvText('line\nbreak')).toBe('"line break"');
    expect(csvNumber('-2.50')).toBe('-2.50');
    expect(csvNumber('=1+1')).toBe('"\'=1+1"');
  });

  it('mirrors the authorised selection, needs EXPORT as well as VIEW, and never includes an unreachable employee', async () => {
    await withTenant(tenant.client, (tx) => tx.execute(sql`update employee set full_name = '=HYPERLINK("http://x")' where client = ${tenant.client} and personnel_number = ${a}`));
    const viewOnly = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW'] });
    expect((await refusal(leaveBalanceCsv({ client: tenant.client, personnelNumbers: [a] }, live(viewOnly), NOW))).code).toBe('LEAVE_AUTHORITY');
    const exporter = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW', 'PEOPLE.LEAVE.EXPORT'] });
    const csv = await leaveBalanceCsv({ client: tenant.client, personnelNumbers: [a, b] }, live(exporter), NOW);
    expect(csv.body.startsWith('﻿')).toBe(true);
    expect(csv.body).toContain(`"'=HYPERLINK`);
    expect(csv.body).not.toContain(`,"${b}",`);
    expect(csv.body).toContain(`Not available to you: ${b}`);
    expect(csv.rows).toBe(3);
  });
});
