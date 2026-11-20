/**
 * Payroll phase 3 — posting a released run to the general ledger.
 *
 * What is worth proving: one PR document per run, dated the last day of the period; debits by cost
 * centre from the result snapshot, credits flat; net pay credited to the account determination names
 * (proved by changing it); zero lines dropped, like lines grouped; the balance asserted; the run and
 * the document stand together and a run posts once; and every refusal is named — authority on both
 * halves, status, period, determination, negative net pay, a debit with no cost object.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { maintainNumberRange } from '../src/modules/foundation/number-ranges';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { assignStructure, defineSalaryStructure, setStructureComponent } from '../src/modules/people/payroll-structure';
import {
  PAYROLL_RUN_CAPABILITY,
  cancelPayrollRun,
  getPayrollRun,
  proposePayrollRun,
  releasePayrollRun,
  type PayrollRunView,
} from '../src/modules/people/payroll-run';
import {
  PayrollPostingError,
  buildPayrollJournal,
  getPayrollPosting,
  postPayrollRun,
} from '../src/modules/people/payroll-posting';
import {
  CENTRE,
  PAYROLL_ACTOR,
  PAYROLL_AUTH,
  buildPayrollFixture,
  createPayrollPoster,
  payrollEmployee,
  type PayrollFixture,
} from './helpers/payroll-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const RUN_AUTH: readonly string[] = [PAYROLL_RUN_CAPABILITY];
const YEAR = 2025;

let tenant: TestTenant;
let fx: PayrollFixture;
let poster: Awaited<ReturnType<typeof createPayrollPoster>>;
let n = 0;
const code = (prefix: string) => `${prefix}${String(++n).padStart(3, '0')}`;

async function expectPostingRefusal(promise: Promise<unknown>, wanted: string): Promise<PayrollPostingError> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(PayrollPostingError);
    expect((error as PayrollPostingError).code, (error as Error).message).toBe(wanted);
    expect((error as PayrollPostingError).remedy).toBeTruthy();
    return error as PayrollPostingError;
  }
  throw new Error(`Expected PayrollPostingError ${wanted}, nothing was thrown.`);
}

async function structure(rules: Array<[string, 'FIXED' | 'PERCENT_OF_BASE', string]>): Promise<string> {
  const s = code('PS');
  await defineSalaryStructure({ client: tenant.client, code: s, name: `Posting ${s}`, currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  for (const [component, kind, value] of rules) {
    await setStructureComponent({ client: tenant.client, structureCode: s, componentCode: component, amountKind: kind, amountValue: value, changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  }
  return s;
}

async function employeeOn(structureCode: string, base: string, from: string, to: string | null = null): Promise<string> {
  const pn = await payrollEmployee(fx, to ? { positionFrom: from, positionTo: to } : { positionFrom: from });
  await assignStructure({ client: tenant.client, personnelNumber: pn, structureCode, baseAmount: base, currency: fx.currency, validFrom: from, validTo: to, changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  return pn;
}

async function releasedRun(period: number): Promise<PayrollRunView> {
  const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
  expect(run.exceptions, JSON.stringify(run.exceptions)).toEqual([]);
  return releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
}

const post = (runId: string, actor = poster) =>
  postPayrollRun({ client: tenant.client, changedBy: actor.username, runId, authorization: actor.authorization });

async function journalLines(documentNumber: string, fiscalYear: number) {
  return withTenant(tenant.client, async (tx) => (await tx.execute(sql`
    select gl_account, debit_credit, amount_document::text as amount, cost_center, line_text, assignment
      from journal_entry_line
     where client = ${tenant.client} and company_code = ${fx.companyCode}
       and document_number = ${documentNumber} and fiscal_year = ${fiscalYear}
     order by line_number`)) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string; cost_center: string | null; line_text: string | null; assignment: string | null }>);
}

async function setNetPayAccount(account: string | null) {
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`delete from account_determination where client = ${tenant.client} and chart_of_accounts = ${fx.chart} and event = 'PAYROLL_NET_PAY'`);
    if (account) {
      await tx.execute(sql`insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${tenant.client}, ${fx.chart}, 'PAYROLL_NET_PAY', '', '', ${account}, ${PAYROLL_ACTOR})`);
    }
  });
}

beforeAll(async () => {
  tenant = await createTenant('payroll-posting');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${tenant.client}, 'SAL', 'Salary', 'EARNING', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ZERO', 'Allowance at nil', 'EARNING', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'PENS', 'Pension (employee)', 'DEDUCTION', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ADV', 'Salary advance recovery', 'DEDUCTION', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ERC', 'Employer contribution', 'EMPLOYER_CONTRIBUTION', false, true, ${PAYROLL_ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, created_by) values
        (${tenant.client}, 'SAL', ${fx.chart}, '500000', null, 'ASSIGNMENT', ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ZERO', ${fx.chart}, '500000', null, 'ASSIGNMENT', ${PAYROLL_ACTOR}),
        (${tenant.client}, 'PENS', ${fx.chart}, null, '250000', 'NONE', ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ADV', ${fx.chart}, null, '250000', 'NONE', ${PAYROLL_ACTOR}),
        (${tenant.client}, 'ERC', ${fx.chart}, '500100', '250000', 'ASSIGNMENT', ${PAYROLL_ACTOR})
      on conflict do nothing`);
  });
  // The journal's document numbers: the standard package defines no range for a test tenant.
  await maintainNumberRange({
    client: tenant.client, objectCode: 'RF_BELEG', companyCode: fx.companyCode, subObject: 'GENERAL', fiscalYear: 0,
    prefix: 'PR', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE',
    mode: 'CREATE', changedBy: 'TEST', reason: 'Payroll posting test setup',
  });
  poster = await createPayrollPoster(tenant.client);
}, 120_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
});

describe('buildPayrollJournal (pure)', () => {
  it('groups by account, cost centre and component; credits carry no cost centre; zeros dropped', () => {
    const lines = buildPayrollJournal({
      lines: [
        { componentCode: 'SAL', componentName: 'Salary', debitAccount: '500000', creditAccount: null, costCenter: 'CC1', amount: '1000.0000' },
        { componentCode: 'SAL', componentName: 'Salary', debitAccount: '500000', creditAccount: null, costCenter: 'CC1', amount: '500.5000' },
        { componentCode: 'SAL', componentName: 'Salary', debitAccount: '500000', creditAccount: null, costCenter: 'CC2', amount: '10.0000' },
        { componentCode: 'ZERO', componentName: null, debitAccount: '500000', creditAccount: null, costCenter: 'CC1', amount: '0.0000' },
        { componentCode: 'ERC', componentName: 'Employer', debitAccount: '500100', creditAccount: '250000', costCenter: 'CC1', amount: '100.0000' },
        { componentCode: 'PENS', componentName: 'Pension', debitAccount: null, creditAccount: '250000', costCenter: null, amount: '50.0000' },
      ],
      netPayAccount: '251000',
      netPayTotal: '1460.5000',
      label: '2025-03',
    });
    expect(lines.map((l) => [l.debitCredit, l.glAccount, l.costCenter ?? '', l.amount, l.lineText])).toEqual([
      ['S', '500000', 'CC1', '1500.5000', 'Salary'],
      ['S', '500000', 'CC2', '10.0000', 'Salary'],
      ['S', '500100', 'CC1', '100.0000', 'Employer'],
      ['H', '250000', '', '100.0000', 'Employer'],
      ['H', '250000', '', '50.0000', 'Pension'],
      ['H', '251000', '', '1460.5000', 'Net pay'],
    ]);
    expect(lines.every((l) => l.assignment === '2025-03')).toBe(true);
  });
});

describe('posting the March 2025 run', () => {
  let main: string;
  let run: PayrollRunView;
  let document: { documentNumber: string; fiscalYear: number };

  beforeAll(async () => {
    main = await structure([
      ['SAL', 'PERCENT_OF_BASE', '100'],
      ['HOUSING', 'FIXED', '200'],
      ['ZERO', 'FIXED', '0'],
      ['PENS', 'PERCENT_OF_BASE', '5'],
      ['ERC', 'PERCENT_OF_BASE', '11'],
    ]);
    await employeeOn(main, '1000', '2024-01-01');
    await employeeOn(main, '1000', '2024-01-01');
    run = await releasedRun(3);
  }, 120_000);

  it('11. a proposed run is refused: it has not been released', async () => {
    const proposed = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 4, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
    const refusal = await expectPostingRefusal(post(proposed.runId), 'RUN_NOT_RELEASED');
    expect(refusal.message).toContain('has not been released');
    await cancelPayrollRun({ client: tenant.client, runId: proposed.runId, reason: 'test', changedBy: PAYROLL_ACTOR }, RUN_AUTH);
  });

  it('18. an actor without PEOPLE.PAYROLL.POST is refused', async () => {
    const clerk = await createPayrollPoster(tenant.client, { capabilities: ['FIN.JOURNAL.POST'] });
    const refusal = await expectPostingRefusal(post(run.runId, clerk), 'PAYROLL_AUTHORITY');
    expect(refusal.message).toContain('authority to post payroll');
  });

  it('19. an actor with PEOPLE.PAYROLL.POST but not FIN.JOURNAL.POST is refused by the posting service', async () => {
    const payrollOnly = await createPayrollPoster(tenant.client, { capabilities: ['PEOPLE.PAYROLL.POST'] });
    const refusal = await expectPostingRefusal(post(run.runId, payrollOnly), 'GL_REFUSED');
    expect(refusal.message).toMatch(/FIN\.JOURNAL\.POST|post/i);
    expect((await getPayrollRun(tenant.client, run.runId, RUN_AUTH))!.status).toBe('RELEASED');
  });

  it('an actor whose Company Code scope misses the company is refused, naming it', async () => {
    const elsewhere = await createPayrollPoster(tenant.client, { companyScopes: ['ZZZZ'] });
    const refusal = await expectPostingRefusal(post(run.runId, elsewhere), 'COMPANY_SCOPE');
    expect(refusal.message).toContain(fx.companyCode);
  });

  it('1, 2, 20. a released run posts one PR document dated the last day of the period, and becomes POSTED', async () => {
    const result = await post(run.runId);
    expect(result).toMatchObject({ status: 'POSTED', postingDate: '2025-03-31', fiscalYear: YEAR });
    document = { documentNumber: result.documentNumber, fiscalYear: result.fiscalYear };
    const entries = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select document_type, posting_date::text as posting_date, reference from journal_entry
       where client = ${tenant.client} and document_number = ${result.documentNumber} and fiscal_year = ${result.fiscalYear}`)) as unknown as Array<{ document_type: string; posting_date: string; reference: string }>);
    expect(entries).toEqual([{ document_type: 'PR', posting_date: '2025-03-31', reference: 'PAYROLL-2025-3' }]);
    const standing = (await getPayrollRun(tenant.client, run.runId, RUN_AUTH))!;
    expect(standing.status).toBe('POSTED');
    const row = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select document_number, document_fiscal_year, posted_by, posting_request_key from payroll_run where client = ${tenant.client} and run_id = ${run.runId}`)) as unknown as Array<Record<string, unknown>>);
    expect(row[0]).toMatchObject({ document_number: result.documentNumber, document_fiscal_year: YEAR, posted_by: poster.username, posting_request_key: `PAYROLL-POST-${run.runId}` });
  });

  it('3, 4. debits equal gross plus employer cost; credits equal net plus deductions plus employer contributions, and balance', async () => {
    const lines = await journalLines(document.documentNumber, document.fiscalYear);
    const sum = (side: string) => lines.filter((l) => l.debit_credit === side).reduce((s, l) => s + Number(l.amount), 0);
    const view = (await getPayrollRun(tenant.client, run.runId, RUN_AUTH))!;
    expect(sum('S')).toBeCloseTo(Number(view.grossPay) + Number(view.employerCost), 4);
    expect(sum('H')).toBeCloseTo(Number(view.netPay) + Number(view.totalDeductions) + Number(view.employerCost), 4);
    expect(sum('S')).toBeCloseTo(sum('H'), 4);
    expect(sum('S')).toBeCloseTo(2620, 4);
    const posting = (await getPayrollPosting(tenant.client, run.runId, RUN_AUTH))!;
    expect(posting).toMatchObject({ documentNumber: document.documentNumber, documentFiscalYear: YEAR, postingDate: '2025-03-31', lineCount: 6, reversalDocumentNumber: null });
    expect(Number(posting.debitTotal)).toBeCloseTo(2620, 4);
  });

  it('5–10. earnings debit, deductions credit, employer contribution both sides, cost centre on debits only, grouped, zero dropped', async () => {
    const lines = await journalLines(document.documentNumber, document.fiscalYear);
    expect(lines.map((l) => [l.debit_credit, l.gl_account, l.cost_center || '', Number(l.amount), l.line_text])).toEqual([
      ['S', '500000', CENTRE, 400, 'Housing allowance'],
      ['S', '500000', CENTRE, 2000, 'Salary'],
      ['S', '500100', CENTRE, 220, 'Employer contribution'],
      ['H', '250000', '', 220, 'Employer contribution'],
      ['H', '250000', '', 100, 'Pension (employee)'],
      ['H', '251000', '', 2300, 'Net pay'],
    ]);
    expect(lines.some((l) => l.line_text === 'Allowance at nil')).toBe(false);
    expect(lines.every((l) => l.assignment === '2025-03')).toBe(true);
  });

  it('12. posting a run twice is refused, naming the document', async () => {
    const refusal = await expectPostingRefusal(post(run.runId), 'RUN_POSTED');
    expect(refusal.message).toContain(document.documentNumber);
  });

  it('13. a repeat submission of the posting request returns the same document, and the run stays POSTED', async () => {
    const replay = await postGlDocument({
      client: tenant.client, changedBy: poster.username, requestKey: `PAYROLL-POST-${run.runId}`,
      companyCode: fx.companyCode, documentDate: '2025-03-31', postingDate: '2025-03-31', documentType: 'PR', currency: fx.currency,
      lines: [
        { glAccount: '500000', debitCredit: 'S', amount: '1.00', costCenter: CENTRE },
        { glAccount: '251000', debitCredit: 'H', amount: '1.00' },
      ],
    }, { authorization: poster.authorization });
    expect(replay.documentNumber).toBe(document.documentNumber);
    const count = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${tenant.client} and document_type = 'PR'`)) as unknown as Array<{ n: number }>);
    expect(count[0]!.n).toBe(1);
    const standing = (await getPayrollRun(tenant.client, run.runId, RUN_AUTH))!;
    expect(standing.status).toBe('POSTED');
  });

  it('21. cancelling a posted run is refused', async () => {
    await expect(cancelPayrollRun({ client: tenant.client, runId: run.runId, reason: 'try', changedBy: PAYROLL_ACTOR }, RUN_AUTH))
      .rejects.toMatchObject({ code: 'RUN_POSTED' });
  });
});

describe('determination, period and snapshot refusals', () => {
  it('5. the net pay credit goes to whatever PAYROLL_NET_PAY names — change it and the account changes', async () => {
    const run = await releasedRun(5);
    await setNetPayAccount('230100');
    try {
      const result = await post(run.runId);
      const lines = await journalLines(result.documentNumber, result.fiscalYear);
      const net = lines.find((l) => l.line_text === 'Net pay')!;
      expect(net).toMatchObject({ gl_account: '230100', debit_credit: 'H' });
      expect(lines.some((l) => l.gl_account === '251000')).toBe(false);
    } finally {
      await setNetPayAccount('251000');
    }
  });

  it('14. a missing PAYROLL_NET_PAY determination is refused, naming /config/account-determination', async () => {
    const run = await releasedRun(6);
    await setNetPayAccount(null);
    try {
      const refusal = await expectPostingRefusal(post(run.runId), 'NO_NET_PAY_ACCOUNT');
      expect(refusal.message).toContain(fx.chart);
      expect(refusal.remedy).toContain('/config/account-determination');
    } finally {
      await setNetPayAccount('251000');
    }
    expect((await getPayrollRun(tenant.client, run.runId, RUN_AUTH))!.status).toBe('RELEASED');
  });

  it('16. negative net pay is refused at calculation (a named exception), and a result that carries it anyway is refused at posting', async () => {
    const negative = await structure([['SAL', 'FIXED', '100'], ['ADV', 'FIXED', '500']]);
    const pn = await employeeOn(negative, '0', '2025-07-01', '2025-07-31');
    const proposed = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 7, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
    const exception = proposed.exceptions.find((e) => e.personnelNumber === pn);
    expect(exception?.reasonCode).toBe('NEGATIVE_NET_PAY');
    expect(exception?.message).toContain('500.00');
    await cancelPayrollRun({ client: tenant.client, runId: proposed.runId, reason: 'negative net test', changedBy: PAYROLL_ACTOR }, RUN_AUTH);

    // Defence in depth: a result that nevertheless carries negative net (written outside the calculation) cannot be posted.
    const fine = await structure([['SAL', 'FIXED', '100']]);
    const pn2 = await employeeOn(fine, '0', '2025-10-01', '2025-10-31');
    const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 10, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
    expect(run.exceptions, JSON.stringify(run.exceptions)).toEqual([]);
    await withTenant(tenant.client, async (tx) => {
      const [old] = (await tx.execute(sql`select * from payroll_result where client = ${tenant.client} and run_id = ${run.runId} and personnel_number = ${pn2}`)) as unknown as Array<Record<string, string>>;
      const [line] = (await tx.execute(sql`select * from payroll_result_line where client = ${tenant.client} and result_id = ${old!.result_id}`)) as unknown as Array<Record<string, string>>;
      await tx.execute(sql`delete from payroll_result where client = ${tenant.client} and result_id = ${old!.result_id}`);
      const id = 'NEG-' + Date.now();
      await tx.execute(sql`insert into payroll_result (client, result_id, run_id, personnel_number, origin, currency, payable_days, total_days, covered_days, unpaid_leave_days, gross_pay, total_deductions, net_pay, employer_cost, cost_center, controlling_area, created_by)
        values (${tenant.client}, ${id}, ${run.runId}, ${pn2}, 'CALCULATED', ${old!.currency}, ${old!.payable_days}, ${old!.total_days}, ${old!.covered_days}, ${old!.unpaid_leave_days}, 100, 500, -400, 0, ${old!.cost_center}, ${old!.controlling_area}, 'TEST')`);
      for (const [no, component, kind, amount, debit, credit, receiver] of [[1, 'SAL', 'EARNING', 100, '500000', null, 'ASSIGNMENT'], [2, 'ADV', 'DEDUCTION', 500, null, '250000', 'NONE']] as const) {
        await tx.execute(sql`insert into payroll_result_line (client, result_id, line_id, line_no, segment_from, segment_to, payable_days, structure_code, base_amount, component_code, component_kind, amount_kind, amount_value, amount, debit_account, credit_account, cost_receiver_category, cost_center, controlling_area, created_by)
          values (${tenant.client}, ${id}, ${`${id}-${no}`}, ${no}, ${line!.segment_from}, ${line!.segment_to}, ${line!.payable_days}, ${line!.structure_code}, 0, ${component}, ${kind}, 'FIXED', ${amount}, ${amount}, ${debit}, ${credit}, ${receiver}, ${receiver === 'ASSIGNMENT' ? old!.cost_center : null}, ${receiver === 'ASSIGNMENT' ? old!.controlling_area : null}, 'TEST')`);
      }
    });
    await releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
    const refusal = await expectPostingRefusal(post(run.runId), 'NEGATIVE_NET_PAY');
    expect(refusal.message).toContain(pn2);
    expect(refusal.message).toContain('-400');
  });

  it('17. an expense component with no cost receiver is refused, naming the component and /config/pay-components', async () => {
    const bare = await structure([['BASIC', 'FIXED', '300']]);
    await employeeOn(bare, '0', '2025-08-01', '2025-08-31');
    const run = await releasedRun(8);
    const refusal = await expectPostingRefusal(post(run.runId), 'NO_COST_OBJECT');
    expect(refusal.message).toContain('BASIC');
    expect(refusal.remedy).toContain('/config/pay-components');
  });

  it('15. a closed period is refused, naming the period', async () => {
    const run = await releasedRun(9);
    const restore = await withTenant(tenant.client, async (tx) => {
      const rows = (await tx.execute(sql`
        select r.variant, r.period_to from posting_period_rule r
          join company_code c on c.client = r.client and c.posting_period_variant = r.variant
         where r.client = ${tenant.client} and c.company_code = ${fx.companyCode} and r.account_type = 'S'`)) as unknown as Array<{ variant: string; period_to: number }>;
      await tx.execute(sql`update posting_period_rule set period_to = 8 where client = ${tenant.client} and variant = ${rows[0]!.variant} and account_type = 'S'`);
      return rows[0]!;
    });
    try {
      const refusal = await expectPostingRefusal(post(run.runId), 'PERIOD_CLOSED');
      expect(refusal.message).toContain('Period 9 of fiscal year 2025');
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`update posting_period_rule set period_to = ${restore.period_to} where client = ${tenant.client} and variant = ${restore.variant} and account_type = 'S'`));
    }
  });
});
