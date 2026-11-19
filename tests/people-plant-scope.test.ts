import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { closeDb, withTenant } from '../src/platform/db/client';
import {
  EMPLOYEE_CAPABILITY, EmployeeMasterError, RECORD_CAPABILITY, changeEmployee, createEmployee, searchEmployees, viewEmployee,
} from '../src/modules/people/employee-master';
import {
  ASSIGNMENT_CAPABILITY, AssignmentError, assignPosition, assignmentsOf, changeAssignment, delimitAssignment, listAssignments,
} from '../src/modules/people/assignment';
import { searchLeaveEmployees } from '../src/modules/people/leave-views';
import { PayrollStructureError, SALARY_STRUCTURE_CAPABILITY, listAssignments as listPayAssignments } from '../src/modules/people/payroll-structure';
import { AREA, CENTRE, buildPayrollFixture, type PayrollFixture } from './helpers/payroll-actor';
import { createFinanceActor } from './helpers/finance-actor';
import { placeOnChart } from './helpers/people-tier';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ADMIN = ['*'] as const;
const HR = [EMPLOYEE_CAPABILITY, RECORD_CAPABILITY, ASSIGNMENT_CAPABILITY, 'PEOPLE.TIME.ENTER', SALARY_STRUCTURE_CAPABILITY];
let tenant: TestTenant;
let fx: PayrollFixture;
let inP1: string; // works in plant PL1
let inP2: string; // works in plant PL2
let wide: string; // company-wide assignment: no plant
const live = (a: { authorization: { userId: string; sessionId: string } }) => ({ authorization: a.authorization });
let n = 0;

async function hire(plant: string | null | 'none'): Promise<string> {
  const pn = `PS${String(++n).padStart(3, '0')}${String(Date.now()).slice(-6)}`;
  await createEmployee({ client: tenant.client, personnelNumber: pn, fullName: `Scope Person ${pn}`, changedBy: 'T', requestKey: `plant-scope-${pn}` }, ADMIN);
  if (plant !== 'none') {
    await assignPosition({
      client: tenant.client, personnelNumber: pn, positionCode: fx.positionCode, controllingArea: AREA, costCenter: CENTRE,
      plant: plant ?? undefined, validFrom: '2025-01-01', changedBy: 'T',
    }, ADMIN);
  }
  return pn;
}

beforeAll(async () => {
  tenant = await createTenant('plant-scope');
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${tenant.client}, 'PL1', 'Plant one', ${tenant.companyCode}, 'KW', 'T'),
             (${tenant.client}, 'PL2', 'Plant two', ${tenant.companyCode}, 'KW', 'T')
      on conflict do nothing`);
  });
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  inP1 = await hire('PL1');
  inP2 = await hire('PL2');
  wide = await hire(null);
}, 180_000);
afterAll(async () => { await destroyTenant(tenant.client); await closeDb(); });

// Every employee here sits on a tier-1 position, so an actor on a tier-5 position stands above them all.
const clerk = async (plants: string[]) => {
  const actor = await createFinanceActor(tenant.client, { capabilities: HR, plantScopes: plants });
  await placeOnChart(tenant.client, actor, 5, plants[0]);
  return actor;
};

describe('employee reach by plant or company', () => {
  it('a plant clerk sees and changes only their plant; an officer without plant scope sees the whole company', async () => {
    const c1 = await clerk(['PL1']);
    const seen = (await searchEmployees(tenant.client, 'SCOPE PERSON', live(c1))).map((e) => e.personnelNumber);
    expect(seen).toContain(inP1);
    expect(seen).not.toContain(inP2);
    expect(seen).not.toContain(wide); // an assignment with no plant is not a plant clerk's

    const officer = await clerk([]);
    const all = (await searchEmployees(tenant.client, 'SCOPE PERSON', live(officer))).map((e) => e.personnelNumber);
    expect(all).toEqual(expect.arrayContaining([inP1, inP2, wide]));

    expect((await viewEmployee(tenant.client, inP1, live(c1))).personnelNumber).toBe(inP1);
    const hidden = await viewEmployee(tenant.client, inP2, live(c1)).catch((e) => e);
    const missing = await viewEmployee(tenant.client, 'NOSUCH99', live(c1)).catch((e) => e);
    expect(hidden).toBeInstanceOf(EmployeeMasterError);
    expect(hidden.message).toBe(missing.message.replace('NOSUCH99', inP2)); // an out-of-reach number looks like an unknown one

    const renamed = await changeEmployee({ client: tenant.client, personnelNumber: inP1, fullName: 'Scope Person Renamed', changedBy: 'x' }, live(c1));
    expect(renamed.fullName).toBe('Scope Person Renamed');
    await expect(changeEmployee({ client: tenant.client, personnelNumber: inP2, fullName: 'Nope', changedBy: 'x' }, live(c1)))
      .rejects.toBeInstanceOf(EmployeeMasterError);
    expect((await changeEmployee({ client: tenant.client, personnelNumber: inP2, fullName: 'Scope Person Two', changedBy: 'x' }, live(officer))).fullName).toBe('Scope Person Two');
  });

  it('holding every plant of the company is company level; holding only some is not', async () => {
    const all = await createFinanceActor(tenant.client, { capabilities: HR }); // every plant the tenant has
    await placeOnChart(tenant.client, all, 5);
    const seen = (await searchEmployees(tenant.client, 'SCOPE PERSON', live(all))).map((e) => e.personnelNumber);
    expect(seen).toEqual(expect.arrayContaining([inP1, inP2, wide]));
    const some = await clerk(['PL1', 'PL2']); // the tenant has further plants, so this is still plant level
    expect((await searchEmployees(tenant.client, 'SCOPE PERSON', live(some))).map((e) => e.personnelNumber)).not.toContain(wide);
  });

  it('a company scope elsewhere, a missing capability or a dead session reach nothing', async () => {
    const elsewhere = await createFinanceActor(tenant.client, { capabilities: HR, companyScopes: ['ZZZZ'], plantScopes: [] });
    expect(await searchEmployees(tenant.client, 'SCOPE PERSON', live(elsewhere))).toEqual([]);
    const none = await createFinanceActor(tenant.client, { capabilities: [] });
    await expect(searchEmployees(tenant.client, undefined, live(none))).rejects.toBeInstanceOf(EmployeeMasterError);
    await expect(searchEmployees(tenant.client, undefined, { authorization: undefined })).rejects.toBeInstanceOf(EmployeeMasterError);
    await expect(searchEmployees(tenant.client, undefined, undefined)).rejects.toThrow();
  });

  it('a hire is a request for a plant: a clerk may ask for their own plant only, and sees only their own requests', async () => {
    const c1 = await clerk(['PL1']);
    const hireOf = (pn: string, plant?: string) => ({
      client: tenant.client, personnelNumber: pn, fullName: 'New Hire', proposedPositionCode: fx.positionCode, ...(plant ? { proposedPlant: plant } : {}), changedBy: 'x',
    });
    await expect(createEmployee(hireOf('NEWHIRE0'), live(c1))).rejects.toBeInstanceOf(EmployeeMasterError); // a plant clerk must name a plant
    await expect(createEmployee(hireOf('NEWHIRE0', 'PL2'), live(c1))).rejects.toBeInstanceOf(EmployeeMasterError);
    const officer = await clerk([]);
    const made = await createEmployee(hireOf('NEWHIRE1', 'PL1'), live(c1));
    expect(made.hireStatus).toBe('PENDING');
    expect(made.isActive).toBe(false);
    expect(made.hireRequestedBy).toBe(c1.username); // logged under the session's user, not the typed name
    expect((await searchEmployees(tenant.client, 'NEW HIRE', live(c1))).map((e) => e.personnelNumber)).toContain('NEWHIRE1');
    expect((await searchEmployees(tenant.client, 'NEW HIRE', live(officer))).map((e) => e.personnelNumber)).toContain('NEWHIRE1');
    const other = await clerk(['PL2']);
    expect(await searchEmployees(tenant.client, 'NEW HIRE', live(other))).toEqual([]);
  });
});

describe('assignments carry the plant, and the scope judges every move', () => {
  it('a clerk assigns into their own plant only, and cannot move or end another plant\'s employee', async () => {
    const c1 = await clerk(['PL1']);
    const officer = await clerk([]);
    const fresh = await hire('none');
    // Into a plant they do not hold, or with no plant at all: refused. Into their own: written.
    const base = { client: tenant.client, personnelNumber: fresh, positionCode: fx.positionCode, controllingArea: AREA, costCenter: CENTRE, validFrom: '2026-01-01', changedBy: 'x' };
    await expect(assignPosition({ ...base, plant: 'PL2' }, live(c1))).rejects.toMatchObject({ message: expect.stringMatching(/scope does not cover/) });
    await expect(assignPosition({ ...base }, live(c1))).rejects.toBeInstanceOf(AssignmentError);
    expect((await assignPosition({ ...base, plant: 'PL1' }, live(c1))).plant).toBe('PL1');

    // Another plant's employee: the assignment looks unknown, so nothing is confirmed.
    await expect(delimitAssignment({ client: tenant.client, personnelNumber: inP2, validFrom: '2025-01-01', validTo: '2026-02-01', changedBy: 'x' }, live(c1)))
      .rejects.toMatchObject({ message: expect.stringMatching(/No assignment of that employee begins on that date/) });
    await expect(changeAssignment({ client: tenant.client, personnelNumber: inP2, validFrom: '2025-01-01', plant: 'PL1', changedBy: 'x' }, live(c1)))
      .rejects.toBeInstanceOf(AssignmentError);
    // Moving their own employee out of reach is refused too.
    await expect(changeAssignment({ client: tenant.client, personnelNumber: inP1, validFrom: '2025-01-01', plant: 'PL2', changedBy: 'x' }, live(c1)))
      .rejects.toMatchObject({ message: expect.stringMatching(/scope does not cover/) });
    expect((await changeAssignment({ client: tenant.client, personnelNumber: inP2, validFrom: '2025-01-01', plant: 'PL1', changedBy: 'x' }, live(officer))).plant).toBe('PL1');
    await changeAssignment({ client: tenant.client, personnelNumber: inP2, validFrom: '2025-01-01', plant: 'PL2', changedBy: 'x' }, live(officer));
  });

  it('refuses a plant that does not exist or sits in another company, and a plant-limited read hides the rest', async () => {
    await expect(assignPosition({
      client: tenant.client, personnelNumber: await hire('none'), positionCode: fx.positionCode, controllingArea: AREA, costCenter: CENTRE,
      plant: 'NOPE', validFrom: '2026-01-01', changedBy: 'x',
    }, ADMIN)).rejects.toMatchObject({ message: expect.stringMatching(/No plant of that code/) });

    const c1 = await clerk(['PL1']);
    const rows = await listAssignments({ client: tenant.client, query: 'SCOPE PERSON' }, live(c1));
    const people = new Set(rows.map((r) => r.personnelNumber));
    expect(people.has(inP1)).toBe(true);
    expect(people.has(inP2)).toBe(false);
    await expect(assignmentsOf(tenant.client, inP2, live(c1))).rejects.toBeInstanceOf(AssignmentError);
    expect((await assignmentsOf(tenant.client, inP1, live(c1))).length).toBeGreaterThan(0);
  });
});

describe('leave and pay follow the same reach', () => {
  it('the leave employee picker and the pay structure honour the plant', async () => {
    const c1 = await clerk(['PL1']);
    const picked = (await searchLeaveEmployees(tenant.client, live(c1), { from: '2026-01-01', to: '2026-12-31' })).map((e) => e.personnelNumber);
    expect(picked).toContain(inP1);
    expect(picked).not.toContain(inP2);
    expect(picked).not.toContain(wide);

    expect(Array.isArray(await listPayAssignments(tenant.client, inP1, live(c1)))).toBe(true);
    await expect(listPayAssignments(tenant.client, inP2, live(c1))).rejects.toBeInstanceOf(PayrollStructureError);

    const officer = await clerk([]);
    const pickedAll = (await searchLeaveEmployees(tenant.client, live(officer), { from: '2026-01-01', to: '2026-12-31' })).map((e) => e.personnelNumber);
    expect(pickedAll).toEqual(expect.arrayContaining([inP1, inP2, wide]));
    expect(Array.isArray(await listPayAssignments(tenant.client, inP2, live(officer)))).toBe(true);
  });
});
