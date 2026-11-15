/**
 * Payroll phase 2 — the run and its calculation.
 *
 * What is worth proving: a run resolves its period from the company's fiscal year variant and refuses
 * a closed or special period; every employee holding a position in the company is either calculated
 * or listed as a named exception; joiners, leavers and unpaid approved leave are prorated by days,
 * clipped and de-duplicated; each line is rounded once and snapshots its accounts and cost receiver;
 * a run with exceptions cannot be released; a released run is frozen; and only one live run stands
 * per company and period. Nothing posts.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  PayrollStructureError,
  assignStructure,
  defineSalaryStructure,
  getStructure,
  removeStructureComponent,
  setStructureComponent,
  validateEmployeeForRun,
} from '../src/modules/people/payroll-structure';
import {
  PAYROLL_RUN_CAPABILITY,
  PayrollRunError,
  calculateComponent,
  calculateResult,
  cancelPayrollRun,
  getPayrollRun,
  getResultWithLines,
  listPayrollRuns,
  listResults,
  payableDaysFor,
  proposePayrollRun,
  recalculatePayrollRun,
  releasePayrollRun,
  type PayrollRunView,
  type ResultRow,
} from '../src/modules/people/payroll-run';
import {
  AREA,
  CENTRE,
  PAYROLL_ACTOR,
  PAYROLL_AUTH,
  buildPayrollFixture,
  payrollEmployee,
  type PayrollFixture,
} from './helpers/payroll-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const RUN_AUTH: readonly string[] = [PAYROLL_RUN_CAPABILITY];
const YEAR = 2025;

let tenant: TestTenant;
let fx: PayrollFixture;
let staff: string;
let n = 0;
const code = (prefix = 'R') => `${prefix}${String(++n).padStart(3, '0')}`;

async function expectRunRefusal(promise: Promise<unknown>, wanted: string): Promise<PayrollRunError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PayrollRunError);
    expect((error as PayrollRunError).code, (error as Error).message).toBe(wanted);
    return error as PayrollRunError;
  }
  throw new Error(`Expected PayrollRunError ${wanted}, nothing was thrown.`);
}

async function assign(personnelNumber: string, structureCode: string, base: string, validFrom: string, validTo: string | null = null) {
  return assignStructure({
    client: tenant.client, personnelNumber, structureCode, baseAmount: base, currency: fx.currency, validFrom, validTo, changedBy: PAYROLL_ACTOR,
  }, PAYROLL_AUTH);
}

async function absence(personnelNumber: string, timeType: string, from: string, to: string, status: string) {
  await withTenant(tenant.client, (tx) => tx.execute(sql`
    insert into absence (client, personnel_number, time_type_code, valid_from, valid_to, status, created_by)
    values (${tenant.client}, ${personnelNumber}, ${timeType}, ${from}, ${to}, ${status}, ${PAYROLL_ACTOR})`));
}

function propose(period: number, extra: { requestKey?: string } = {}) {
  return proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period, changedBy: PAYROLL_ACTOR, ...extra }, RUN_AUTH);
}

const resultOf = (results: ResultRow[], pn: string) => {
  const r = results.find((x) => x.personnelNumber === pn);
  expect(r, `result for ${pn}`).toBeTruthy();
  return r!;
};
const linesOf = async (r: ResultRow) => (await getResultWithLines(tenant.client, r.resultId, RUN_AUTH))!.lines;
const amountOf = async (r: ResultRow, component: string) =>
  (await linesOf(r)).filter((l) => l.componentCode === component).map((l) => l.amount);

beforeAll(async () => {
  tenant = await createTenant('payroll-run');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${tenant.client}, 'PENS', 'Pension (employee)', 'DEDUCTION', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ERC', 'Employer contribution', 'EMPLOYER_CONTRIBUTION', false, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'EOS', 'End of service', 'EOS_PROVISION', false, true, ${PAYROLL_ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, controlling_area, cost_center, created_by)
      values (${tenant.client}, 'PENS', ${fx.chart}, null, '250000', 'NONE', null, null, ${PAYROLL_ACTOR}),
             (${tenant.client}, 'ERC', ${fx.chart}, '500100', '250000', 'FIXED', ${AREA}, ${CENTRE}, ${PAYROLL_ACTOR}),
             (${tenant.client}, 'EOS', ${fx.chart}, '500200', '240000', 'ASSIGNMENT', null, null, ${PAYROLL_ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into time_type (client, code, name, type_kind, reduces_quota, is_paid, created_by) values
        (${tenant.client}, 'UNP', 'Leave without pay', 'ABSENCE', false, false, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'UNP2', 'Unpaid special leave', 'ABSENCE', false, false, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'PAID', 'Paid leave', 'ABSENCE', false, true, ${PAYROLL_ACTOR})
      on conflict do nothing`);
  });
  staff = code('ST');
  await defineSalaryStructure({ client: tenant.client, code: staff, name: 'Staff', currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  for (const [component, kind, value] of [
    ['BASIC', 'PERCENT_OF_BASE', '100'],
    ['HOUSING', 'FIXED', '310'],
    ['PENS', 'PERCENT_OF_BASE', '5'],
    ['ERC', 'PERCENT_OF_BASE', '11'],
  ] as const) {
    await setStructureComponent({ client: tenant.client, structureCode: staff, componentCode: component, amountKind: kind, amountValue: value, changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  }
}, 120_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
});

// ── Pure: proration ─────────────────────────────────────────────────────────

describe('payableDaysFor (pure)', () => {
  const march = { periodFrom: '2025-03-01', periodTo: '2025-03-31' };
  const unpaid = (validFrom: string, validTo: string | null, status = 'APPROVED') => ({ validFrom, validTo, status, isPaid: false });

  it('2. a full-period assignment is paid every day', () => {
    const r = payableDaysFor({ ...march, assignmentFrom: '2024-01-01', assignmentTo: null, absences: [] });
    expect(r).toMatchObject({ covered: true, coveredDays: 31, payableDays: 31, totalDays: 31, unpaidLeaveDays: 0, factor: 1 });
  });

  it('3. a joiner is paid only from the day they start', () => {
    const r = payableDaysFor({ ...march, assignmentFrom: '2025-03-11', assignmentTo: null, absences: [] });
    expect(r).toMatchObject({ coveredFrom: '2025-03-11', coveredTo: '2025-03-31', payableDays: 21, totalDays: 31 });
  });

  it('4. a leaver is paid only to their last day', () => {
    const r = payableDaysFor({ ...march, assignmentFrom: '2024-01-01', assignmentTo: '2025-03-20', absences: [] });
    expect(r).toMatchObject({ coveredFrom: '2025-03-01', coveredTo: '2025-03-20', payableDays: 20 });
  });

  it('5. an assignment outside the period covers nothing', () => {
    const r = payableDaysFor({ ...march, assignmentFrom: '2025-04-01', assignmentTo: null, absences: [] });
    expect(r).toMatchObject({ covered: false, payableDays: 0, coveredDays: 0 });
  });

  it('6. an unpaid approved absence reduces payable days by exactly its days', () => {
    const r = payableDaysFor({ ...march, assignmentFrom: '2024-01-01', assignmentTo: null, absences: [unpaid('2025-03-05', '2025-03-07')] });
    expect(r).toMatchObject({ unpaidLeaveDays: 3, payableDays: 28 });
  });

  it('7. an absence straddling the period boundary counts only the days inside', () => {
    const r = payableDaysFor({ ...march, assignmentFrom: '2024-01-01', assignmentTo: null, absences: [unpaid('2025-02-25', '2025-03-02'), unpaid('2025-03-30', null)] });
    expect(r).toMatchObject({ unpaidLeaveDays: 4, payableDays: 27 });
    // And clipped to the covered span of a joiner, too.
    const joiner = payableDaysFor({ ...march, assignmentFrom: '2025-03-11', assignmentTo: null, absences: [unpaid('2025-03-05', '2025-03-12')] });
    expect(joiner).toMatchObject({ unpaidLeaveDays: 2, payableDays: 19 });
  });

  it('8. overlapping unpaid absences count a shared day once', () => {
    const r = payableDaysFor({ ...march, assignmentFrom: '2024-01-01', assignmentTo: null, absences: [unpaid('2025-03-10', '2025-03-14'), unpaid('2025-03-12', '2025-03-16'), unpaid('2025-03-17', '2025-03-17')] });
    expect(r).toMatchObject({ unpaidLeaveDays: 8, payableDays: 23 });
  });

  it('9. requested, rejected, cancelled and paid absences do not reduce payable days', () => {
    const r = payableDaysFor({
      ...march, assignmentFrom: '2024-01-01', assignmentTo: null,
      absences: [unpaid('2025-03-01', '2025-03-05', 'REQUESTED'), unpaid('2025-03-06', '2025-03-08', 'REJECTED'), unpaid('2025-03-09', '2025-03-09', 'CANCELLED'), { validFrom: '2025-03-10', validTo: '2025-03-12', status: 'APPROVED', isPaid: true }],
    });
    expect(r).toMatchObject({ unpaidLeaveDays: 0, payableDays: 31 });
  });
});

describe('calculateComponent (pure)', () => {
  it('10. FIXED and PERCENT_OF_BASE apply the factor, then round once', () => {
    expect(calculateComponent({ amountKind: 'FIXED', amountValue: '310', baseAmount: '1000', payableDays: 31, totalDays: 31, decimals: 2 })).toBe('310.00');
    expect(calculateComponent({ amountKind: 'FIXED', amountValue: '310', baseAmount: '1000', payableDays: 21, totalDays: 31, decimals: 2 })).toBe('210.00');
    expect(calculateComponent({ amountKind: 'PERCENT_OF_BASE', amountValue: '100', baseAmount: '1000', payableDays: 21, totalDays: 31, decimals: 2 })).toBe('677.42');
    expect(calculateComponent({ amountKind: 'PERCENT_OF_BASE', amountValue: '7.5', baseAmount: '1234.5678', payableDays: 30, totalDays: 30, decimals: 3 })).toBe('92.593');
    // 5 % of 1000 for 21/31 is 33.870967… — one rounding, not 50.00 × 0.68 = 34.00.
    expect(calculateComponent({ amountKind: 'PERCENT_OF_BASE', amountValue: '5', baseAmount: '1000', payableDays: 21, totalDays: 31, decimals: 2 })).toBe('33.87');
    expect(calculateComponent({ amountKind: 'FIXED', amountValue: '100', baseAmount: '0', payableDays: 0, totalDays: 31, decimals: 0 })).toBe('0');
  });
});

// ── The run ─────────────────────────────────────────────────────────────────

describe('a run for March 2025', () => {
  const people: Record<string, string> = {};
  let run: PayrollRunView;

  beforeAll(async () => {
    people.full = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
    people.joiner = await payrollEmployee(fx, { positionFrom: '2025-03-11' });
    people.leaver = await payrollEmployee(fx, { positionFrom: '2024-01-01', positionTo: '2025-03-20' });
    people.unpaid = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
    people.straddle = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
    people.overlap = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
    people.raise = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
    people.unready = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
    for (const key of ['full', 'unpaid', 'straddle', 'overlap']) await assign(people[key]!, staff, '1000', '2024-01-01');
    await assign(people.joiner!, staff, '1000', '2025-03-11');
    await assign(people.leaver!, staff, '1000', '2024-01-01', '2025-03-20');
    await assign(people.raise!, staff, '1000', '2024-01-01', '2025-03-15');
    await assign(people.raise!, staff, '1240', '2025-03-16');
    await absence(people.unpaid!, 'UNP', '2025-03-05', '2025-03-07', 'APPROVED');
    await absence(people.unpaid!, 'PAID', '2025-03-20', '2025-03-21', 'APPROVED');
    await absence(people.straddle!, 'UNP', '2025-02-25', '2025-03-02', 'APPROVED');
    await absence(people.straddle!, 'UNP', '2025-03-10', '2025-03-12', 'REQUESTED');
    await absence(people.straddle!, 'UNP', '2025-03-14', '2025-03-14', 'REJECTED');
    await absence(people.overlap!, 'UNP', '2025-03-10', '2025-03-14', 'APPROVED');
    await absence(people.overlap!, 'UNP2', '2025-03-12', '2025-03-16', 'APPROVED');
  }, 120_000);

  it('is refused without the run capability, and for a special period', async () => {
    await expectRunRefusal(proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 3, changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH), 'PAYROLL_AUTHORITY');
    const special = await expectRunRefusal(propose(13), 'PERIOD_UNRESOLVED');
    expect(special.message).toContain('special period');
  });

  it('is refused for a period that is not open, naming the period', async () => {
    const restore = await withTenant(tenant.client, async (tx) => {
      const rows = (await tx.execute(sql`
        select r.variant, r.period_to from posting_period_rule r
          join company_code c on c.client = r.client and c.posting_period_variant = r.variant
         where r.client = ${tenant.client} and c.company_code = ${fx.companyCode} and r.account_type = 'S'`)) as unknown as Array<{ variant: string; period_to: number }>;
      await tx.execute(sql`update posting_period_rule set period_to = 2 where client = ${tenant.client} and variant = ${rows[0]!.variant} and account_type = 'S'`);
      return rows[0]!;
    });
    try {
      const closed = await expectRunRefusal(propose(3), 'PERIOD_CLOSED');
      expect(closed.message).toContain('Period 3 of fiscal year 2025');
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`update posting_period_rule set period_to = ${restore.period_to} where client = ${tenant.client} and variant = ${restore.variant} and account_type = 'S'`));
    }
  });

  it('1. is proposed with the period dates and total days from the variant', async () => {
    run = await propose(3, { requestKey: 'payroll-run-test-march' });
    expect(run).toMatchObject({ status: 'PROPOSED', companyCode: fx.companyCode, fiscalYear: YEAR, period: 3, periodFrom: '2025-03-01', periodTo: '2025-03-31', totalDays: 31, currency: fx.currency });
    // A resubmitted form is handed the same run.
    const replay = await propose(3, { requestKey: 'payroll-run-test-march' });
    expect(replay.runId).toBe(run.runId);
    expect((await listPayrollRuns(tenant.client, RUN_AUTH)).map((r) => r.runId)).toContain(run.runId);
  });

  it('5. an employee with no structure for the period is a named exception, not dropped', async () => {
    const e = run.exceptions.filter((x) => x.personnelNumber === people.unready);
    expect(e.length).toBeGreaterThan(0);
    expect(e[0]).toMatchObject({ reasonCode: 'NO_STRUCTURE' });
    expect(e[0]!.message).toContain(people.unready);
    expect(run.exceptionCount).toBe(1);
    expect(run.employeeCount).toBe(7);
    expect((await listResults(tenant.client, run.runId, undefined, RUN_AUTH)).some((r) => r.personnelNumber === people.unready)).toBe(false);
  });

  it('2, 3, 4. full, joiner and leaver are paid for the days they are covered', async () => {
    const results = await listResults(tenant.client, run.runId, undefined, RUN_AUTH);
    expect(resultOf(results, people.full!)).toMatchObject({ payableDays: '31.00', totalDays: '31.00', grossPay: '1310.0000', totalDeductions: '50.0000', netPay: '1260.0000', employerCost: '110.0000' });
    expect(resultOf(results, people.joiner!)).toMatchObject({ payableDays: '21.00', coveredDays: '21.00', grossPay: '887.4200', totalDeductions: '33.8700', netPay: '853.5500', employerCost: '74.5200' });
    expect(resultOf(results, people.leaver!)).toMatchObject({ payableDays: '20.00', grossPay: '845.1600', totalDeductions: '32.2600', netPay: '812.9000', employerCost: '70.9700' });
  });

  it('6, 7, 8, 9. unpaid approved leave is clipped, de-duplicated, and only approved unpaid counts', async () => {
    const results = await listResults(tenant.client, run.runId, undefined, RUN_AUTH);
    expect(resultOf(results, people.unpaid!)).toMatchObject({ payableDays: '28.00', unpaidLeaveDays: '3.00' });
    expect(resultOf(results, people.straddle!)).toMatchObject({ payableDays: '29.00', unpaidLeaveDays: '2.00' });
    expect(resultOf(results, people.overlap!)).toMatchObject({ payableDays: '24.00', unpaidLeaveDays: '7.00' });
    expect(await amountOf(resultOf(results, people.unpaid!), 'BASIC')).toEqual(['903.2300']);
  });

  it('10. a mid-period raise splits the period into segments, each with its own base', async () => {
    const results = await listResults(tenant.client, run.runId, undefined, RUN_AUTH);
    const raise = resultOf(results, people.raise!);
    const basic = (await linesOf(raise)).filter((l) => l.componentCode === 'BASIC');
    expect(basic.map((l) => [l.segmentFrom, l.segmentTo, l.payableDays, l.baseAmount, l.amount])).toEqual([
      ['2025-03-01', '2025-03-15', '15.00', '1000.0000', '483.8700'],
      ['2025-03-16', '2025-03-31', '16.00', '1240.0000', '640.0000'],
    ]);
    expect(raise.payableDays).toBe('31.00');
  });

  it('11. gross − deductions = net on every result, and totals are sums of the rounded lines', async () => {
    const results = await listResults(tenant.client, run.runId, undefined, RUN_AUTH);
    for (const r of results) {
      expect(Number(r.grossPay) - Number(r.totalDeductions)).toBeCloseTo(Number(r.netPay), 4);
      const lines = await linesOf(r);
      const sum = (kind: string) => lines.filter((l) => l.componentKind === kind).reduce((s, l) => s + Math.round(Number(l.amount) * 10000), 0) / 10000;
      expect(sum('EARNING')).toBeCloseTo(Number(r.grossPay), 4);
      expect(sum('DEDUCTION')).toBeCloseTo(Number(r.totalDeductions), 4);
      expect(sum('EMPLOYER_CONTRIBUTION')).toBeCloseTo(Number(r.employerCost), 4);
    }
    const view = (await getPayrollRun(tenant.client, run.runId, RUN_AUTH))!;
    const net = results.reduce((s, r) => s + Number(r.netPay), 0);
    expect(Number(view.netPay)).toBeCloseTo(net, 4);
  });

  it('12. each line snapshots accounts and cost receiver, and keeps them when configuration changes', async () => {
    const full = resultOf(await listResults(tenant.client, run.runId, undefined, RUN_AUTH), people.full!);
    const byCode = Object.fromEntries((await linesOf(full)).map((l) => [l.componentCode, l]));
    expect(byCode.BASIC).toMatchObject({ debitAccount: '500000', creditAccount: null, costReceiverCategory: 'NONE', costCenter: null, controllingArea: null });
    expect(byCode.HOUSING).toMatchObject({ debitAccount: '500000', costReceiverCategory: 'ASSIGNMENT', costCenter: CENTRE, controllingArea: AREA, amount: '310.0000' });
    expect(byCode.PENS).toMatchObject({ debitAccount: null, creditAccount: '250000', costReceiverCategory: 'NONE' });
    expect(byCode.ERC).toMatchObject({ debitAccount: '500100', creditAccount: '250000', costReceiverCategory: 'FIXED', costCenter: CENTRE, controllingArea: AREA });
    expect(full).toMatchObject({ costCenter: CENTRE, controllingArea: AREA });

    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update pay_component_config set debit_account = '500100' where client = ${tenant.client} and component_code = 'HOUSING' and chart_of_accounts = ${fx.chart}`));
    try {
      const after = Object.fromEntries((await linesOf(full)).map((l) => [l.componentCode, l]));
      expect(after.HOUSING!.debitAccount).toBe('500000');
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`
        update pay_component_config set debit_account = '500000' where client = ${tenant.client} and component_code = 'HOUSING' and chart_of_accounts = ${fx.chart}`));
    }
  });

  it('13. releasing with an exception is refused, naming the employee and the reason', async () => {
    const refusal = await expectRunRefusal(releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH), 'RELEASE_EXCEPTIONS');
    expect(refusal.message).toContain(people.unready);
    expect(refusal.message).toContain('NO_STRUCTURE');
  });

  it('releasing is refused while an included employee is no longer ready, or a new employee joined the selection', async () => {
    await assign(people.unready!, staff, '900', '2024-01-01');
    run = await recalculatePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
    expect(run).toMatchObject({ exceptionCount: 0, employeeCount: 8 });

    // A component unmapped after calculation: the included employees are no longer ready.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update salary_structure_component set component_code = 'LOAN' where client = ${tenant.client} and structure_code = ${staff} and component_code = 'PENS'`));
    try {
      const unready = await expectRunRefusal(releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH), 'RELEASE_UNREADY');
      expect(unready.message).toContain(people.full);
      expect(unready.message).toContain('COMPONENT_UNMAPPED');
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`
        update salary_structure_component set component_code = 'PENS' where client = ${tenant.client} and structure_code = ${staff} and component_code = 'LOAN'`));
    }

    const late = await payrollEmployee(fx, { positionFrom: '2025-03-25' });
    await assign(late, staff, '1000', '2025-03-25');
    const stale = await expectRunRefusal(releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH), 'RUN_STALE');
    expect(stale.message).toContain(late);
    run = await recalculatePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
    expect(run.employeeCount).toBe(9);
  });

  it('a proposed run is released, and is then frozen', async () => {
    const released = await releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
    expect(released).toMatchObject({ status: 'RELEASED', releasedBy: PAYROLL_ACTOR });
    expect(released.releasedAt).toBeTruthy();
    run = released;
  });

  it('14. recalculating or re-releasing a released run is refused', async () => {
    const frozen = await expectRunRefusal(recalculatePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH), 'RUN_FROZEN');
    expect(frozen.remedy).toContain('later period');
    await expectRunRefusal(releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH), 'RUN_FROZEN');
  });

  it('15. a second run for a period every employee of which is already covered is refused, naming the covering run (9281: off-cycle)', async () => {
    const second = await expectRunRefusal(propose(3), 'ALL_COVERED');
    expect(second.message).toContain(run.runId);
  });

  it('18. cancelling needs a reason, sets CANCELLED, and frees the period for a new run', async () => {
    await expectRunRefusal(cancelPayrollRun({ client: tenant.client, runId: run.runId, reason: '', changedBy: PAYROLL_ACTOR }, RUN_AUTH), 'PAYROLL_INPUT');
    const cancelled = await cancelPayrollRun({ client: tenant.client, runId: run.runId, reason: 'Wrong base for one employee', changedBy: PAYROLL_ACTOR }, RUN_AUTH);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Wrong base for one employee', cancelledBy: PAYROLL_ACTOR });
    // History stays.
    expect((await listResults(tenant.client, run.runId, undefined, RUN_AUTH)).length).toBe(9);
    await expectRunRefusal(recalculatePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH), 'RUN_CANCELLED');
    const again = await propose(3);
    expect(again.status).toBe('PROPOSED');
    expect(again.runId).not.toBe(run.runId);
  });

  it('a posted run cannot be cancelled', async () => {
    const standing = (await listPayrollRuns(tenant.client, RUN_AUTH)).find((r) => r.period === 3 && r.status === 'PROPOSED')!;
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update payroll_run set status = 'POSTED', released_by = ${PAYROLL_ACTOR}, released_at = now(),
             document_number = 'TEST-POSTED', document_fiscal_year = ${YEAR} where client = ${tenant.client} and run_id = ${standing.runId}`));
    await expectRunRefusal(cancelPayrollRun({ client: tenant.client, runId: standing.runId, reason: 'try', changedBy: PAYROLL_ACTOR }, RUN_AUTH), 'RUN_POSTED');
  });
});

// ── Refusals that are about configuration ───────────────────────────────────

describe('a run for June 2025: configuration refusals', () => {
  let eosEmployee: string;
  let unmappedEmployee: string;
  let eosStructure: string;
  let run: PayrollRunView;

  beforeAll(async () => {
    eosStructure = code('EO');
    await defineSalaryStructure({ client: tenant.client, code: eosStructure, name: 'With EOS', currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    await setStructureComponent({ client: tenant.client, structureCode: eosStructure, componentCode: 'BASIC', amountKind: 'PERCENT_OF_BASE', amountValue: '100', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    // A structure that already names an EOS component (as data from before phase 2 did).
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into salary_structure_component (client, structure_code, component_code, amount_kind, amount_value, created_by)
      values (${tenant.client}, ${eosStructure}, 'EOS', 'PERCENT_OF_BASE', 8.33, ${PAYROLL_ACTOR})`));
    const unmappedStructure = code('UM');
    await defineSalaryStructure({ client: tenant.client, code: unmappedStructure, name: 'Unmapped', currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    await setStructureComponent({ client: tenant.client, structureCode: unmappedStructure, componentCode: 'LOAN', amountKind: 'FIXED', amountValue: '25', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);

    eosEmployee = await payrollEmployee(fx, { positionFrom: '2025-06-01', positionTo: '2025-06-30' });
    unmappedEmployee = await payrollEmployee(fx, { positionFrom: '2025-06-01', positionTo: '2025-06-30' });
    await assign(eosEmployee, eosStructure, '1000', '2025-06-01', '2025-06-30');
    await assign(unmappedEmployee, unmappedStructure, '1000', '2025-06-01', '2025-06-30');
    run = await propose(6);
  }, 120_000);

  it('16. a structure naming an EOS_PROVISION component is refused', async () => {
    const e = run.exceptions.find((x) => x.personnelNumber === eosEmployee);
    expect(e).toMatchObject({ reasonCode: 'EOS_NOT_SUPPORTED' });
    expect(e!.remedy).toContain('/people/salary-structures');
    // The calculation refuses it on its own too, and nothing is written.
    const runRow = { ...run, status: 'PROPOSED' as const };
    await withTenant(tenant.client, async (tx) => {
      await expectRunRefusal(
        tx.transaction(async (inner) => { await calculateResult(inner, tenant.client, runRow, { personnelNumber: eosEmployee }); }),
        'EOS_NOT_SUPPORTED',
      );
    });
    // A structure may no longer take an EOS component, and one that names it can drop it.
    await expect(setStructureComponent({ client: tenant.client, structureCode: eosStructure, componentCode: 'EOS', amountKind: 'FIXED', amountValue: '1', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH))
      .rejects.toMatchObject({ code: 'EOS_NOT_SUPPORTED' });
    await expect(setStructureComponent({ client: tenant.client, structureCode: eosStructure, componentCode: 'EOS', amountKind: 'FIXED', amountValue: '1', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH))
      .rejects.toBeInstanceOf(PayrollStructureError);
    const after = await removeStructureComponent({ client: tenant.client, structureCode: eosStructure, componentCode: 'EOS', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    expect(after.components.map((c) => c.componentCode)).toEqual(['BASIC']);
    expect((await getStructure(tenant.client, eosStructure, PAYROLL_AUTH)).components).toHaveLength(1);
    const ready = await withTenant(tenant.client, (tx) => validateEmployeeForRun(tx, tenant.client, eosEmployee, '2025-06-01', '2025-06-30'));
    expect(ready.ready).toBe(true);
  });

  it('17. a component unmapped in the company chart is refused, naming /config/pay-components', async () => {
    const e = run.exceptions.find((x) => x.personnelNumber === unmappedEmployee);
    expect(e).toMatchObject({ reasonCode: 'COMPONENT_UNMAPPED' });
    expect(`${e!.message} ${e!.remedy}`).toContain('/config/pay-components');
  });

  it('recalculating picks up the fix, and exceptions block release until then', async () => {
    await expectRunRefusal(releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH), 'RELEASE_EXCEPTIONS');
    run = await recalculatePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
    expect(run.exceptions.map((e) => e.personnelNumber)).toEqual([unmappedEmployee]);
    const eos = resultOf(await listResults(tenant.client, run.runId, undefined, RUN_AUTH), eosEmployee);
    expect(eos).toMatchObject({ payableDays: '30.00', grossPay: '1000.0000' });
  });
});
