/**
 * Company-configured payroll components (9318): employee-specific recurring entries (ADD / REPLACE, proration
 * policies), one-time adjustments with approval, the calculation, release, posting and the controls around them.
 *
 * Every figure here is hypothetical: nothing is a statutory rate. Assertions read stored results, lines, journal
 * lines and change documents, not only helper output.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { maintainNumberRange } from '../src/modules/foundation/number-ranges';
import {
  ADJUSTMENT_APPROVE_CAPABILITY,
  ADJUSTMENT_ENTER_CAPABILITY,
  COMPONENT_MAINTAIN_CAPABILITY,
  addEmployeeComponent,
  cancelAdjustment,
  decideAdjustment,
  endEmployeeComponent,
  enterAdjustment,
  listAdjustments,
  listEmployeeComponents,
  withdrawEmployeeComponent,
  type AddEmployeeComponentInput,
} from '../src/modules/people/payroll-components';
import { PayrollRunError, daysOutside, getPayrollRun, getResultWithLines, listResults, proposePayrollRun, recalculatePayrollRun, releasePayrollRun, cancelPayrollRun, PAYROLL_RUN_CAPABILITY, type ResultLineRow, type ResultRow } from '../src/modules/people/payroll-run';
import { postPayrollRun } from '../src/modules/people/payroll-posting';
import { assignStructure, defineSalaryStructure, setStructureComponent } from '../src/modules/people/payroll-structure';
import { AREA, CENTRE, PAYROLL_ACTOR, PAYROLL_AUTH, buildPayrollFixture, createPayrollPoster, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createFinanceActor } from './helpers/finance-actor';
import { createTenant, destroyTenant, seedAccounts, type TestTenant } from './helpers';

const YEAR = 2025;
const MAINT = [COMPONENT_MAINTAIN_CAPABILITY];
const ENTER = [ADJUSTMENT_ENTER_CAPABILITY];
const APPROVE = [ADJUSTMENT_APPROVE_CAPABILITY];
const RUN = [PAYROLL_RUN_CAPABILITY, 'PEOPLE.PAYROLL.RESULT'];

interface Setup { tenant: TestTenant; fx: PayrollFixture; n: number }

async function setup(name: string, currency?: string): Promise<Setup> {
  const tenant = await createTenant(name, currency ? { currency } : {});
  const fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await seedAccounts(tenant, ['250100', '250200', '250300']);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${tenant.client}, 'PENS', 'Pension (employee)', 'DEDUCTION', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ADV', 'Advance recovery', 'DEDUCTION', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ADV2', 'Recovery two', 'DEDUCTION', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ADV3', 'Recovery three', 'DEDUCTION', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'BONUS', 'Bonus', 'EARNING', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ERC', 'Employer contribution', 'EMPLOYER_CONTRIBUTION', false, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ERX', 'Employer contribution extra', 'EMPLOYER_CONTRIBUTION', false, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'LOANX', 'Unmapped deduction', 'DEDUCTION', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'EOSP', 'End of service', 'EOS_PROVISION', false, true, ${PAYROLL_ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, controlling_area, cost_center, created_by) values
        (${tenant.client}, 'PENS', ${fx.chart}, null, '250000', 'NONE', null, null, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ADV', ${fx.chart}, null, '250100', 'NONE', null, null, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ADV2', ${fx.chart}, null, '250100', 'NONE', null, null, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ADV3', ${fx.chart}, null, '250100', 'NONE', null, null, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'BONUS', ${fx.chart}, '500000', null, 'ASSIGNMENT', null, null, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ERC', ${fx.chart}, '500100', '250200', 'ASSIGNMENT', null, null, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ERX', ${fx.chart}, '500100', '250300', 'ASSIGNMENT', null, null, ${PAYROLL_ACTOR})
      on conflict do nothing`);
    // The 5xxxxx accounts require a cost object, so personnel cost is charged to the employee's cost centre.
    await tx.execute(sql`update pay_component_config set cost_receiver_category = 'ASSIGNMENT' where client = ${tenant.client} and component_code = 'BASIC'`);
    await tx.execute(sql`delete from account_determination where client = ${tenant.client} and chart_of_accounts = ${fx.chart} and event = 'PAYROLL_NET_PAY'`);
    await tx.execute(sql`insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${tenant.client}, ${fx.chart}, 'PAYROLL_NET_PAY', '', '', '251000', ${PAYROLL_ACTOR})`);
    await tx.execute(sql`
      insert into time_type (client, code, name, type_kind, reduces_quota, is_paid, created_by) values
        (${tenant.client}, 'UNP', 'Leave without pay', 'ABSENCE', false, false, ${PAYROLL_ACTOR}) on conflict do nothing`);
  });
  await maintainNumberRange({
    client: tenant.client, objectCode: 'RF_BELEG', companyCode: fx.companyCode, subObject: 'GENERAL', fiscalYear: 0,
    prefix: 'PR', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE',
    mode: 'CREATE', changedBy: 'TEST', reason: 'Payroll component test setup',
  });
  return { tenant, fx, n: 0 };
}

let S: Setup;
let T: TestTenant;
let fx: PayrollFixture;
let structureCode: string;
const code = (p: string) => `${p}${String(++S.n).padStart(3, '0')}`;

async function newStructure(rules: Array<[string, 'FIXED' | 'PERCENT_OF_BASE', string]>): Promise<string> {
  const s = code('CS');
  await defineSalaryStructure({ client: T.client, code: s, name: `Components ${s}`, currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  for (const [component, kind, value] of rules) {
    await setStructureComponent({ client: T.client, structureCode: s, componentCode: component, amountKind: kind, amountValue: value, changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  }
  return s;
}

async function employee(base = '1000', options: { from?: string; to?: string; assignTo?: string; structure?: string } = {}): Promise<string> {
  const from = options.from ?? '2024-01-01';
  const pn = await payrollEmployee(fx, { positionFrom: from, ...(options.to ? { positionTo: options.to } : {}) });
  await assignStructure({
    client: T.client, personnelNumber: pn, structureCode: options.structure ?? structureCode, baseAmount: base, currency: fx.currency,
    validFrom: from, validTo: options.assignTo ?? options.to ?? null, changedBy: PAYROLL_ACTOR,
  }, PAYROLL_AUTH);
  return pn;
}

const entry = (pn: string, over: Partial<AddEmployeeComponentInput> = {}, by = 'HR_CLERK') =>
  addEmployeeComponent({
    client: T.client, personnelNumber: pn, componentCode: 'ADV', mode: 'ADD', amountKind: 'FIXED', amountValue: '20', currency: fx.currency,
    validFrom: '2024-01-01', prorationPolicy: 'PAYABLE_CALENDAR_DAYS', reason: 'Company policy test', changedBy: by, ...over,
  }, MAINT);

const propose = (period: number) => proposePayrollRun({ client: T.client, companyCode: fx.companyCode, fiscalYear: YEAR, period, changedBy: PAYROLL_ACTOR }, RUN);
const recalc = (runId: string) => recalculatePayrollRun({ client: T.client, runId, changedBy: PAYROLL_ACTOR }, RUN);
const release = (runId: string, extra: { acknowledgePending?: boolean } = {}) => releasePayrollRun({ client: T.client, runId, changedBy: PAYROLL_ACTOR, ...extra }, RUN);
const cancelRun = (runId: string) => cancelPayrollRun({ client: T.client, runId, reason: 'test cleanup', changedBy: PAYROLL_ACTOR }, RUN);

async function resultOf(runId: string, pn: string): Promise<{ result: ResultRow; lines: ResultLineRow[] }> {
  const rows = await listResults(T.client, runId, pn, RUN);
  expect(rows, `result for ${pn}`).toHaveLength(1);
  return (await getResultWithLines(T.client, rows[0]!.resultId, RUN))!;
}
const amounts = (lines: ResultLineRow[], component: string, source?: string) =>
  lines.filter((l) => l.componentCode === component && (!source || l.sourceType === source)).map((l) => l.amount);
const exceptionOf = (run: { exceptions: Array<{ personnelNumber: string; reasonCode: string }> }, pn: string) => run.exceptions.find((e) => e.personnelNumber === pn);

async function expectRefusal(promise: Promise<unknown>, wanted: string) {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code, (error as Error).message).toBe(wanted);
    expect((error as { remedy?: string }).remedy, `remedy of ${wanted}`).toBeTruthy();
    return error as PayrollRunError;
  }
  throw new Error(`Expected refusal ${wanted}, nothing was thrown.`);
}
async function absence(pn: string, from: string, to: string) {
  await withTenant(T.client, (tx) => tx.execute(sql`
    insert into absence (client, personnel_number, time_type_code, valid_from, valid_to, status, created_by)
    values (${T.client}, ${pn}, 'UNP', ${from}, ${to}, 'APPROVED', ${PAYROLL_ACTOR})`));
}
const adjustment = (pn: string, period: number, over: Record<string, unknown> = {}, by = 'CLERK') =>
  enterAdjustment({
    client: T.client, companyCode: fx.companyCode, fiscalYear: YEAR, period, personnelNumber: pn, componentCode: 'BONUS', amount: '125.50',
    reason: 'One-off award (test)', sourceReference: 'DOC-1', changedBy: by, ...over,
  } as Parameters<typeof enterAdjustment>[0], ENTER);
const approve = (id: string, by = 'BOSS', decision: 'APPROVE' | 'REJECT' = 'APPROVE', note?: string) =>
  decideAdjustment({ client: T.client, adjustmentId: id, decision, note, changedBy: by }, APPROVE);

beforeAll(async () => {
  S = await setup('pay-components');
  T = S.tenant;
  fx = S.fx;
  structureCode = await newStructure([['BASIC', 'PERCENT_OF_BASE', '100'], ['PENS', 'PERCENT_OF_BASE', '5'], ['ERC', 'PERCENT_OF_BASE', '8']]);
}, 180_000);

afterAll(async () => {
  if (S) await destroyTenant(T.client);
});

describe('daysOutside (pure)', () => {
  it('returns the days no cut covers', () => {
    expect(daysOutside('2025-04-01', '2025-04-30', [])).toEqual([['2025-04-01', '2025-04-30']]);
    expect(daysOutside('2025-04-01', '2025-04-30', [['2025-04-11', null]])).toEqual([['2025-04-01', '2025-04-10']]);
    expect(daysOutside('2025-04-01', '2025-04-30', [['2025-04-05', '2025-04-10'], ['2025-04-20', '2025-04-22']])).toEqual([
      ['2025-04-01', '2025-04-04'], ['2025-04-11', '2025-04-19'], ['2025-04-23', '2025-04-30'],
    ]);
    expect(daysOutside('2025-04-01', '2025-04-30', [['2024-01-01', null]])).toEqual([]);
  });
});

describe('1. replacement, addition, isolation, and the worked example (January, 31 days)', () => {
  let run: Awaited<ReturnType<typeof propose>>;
  let plain: string; let replaced: string; let added: string;

  beforeAll(async () => {
    plain = await employee('1000');
    replaced = await employee('1000');
    added = await employee('1000');
    await entry(replaced, { componentCode: 'PENS', mode: 'REPLACE', amountValue: '70', reason: 'Agreed fixed pension amount' });
    await entry(added, { componentCode: 'ADV', mode: 'ADD', amountValue: '20' });
    await entry(added, { componentCode: 'ERX', mode: 'ADD', amountKind: 'PERCENT_OF_BASE', amountValue: '2' });
    await entry(added, { componentCode: 'BONUS', mode: 'ADD', amountValue: '15.5' });
    run = await propose(1);
  }, 120_000);

  it('an employee without overrides keeps the structure: gross 1000, net 950, employer 80 (hypothetical rates)', async () => {
    expect(run.exceptions.filter((e) => !e.informational)).toEqual([]);
    const { result, lines } = await resultOf(run.runId, plain);
    expect(result).toMatchObject({ grossPay: '1000.0000', totalDeductions: '50.0000', netPay: '950.0000', employerCost: '80.0000' });
    expect(lines.every((l) => l.sourceType === 'STRUCTURE')).toBe(true);
    const pens = lines.find((l) => l.componentCode === 'PENS')!;
    expect(pens.calcBasis).toContain('5% of the assigned base salary 1000.0000');
    expect(pens.calcBasis).toContain('not taxable gross');
    // employer total cost = gross + employer contribution
    expect(Number(result.grossPay) + Number(result.employerCost)).toBe(1080);
  });

  it('a replacement suppresses only that component for that employee and is labelled', async () => {
    const { result, lines } = await resultOf(run.runId, replaced);
    expect(amounts(lines, 'PENS')).toEqual(['70.0000']);
    expect(lines.find((l) => l.componentCode === 'PENS')).toMatchObject({ sourceType: 'EMPLOYEE_REPLACE', amountKind: 'FIXED', prorationPolicy: 'PAYABLE_CALENDAR_DAYS' });
    expect(lines.find((l) => l.componentCode === 'PENS')!.sourceId).toBeTruthy();
    expect(amounts(lines, 'BASIC')).toEqual(['1000.0000']);
    expect(result).toMatchObject({ grossPay: '1000.0000', totalDeductions: '70.0000', netPay: '930.0000', employerCost: '80.0000' });
  });

  it('additions are separate, identifiable lines of all three kinds; employer contribution never reduces net pay', async () => {
    const { result, lines } = await resultOf(run.runId, added);
    expect(lines.filter((l) => l.sourceType === 'EMPLOYEE_ADD').map((l) => [l.componentCode, l.componentKind, l.amount]).sort()).toEqual([
      ['ADV', 'DEDUCTION', '20.0000'], ['BONUS', 'EARNING', '15.5000'], ['ERX', 'EMPLOYER_CONTRIBUTION', '20.0000'],
    ]);
    expect(amounts(lines, 'PENS', 'STRUCTURE')).toEqual(['50.0000']);
    expect(result).toMatchObject({ grossPay: '1015.5000', totalDeductions: '70.0000', netPay: '945.5000', employerCost: '100.0000' });
  });

  it('totals reconcile to the rounded lines and the run view', async () => {
    const view = (await getPayrollRun(T.client, run.runId, RUN))!;
    expect(view).toMatchObject({ grossPay: '3015.5000', totalDeductions: '190.0000', netPay: '2825.5000', employerCost: '260.0000' });
    for (const pn of [plain, replaced, added]) {
      const { result, lines } = await resultOf(run.runId, pn);
      const sum = (kind: string) => lines.filter((l) => l.componentKind === kind).reduce((a, l) => a + Math.round(Number(l.amount) * 10000), 0) / 10000;
      expect(sum('EARNING')).toBe(Number(result.grossPay));
      expect(sum('DEDUCTION')).toBe(Number(result.totalDeductions));
      expect(sum('EMPLOYER_CONTRIBUTION')).toBe(Number(result.employerCost));
    }
  });

  it('posts balanced, with separately mapped employee deductions and employer contribution payables, then is frozen', async () => {
    const released = await release(run.runId);
    expect(released.status).toBe('RELEASED');
    const poster = await createPayrollPoster(T.client);
    const posted = await postPayrollRun({ client: T.client, changedBy: poster.username, runId: run.runId, authorization: poster.authorization });
    expect(posted.debitTotal).toBe(posted.creditTotal);
    const lines = await withTenant(T.client, async (tx) => (await tx.execute(sql`
      select gl_account, debit_credit, amount_document::text as amount, cost_center, line_text from journal_entry_line
       where client = ${T.client} and document_number = ${posted.documentNumber} and fiscal_year = ${posted.fiscalYear}`)) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string; cost_center: string | null; line_text: string | null }>);
    const sumOf = (side: string, account: string) => lines.filter((l) => l.debit_credit === side && l.gl_account === account).reduce((a, l) => a + Number(l.amount), 0);
    expect(sumOf('S', '500100')).toBe(260); // employer contribution expense: 80 + 80 + 80 + 20
    expect(sumOf('H', '250200')).toBe(240); // ERC payable (3 × 80)
    expect(sumOf('H', '250300')).toBe(20); // ERX payable, a separate mapping
    expect(sumOf('H', '250000')).toBe(170); // employee deductions to the pension payable: 50 + 70 + 50
    expect(sumOf('H', '250100')).toBe(20); // advance recovery offset
    expect(sumOf('H', '251000')).toBe(2825.5); // net pay liability
    expect(lines.filter((l) => l.gl_account === '500100' && l.debit_credit === 'S').every((l) => l.cost_center === CENTRE)).toBe(true);
    // Frozen history: an entry touching the paid period is refused, a later one is accepted.
    await expectRefusal(entry(plain, { componentCode: 'ADV', validFrom: '2025-01-10' }), 'HISTORY_FROZEN');
    await entry(plain, { componentCode: 'ADV', validFrom: '2025-02-01' });
    await expectRefusal(endEmployeeComponent({ client: T.client, entryId: (await listEmployeeComponents(T.client, replaced, MAINT))[0]!.entryId, validTo: '2025-01-15', reason: 'x', changedBy: 'HR' }, MAINT), 'HISTORY_FROZEN');
  }, 120_000);
});

describe('2. effective dates, proration policies and ambiguity (April, 30 days)', () => {
  let run: Awaited<ReturnType<typeof propose>>;
  const who: Record<string, string> = {};

  beforeAll(async () => {
    // a: two consecutive replacements — structure PENS is fully suppressed.
    who.a = await employee('1000');
    await entry(who.a, { componentCode: 'PENS', mode: 'REPLACE', amountValue: '60', validTo: '2025-04-10' });
    await entry(who.a, { componentCode: 'PENS', mode: 'REPLACE', amountValue: '90', validFrom: '2025-04-11' });
    // b: replacement from the 11th only — the structure rule applies on days 1–10.
    who.b = await employee('1000');
    await entry(who.b, { componentCode: 'PENS', mode: 'REPLACE', amountKind: 'PERCENT_OF_BASE', amountValue: '10', validFrom: '2025-04-11' });
    // c: salary base changes mid-period; a percentage entry follows the base of each segment.
    who.c = await employee('1000', { assignTo: '2025-04-10' });
    await assignStructure({ client: T.client, personnelNumber: who.c, structureCode, baseAmount: '2000', currency: fx.currency, validFrom: '2025-04-11', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    await entry(who.c, { componentCode: 'ERX', mode: 'ADD', amountKind: 'PERCENT_OF_BASE', amountValue: '3' });
    // d: approved unpaid leave 1–6 April under each policy.
    who.d = await employee('1000');
    await absence(who.d, '2025-04-01', '2025-04-06');
    await entry(who.d, { componentCode: 'ADV', amountValue: '30', prorationPolicy: 'PAYABLE_CALENDAR_DAYS' });
    await entry(who.d, { componentCode: 'ADV2', amountValue: '30', prorationPolicy: 'NO_UNPAID_LEAVE_REDUCTION' });
    await entry(who.d, { componentCode: 'ADV3', amountValue: '30', prorationPolicy: 'FULL_PERIOD' });
    // e: joiner on the 16th — full period applies once for the whole employment; no-leave-reduction covers 15 days.
    who.e = await employee('1000', { from: '2025-04-16' });
    await entry(who.e, { componentCode: 'ADV3', amountValue: '30', prorationPolicy: 'FULL_PERIOD', validFrom: '2024-01-01' });
    await entry(who.e, { componentCode: 'ADV2', amountValue: '30', prorationPolicy: 'NO_UNPAID_LEAVE_REDUCTION' });
    // f: leaver on the 20th, percentage of base prorated by 20/30.
    who.f = await employee('1000', { to: '2025-04-20' });
    await entry(who.f, { componentCode: 'ADV', amountKind: 'PERCENT_OF_BASE', amountValue: '3', prorationPolicy: 'PAYABLE_CALENDAR_DAYS' });
    // g: full period with two salary assignments — the base is ambiguous.
    who.g = await employee('1000', { assignTo: '2025-04-10' });
    await assignStructure({ client: T.client, personnelNumber: who.g, structureCode, baseAmount: '1500', currency: fx.currency, validFrom: '2025-04-11', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    await entry(who.g, { componentCode: 'ADV3', amountKind: 'PERCENT_OF_BASE', amountValue: '2', prorationPolicy: 'FULL_PERIOD' });
    // h: full period that starts after the employee does — ambiguous; i: two overlapping entries for the component.
    who.h = await employee('1000');
    await entry(who.h, { componentCode: 'ADV3', amountValue: '30', prorationPolicy: 'FULL_PERIOD', validFrom: '2025-04-11' });
    who.i = await employee('1000');
    await entry(who.i, { componentCode: 'ADV3', amountValue: '30', prorationPolicy: 'FULL_PERIOD', validTo: '2025-04-10' });
    await entry(who.i, { componentCode: 'ADV3', amountValue: '40', prorationPolicy: 'PAYABLE_CALENDAR_DAYS', validFrom: '2025-04-11' });
    // j: no override at all — shared-structure behaviour unchanged.
    who.j = await employee('1000', { from: '2025-04-11' });
    run = await propose(4);
  }, 240_000);

  it('a: mid-period replacement change splits the entry at its effective dates; the structure rule is suppressed', async () => {
    const { lines } = await resultOf(run.runId, who.a);
    expect(amounts(lines, 'PENS')).toEqual(['20.0000', '60.0000']);
    expect(lines.every((l) => l.componentCode !== 'PENS' || l.sourceType === 'EMPLOYEE_REPLACE')).toBe(true);
    expect(lines.filter((l) => l.componentCode === 'PENS').map((l) => [l.segmentFrom, l.segmentTo])).toEqual([['2025-04-01', '2025-04-10'], ['2025-04-11', '2025-04-30']]);
  });

  it('b: structure rule runs on the days before the replacement and is suppressed from it', async () => {
    const { lines, result } = await resultOf(run.runId, who.b);
    expect(lines.filter((l) => l.componentCode === 'PENS').map((l) => [l.sourceType, l.segmentFrom, l.segmentTo, l.amount])).toEqual([
      ['STRUCTURE', '2025-04-01', '2025-04-10', '16.6700'],
      ['EMPLOYEE_REPLACE', '2025-04-11', '2025-04-30', '66.6700'],
    ]);
    expect(result.totalDeductions).toBe('83.3400');
  });

  it('c: a base change splits the calculation and shows the base used per segment', async () => {
    const { lines } = await resultOf(run.runId, who.c);
    expect(lines.filter((l) => l.componentCode === 'ERX').map((l) => [l.baseAmount, l.amount])).toEqual([['1000.0000', '10.0000'], ['2000.0000', '40.0000']]);
    expect(lines.filter((l) => l.componentCode === 'BASIC').map((l) => l.amount)).toEqual(['333.3300', '1333.3300']);
  });

  it('d: the three proration policies, with approved unpaid leave', async () => {
    const { lines } = await resultOf(run.runId, who.d);
    expect(amounts(lines, 'ADV')).toEqual(['24.0000']); // 30 × 24/30 payable days
    expect(amounts(lines, 'ADV2')).toEqual(['30.0000']); // covered days, leave not deducted
    expect(amounts(lines, 'ADV3')).toEqual(['30.0000']); // once for the period
    expect(lines.filter((l) => l.componentCode === 'ADV3')).toHaveLength(1);
    expect(lines.find((l) => l.componentCode === 'ADV3')!.calcBasis).toContain('full period, applied once');
  });

  it('e: a joiner gets the full-period amount once and a covered-days amount for no-reduction', async () => {
    const { lines } = await resultOf(run.runId, who.e);
    expect(amounts(lines, 'ADV3')).toEqual(['30.0000']);
    expect(amounts(lines, 'ADV2')).toEqual(['15.0000']);
    expect(amounts(lines, 'BASIC')).toEqual(['500.0000']);
  });

  it('f: a leaver is prorated by payable days (percentage converted to its period value first)', async () => {
    expect(amounts((await resultOf(run.runId, who.f)).lines, 'ADV')).toEqual(['20.0000']); // 3 % of 1000 = 30; × 20/30
  });

  it('g, h, i: ambiguous full-period rules are refused with a remedy, never guessed or duplicated', async () => {
    for (const pn of [who.g!, who.h!, who.i!]) {
      const e = exceptionOf(run, pn);
      expect(e?.reasonCode, pn).toBe('FULL_PERIOD_AMBIGUOUS');
    }
    const g = run.exceptions.find((e) => e.personnelNumber === who.g)!;
    expect(g.message).toContain('more than one salary assignment');
    expect(g.remedy).toContain('one-time payroll adjustment');
    await expectRefusal(release(run.runId), 'RELEASE_EXCEPTIONS');
  });

  it('j: an employee without overrides is calculated exactly by the shared structure', async () => {
    const { result, lines } = await resultOf(run.runId, who.j);
    expect(lines.every((l) => l.sourceType === 'STRUCTURE' && l.sourceId === null)).toBe(true);
    expect(result.grossPay).toBe('666.6700'); // 1000 × 20/30
    expect(amounts(lines, 'PENS')).toEqual(['33.3300']);
  });

  it('a recurring entry for an employee with no payroll result yet (onboarding) is accepted', async () => {
    const fresh = await employee('1000', { from: '2026-02-01' });
    const created = await entry(fresh, { componentCode: 'ADV', validFrom: '2026-02-01' });
    expect(created).toMatchObject({ status: 'ACTIVE', componentName: 'Advance recovery', mode: 'ADD' });
    expect(created.basisLabel).toContain('fixed amount per payroll period');
  });

  it('cleanup', async () => { await cancelRun(run.runId); });
});

describe('recurring entry controls', () => {
  it('mode, policy and reason are mandatory — nothing defaults silently', async () => {
    const pn = await employee();
    await expectRefusal(entry(pn, { mode: undefined as never }), 'PAYROLL_INPUT');
    await expectRefusal(entry(pn, { prorationPolicy: undefined as never }), 'PAYROLL_INPUT');
    await expectRefusal(entry(pn, { reason: '   ' }), 'PAYROLL_INPUT');
    await expectRefusal(entry(pn, { amountValue: '-5' }), 'PAYROLL_INPUT');
    await expectRefusal(entry(pn, { amountKind: 'PERCENT_OF_BASE', amountValue: '150' }), 'PERCENT_RANGE');
    await expectRefusal(entry(pn, { amountValue: '10.123' }), 'AMOUNT_PRECISION');
    await expectRefusal(entry(pn, { componentCode: 'EOSP' }), 'EOS_NOT_SUPPORTED');
    await expectRefusal(entry(pn, { componentCode: 'NOPE' }), 'COMPONENT_UNKNOWN');
    await expectRefusal(entry(pn, { validTo: '2023-01-01' }), 'ENTRY_PERIOD');
  });

  it('overlapping replacements are refused; the database constraint stops a race; add and replace may coexist', async () => {
    const pn = await employee();
    await entry(pn, { componentCode: 'PENS', mode: 'REPLACE', validFrom: '2026-01-01', validTo: '2026-06-30' });
    await expectRefusal(entry(pn, { componentCode: 'PENS', mode: 'REPLACE', validFrom: '2026-06-30' }), 'REPLACEMENT_OVERLAP');
    await entry(pn, { componentCode: 'PENS', mode: 'ADD', validFrom: '2026-06-30' });
    await entry(pn, { componentCode: 'ADV', mode: 'REPLACE', validFrom: '2026-06-30' });
    const racer = await employee();
    const settled = await Promise.allSettled([1, 2, 3, 4].map((i) => entry(racer, { componentCode: 'PENS', mode: 'REPLACE', validFrom: '2027-01-01', amountValue: String(10 + i) })));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled.filter((x) => x.status === 'rejected')) expect(((s as PromiseRejectedResult).reason as { code: string }).code).toBe('REPLACEMENT_OVERLAP');
    const stored = await withTenant(T.client, async (tx) => (await tx.execute(sql`select count(*)::int as n from employee_pay_component where client = ${T.client} and personnel_number = ${racer} and status = 'ACTIVE'`)) as unknown as Array<{ n: number }>);
    expect(stored[0]!.n).toBe(1);
    // the database itself refuses an overlapping active replacement even if the service were bypassed
    await expect(withTenant(T.client, (tx) => tx.execute(sql`
      insert into employee_pay_component (client, entry_id, personnel_number, component_code, mode, amount_kind, amount_value, currency, valid_from, proration_policy, reason)
      values (${T.client}, 'RAW-1', ${racer}, 'PENS', 'REPLACE', 'FIXED', 5, ${fx.currency}, '2027-03-01', 'FULL_PERIOD', 'raw')`))).rejects.toThrow();
  });

  it('ending and withdrawing keep history, record the reason, and are audited', async () => {
    const pn = await employee();
    const e = await entry(pn, { componentCode: 'ADV', validFrom: '2026-03-01', reason: 'Initial agreement' });
    const ended = await endEmployeeComponent({ client: T.client, entryId: e.entryId, validTo: '2026-05-31', reason: 'Agreement ended', changedBy: 'HR2' }, MAINT);
    expect(ended).toMatchObject({ validTo: '2026-05-31', changedBy: 'HR2' });
    await expectRefusal(endEmployeeComponent({ client: T.client, entryId: e.entryId, validTo: '2026-09-30', reason: 'x', changedBy: 'HR2' }, MAINT), 'ENTRY_EXTEND');
    const w = await entry(pn, { componentCode: 'ADV2', validFrom: '2026-07-01' });
    const withdrawn = await withdrawEmployeeComponent({ client: T.client, entryId: w.entryId, reason: 'Entered by mistake', changedBy: 'HR2' }, MAINT);
    expect(withdrawn).toMatchObject({ status: 'WITHDRAWN', withdrawnReason: 'Entered by mistake' });
    const history = await listEmployeeComponents(T.client, pn, MAINT);
    expect(history.map((h) => h.status).sort()).toEqual(['ACTIVE', 'WITHDRAWN']);
    const audit = await withTenant(T.client, async (tx) => (await tx.execute(sql`
      select d.change_type, d.changed_by, d.reason, i.field_name, i.new_value
        from change_document d left join change_document_item i on i.change_document_id = d.id
       where d.client = ${T.client} and d.object_class = 'employee_pay_component' and d.object_key = ${`${pn}/${e.entryId}`} order by d.changed_at`)) as unknown as Array<{ change_type: string; changed_by: string; reason: string | null; field_name: string | null; new_value: string | null }>);
    expect(audit.map((a) => a.change_type)).toContain('CREATE');
    expect(audit.find((a) => a.change_type === 'CHANGE')).toMatchObject({ changed_by: 'HR2', reason: 'Agreement ended' });
    expect(audit.find((a) => a.field_name === 'amountValue')?.new_value).toBe('20');
  });

  it('an entry in another currency becomes a named exception, not a converted or wrong line', async () => {
    const pn = await employee();
    await entry(pn, { componentCode: 'ADV', currency: 'EUR', validFrom: '2025-11-01', amountValue: '5' });
    const run = await propose(11);
    expect(exceptionOf(run, pn)?.reasonCode).toBe('CURRENCY_DIFFERS');
    await cancelRun(run.runId);
  }, 120_000);
});

describe('3. one-time adjustments: lifecycle, approval, exactly-once (June)', () => {
  let a: string; let b: string;

  beforeAll(async () => { a = await employee('1000'); b = await employee('1000'); }, 120_000);

  it('requires a reason, a positive amount in payroll precision, a configured component and a company employee', async () => {
    await expectRefusal(adjustment(a, 6, { reason: '' }), 'PAYROLL_INPUT');
    await expectRefusal(adjustment(a, 6, { amount: '0' }), 'AMOUNT_NOT_POSITIVE');
    await expectRefusal(adjustment(a, 6, { amount: '-1' }), 'PAYROLL_INPUT');
    await expectRefusal(adjustment(a, 6, { amount: '1.234' }), 'AMOUNT_PRECISION');
    await expectRefusal(adjustment(a, 6, { componentCode: 'LOANX' }), 'COMPONENT_UNMAPPED');
    await expectRefusal(adjustment(a, 6, { componentCode: 'EOSP' }), 'EOS_NOT_SUPPORTED');
    await expectRefusal(adjustment('NOBODY1', 6), 'EMPLOYEE_UNKNOWN');
    const outsider = await payrollEmployee(fx, { positionFrom: null });
    await expectRefusal(adjustment(outsider, 6), 'NOT_IN_COMPANY');
  });

  it('pending → approved by someone else → recalculation → release applies it once; pending and rejected never calculate', async () => {
    const pending = await adjustment(a, 6);
    const rejected = await adjustment(b, 6, { amount: '40', componentCode: 'ADV' });
    expect(pending).toMatchObject({ status: 'PENDING', amount: '125.5000', createdBy: 'CLERK' });
    await approve(rejected.adjustmentId, 'BOSS', 'REJECT', 'Not supported by a document');
    const proposed = await propose(6);
    expect(proposed.pendingAdjustments).toBe(1);
    expect((await resultOf(proposed.runId, a)).lines.some((l) => l.sourceType === 'ONE_TIME')).toBe(false);
    expect((await resultOf(proposed.runId, b)).lines.some((l) => l.sourceType === 'ONE_TIME')).toBe(false);

    // creator cannot approve; unknown id; rejection needs a note
    await expectRefusal(approve(pending.adjustmentId, 'CLERK'), 'SELF_APPROVAL');
    await expectRefusal(approve('missing'), 'ADJUSTMENT_UNKNOWN');
    await expectRefusal(approve(pending.adjustmentId, 'BOSS', 'REJECT'), 'DECISION_NOTE');
    const approved = await approve(pending.adjustmentId, 'BOSS');
    expect(approved).toMatchObject({ status: 'APPROVED', decidedBy: 'BOSS' });
    expect(approved.decidedAt).toBeTruthy();
    await expectRefusal(approve(pending.adjustmentId, 'BOSS2'), 'ADJUSTMENT_STATE');

    // the proposal is now stale and cannot be released
    const stale = (await getPayrollRun(T.client, proposed.runId, RUN))!;
    expect(stale.staleReasons.join(' ')).toContain(pending.adjustmentId);
    await expectRefusal(release(proposed.runId), 'RUN_STALE_INPUTS');
    const fresh = await recalc(proposed.runId);
    expect(fresh.staleReasons).toEqual([]);
    const { result, lines } = await resultOf(proposed.runId, a);
    const one = lines.filter((l) => l.sourceType === 'ONE_TIME');
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ componentCode: 'BONUS', amount: '125.5000', sourceId: pending.adjustmentId, amountKind: 'FIXED', prorationPolicy: null });
    expect(one[0]!.calcBasis).toContain('not prorated');
    expect(result.grossPay).toBe('1125.5000');
    // recalculating again does not consume it twice
    await recalc(proposed.runId);
    const settled = await resultOf(proposed.runId, a);
    expect(settled.lines.filter((l) => l.sourceType === 'ONE_TIME')).toHaveLength(1);

    // release warns about nothing here (the only pending one was decided); the adjustment becomes APPLIED
    const released = await release(proposed.runId);
    expect(released.status).toBe('RELEASED');
    const [after] = await listAdjustments(T.client, { personnelNumber: a, period: 6 }, ENTER);
    expect(after).toMatchObject({ status: 'APPLIED', appliedRunId: proposed.runId });
    expect(after!.appliedResultId).toBe(settled.result.resultId);
    await expectRefusal(cancelAdjustment({ client: T.client, adjustmentId: pending.adjustmentId, reason: 'no', changedBy: 'CLERK' }, ENTER), 'ADJUSTMENT_APPLIED');
    await expectRefusal(approve(pending.adjustmentId, 'BOSS2'), 'ADJUSTMENT_STATE');
    // the released result is immutable
    await expect(withTenant(T.client, (tx) => tx.execute(sql`delete from payroll_result where client = ${T.client} and run_id = ${proposed.runId}`))).rejects.toThrow();
    // a frozen period takes no new adjustment for that employee: it belongs in a later period
    await expectRefusal(adjustment(a, 6), 'PERIOD_FROZEN');

    // cancelling a released run gives the adjustment back; a re-proposal applies it again, never twice, never lost
    await cancelRun(proposed.runId);
    expect((await listAdjustments(T.client, { personnelNumber: a, period: 6 }, ENTER))[0]).toMatchObject({ status: 'APPROVED', appliedRunId: null });
    const again = await propose(6);
    expect((await resultOf(again.runId, a)).lines.filter((l) => l.sourceType === 'ONE_TIME')).toHaveLength(1);
    await release(again.runId);
    const live = await withTenant(T.client, async (tx) => (await tx.execute(sql`
      select count(*)::int as n from payroll_result_line l join payroll_result r on r.client = l.client and r.result_id = l.result_id
        join payroll_run run on run.client = r.client and run.run_id = r.run_id
       where l.client = ${T.client} and l.source_id = ${pending.adjustmentId} and run.status <> 'CANCELLED'`)) as unknown as Array<{ n: number }>);
    expect(live[0]!.n).toBe(1);
  }, 240_000);

  it('release warns about pending adjustments and requires an explicit acknowledgement', async () => {
    const c = await employee('1000');
    const waiting = await adjustment(c, 7);
    const run = await propose(7);
    expect(run.pendingAdjustments).toBe(1);
    const e = await expectRefusal(release(run.runId), 'PENDING_ADJUSTMENTS');
    expect(e.message).toContain('NOT in this run');
    const released = await release(run.runId, { acknowledgePending: true });
    expect(released.status).toBe('RELEASED');
    // the pending adjustment stays pending; it is not consumed and is not silently lost
    expect((await listAdjustments(T.client, { personnelNumber: c }, ENTER))[0]).toMatchObject({ status: 'PENDING' });
    await cancelAdjustment({ client: T.client, adjustmentId: waiting.adjustmentId, reason: 'Re-enter in the next period', changedBy: 'CLERK' }, ENTER);
  }, 180_000);

  it('concurrent approvals: exactly one wins', async () => {
    const d = await employee('1000');
    const adj = await adjustment(d, 8);
    const settled = await Promise.allSettled(['BOSS1', 'BOSS2', 'BOSS3', 'BOSS4'].map((who) => approve(adj.adjustmentId, who)));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled.filter((x) => x.status === 'rejected')) expect(((s as PromiseRejectedResult).reason as { code: string }).code).toBe('ADJUSTMENT_STATE');
    const [row] = await listAdjustments(T.client, { personnelNumber: d }, ENTER);
    expect(row!.status).toBe('APPROVED');
  });

  it('a correction is a separately approved offsetting entry in a later period, traced to the earlier result, posted once', async () => {
    const [earlier] = await listResults(T.client, (await withTenant(T.client, async (tx) => (await tx.execute(sql`select run_id from payroll_run where client = ${T.client} and period = 6 and status = 'RELEASED' limit 1`)) as unknown as Array<{ run_id: string }>))[0]!.run_id, a, RUN);
    // an employer contribution cannot be corrected this way — the posting model cannot reverse it safely
    await expectRefusal(adjustment(a, 9, { componentCode: 'ERC', correctsResultId: earlier!.resultId, amount: '5' }), 'CONTRIBUTION_CORRECTION_UNSUPPORTED');
    await expectRefusal(adjustment(a, 9, { componentCode: 'ADV', correctsResultId: 'nope', amount: '5' }), 'CORRECTION_TARGET');
    const offset = await adjustment(a, 9, { componentCode: 'ADV', amount: '125.50', correctsResultId: earlier!.resultId, reason: 'Reverses the period 6 award', sourceReference: 'CORR-6' });
    expect(offset.correctsResultId).toBe(earlier!.resultId);
    await approve(offset.adjustmentId, 'BOSS');
    const run = await propose(9);
    const { lines, result } = await resultOf(run.runId, a);
    expect(lines.filter((l) => l.sourceType === 'ONE_TIME').map((l) => [l.componentCode, l.componentKind, l.amount])).toEqual([['ADV', 'DEDUCTION', '125.5000']]);
    expect(result.netPay).toBe('824.5000'); // 1000 gross − 50 pension − 125.5 offset
    await release(run.runId);
    const poster = await createPayrollPoster(T.client);
    const posted = await postPayrollRun({ client: T.client, changedBy: poster.username, runId: run.runId, authorization: poster.authorization });
    expect(posted.debitTotal).toBe(posted.creditTotal);
    const count = await withTenant(T.client, async (tx) => (await tx.execute(sql`select count(*)::int as n from payroll_result_line where client = ${T.client} and source_id = ${offset.adjustmentId}`)) as unknown as Array<{ n: number }>);
    expect(count[0]!.n).toBe(1);
    expect((await listAdjustments(T.client, { personnelNumber: a, period: 9 }, ENTER))[0]!.status).toBe('APPLIED');
  }, 240_000);
});

describe('4. staleness of a proposed run after a recurring change (May)', () => {
  it('a relevant change marks the proposal stale and release needs a recalculation', async () => {
    const pn = await employee('1000');
    const run = await propose(5);
    expect(run.staleReasons).toEqual([]);
    await entry(pn, { componentCode: 'ADV', validFrom: '2025-05-01', amountValue: '10' });
    const view = (await getPayrollRun(T.client, run.runId, RUN))!;
    expect(view.staleReasons.join(' ')).toContain(pn);
    await expectRefusal(release(run.runId), 'RUN_STALE_INPUTS');
    const refreshed = await recalc(run.runId);
    expect(refreshed.staleReasons).toEqual([]);
    expect(amounts((await resultOf(run.runId, pn)).lines, 'ADV')).toEqual(['10.0000']);
    await cancelRun(run.runId);
  }, 120_000);
});

describe('5. accounting and calculation guards (August)', () => {
  it('negative net pay is refused as a named exception, nothing is capped; an unmapped component is refused', async () => {
    const poor = await employee('100');
    await entry(poor, { componentCode: 'ADV', amountValue: '500', validFrom: '2025-08-01' });
    const unmapped = await employee('1000');
    await entry(unmapped, { componentCode: 'LOANX', amountValue: '10', validFrom: '2025-08-01' });
    const run = await propose(8);
    expect(exceptionOf(run, poor)?.reasonCode).toBe('NEGATIVE_NET_PAY');
    expect(exceptionOf(run, unmapped)?.reasonCode).toBe('COMPONENT_UNMAPPED');
    const stored = await withTenant(T.client, async (tx) => (await tx.execute(sql`select count(*)::int as n from payroll_result where client = ${T.client} and run_id = ${run.runId} and personnel_number in (${poor}, ${unmapped})`)) as unknown as Array<{ n: number }>);
    expect(stored[0]!.n).toBe(0);
    await expectRefusal(release(run.runId), 'RELEASE_EXCEPTIONS');
    await cancelRun(run.runId);
  }, 120_000);

  it('a period that is not open refuses an adjustment and writes nothing', async () => {
    const pn = await employee('1000');
    const rule = await withTenant(T.client, async (tx) => (await tx.execute(sql`
      select r.variant, r.period_to from posting_period_rule r
        join company_code c on c.client = r.client and c.posting_period_variant = r.variant
       where r.client = ${T.client} and c.company_code = ${fx.companyCode} and r.account_type = 'S'`)) as unknown as Array<{ variant: string; period_to: number }>);
    await withTenant(T.client, (tx) => tx.execute(sql`update posting_period_rule set period_to = 2 where client = ${T.client} and variant = ${rule[0]!.variant} and account_type = 'S'`));
    try {
      const before = await withTenant(T.client, async (tx) => (await tx.execute(sql`select count(*)::int as n from payroll_adjustment where client = ${T.client}`)) as unknown as Array<{ n: number }>);
      await expectRefusal(adjustment(pn, 3), 'PERIOD_CLOSED');
      const after = await withTenant(T.client, async (tx) => (await tx.execute(sql`select count(*)::int as n from payroll_adjustment where client = ${T.client}`)) as unknown as Array<{ n: number }>);
      expect(after[0]!.n).toBe(before[0]!.n);
    } finally {
      await withTenant(T.client, (tx) => tx.execute(sql`update posting_period_rule set period_to = ${rule[0]!.period_to} where client = ${T.client} and variant = ${rule[0]!.variant} and account_type = 'S'`));
    }
  });
});

describe('6. security, scope, tenant isolation and audit', () => {
  it('callers without the capability see and change nothing', async () => {
    const pn = await employee();
    await expectRefusal(listEmployeeComponents(T.client, pn, []), 'PAYROLL_AUTHORITY');
    await expectRefusal(listEmployeeComponents(T.client, pn, undefined), 'PAYROLL_AUTHORITY');
    await expectRefusal(listAdjustments(T.client, {}, ['PEOPLE.EMPLOYEE.CREATE']), 'PAYROLL_AUTHORITY');
    await expectRefusal(addEmployeeComponent({ client: T.client, personnelNumber: pn, componentCode: 'ADV', mode: 'ADD', amountKind: 'FIXED', amountValue: '1', currency: fx.currency, validFrom: '2026-01-01', prorationPolicy: 'FULL_PERIOD', reason: 'x', changedBy: 'X' }, ENTER), 'PAYROLL_AUTHORITY');
    await expectRefusal(enterAdjustment({ client: T.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 6, personnelNumber: pn, componentCode: 'BONUS', amount: '1', reason: 'x', changedBy: 'X' }, APPROVE), 'PAYROLL_AUTHORITY');
    await expectRefusal(decideAdjustment({ client: T.client, adjustmentId: 'x', decision: 'APPROVE', changedBy: 'X' }, ENTER), 'PAYROLL_AUTHORITY');
  });

  it('a session whose scope omits the company cannot approve, enter or read; a scoped session can', async () => {
    const pn = await employee();
    const adj = await adjustment(pn, 10);
    const outside = await createFinanceActor(T.client, { capabilities: [ADJUSTMENT_APPROVE_CAPABILITY, ADJUSTMENT_ENTER_CAPABILITY], companyScopes: ['ZZZZ'] });
    await expectRefusal(decideAdjustment({ client: T.client, adjustmentId: adj.adjustmentId, decision: 'APPROVE', changedBy: outside.username }, { authorization: outside.authorization }), 'ADJUSTMENT_UNKNOWN');
    await expectRefusal(enterAdjustment({ client: T.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 10, personnelNumber: pn, componentCode: 'BONUS', amount: '1', reason: 'x', changedBy: outside.username }, { authorization: outside.authorization }), 'COMPANY_SCOPE');
    expect(await listAdjustments(T.client, {}, { authorization: outside.authorization })).toEqual([]);
    const inside = await createFinanceActor(T.client, { capabilities: [ADJUSTMENT_APPROVE_CAPABILITY] });
    // an authorised, in-scope session that is not the creator approves
    const done = await decideAdjustment({ client: T.client, adjustmentId: adj.adjustmentId, decision: 'APPROVE', changedBy: inside.username }, { authorization: inside.authorization });
    expect(done).toMatchObject({ status: 'APPROVED', decidedBy: inside.username });
    // a session without the capability is refused
    const noCap = await createFinanceActor(T.client, { capabilities: ['FIN.JOURNAL.DISPLAY'] });
    await expectRefusal(listAdjustments(T.client, {}, { authorization: noCap.authorization }), 'PAYROLL_AUTHORITY');
  });

  it('another tenant sees none of it and cannot decide it', async () => {
    const other = await setup('pay-components-2');
    try {
      expect(await withTenant(other.tenant.client, (tx) => tx.execute(sql`select 1 from payroll_adjustment`))).toHaveLength(0);
      const existing = await withTenant(T.client, async (tx) => (await tx.execute(sql`select adjustment_id from payroll_adjustment where client = ${T.client} limit 1`)) as unknown as Array<{ adjustment_id: string }>);
      await expect(decideAdjustment({ client: other.tenant.client, adjustmentId: existing[0]!.adjustment_id, decision: 'APPROVE', changedBy: 'BOSS' }, APPROVE)).rejects.toMatchObject({ code: 'ADJUSTMENT_UNKNOWN' });
      expect(await listAdjustments(other.tenant.client, {}, ENTER)).toEqual([]);
    } finally {
      await destroyTenant(other.tenant.client);
    }
  }, 180_000);

  it('the audit trail names who, what, when and why — and the database holds the separation of duties itself', async () => {
    const pn = await employee();
    const adj = await adjustment(pn, 10, { reason: 'Audit trail check', componentCode: 'BONUS', amount: '3' });
    await approve(adj.adjustmentId, 'AUDITOR');
    const trail = await withTenant(T.client, async (tx) => (await tx.execute(sql`
      select d.change_type, d.changed_by, d.reason, d.transaction_code from change_document d
       where d.client = ${T.client} and d.object_class = 'payroll_adjustment' and d.object_key = ${adj.adjustmentId} order by d.changed_at, d.id`)) as unknown as Array<{ change_type: string; changed_by: string; reason: string | null; transaction_code: string }>);
    expect(trail.map((t) => [t.change_type, t.changed_by, t.transaction_code])).toEqual([
      ['CREATE', 'CLERK', ADJUSTMENT_ENTER_CAPABILITY], ['CHANGE', 'AUDITOR', ADJUSTMENT_APPROVE_CAPABILITY],
    ]);
    expect(trail[0]!.reason).toBe('Audit trail check');
    await expect(withTenant(T.client, (tx) => tx.execute(sql`
      update payroll_adjustment set status = 'REJECTED', decided_by = created_by, decided_at = now(), decision_note = 'self'
       where client = ${T.client} and adjustment_id = ${adj.adjustmentId}`))).rejects.toThrow();
  });
});

describe('7. three-decimal currency (KWD)', () => {
  it('calculates, rounds once and refuses excess precision in the payroll currency', async () => {
    const kw = await setup('pay-components-kwd', 'KWD');
    const prev = { S, T, fx, structureCode };
    S = kw; T = kw.tenant; fx = kw.fx;
    try {
      const st = await newStructure([['BASIC', 'PERCENT_OF_BASE', '100'], ['PENS', 'PERCENT_OF_BASE', '5'], ['ERC', 'PERCENT_OF_BASE', '8']]);
      const pn = await employee('1000', { structure: st });
      const rounding = await employee('1234.567', { structure: st });
      await entry(rounding, { componentCode: 'ERX', mode: 'ADD', amountKind: 'PERCENT_OF_BASE', amountValue: '5' });
      await entry(rounding, { componentCode: 'ADV', mode: 'ADD', amountValue: '10.125' });
      await expectRefusal(entry(pn, { amountValue: '10.1234' }), 'AMOUNT_PRECISION');
      await expectRefusal(adjustment(pn, 1, { amount: '1.2345' }), 'AMOUNT_PRECISION');
      const run = await propose(1);
      expect(run.currency).toBe('KWD');
      const example = (await resultOf(run.runId, pn)).result;
      expect(example).toMatchObject({ grossPay: '1000.0000', totalDeductions: '50.0000', netPay: '950.0000', employerCost: '80.0000' });
      const { lines, result } = await resultOf(run.runId, rounding);
      expect(amounts(lines, 'ERX')).toEqual(['61.7280']); // 5 % of 1234.567 = 61.72835 → 61.728
      expect(amounts(lines, 'ADV')).toEqual(['10.1250']);
      expect(amounts(lines, 'PENS')).toEqual(['61.7280']); // 5 % of 1234.567 = 61.72835 → 61.728
      expect(result.netPay).toBe('1162.7140');
      expect(Number(result.grossPay) - Number(result.totalDeductions)).toBeCloseTo(Number(result.netPay), 4);
      await release(run.runId);
      const poster = await createPayrollPoster(T.client);
      const posted = await postPayrollRun({ client: T.client, changedBy: poster.username, runId: run.runId, authorization: poster.authorization });
      expect(posted.debitTotal).toBe(posted.creditTotal);
      expect(posted.debitTotal).toMatch(/\.\d{3}0*$/);
    } finally {
      await destroyTenant(kw.tenant.client);
      S = prev.S; T = prev.T; fx = prev.fx; structureCode = prev.structureCode;
    }
  }, 240_000);
});

void AREA;
