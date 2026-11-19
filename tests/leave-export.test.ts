import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { closeDb, withTenant } from '../src/platform/db/client';
import { claimNext, runClaimed } from '../src/platform/job/execute';
import { clearJobRegistry, registerJob } from '../src/platform/job/registry';
import { defineTimeType } from '../src/modules/people/time-leave';
import { LeaveError } from '../src/modules/people/leave-access';
import { assignLeavePolicy, defineLeavePolicy } from '../src/modules/people/leave-policy';
import { SYSTEM_ACCRUAL_ACCESS, accrueChunk } from '../src/modules/people/leave-accrual';
import { adjustLeaveBalance } from '../src/modules/people/leave-ledger';
import { localDate } from '../src/modules/people/leave-math';
import { LEAVE_EXPORT_JOB, downloadLeaveExport, listLeaveExports, requestLeaveExport, runLeaveExportChunk } from '../src/modules/people/leave-export';
import { buildPayrollFixture, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createFinanceActor } from './helpers/finance-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ADMIN = ['*'] as const;
const ACTOR = 'LEAVE_EXPORT_TEST';
let tenant: TestTenant;
let fx: PayrollFixture;
let a: string;
let b: string;
let seq = 0;
const key = () => `export-key-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;
const live = (actor: { authorization: { userId: string; sessionId: string } }) => ({ authorization: actor.authorization });

async function refusal(p: Promise<unknown>): Promise<LeaveError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(LeaveError); return e as LeaveError; }
  throw new Error('expected a LeaveError');
}
async function drive(): Promise<void> {
  clearJobRegistry();
  registerJob({ code: LEAVE_EXPORT_JOB, chunk: runLeaveExportChunk });
  for (let i = 0; i < 10; i += 1) {
    const claimed = await claimNext('worker-test', ['INTENSIVE']);
    if (!claimed) break;
    await runClaimed('worker-test', claimed, {});
  }
}

beforeAll(async () => {
  tenant = await createTenant('leave-export');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await defineTimeType({ client: tenant.client, code: 'SICK', name: 'Sick', typeKind: 'ABSENCE', reducesQuota: true, isPaid: true, changedBy: ACTOR }, ADMIN);
  await defineLeavePolicy({
    client: tenant.client, code: 'STD', name: 'Standard', validFrom: '2026-01-01', partialMonthMode: 'PRORATE_DAYS',
    lines: [{ timeTypeCode: 'SICK', annualDays: '12', accrualMode: 'ANNUAL_UPFRONT', fallbackTypeCode: null }], changedBy: ACTOR,
  }, ADMIN);
  a = await payrollEmployee(fx, { positionFrom: '2025-12-01' });
  b = await payrollEmployee(fx, { positionFrom: null });
  for (const pn of [a, b]) {
    await assignLeavePolicy({ client: tenant.client, subjectKind: 'PERSON', subject: pn, policyCode: 'STD', validFrom: '2026-01-01', changedBy: ACTOR }, ADMIN);
  }
  await accrueChunk(tenant.client, { access: SYSTEM_ACCRUAL_ACCESS, after: null, limit: 500, window: 'ALL', at: new Date('2026-03-02T09:00:00Z') });
}, 180_000);

afterAll(async () => {
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('large leave export', () => {
  it('builds the file in the worker for the requester\'s reach only, and the owner downloads it', async () => {
    const actor = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW', 'PEOPLE.LEAVE.EXPORT'] });
    const v = await requestLeaveExport({ client: tenant.client, personnelNumbers: [a, b], asOf: '2026-03-01', requestKey: key() }, live(actor));
    expect(v.status).toBe('QUEUED');
    expect(v.downloadPath).toBeNull();
    await drive();
    const done = (await listLeaveExports(tenant.client, live(actor)))[0]!;
    expect(done.status).toBe('COMPLETED');
    expect(done.downloadPath).toBe(`/api/leave/balances/export/${v.exportId}`);
    const file = await downloadLeaveExport(tenant.client, v.exportId, live(actor));
    const text = file.body.toString('utf8');
    expect(text).toContain(a);
    expect(text).toContain('SICK');
    expect(text).toContain('12.00');
    // b has no company assignment: absent as a row, named only in the uniform not-available note.
    expect(text.split('\r\n').filter((l) => l.startsWith(`"${b}"`))).toEqual([]);
    expect(text).toContain('Not available to you');
    expect(file.filename).toBe('leave-balances-2026-03-01.csv');
  });

  it('is idempotent on its key, refuses a reused key with another selection, and needs a session and EXPORT', async () => {
    const actor = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW', 'PEOPLE.LEAVE.EXPORT'] });
    const k = key();
    const one = await requestLeaveExport({ client: tenant.client, personnelNumbers: [a], requestKey: k }, live(actor));
    const two = await requestLeaveExport({ client: tenant.client, personnelNumbers: [a], requestKey: k }, live(actor));
    expect(two.exportId).toBe(one.exportId);
    expect((await refusal(requestLeaveExport({ client: tenant.client, personnelNumbers: [b], requestKey: k }, live(actor)))).code).toBe('KEY_REUSED');
    expect((await refusal(requestLeaveExport({ client: tenant.client, personnelNumbers: [a], requestKey: key() }, ['PEOPLE.LEAVE.VIEW', 'PEOPLE.LEAVE.EXPORT']))).code).toBe('LEAVE_AUTHORITY');
    const viewOnly = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW'] });
    expect((await refusal(requestLeaveExport({ client: tenant.client, personnelNumbers: [a], requestKey: key() }, live(viewOnly)))).code).toBe('LEAVE_AUTHORITY');
    expect((await refusal(requestLeaveExport({ client: tenant.client, requestKey: key() }, live(actor)))).code).toBe('NO_SELECTION');
  });

  it('another user cannot download it, and revoked authority ends the job with no file', async () => {
    const owner = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW', 'PEOPLE.LEAVE.EXPORT'] });
    const other = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW', 'PEOPLE.LEAVE.EXPORT'] });
    const ok = await requestLeaveExport({ client: tenant.client, personnelNumbers: [a], requestKey: key() }, live(owner));
    await drive();
    expect((await refusal(downloadLeaveExport(tenant.client, ok.exportId, live(other)))).code).toBe('EXPORT_NOT_FOUND');
    expect((await listLeaveExports(tenant.client, live(other))).map((e) => e.exportId)).not.toContain(ok.exportId);

    const doomed = await requestLeaveExport({ client: tenant.client, personnelNumbers: [a], requestKey: key() }, live(owner));
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      delete from role_capability where client = ${tenant.client} and capability_code = 'PEOPLE.LEAVE.EXPORT'
         and role_code in (select role_code from user_role where client = ${tenant.client} and user_id = ${owner.userId})`));
    await drive();
    const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select status, error_code, body is not null as has_body from leave_export where client = ${tenant.client} and export_id = ${doomed.exportId}`))) as unknown as Array<{ status: string; error_code: string; has_body: boolean }>;
    expect(rows[0]).toEqual({ status: 'FAILED', error_code: 'LEAVE_AUTHORITY', has_body: false });
  });
});

describe('adjustment date', () => {
  it('is dated by the tenant time zone, not the server date', async () => {
    await withTenant(tenant.client, (tx) => tx.execute(sql`update client set timezone = 'Pacific/Kiritimati' where client = ${tenant.client}`));
    const year = Number(localDate(new Date(), 'Pacific/Kiritimati').slice(0, 4));
    await accrueChunk(tenant.client, { access: SYSTEM_ACCRUAL_ACCESS, after: null, limit: 500, window: 'ALL' });
    await adjustLeaveBalance({ client: tenant.client, personnelNumber: a, timeTypeCode: 'SICK', year, days: '1', reason: 'Tz check', requestKey: key(), changedBy: ACTOR }, ADMIN);
    const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select effective_date::text as eff from leave_ledger
       where client = ${tenant.client} and personnel_number = ${a} and entry_kind = 'ADJUSTMENT' and year = ${year}`))) as unknown as Array<{ eff: string }>;
    expect(rows.map((r) => r.eff)).toEqual([localDate(new Date(), 'Pacific/Kiritimati')]);
  });
});
