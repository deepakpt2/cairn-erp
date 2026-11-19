/**
 * Payroll phase 1 — salary structures, their assignment, the paid/unpaid flag, and the readiness
 * check a payroll run will stand on.
 *
 * What is worth proving: the amount rule lives on the structure component and is bounded there;
 * assignments are effective-dated with an inclusive last day and never overlap; ending one keeps the
 * history; and `validateEmployeeForRun` names every reason an employee cannot be in a run — without
 * calculating or posting anything.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { TIME_ENTER_CAPABILITY, defineTimeType, getTimeTypeView } from '../src/modules/people/time-leave';
import {
  PayrollStructureError,
  assignStructure,
  assignmentFor,
  defineSalaryStructure,
  changeSalaryStructure,
  endAssignment,
  getStructure,
  listAssignments,
  listStructures,
  setStructureComponent,
  validateEmployeeForRun,
  type ReadinessReason,
} from '../src/modules/people/payroll-structure';
import {
  AREA,
  CENTRE_LATER,
  NO_PAYROLL_AUTH,
  PAYROLL_ACTOR,
  PAYROLL_AUTH,
  buildPayrollFixture,
  payrollEmployee,
  type PayrollFixture,
} from './helpers/payroll-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const FROM = '2025-03-01';
const TO = '2025-03-31';

let tenant: TestTenant;
let fx: PayrollFixture;
let n = 0;
const code = (prefix = 'S') => `${prefix}${String(++n).padStart(3, '0')}`;

async function expectRefusal(promise: Promise<unknown>, codeWanted: string): Promise<PayrollStructureError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PayrollStructureError);
    expect((error as PayrollStructureError).code).toBe(codeWanted);
    expect((error as PayrollStructureError).remedy).toBeTruthy();
    return error as PayrollStructureError;
  }
  throw new Error(`Expected PayrollStructureError ${codeWanted}, nothing was thrown.`);
}

async function structure(components: Array<{ component: string; kind: 'FIXED' | 'PERCENT_OF_BASE'; value: string }>, over: { validFrom?: string; validTo?: string | null; currency?: string } = {}) {
  const s = code();
  await defineSalaryStructure({
    client: tenant.client, code: s, name: `Structure ${s}`, currency: over.currency ?? fx.currency,
    validFrom: over.validFrom ?? '2024-01-01', validTo: over.validTo ?? null, changedBy: PAYROLL_ACTOR,
  }, PAYROLL_AUTH);
  for (const c of components) {
    await setStructureComponent({
      client: tenant.client, structureCode: s, componentCode: c.component, amountKind: c.kind, amountValue: c.value, changedBy: PAYROLL_ACTOR,
    }, PAYROLL_AUTH);
  }
  return s;
}

async function assign(personnelNumber: string, structureCode: string, validFrom: string, validTo: string | null = null, currency = fx.currency) {
  return assignStructure({
    client: tenant.client, personnelNumber, structureCode, baseAmount: '1000.00', currency, validFrom, validTo, changedBy: PAYROLL_ACTOR,
  }, PAYROLL_AUTH);
}

async function readiness(personnelNumber: string, from = FROM, to = TO) {
  return withTenant(tenant.client, (tx) => validateEmployeeForRun(tx, tenant.client, personnelNumber, from, to));
}

function hasReason(reasons: ReadinessReason[], wanted: ReadinessReason['code'], fragment: string) {
  const found = reasons.find((r) => r.code === wanted);
  expect(found, `${wanted} in ${JSON.stringify(reasons)}`).toBeTruthy();
  expect(found!.message).toContain(fragment);
  return found!;
}

beforeAll(async () => {
  tenant = await createTenant('payroll-structure');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
}, 120_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
});

describe('structures and their components', () => {
  it('1. defines a structure and lists it', async () => {
    const s = await structure([]);
    const listed = (await listStructures(tenant.client, PAYROLL_AUTH)).find((r) => r.code === s);
    expect(listed).toMatchObject({ code: s, currency: fx.currency, validFrom: '2024-01-01', validTo: null, isValid: true, components: 0 });
    await expectRefusal(
      defineSalaryStructure({ client: tenant.client, code: s, name: 'again', currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH),
      'STRUCTURE_EXISTS',
    );
  });

  it('2. adds a component with its amount rule, and changes the rule in place', async () => {
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '2500' }]);
    await setStructureComponent({ client: tenant.client, structureCode: s, componentCode: fx.housing, amountKind: 'PERCENT_OF_BASE', amountValue: '7.5', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    let view = await getStructure(tenant.client, s, PAYROLL_AUTH);
    expect(view.components.map((c) => [c.componentCode, c.amountKind, Number(c.amountValue)])).toEqual([
      ['BASIC', 'FIXED', 2500],
      ['HOUSING', 'PERCENT_OF_BASE', 7.5],
    ]);
    await setStructureComponent({ client: tenant.client, structureCode: s, componentCode: fx.basic, amountKind: 'FIXED', amountValue: '2600', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    view = await getStructure(tenant.client, s, PAYROLL_AUTH);
    expect(Number(view.components.find((c) => c.componentCode === 'BASIC')!.amountValue)).toBe(2600);
    // The rule never reaches pay_component: it has no amount column at all.
    const columns = (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns where table_name = 'pay_component'
    `))) as unknown as Array<{ column_name: string }>;
    expect(columns.map((c) => c.column_name).filter((c) => /amount|rate|percent/.test(c))).toEqual([]);
  });

  it('3. refuses a percentage of base over 100 — in the service and in the database', async () => {
    const s = await structure([]);
    await expectRefusal(
      setStructureComponent({ client: tenant.client, structureCode: s, componentCode: fx.basic, amountKind: 'PERCENT_OF_BASE', amountValue: '100.5', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH),
      'PERCENT_OVER_100',
    );
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into salary_structure_component (client, structure_code, component_code, amount_kind, amount_value, created_by)
      values (${tenant.client}, ${s}, 'BASIC', 'PERCENT_OF_BASE', 101, 'X')
    `))).rejects.toThrow(/salary_structure_component_percent_ck/);
    // Exactly 100 stands.
    await setStructureComponent({ client: tenant.client, structureCode: s, componentCode: fx.basic, amountKind: 'PERCENT_OF_BASE', amountValue: '100', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  });

  it('4. refuses a component that does not exist, and a formula kind that is not built', async () => {
    const s = await structure([]);
    await expectRefusal(
      setStructureComponent({ client: tenant.client, structureCode: s, componentCode: 'NOSUCH', amountKind: 'FIXED', amountValue: '1', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH),
      'COMPONENT_UNKNOWN',
    );
    await expectRefusal(
      setStructureComponent({ client: tenant.client, structureCode: s, componentCode: fx.basic, amountKind: 'FORMULA', amountValue: '1', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH),
      'AMOUNT_KIND',
    );
  });

  it('retires by validity, never by delete; refuses without the capability', async () => {
    const s = await structure([]);
    const retired = await changeSalaryStructure({ client: tenant.client, code: s, isValid: false, changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    expect(retired.isValid).toBe(false);
    await expectRefusal(
      defineSalaryStructure({ client: tenant.client, code: code(), name: 'x', currency: fx.currency, validFrom: '2024-01-01', changedBy: 'no.payroll' }, NO_PAYROLL_AUTH),
      'PAYROLL_AUTHORITY',
    );
    const grants = (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select privilege_type from information_schema.role_table_grants
       where table_name = 'salary_structure' and grantee = 'cairn_app'
    `))) as unknown as Array<{ privilege_type: string }>;
    expect(grants.map((g) => g.privilege_type)).not.toContain('DELETE');
  });
});

describe('assignments', () => {
  it('5. assigns a structure with a base; assignmentFor returns it inside validity (inclusive last day)', async () => {
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '1' }]);
    const person = await payrollEmployee(fx);
    const a = await assign(person, s, '2025-01-01', '2025-06-30');
    expect(a).toMatchObject({ personnelNumber: person, structureCode: s, currency: fx.currency, validFrom: '2025-01-01', validTo: '2025-06-30' });
    expect(Number(a.baseAmount)).toBe(1000);
    const onFirst = await withTenant(tenant.client, (tx) => assignmentFor(tx, tenant.client, person, '2025-01-01'));
    const onLast = await withTenant(tenant.client, (tx) => assignmentFor(tx, tenant.client, person, '2025-06-30'));
    expect(onFirst?.assignmentId).toBe(a.assignmentId);
    expect(onLast?.assignmentId).toBe(a.assignmentId);
  });

  it('6. assignmentFor returns nothing outside validity', async () => {
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '1' }]);
    const person = await payrollEmployee(fx);
    await assign(person, s, '2025-01-01', '2025-06-30');
    expect(await withTenant(tenant.client, (tx) => assignmentFor(tx, tenant.client, person, '2024-12-31'))).toBeNull();
    expect(await withTenant(tenant.client, (tx) => assignmentFor(tx, tenant.client, person, '2025-07-01'))).toBeNull();
  });

  it('7. refuses overlapping assignments by name; the next day after the end is free', async () => {
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '1' }]);
    const person = await payrollEmployee(fx);
    await assign(person, s, '2025-01-01', '2025-06-30');
    const clash = await expectRefusal(assign(person, s, '2025-06-30'), 'ASSIGNMENT_OVERLAP');
    expect(clash.message).toContain(person);
    expect(clash.message).toContain('Two pay structures cannot cover one day');
    const next = await assign(person, s, '2025-07-01');
    expect(next.validFrom).toBe('2025-07-01');
  });

  it('is idempotent on the request key', async () => {
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '1' }]);
    const person = await payrollEmployee(fx);
    const input = { client: tenant.client, personnelNumber: person, structureCode: s, baseAmount: '900', currency: fx.currency, validFrom: '2025-01-01', requestKey: `req-${person}`, changedBy: PAYROLL_ACTOR };
    const a = await assignStructure(input, PAYROLL_AUTH);
    const b = await assignStructure(input, PAYROLL_AUTH);
    expect(b.assignmentId).toBe(a.assignmentId);
    expect(await listAssignments(tenant.client, person, PAYROLL_AUTH)).toHaveLength(1);
  });

  it('10. ending an assignment sets validTo and keeps the history readable', async () => {
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '1' }]);
    const person = await payrollEmployee(fx);
    const a = await assign(person, s, '2025-01-01');
    const ended = await endAssignment({ client: tenant.client, assignmentId: a.assignmentId, validTo: '2025-03-15', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    expect(ended.validTo).toBe('2025-03-15');
    const history = await listAssignments(tenant.client, person, PAYROLL_AUTH);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ assignmentId: a.assignmentId, validFrom: '2025-01-01', validTo: '2025-03-15' });
    await expectRefusal(
      endAssignment({ client: tenant.client, assignmentId: a.assignmentId, validTo: '2025-04-30', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH),
      'ASSIGNMENT_EXTEND',
    );
  });
});

describe('validateEmployeeForRun — what must stand before a run', () => {
  it('8. reports ready for a structure, mapped components and a covering position', async () => {
    const s = await structure([
      { component: fx.basic, kind: 'FIXED', value: '2500' },
      { component: fx.housing, kind: 'PERCENT_OF_BASE', value: '10' },
    ]);
    const person = await payrollEmployee(fx);
    await assign(person, s, '2025-01-01');
    const result = await readiness(person);
    expect(result.reasons).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it('9a. no structure covering the period', async () => {
    const person = await payrollEmployee(fx);
    const r = await readiness(person);
    expect(r.ready).toBe(false);
    const reason = hasReason(r.reasons, 'NO_STRUCTURE', `No pay structure stands for employee ${person} on ${FROM}`);
    expect(reason.remedy).toContain('/people/employees');
  });

  it('9b. two pay structures covering one day (written past the service)', async () => {
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '1' }]);
    const person = await payrollEmployee(fx);
    await assign(person, s, '2025-01-01');
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into salary_structure_assignment (client, assignment_id, personnel_number, structure_code, base_amount, currency, valid_from, created_by)
      values (${tenant.client}, ${`dup-${person}`}, ${person}, ${s}, 1, ${fx.currency}, '2025-03-10', 'X')
    `));
    hasReason((await readiness(person)).reasons, 'OVERLAPPING_STRUCTURES', `Two pay structures cover employee ${person} on 2025-03-10`);
  });

  it('9c. a structure not valid for the whole period', async () => {
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '1' }], { validTo: '2025-03-15' });
    const person = await payrollEmployee(fx);
    await assign(person, s, '2025-01-01');
    hasReason((await readiness(person)).reasons, 'STRUCTURE_NOT_VALID', `Structure ${s} is not valid for the whole period`);
  });

  it('9d. a structure naming no components', async () => {
    const s = await structure([]);
    const person = await payrollEmployee(fx);
    await assign(person, s, '2025-01-01');
    hasReason((await readiness(person)).reasons, 'STRUCTURE_EMPTY', `Structure ${s} names no components`);
  });

  it('9e. a component not mapped in the company’s chart', async () => {
    const s = await structure([{ component: fx.unmapped, kind: 'FIXED', value: '50' }]);
    const person = await payrollEmployee(fx);
    await assign(person, s, '2025-01-01');
    const reason = hasReason((await readiness(person)).reasons, 'COMPONENT_UNMAPPED', `Component LOAN is not mapped to an account in chart ${fx.chart}`);
    expect(reason.remedy).toContain('/config/pay-components');
  });

  it('9f. no position covering the period', async () => {
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '1' }]);
    const person = await payrollEmployee(fx, { positionFrom: null });
    await assign(person, s, '2025-01-01');
    hasReason((await readiness(person)).reasons, 'NO_POSITION', `Employee ${person} holds no position covering the period`);
  });

  it('9g. a component charging the employee’s cost centre when the employee has none standing', async () => {
    const s = await structure([{ component: fx.housing, kind: 'PERCENT_OF_BASE', value: '5' }]);
    const person = await payrollEmployee(fx, { positionFrom: null });
    // A position whose cost centre only stands from 2032 — written past the service, which would refuse it.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into position_assignment (client, personnel_number, position_code, controlling_area, cost_center, company_code, valid_from, created_by)
      values (${tenant.client}, ${person}, ${fx.positionCode}, ${AREA}, ${CENTRE_LATER}, ${fx.companyCode}, '2025-01-01', 'X')
    `));
    await assign(person, s, '2025-01-01');
    hasReason((await readiness(person)).reasons, 'NO_COST_CENTRE', `Component HOUSING charges to the employee's cost centre, and employee ${person} has none`);
  });

  it('9h. a currency other than the books’ is recorded, not refused', async () => {
    const other = fx.currency === 'EUR' ? 'GBP' : 'EUR';
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '1' }]);
    const person = await payrollEmployee(fx);
    await assign(person, s, '2025-01-01', null, other);
    const r = await readiness(person);
    expect(r.ready).toBe(true);
    expect(r.notes.map((n) => n.message)).toContain(`Employee ${person} is paid in ${other}, the company ${fx.companyCode} keeps books in ${fx.currency}.`);
  });

  it('covers a joiner for the days they hold a position, not the whole month', async () => {
    const s = await structure([{ component: fx.basic, kind: 'FIXED', value: '1' }]);
    const person = await payrollEmployee(fx, { positionFrom: '2025-03-16' });
    await assign(person, s, '2025-03-16');
    expect((await readiness(person)).ready).toBe(true);
  });

  it('calculates and posts nothing', async () => {
    const before = (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select (select count(*)::int from journal_entry where client = ${tenant.client}) as journals
    `))) as unknown as Array<{ journals: number }>;
    const person = await payrollEmployee(fx);
    await readiness(person);
    const after = (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select (select count(*)::int from journal_entry where client = ${tenant.client}) as journals
    `))) as unknown as Array<{ journals: number }>;
    expect(after[0]!.journals).toBe(before[0]!.journals);
  });
});

describe('time types: paid or unpaid', () => {
  it('11. is_paid defaults to true for a row written without it, and false is recorded when asked', async () => {
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into time_type (client, code, name, type_kind, reduces_quota, created_by)
      values (${tenant.client}, 'OLDLEAVE', 'Leave written before 9277', 'ABSENCE', true, 'X')
    `));
    expect((await getTimeTypeView(tenant.client, 'OLDLEAVE')).isPaid).toBe(true);
    const unpaid = await defineTimeType(
      { client: tenant.client, code: 'UNPAID', name: 'Leave without pay', typeKind: 'ABSENCE', reducesQuota: false, isPaid: false, changedBy: PAYROLL_ACTOR },
      ['PEOPLE.LEAVE.CONFIGURE'],
    );
    expect(unpaid.isPaid).toBe(false);
  });
});
