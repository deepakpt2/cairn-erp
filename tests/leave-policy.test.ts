import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { EMPLOYEE_CAPABILITY, createEmployee } from '../src/modules/people/employee-master';
import { defineTimeType } from '../src/modules/people/time-leave';
import {
  LeaveError,
} from '../src/modules/people/leave-access';
import {
  addGroupMember, addLeavePolicyVersion, assignLeavePolicy, defineLeaveGroup, defineLeavePolicy,
  endLeavePolicyAssignment, listLeaveAssignments, listLeaveGroups, listLeavePolicies, resolveLeaveSegments,
} from '../src/modules/people/leave-policy';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ADMIN = ['*'] as const;
const ENTER_ONLY = ['PEOPLE.TIME.ENTER'] as const;
const ACTOR = 'LEAVE_POLICY_TEST';

let tenant: TestTenant;
let other: TestTenant;
let n = 0;

async function person(t: TestTenant): Promise<string> {
  const personnelNumber = `LP${String(700000 + ++n)}`;
  await createEmployee({ client: t.client, personnelNumber, fullName: `Leave Policy Person ${n}`, changedBy: ACTOR, requestKey: `lp-emp-${n}-${t.client}` }, [EMPLOYEE_CAPABILITY]);
  return personnelNumber;
}

async function failure(p: Promise<unknown>): Promise<LeaveError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LeaveError);
    return e as LeaveError;
  }
  throw new Error('expected a LeaveError');
}

const LINES = [
  { timeTypeCode: 'ANNUAL', annualDays: '24', accrualMode: 'MONTHLY' as const, fallbackTypeCode: 'UNPAID' },
  { timeTypeCode: 'UNPAID', annualDays: '15', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
  { timeTypeCode: 'SICK', annualDays: '12', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
  { timeTypeCode: 'EMERG', annualDays: '20', accrualMode: 'ANNUAL_UPFRONT' as const, fallbackTypeCode: null },
];

describe('leave policy configuration', () => {
  beforeAll(async () => {
    tenant = await createTenant('leave-policy-a', { withConfiguration: true });
    other = await createTenant('leave-policy-b', { withConfiguration: true });
    for (const [code, paid] of [['ANNUAL', true], ['UNPAID', false], ['SICK', true], ['EMERG', false]] as const) {
      await defineTimeType({ client: tenant.client, code, name: code, typeKind: 'ABSENCE', reducesQuota: true, isPaid: paid, changedBy: ACTOR }, ADMIN);
    }
    await defineTimeType({ client: tenant.client, code: 'ATTEND', name: 'Attendance', typeKind: 'ATTENDANCE', changedBy: ACTOR }, ADMIN);
  });
  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
  });

  const base = () => ({ client: tenant.client, validFrom: '2026-01-01', partialMonthMode: 'PRORATE_DAYS' as const, lines: LINES, changedBy: ACTOR });

  it('refuses callers without the configure capability, including time-entry users', async () => {
    const e = await failure(defineLeavePolicy({ ...base(), code: 'NOAUTH', name: 'No' }, ENTER_ONLY));
    expect(e.code).toBe('LEAVE_AUTHORITY');
    expect((await failure(defineLeavePolicy({ ...base(), code: 'NOAUTH', name: 'No' }, undefined))).code).toBe('LEAVE_AUTHORITY');
  });

  it('requires an explicit partial-month choice and rejects mid-month versions', async () => {
    const { partialMonthMode: _omit, ...rest } = base();
    expect((await failure(defineLeavePolicy({ ...rest, code: 'NOMODE', name: 'x' }, ADMIN))).code).toBe('PARTIAL_MONTH_MODE');
    expect((await failure(defineLeavePolicy({ ...base(), validFrom: '2026-01-15', code: 'MIDM', name: 'x' }, ADMIN))).code).toBe('VERSION_MONTH_START');
  });

  it('validates lines: known quota types, fallback inside the policy, no cycles', async () => {
    expect((await failure(defineLeavePolicy({ ...base(), code: 'BADT', name: 'x', lines: [{ ...LINES[0]!, timeTypeCode: 'ATTEND', fallbackTypeCode: null }] }, ADMIN))).code).toBe('TIME_TYPE_NO_QUOTA');
    expect((await failure(defineLeavePolicy({ ...base(), code: 'BADF', name: 'x', lines: [LINES[0]!] }, ADMIN))).code).toBe('FALLBACK_NOT_IN_POLICY');
    const cyc = [
      { ...LINES[0]!, fallbackTypeCode: 'SICK' },
      { ...LINES[2]!, fallbackTypeCode: 'ANNUAL' },
    ];
    expect((await failure(defineLeavePolicy({ ...base(), code: 'CYC', name: 'x', lines: cyc }, ADMIN))).code).toBe('FALLBACK_CYCLE');
    // nothing was written by the refused definitions
    expect((await listLeavePolicies(tenant.client, ADMIN)).map((p) => p.code)).not.toContain('CYC');
  });

  it('defines the example policy; versions are immutable and ordered', async () => {
    const p = await defineLeavePolicy({ ...base(), code: 'STD', name: 'Standard' }, ADMIN);
    expect(p.versions).toHaveLength(1);
    expect(p.versions[0]!.partialMonthMode).toBe('PRORATE_DAYS');
    expect(p.versions[0]!.lines.find((l) => l.timeTypeCode === 'ANNUAL')).toMatchObject({ annualDays: '24.00', accrualMode: 'MONTHLY', fallbackTypeCode: 'UNPAID' });
    expect((await failure(addLeavePolicyVersion({ ...base(), policyCode: 'STD', validFrom: '2026-01-01' }, ADMIN))).code).toBe('VERSION_NOT_LATER');
    const v2 = await addLeavePolicyVersion({ ...base(), policyCode: 'STD', validFrom: '2027-01-01', partialMonthMode: 'FULL_IF_ANY' }, ADMIN);
    expect(v2.versions.map((v) => v.version)).toEqual([1, 2]);
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`update leave_policy_version set partial_month_mode = 'FULL_IF_ANY' where client = ${tenant.client} and policy_code = 'STD' and version = 1`))).rejects.toThrow();
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`delete from leave_policy_line where client = ${tenant.client} and policy_code = 'STD'`))).rejects.toThrow();
  });

  it('group membership is exclusive in time; assignments overlap-refuse by name', async () => {
    await defineLeaveGroup({ client: tenant.client, code: 'G1', name: 'Group one', changedBy: ACTOR }, ADMIN);
    await defineLeaveGroup({ client: tenant.client, code: 'G2', name: 'Group two', changedBy: ACTOR }, ADMIN);
    const a = await person(tenant);
    await addGroupMember({ client: tenant.client, groupCode: 'G1', personnelNumber: a, validFrom: '2026-01-01', validTo: '2026-06-30', changedBy: ACTOR }, ADMIN);
    expect((await failure(addGroupMember({ client: tenant.client, groupCode: 'G2', personnelNumber: a, validFrom: '2026-06-01', changedBy: ACTOR }, ADMIN))).code).toBe('MEMBERSHIP_OVERLAP');
    await addGroupMember({ client: tenant.client, groupCode: 'G2', personnelNumber: a, validFrom: '2026-07-01', changedBy: ACTOR }, ADMIN);

    await assignLeavePolicy({ client: tenant.client, subjectKind: 'GROUP', subject: 'G1', policyCode: 'STD', validFrom: '2026-01-01', changedBy: ACTOR }, ADMIN);
    expect((await failure(assignLeavePolicy({ client: tenant.client, subjectKind: 'GROUP', subject: 'G1', policyCode: 'STD', validFrom: '2026-03-01', changedBy: ACTOR }, ADMIN))).code).toBe('ASSIGNMENT_OVERLAP');
    expect((await failure(assignLeavePolicy({ client: tenant.client, subjectKind: 'GROUP', subject: 'G1', policyCode: 'NOPE', validFrom: '2030-01-01', changedBy: ACTOR }, ADMIN))).code).toBe('POLICY_UNKNOWN');
    expect((await failure(assignLeavePolicy({ client: tenant.client, subjectKind: 'GROUP', subject: 'G2', policyCode: 'STD', validFrom: '2025-12-01', changedBy: ACTOR }, ADMIN))).code).toBe('BEFORE_FIRST_VERSION');
  });

  it('a direct assignment overrides the group only for its interval; the group resumes after', async () => {
    await defineLeavePolicy({ ...base(), code: 'DIRECT', name: 'Direct', lines: [{ timeTypeCode: 'ANNUAL', annualDays: '30', accrualMode: 'MONTHLY', fallbackTypeCode: null }] }, ADMIN);
    await defineLeaveGroup({ client: tenant.client, code: 'G3', name: 'Group three', changedBy: ACTOR }, ADMIN);
    const b = await person(tenant);
    await addGroupMember({ client: tenant.client, groupCode: 'G3', personnelNumber: b, validFrom: '2026-01-01', changedBy: ACTOR }, ADMIN);
    await assignLeavePolicy({ client: tenant.client, subjectKind: 'GROUP', subject: 'G3', policyCode: 'STD', validFrom: '2026-01-01', changedBy: ACTOR }, ADMIN);
    const directId = await assignLeavePolicy({ client: tenant.client, subjectKind: 'PERSON', subject: b, policyCode: 'DIRECT', validFrom: '2026-04-01', validTo: '2026-06-30', changedBy: ACTOR }, ADMIN);

    const segs = await withTenant(tenant.client, (tx) => resolveLeaveSegments(tx, tenant.client, b, '2026-01-01', '2026-12-31'));
    expect(segs.map((s) => [s.policyCode, s.source, s.from, s.to])).toEqual([
      ['STD', 'GROUP', '2026-01-01', '2026-03-31'],
      ['DIRECT', 'PERSON', '2026-04-01', '2026-06-30'],
      ['STD', 'GROUP', '2026-07-01', '2026-12-31'],
    ]);
    // two direct assignments cannot overlap either
    expect((await failure(assignLeavePolicy({ client: tenant.client, subjectKind: 'PERSON', subject: b, policyCode: 'DIRECT', validFrom: '2026-06-01', changedBy: ACTOR }, ADMIN))).code).toBe('ASSIGNMENT_OVERLAP');
    // ending the override early returns the group sooner
    await endLeavePolicyAssignment({ client: tenant.client, id: directId, validTo: '2026-04-30', changedBy: ACTOR }, ADMIN);
    const after = await withTenant(tenant.client, (tx) => resolveLeaveSegments(tx, tenant.client, b, '2026-04-01', '2026-06-30'));
    expect(after.map((s) => [s.policyCode, s.from, s.to])).toEqual([['DIRECT', '2026-04-01', '2026-04-30'], ['STD', '2026-05-01', '2026-06-30']]);
  });

  it('splits a segment at a policy version boundary and never invents entitlement before the first version', async () => {
    const c = await person(tenant);
    await assignLeavePolicy({ client: tenant.client, subjectKind: 'PERSON', subject: c, policyCode: 'STD', validFrom: '2026-10-01', changedBy: ACTOR }, ADMIN);
    const segs = await withTenant(tenant.client, (tx) => resolveLeaveSegments(tx, tenant.client, c, '2026-10-01', '2027-02-28'));
    expect(segs.map((s) => [s.version, s.partialMonthMode, s.from, s.to])).toEqual([
      [1, 'PRORATE_DAYS', '2026-10-01', '2026-12-31'],
      [2, 'FULL_IF_ANY', '2027-01-01', '2027-02-28'],
    ]);
    expect(await withTenant(tenant.client, (tx) => resolveLeaveSegments(tx, tenant.client, c, '2026-01-01', '2026-09-30'))).toEqual([]);
  });

  it('refuses a posted-period rewrite and an unknown/inactive employee', async () => {
    const d = await person(tenant);
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into leave_ledger (client, id, personnel_number, time_type_code, year, entry_kind, effective_date, quantity, source_kind, source_key, created_by)
      values (${tenant.client}, 'LED-POSTED-1', ${d}, 'ANNUAL', 2026, 'MONTHLY_ACCRUAL', '2026-05-31', 2.00, 'ACCRUAL', ${`posted-${d}`}, 'TEST')`));
    expect((await failure(addGroupMember({ client: tenant.client, groupCode: 'G1', personnelNumber: d, validFrom: '2026-05-10', changedBy: ACTOR }, ADMIN))).code).toBe('CHANGE_AFFECTS_POSTED');
    expect((await failure(assignLeavePolicy({ client: tenant.client, subjectKind: 'PERSON', subject: 'ZZ9999', policyCode: 'STD', validFrom: '2026-08-01', changedBy: ACTOR }, ADMIN))).code).toBe('EMPLOYEE_UNKNOWN');
  });

  it('the ledger is immutable and its projection cannot be edited around', async () => {
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`update leave_ledger set quantity = 9 where client = ${tenant.client}`))).rejects.toThrow();
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`delete from leave_ledger where client = ${tenant.client}`))).rejects.toThrow();
    // the projection row the posted entry created is policy-owned: a direct edit is refused
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`update leave_quota set entitlement = 99 where client = ${tenant.client} and mode = 'POLICY'`))).rejects.toThrow();
    const [q] = await withTenant(tenant.client, (tx) => tx.execute(sql`select remaining::text as r from leave_quota where client = ${tenant.client} and mode = 'POLICY' limit 1`)) as unknown as Array<{ r: string }>;
    expect(q!.r).toBe('2.00');
  });

  it('is invisible to another tenant', async () => {
    expect(await listLeavePolicies(other.client, ADMIN)).toEqual([]);
    expect(await listLeaveGroups(other.client, ADMIN)).toEqual([]);
    expect(await listLeaveAssignments(other.client, ADMIN)).toEqual([]);
    const own = await listLeaveGroups(tenant.client, ADMIN);
    expect(own.length).toBeGreaterThan(0);
    const rows = await withTenant(other.client, (tx) => tx.execute(sql`select count(*)::int as c from leave_group where client = ${tenant.client}`)) as unknown as Array<{ c: number }>;
    expect(rows[0]!.c).toBe(0);
  });
});
