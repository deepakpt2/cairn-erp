import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb } from '../src/platform/db/client';
import { defineTimeType } from '../src/modules/people/time-leave';
import { LeaveError } from '../src/modules/people/leave-access';
import { requestLeaveAbsence } from '../src/modules/people/leave-absence';
import { listLeaveAbsences, listLeaveTimeRecordings, searchLeaveEmployees } from '../src/modules/people/leave-views';
import { buildPayrollFixture, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createFinanceActor } from './helpers/finance-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ADMIN = ['*'] as const;
let tenant: TestTenant;
let fx: PayrollFixture;
let a: string; // reachable by a scoped caller
let b: string; // no company assignment: never reachable by a scoped caller

beforeAll(async () => {
  tenant = await createTenant('leave-views');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await defineTimeType({ client: tenant.client, code: 'TRAIN', name: 'Training', typeKind: 'ABSENCE', reducesQuota: false, isPaid: true, changedBy: 'T' }, ADMIN);
  a = await payrollEmployee(fx, { positionFrom: '2025-12-01' });
  b = await payrollEmployee(fx, { positionFrom: null });
  for (const pn of [a, b]) {
    await requestLeaveAbsence({ client: tenant.client, personnelNumber: pn, timeTypeCode: 'TRAIN', validFrom: '2026-04-06', validTo: '2026-04-07', requestKey: `views-${pn}-key` }, ['PEOPLE.TIME.ENTER']);
  }
}, 180_000);
afterAll(async () => { await destroyTenant(tenant.client); await closeDb(); });

const live = (x: { authorization: { userId: string; sessionId: string } }) => ({ authorization: x.authorization });

describe('scoped leave reads', () => {
  it('lists absences with their exact ids, only for employees the caller reaches', async () => {
    const actor = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.TIME.ENTER'] });
    const scoped = await listLeaveAbsences(tenant.client, live(actor));
    expect(scoped.map((r) => r.personnelNumber)).toEqual([a]);
    expect(scoped[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    const all = await listLeaveAbsences(tenant.client, ADMIN);
    expect(all.map((r) => r.personnelNumber).sort()).toEqual([a, b].sort());
  });

  it('a company scope elsewhere sees nothing, and a role without any leave capability is refused', async () => {
    const elsewhere = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.TIME.ENTER'], companyScopes: ['ZZZZ'] });
    expect(await listLeaveAbsences(tenant.client, live(elsewhere))).toEqual([]);
    expect(await searchLeaveEmployees(tenant.client, live(elsewhere), { from: '2026-01-01', to: '2026-12-31' })).toEqual([]);
    const none = await createFinanceActor(tenant.client, { capabilities: [] });
    await expect(listLeaveAbsences(tenant.client, live(none))).rejects.toBeInstanceOf(LeaveError);
    await expect(listLeaveTimeRecordings(tenant.client, live(none))).rejects.toBeInstanceOf(LeaveError);
  });

  it('the employee picker is narrowed by scope and by the search text', async () => {
    const actor = await createFinanceActor(tenant.client, { capabilities: ['PEOPLE.TIME.ENTER'] });
    const picked = await searchLeaveEmployees(tenant.client, live(actor), { from: '2026-01-01', to: '2026-12-31' });
    expect(picked.map((e) => e.personnelNumber)).toContain(a);
    expect(picked.map((e) => e.personnelNumber)).not.toContain(b);
    expect(await searchLeaveEmployees(tenant.client, live(actor), { query: 'NO-SUCH-NAME', from: '2026-01-01', to: '2026-12-31' })).toEqual([]);
    // Wildcard characters in the search text are literal, not a way to widen it.
    expect(await searchLeaveEmployees(tenant.client, live(actor), { query: '%', from: '2026-01-01', to: '2026-12-31' })).toEqual([]);
  });
});
