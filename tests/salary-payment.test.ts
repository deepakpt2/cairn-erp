/**
 * Payroll phase 4 — paying a posted run.
 *
 * What is worth proving: one PY document dated as asked; the bank credit goes to the chosen bank
 * account's G/L account (proved by paying another run from a second account) and the debits to the
 * PAYROLL_NET_PAY account, one per employee with positive net pay; no cost object, no partner; the
 * payroll document's payable and the payment's own debits are cleared; a salary_payment row records
 * it; a run is paid once; and every refusal is named — status, date, bank, currency, period,
 * authority, and the reconciliation guard that pays only what was posted.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { maintainNumberRange } from '../src/modules/foundation/number-ranges';
import { postGlDocument } from '../src/modules/finance/gl-document';
import { assignStructure, defineSalaryStructure, setStructureComponent } from '../src/modules/people/payroll-structure';
import { PAYROLL_RUN_CAPABILITY, proposePayrollRun, releasePayrollRun, type PayrollRunView } from '../src/modules/people/payroll-run';
import { postPayrollRun } from '../src/modules/people/payroll-posting';
import {
  SalaryPaymentError,
  buildSalaryPaymentJournal,
  getSalaryPayment,
  paySalaryRun,
} from '../src/modules/people/salary-payment';
import {
  PAYROLL_ACTOR,
  PAYROLL_AUTH,
  PAYROLL_PAYER_CAPABILITIES,
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
let payer: Awaited<ReturnType<typeof createPayrollPoster>>;
const people: string[] = [];
let zeroPay: string;

async function expectRefusal(promise: Promise<unknown>, wanted: string): Promise<SalaryPaymentError> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(SalaryPaymentError);
    expect((error as SalaryPaymentError).code, (error as Error).message).toBe(wanted);
    return error as SalaryPaymentError;
  }
  throw new Error(`Expected SalaryPaymentError ${wanted}, nothing was thrown.`);
}

async function runFor(period: number, post = true): Promise<PayrollRunView> {
  const proposed = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
  expect(proposed.exceptions, JSON.stringify(proposed.exceptions)).toEqual([]);
  const released = await releasePayrollRun({ client: tenant.client, runId: proposed.runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
  if (post) await postPayrollRun({ client: tenant.client, changedBy: payer.username, runId: released.runId, authorization: payer.authorization });
  return released;
}

const pay = (runId: string, over: Partial<{ paymentDate: string; houseBankKey: string; bankAccountId: string }> = {}, actor = payer) =>
  paySalaryRun({
    client: tenant.client, changedBy: actor.username, runId, authorization: actor.authorization,
    paymentDate: over.paymentDate ?? '2025-04-05', houseBankKey: over.houseBankKey ?? 'HB01', bankAccountId: over.bankAccountId ?? 'MAIN',
  });

async function lines(documentNumber: string, fiscalYear: number) {
  return withTenant(tenant.client, async (tx) => (await tx.execute(sql`
    select line_number, gl_account, debit_credit, amount_document::text as amount, cost_center, business_partner,
           clearing_document, clearing_date::text as clearing_date, line_text
      from journal_entry_line
     where client = ${tenant.client} and company_code = ${fx.companyCode}
       and document_number = ${documentNumber} and fiscal_year = ${fiscalYear}
     order by line_number`)) as unknown as Array<{ line_number: number; gl_account: string; debit_credit: string; amount: string; cost_center: string | null; business_partner: string | null; clearing_document: string | null; clearing_date: string | null; line_text: string }>);
}

async function runDocument(runId: string) {
  return withTenant(tenant.client, async (tx) => ((await tx.execute(sql`
    select document_number, document_fiscal_year from payroll_run where client = ${tenant.client} and run_id = ${runId}`)) as unknown as Array<{ document_number: string; document_fiscal_year: number }>)[0]!);
}

async function setNetPayAccount(account: string) {
  await withTenant(tenant.client, (tx) => tx.execute(sql`
    update account_determination set gl_account = ${account}
     where client = ${tenant.client} and chart_of_accounts = ${fx.chart} and event = 'PAYROLL_NET_PAY'`));
}

beforeAll(async () => {
  tenant = await createTenant('salary-payment');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${tenant.client}, 'SAL', 'Salary', 'EARNING', true, true, ${PAYROLL_ACTOR}),
        (${tenant.client}, 'PENS', 'Pension (employee)', 'DEDUCTION', true, true, ${PAYROLL_ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, created_by) values
        (${tenant.client}, 'SAL', ${fx.chart}, '500000', null, 'ASSIGNMENT', ${PAYROLL_ACTOR}),
        (${tenant.client}, 'PENS', ${fx.chart}, null, '250000', 'NONE', ${PAYROLL_ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`insert into bank_master (bank_country, bank_key, name, created_by)
      values ('KW', 'PAYTEST01', 'Payroll Test Bank', ${PAYROLL_ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
      values (${tenant.client}, ${fx.companyCode}, 'HB01', 'KW', 'PAYTEST01', ${PAYROLL_ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by) values
      (${tenant.client}, ${fx.companyCode}, 'HB01', 'MAIN', '100001', ${fx.currency}, '101000', ${PAYROLL_ACTOR}),
      (${tenant.client}, ${fx.companyCode}, 'HB01', 'ALT', '100002', ${fx.currency}, '101100', ${PAYROLL_ACTOR}),
      (${tenant.client}, ${fx.companyCode}, 'HB01', 'EUR', '100003', 'EUR', '101100', ${PAYROLL_ACTOR})
      on conflict do nothing`);
  });
  await maintainNumberRange({
    client: tenant.client, objectCode: 'RF_BELEG', companyCode: fx.companyCode, subObject: 'GENERAL', fiscalYear: 0,
    prefix: 'PY', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE',
    mode: 'CREATE', changedBy: 'TEST', reason: 'Salary payment test setup',
  });
  payer = await createPayrollPoster(tenant.client, { capabilities: PAYROLL_PAYER_CAPABILITIES });

  const s = 'PAYS';
  await defineSalaryStructure({ client: tenant.client, code: s, name: 'Paid staff', currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  await setStructureComponent({ client: tenant.client, structureCode: s, componentCode: 'SAL', amountKind: 'PERCENT_OF_BASE', amountValue: '100', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  await setStructureComponent({ client: tenant.client, structureCode: s, componentCode: 'PENS', amountKind: 'PERCENT_OF_BASE', amountValue: '5', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  for (const base of ['1000', '2000']) {
    const pn = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
    await assignStructure({ client: tenant.client, personnelNumber: pn, structureCode: s, baseAmount: base, currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
    people.push(pn);
  }
  zeroPay = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
  await assignStructure({ client: tenant.client, personnelNumber: zeroPay, structureCode: s, baseAmount: '0', currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
});

describe('buildSalaryPaymentJournal (pure)', () => {
  it('one debit per paid employee in personnel-number order, one bank credit, zero dropped, no cost object', () => {
    const journal = buildSalaryPaymentJournal({
      employees: [
        { personnelNumber: 'B2', fullName: 'Bea', netPay: '1900.0000' },
        { personnelNumber: 'A1', fullName: 'Ali', netPay: '950.0000' },
        { personnelNumber: 'C3', fullName: 'Cy', netPay: '0.0000' },
      ],
      netPayAccount: '251000', bankAccount: '101000', label: 'SAL-2025-3',
    });
    expect(journal).toEqual([
      { glAccount: '251000', debitCredit: 'S', amount: '950.0000', assignment: 'SAL-2025-3', lineText: 'A1 Ali' },
      { glAccount: '251000', debitCredit: 'S', amount: '1900.0000', assignment: 'SAL-2025-3', lineText: 'B2 Bea' },
      { glAccount: '101000', debitCredit: 'H', amount: '2850.0000', assignment: 'SAL-2025-3', lineText: 'Salary payment SAL-2025-3' },
    ]);
  });
});

describe('paying the March 2025 run', () => {
  let run: PayrollRunView;
  let payment: { documentNumber: string; fiscalYear: number };

  beforeAll(async () => {
    run = await runFor(3);
  }, 120_000);

  it('12. a released but unposted run is refused', async () => {
    const released = await runFor(4, false);
    const refusal = await expectRefusal(pay(released.runId), 'RUN_NOT_POSTED');
    expect(refusal.message).toContain('RELEASED');
    expect(refusal.message).toContain('Post the run before paying it');
  });

  it('13. a payment date before the end of the period is refused', async () => {
    const refusal = await expectRefusal(pay(run.runId, { paymentDate: '2025-03-30' }), 'PAID_BEFORE_PERIOD_END');
    expect(refusal.message).toContain('2025-03-30');
    expect(refusal.message).toContain('2025-03-31');
    await expectRefusal(pay(run.runId, { paymentDate: '2025-02-30' }), 'PAYMENT_DATE');
  });

  it('14. a bank account that does not stand for the company is refused, naming /config/house-banks', async () => {
    const refusal = await expectRefusal(pay(run.runId, { houseBankKey: 'HB09', bankAccountId: 'MAIN' }), 'BANK_ACCOUNT_UNKNOWN');
    expect(refusal.message).toContain(fx.companyCode);
    expect(refusal.remedy).toContain('/config/house-banks');
  });

  it('15. a bank account in another currency is refused, naming both', async () => {
    const refusal = await expectRefusal(pay(run.runId, { bankAccountId: 'EUR' }), 'BANK_CURRENCY');
    expect(refusal.message).toContain('EUR');
    expect(refusal.message).toContain(fx.currency);
  });

  it('16. a closed period is refused, naming the period', async () => {
    const restore = await withTenant(tenant.client, async (tx) => {
      const rows = (await tx.execute(sql`
        select r.variant, r.period_to from posting_period_rule r
          join company_code c on c.client = r.client and c.posting_period_variant = r.variant
         where r.client = ${tenant.client} and c.company_code = ${fx.companyCode} and r.account_type = 'S'`)) as unknown as Array<{ variant: string; period_to: number }>;
      await tx.execute(sql`update posting_period_rule set period_to = 3 where client = ${tenant.client} and variant = ${rows[0]!.variant} and account_type = 'S'`);
      return rows[0]!;
    });
    try {
      const refusal = await expectRefusal(pay(run.runId), 'PERIOD_CLOSED');
      expect(refusal.message).toContain('Period 4 of fiscal year 2025');
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(sql`update posting_period_rule set period_to = ${restore.period_to} where client = ${tenant.client} and variant = ${restore.variant} and account_type = 'S'`));
    }
  });

  it('17. an actor without PEOPLE.PAYROLL.PAYMENT is refused', async () => {
    const actor = await createPayrollPoster(tenant.client, { capabilities: ['FIN.JOURNAL.POST'] });
    const refusal = await expectRefusal(pay(run.runId, {}, actor), 'PAYMENT_AUTHORITY');
    expect(refusal.message).toContain('authority to pay salaries');
  });

  it('18. an actor with it but without FIN.JOURNAL.POST is refused by the posting service', async () => {
    const actor = await createPayrollPoster(tenant.client, { capabilities: ['PEOPLE.PAYROLL.PAYMENT'] });
    await expectRefusal(pay(run.runId, {}, actor), 'GL_REFUSED');
    expect(await getSalaryPayment(tenant.client, run.runId, RUN_AUTH)).toBeNull();
  });

  it('1, 3–7. a posted run is paid: one PY document, a debit per paid employee on the net pay account, one bank credit', async () => {
    const result = await pay(run.runId);
    expect(result).toMatchObject({ paymentDate: '2025-04-05', employeeCount: 2, totalAmount: '2850.0000' });
    payment = { documentNumber: result.documentNumber, fiscalYear: result.fiscalYear };
    const header = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select document_type, posting_date::text as posting_date from journal_entry
       where client = ${tenant.client} and document_number = ${result.documentNumber} and fiscal_year = ${result.fiscalYear}`)) as unknown as Array<{ document_type: string; posting_date: string }>);
    expect(header).toEqual([{ document_type: 'PY', posting_date: '2025-04-05' }]);
    const posted = await lines(result.documentNumber, result.fiscalYear);
    const sorted = [...people].sort();
    expect(posted.map((l) => [l.debit_credit, l.gl_account, Number(l.amount), l.line_text.split(' ')[0]])).toEqual([
      ['S', '251000', sorted[0] === people[0] ? 950 : 1900, sorted[0]],
      ['S', '251000', sorted[1] === people[0] ? 950 : 1900, sorted[1]],
      ['H', '101000', 2850, 'Salary'],
    ]);
    expect(posted.some((l) => l.line_text.startsWith(zeroPay))).toBe(false);
    expect(posted.every((l) => !l.cost_center && !l.business_partner)).toBe(true);
    const net = (await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select sum(net_pay)::text as net from payroll_result where client = ${tenant.client} and run_id = ${run.runId}`)) as unknown as Array<{ net: string }>))[0]!.net;
    expect(Number(result.debitTotal)).toBeCloseTo(Number(net), 4);
    expect(result.debitTotal).toBe(result.creditTotal);
  });

  it('8, 9. the payroll document\'s net pay credit and the payment\'s own debits are cleared', async () => {
    const pr = await runDocument(run.runId);
    const prLines = await lines(pr.document_number, pr.document_fiscal_year);
    const netPay = prLines.filter((l) => l.gl_account === '251000' && l.debit_credit === 'H');
    expect(netPay.length).toBe(1);
    expect(netPay[0]).toMatchObject({ clearing_document: payment.documentNumber, clearing_date: '2025-04-05' });
    expect(prLines.filter((l) => l.gl_account !== '251000').every((l) => l.clearing_document === null)).toBe(true);
    const own = await lines(payment.documentNumber, payment.fiscalYear);
    expect(own.filter((l) => l.debit_credit === 'S').every((l) => l.clearing_document === payment.documentNumber && l.clearing_date === '2025-04-05')).toBe(true);
    expect(own.find((l) => l.debit_credit === 'H')!.clearing_document).toBeNull();
  });

  it('10. a salary_payment row records the bank, both accounts, the count and the amount', async () => {
    const view = (await getSalaryPayment(tenant.client, run.runId, RUN_AUTH))!;
    expect(view).toMatchObject({
      paymentDate: '2025-04-05', houseBankKey: 'HB01', bankAccountId: 'MAIN', bankGlAccount: '101000', netPayAccount: '251000',
      employeeCount: 2, totalAmount: '2850.0000', documentNumber: payment.documentNumber, documentFiscalYear: payment.fiscalYear,
      paidBy: payer.username, reversalDocumentNumber: null,
    });
  });

  it('11. paying the same run twice is refused, naming the first payment document', async () => {
    const refusal = await expectRefusal(pay(run.runId), 'ALREADY_PAID');
    expect(refusal.message).toContain(payment.documentNumber);
    expect(refusal.message).toContain('2025-04-05');
  });

  it('20. a repeat submission with the same request key returns the same document, and the run stays paid', async () => {
    const replay = await postGlDocument({
      client: tenant.client, changedBy: payer.username, requestKey: `SALARY-PAY-${run.runId}`,
      companyCode: fx.companyCode, documentDate: '2025-04-05', postingDate: '2025-04-05', documentType: 'PY', currency: fx.currency,
      lines: [
        { glAccount: '251000', debitCredit: 'S', amount: '1.00' },
        { glAccount: '101000', debitCredit: 'H', amount: '1.00' },
      ],
    }, { authorization: payer.authorization });
    expect(replay.documentNumber).toBe(payment.documentNumber);
    const count = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${tenant.client} and document_type = 'PY'`)) as unknown as Array<{ n: number }>);
    expect(count[0]!.n).toBe(1);
    expect((await getSalaryPayment(tenant.client, run.runId, RUN_AUTH))!.documentNumber).toBe(payment.documentNumber);
  });
});

describe('the bank and the payable come from configuration', () => {
  it('2. paying from a second bank account moves the credit to that account', async () => {
    const run = await runFor(5);
    const result = await pay(run.runId, { paymentDate: '2025-06-05', bankAccountId: 'ALT' });
    const posted = await lines(result.documentNumber, result.fiscalYear);
    expect(posted.find((l) => l.debit_credit === 'H')!.gl_account).toBe('101100');
    expect((await getSalaryPayment(tenant.client, run.runId, RUN_AUTH))!.bankGlAccount).toBe('101100');
  });

  it('19. the reconciliation guard: a determination changed after posting refuses the payment, naming both amounts', async () => {
    const run = await runFor(6);
    await setNetPayAccount('230100');
    try {
      const refusal = await expectRefusal(pay(run.runId, { paymentDate: '2025-07-05' }), 'NOTHING_OPEN');
      expect(refusal.message).toContain('230100');
      expect(refusal.message).toContain('0.0000');
      expect(refusal.message).toContain('2850.0000');
    } finally {
      await setNetPayAccount('251000');
    }
    expect(await getSalaryPayment(tenant.client, run.runId, RUN_AUTH)).toBeNull();
  });

  it('the reconciliation guard: an open amount that differs from the results refuses, naming both', async () => {
    const run = await runFor(7);
    const pr = await runDocument(run.runId);
    // Simulate a payroll document whose open net pay no longer agrees with the results (a hand-edited
    // ledger line): pay what the run's results say only when the ledger agrees. A posted result itself
    // can be neither updated (no grant) nor deleted (9281 trigger).
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update journal_entry_line set amount_document = amount_document - 1900
       where client = ${tenant.client} and document_number = ${pr.document_number} and fiscal_year = ${pr.document_fiscal_year}
         and gl_account = '251000' and debit_credit = 'H'`));
    const refusal = await expectRefusal(pay(run.runId, { paymentDate: '2025-08-05' }), 'NET_PAY_MISMATCH');
    expect(refusal.message).toContain(pr.document_number);
    expect(refusal.message).toContain('2850.0000');
    expect(refusal.message).toContain('950.0000'); // what the ledger leaves open
  });
});
