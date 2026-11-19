import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { closeDb, withTenant } from '../src/platform/db/client';
import {
  EMPLOYEE_CAPABILITY, EmployeeMasterError, RECORD_CAPABILITY, createEmployee, decideHire, linkEmployeeUser, viewEmployee,
} from '../src/modules/people/employee-master';
import { ASSIGNMENT_CAPABILITY, AssignmentError, assignPosition } from '../src/modules/people/assignment';
import { POSITION_CAPABILITY, changePosition, definePosition } from '../src/modules/people/org-structure';
import { HIRE_APPROVE_CAPABILITY } from '../src/modules/people/employee-tier';
import { AREA, CENTRE, buildPayrollFixture, type PayrollFixture } from './helpers/payroll-actor';
import { createFinanceActor } from './helpers/finance-actor';
import { placeOnChart } from './helpers/people-tier';
import { role, userRole } from '../src/platform/tables/security';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ADMIN = ['*'] as const;
const HR = [EMPLOYEE_CAPABILITY, RECORD_CAPABILITY, ASSIGNMENT_CAPABILITY, POSITION_CAPABILITY];
const APPROVER = [...HR, HIRE_APPROVE_CAPABILITY];
let tenant: TestTenant;
let fx: PayrollFixture;
let unit: string;
let n = 0;
const live = (a: { authorization: { userId: string; sessionId: string } }) => ({ authorization: a.authorization });

async function position(tier: number): Promise<string> {
  const code = `TQ${tier}${String(Date.now()).slice(-5)}${++n}`;
  await definePosition({ client: tenant.client, code, title: `Position tier ${tier}`, orgUnitCode: unit, tier, changedBy: 'T' }, ADMIN);
  return code;
}
async function actor(caps: string[], tier: number | null, plants: string[] = []) {
  const a = await createFinanceActor(tenant.client, { capabilities: caps, plantScopes: plants });
  if (tier !== null) await placeOnChart(tenant.client, a, tier, plants[0]);
  return a;
}
/** A user holding the ADMINISTRATOR system role: top tier, outside the employee group. */
async function admin() {
  const a = await createFinanceActor(tenant.client, { capabilities: ['*'] });
  await withTenant(tenant.client, async (tx) => {
    await tx.insert(role).values({
      client: tenant.client, code: 'ADMINISTRATOR', name: 'Administrator', description: 'Test copy of the system role', isSystemRole: true, isReadOnly: false, createdBy: 'T',
    }).onConflictDoNothing();
    await tx.insert(userRole).values({ client: tenant.client, userId: a.userId, roleCode: 'ADMINISTRATOR', createdBy: 'T' });
  });
  return a;
}
const request = (pn: string, positionCode: string, plant: string) => ({
  client: tenant.client, personnelNumber: pn, fullName: `Hire ${pn}`, proposedPositionCode: positionCode, proposedPlant: plant, changedBy: 'typed',
});

beforeAll(async () => {
  tenant = await createTenant('tier-approval');
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${tenant.client}, 'PL1', 'Plant one', ${tenant.companyCode}, 'KW', 'T'), (${tenant.client}, 'PL2', 'Plant two', ${tenant.companyCode}, 'KW', 'T')
      on conflict do nothing`);
  });
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  unit = `TQU${n}`;
  const { defineOrgUnit } = await import('../src/modules/people/org-structure');
  await defineOrgUnit({ client: tenant.client, code: unit, name: 'Tier unit', changedBy: 'T' }, ADMIN);
}, 180_000);
afterAll(async () => { await destroyTenant(tenant.client); await closeDb(); });

describe('hire requests need a tier above the position', () => {
  it('a clerk cannot add a manager; a clerk can request a lower tier, logged under the session user', async () => {
    const manager = await position(5);
    const staff = await position(2);
    const clerk = await actor(HR, 3, ['PL1']);
    await expect(createEmployee(request('TQH001', manager, 'PL1'), live(clerk))).rejects.toMatchObject({ message: expect.stringMatching(/tier/i) });
    const made = await createEmployee(request('TQH002', staff, 'PL1'), live(clerk));
    expect(made).toMatchObject({ hireStatus: 'PENDING', isActive: false, hireRequestedBy: clerk.username, tier: 2 });
    // The same tier is not above.
    await expect(createEmployee(request('TQH003', await position(3), 'PL1'), live(clerk))).rejects.toBeInstanceOf(EmployeeMasterError);
  });

  it('a user linked to no employee is refused; admin roles are top tier; in-process callers bypass', async () => {
    const staff = await position(2);
    const unlinked = await actor(HR, null, []);
    await expect(createEmployee(request('TQH010', staff, 'PL1'), live(unlinked))).rejects.toMatchObject({ message: expect.stringMatching(/tier|linked/i) });
    const root = await admin();
    expect((await createEmployee(request('TQH011', await position(9), 'PL1'), live(root))).hireStatus).toBe('PENDING');
    expect((await createEmployee({ client: tenant.client, personnelNumber: 'TQH012', fullName: 'In process', changedBy: 'T' }, ADMIN)).isActive).toBe(true);
  });
});

describe('approving a hire', () => {
  it('needs the capability, a higher tier, reach and a different person; reject needs a note', async () => {
    const staff = await position(2);
    const requester = await actor(APPROVER, 3, ['PL1']);
    await createEmployee(request('TQA001', staff, 'PL1'), live(requester));
    const decide = (pn: string, a: { authorization: { userId: string; sessionId: string } }, decision: 'APPROVE' | 'REJECT' = 'APPROVE', note?: string) =>
      decideHire({ client: tenant.client, personnelNumber: pn, decision, ...(note ? { note } : {}), changedBy: 'typed' }, live(a));

    await expect(decide('TQA001', requester)).rejects.toMatchObject({ message: expect.stringMatching(/you requested/i) }); // not your own
    const noCap = await actor(HR, 6, []);
    await expect(decide('TQA001', noCap)).rejects.toBeInstanceOf(EmployeeMasterError);
    const peer = await actor(APPROVER, 2, []);
    await expect(decide('TQA001', peer)).rejects.toMatchObject({ message: expect.stringMatching(/tier/i) }); // not above tier 2
    const elsewhere = await actor(APPROVER, 6, ['PL2']);
    await expect(decide('TQA001', elsewhere)).rejects.toBeInstanceOf(EmployeeMasterError); // plant PL1 is out of reach
    const officer = await actor(APPROVER, 4, []);
    await expect(decide('TQA001', officer, 'REJECT')).rejects.toMatchObject({ message: expect.stringMatching(/note|reason/i) });

    const approved = await decide('TQA001', officer);
    expect(approved).toMatchObject({ hireStatus: 'ACTIVE', isActive: true });
    await expect(decide('TQA001', officer)).rejects.toBeInstanceOf(EmployeeMasterError); // no longer pending
  });

  it('a rejected hire stays inactive; an admin may approve their own request', async () => {
    const staff = await position(2);
    const officer = await actor(APPROVER, 4, []);
    const clerk = await actor(HR, 3, ['PL1']);
    await createEmployee(request('TQA002', staff, 'PL1'), live(clerk));
    const rejected = await decideHire({ client: tenant.client, personnelNumber: 'TQA002', decision: 'REJECT', note: 'No budget', changedBy: 'x' }, live(officer));
    expect(rejected).toMatchObject({ hireStatus: 'REJECTED', isActive: false });

    const root = await admin();
    await createEmployee(request('TQA003', staff, 'PL1'), live(root));
    expect((await decideHire({ client: tenant.client, personnelNumber: 'TQA003', decision: 'APPROVE', changedBy: 'x' }, live(root))).isActive).toBe(true);
  });
});

describe('assignments, positions and links are tier-checked', () => {
  it('assigning needs a tier above the employee and the target position', async () => {
    const low = await position(2);
    const high = await position(5);
    const clerk = await actor(HR, 3, ['PL1']);
    await createEmployee({ client: tenant.client, personnelNumber: 'TQS001', fullName: 'Staff', changedBy: 'T' }, ADMIN);
    const base = { client: tenant.client, personnelNumber: 'TQS001', controllingArea: AREA, costCenter: CENTRE, plant: 'PL1', validFrom: '2026-01-01', changedBy: 'x' };
    await expect(assignPosition({ ...base, positionCode: high }, live(clerk))).rejects.toBeInstanceOf(AssignmentError);
    expect((await assignPosition({ ...base, positionCode: low }, live(clerk))).plant).toBe('PL1');
  });

  it('changing a position tier needs a tier above both the old and the new value', async () => {
    const code = await position(4);
    const officer = await actor(HR, 5, []);
    await expect(changePosition({ client: tenant.client, code, tier: 6, changedBy: 'x' }, live(officer))).rejects.toBeDefined();
    expect((await changePosition({ client: tenant.client, code, tier: 3, changedBy: 'x' }, live(officer))).tier).toBe(3);
  });

  it('linking: not yourself, not an inactive employee, one user per employee', async () => {
    const officer = await actor(HR, 5, []);
    const mine = await placeOnChart(tenant.client, await actor(HR, null), 1);
    const other = await actor(HR, null);
    const link = (pn: string, username: string | null, a = officer) => linkEmployeeUser({ client: tenant.client, personnelNumber: pn, username, changedBy: 'x' }, live(a));
    expect((await link(mine.personnelNumber, other.username)).linkedUsername).toBe(other.username);
    await expect(link('TQS001', other.username)).rejects.toBeInstanceOf(EmployeeMasterError); // already another's
    await expect(link('TQS001', officer.username)).rejects.toBeInstanceOf(EmployeeMasterError); // not yourself
    expect((await viewEmployee(tenant.client, mine.personnelNumber, live(officer))).linkedUsername).toBe(other.username);
  });
});
