/**
 * Payroll phase 5 — the follow-up pass.
 *
 * A · off-cycle runs: a second run for a period pays only employees no live run covers, names the
 *     rest as information, carries its predecessor, posts and is paid on its own; the database
 *     refuses one employee in two live runs of a period.
 * B · Company Code scope on the Phase 1 and 2 mutating services.
 * C · the read services judge the session and the capability themselves; a list filters by scope.
 * D · a released or posted result cannot be deleted, a proposed one can, and lines go with it.
 * E · every posting event has a label.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { t } from '../src/platform/i18n';
import { POSTING_EVENTS } from '../src/modules/foundation/account-determination';
import { maintainNumberRange } from '../src/modules/foundation/number-ranges';
import {
  PayrollStructureError,
  assignStructure,
  defineSalaryStructure,
  endAssignment,
  listStructures,
  setStructureComponent,
} from '../src/modules/people/payroll-structure';
import {
  PAYROLL_RUN_CAPABILITY,
  PayrollRunError,
  cancelPayrollRun,
  getPayrollRun,
  listPayrollRuns,
  listResults,
  proposePayrollRun,
  releasePayrollRun,
  type PayrollRunView,
} from '../src/modules/people/payroll-run';
import { postPayrollRun } from '../src/modules/people/payroll-posting';
import { paySalaryRun, getSalaryPayment } from '../src/modules/people/salary-payment';
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
const STRUCTURE = 'OFFC';

let tenant: TestTenant;
let fx: PayrollFixture;
let payer: Awaited<ReturnType<typeof createPayrollPoster>>;
const base: string[] = [];

async function expectError<E extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => E, code: string): Promise<E> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(type);
    expect((error as unknown as { code: string }).code, (error as Error).message).toBe(code);
    return error as E;
  }
  throw new Error(`Expected ${type.name} ${code}, nothing was thrown.`);
}

async function expectSqlState(promise: Promise<unknown>, state: string): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    const err = error as { code?: string; cause?: { code?: string } };
    expect(err.code ?? err.cause?.code, String(error)).toBe(state);
    return error as Error;
  }
  throw new Error(`Expected SQLSTATE ${state}, nothing was thrown.`);
}

const propose = (period: number) =>
  proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
const release = (runId: string) => releasePayrollRun({ client: tenant.client, runId, changedBy: PAYROLL_ACTOR }, RUN_AUTH);
const post = (runId: string) => postPayrollRun({ client: tenant.client, changedBy: payer.username, runId, authorization: payer.authorization });
const pay = (runId: string, paymentDate: string) => paySalaryRun({
  client: tenant.client, changedBy: payer.username, runId, authorization: payer.authorization,
  paymentDate, houseBankKey: 'HB01', bankAccountId: 'MAIN',
});

async function employeeFrom(from: string, to?: string, assign = true): Promise<string> {
  const pn = await payrollEmployee(fx, to ? { positionFrom: from, positionTo: to } : { positionFrom: from });
  if (assign) {
    await assignStructure({ client: tenant.client, personnelNumber: pn, structureCode: STRUCTURE, baseAmount: '1000', currency: fx.currency, validFrom: from, validTo: to ?? null, changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  }
  return pn;
}

async function deleteResultsOf(runId: string) {
  return withTenant(tenant.client, (tx) => tx.execute(sql`delete from payroll_result where client = ${tenant.client} and run_id = ${runId}`));
}

beforeAll(async () => {
  tenant = await createTenant('payroll-followup');
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${tenant.client}, 'SAL', 'Salary', 'EARNING', true, true, ${PAYROLL_ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, created_by) values
        (${tenant.client}, 'SAL', ${fx.chart}, '500000', null, 'ASSIGNMENT', ${PAYROLL_ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`insert into bank_master (bank_country, bank_key, name, created_by)
      values ('KW', 'PAYTEST05', 'Payroll Follow-up Bank', ${PAYROLL_ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
      values (${tenant.client}, ${fx.companyCode}, 'HB01', 'KW', 'PAYTEST05', ${PAYROLL_ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
      values (${tenant.client}, ${fx.companyCode}, 'HB01', 'MAIN', '500001', ${fx.currency}, '101000', ${PAYROLL_ACTOR}) on conflict do nothing`);
  });
  await maintainNumberRange({
    client: tenant.client, objectCode: 'RF_BELEG', companyCode: fx.companyCode, subObject: 'GENERAL', fiscalYear: 0,
    prefix: 'FU', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE',
    mode: 'CREATE', changedBy: 'TEST', reason: 'Payroll follow-up test setup',
  });
  payer = await createPayrollPoster(tenant.client, { capabilities: PAYROLL_PAYER_CAPABILITIES });
  await defineSalaryStructure({ client: tenant.client, code: STRUCTURE, name: 'Off-cycle', currency: fx.currency, validFrom: '2024-01-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  await setStructureComponent({ client: tenant.client, structureCode: STRUCTURE, componentCode: 'SAL', amountKind: 'FIXED', amountValue: '1000', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  base.push(await employeeFrom('2024-01-01'), await employeeFrom('2024-01-01'));
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
});

// ── A · Off-cycle runs ──────────────────────────────────────────────────────

describe('A · an off-cycle run for March 2025', () => {
  let first: PayrollRunView;
  let second: PayrollRunView;
  let late: string;

  beforeAll(async () => {
    first = await release((await propose(3)).runId);
    await post(first.runId);
    // Hired after the March run was released: nobody has paid them for March.
    late = await employeeFrom('2025-03-20');
  }, 120_000);

  it('5. the first run of a period has no predecessor', () => {
    expect(first.predecessorRunId).toBeNull();
  });

  it('1, 2, 4. a second run can be proposed; it excludes everyone the first covered and names it as predecessor', async () => {
    second = await propose(3);
    expect(second.status).toBe('PROPOSED');
    expect(second.predecessorRunId).toBe(first.runId);
    const paid = (await listResults(tenant.client, second.runId, undefined, RUN_AUTH)).map((r) => r.personnelNumber);
    expect(paid).toEqual([late]);
    expect(second.employeeCount).toBe(1);
  });

  it('3. the excluded employees appear as named, informational exceptions naming the covering run', () => {
    const covered = second.exceptions.filter((e) => e.reasonCode === 'ALREADY_COVERED');
    expect(covered.map((e) => e.personnelNumber).sort()).toEqual([...base].sort());
    expect(covered.every((e) => e.informational && e.message.includes(`Already covered by run ${first.runId}`))).toBe(true);
    expect(second.exceptionCount).toBe(0);
  });

  it('7. the off-cycle run releases, posts its own PR document and is paid by its own payment', async () => {
    await release(second.runId);
    const posted = await post(second.runId);
    expect(posted.status).toBe('POSTED');
    const paidFirst = await pay(first.runId, '2025-04-05');
    const paidSecond = await pay(second.runId, '2025-04-05');
    expect(paidSecond.documentNumber).not.toBe(paidFirst.documentNumber);
    expect(paidSecond.employeeCount).toBe(1);
    expect((await getSalaryPayment(tenant.client, second.runId, RUN_AUTH))!.totalAmount).toBe(paidSecond.totalAmount);
    const documents = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select document_type, count(*)::int as n from journal_entry where client = ${tenant.client} group by 1 order by 1`)) as unknown as Array<{ document_type: string; n: number }>);
    expect(documents).toEqual([{ document_type: 'PR', n: 2 }, { document_type: 'PY', n: 2 }]);
  });

  it('6. a third run when every employee is already covered is refused, naming the covering run', async () => {
    const refusal = await expectError(propose(3), PayrollRunError, 'ALL_COVERED');
    expect(refusal.message).toContain(first.runId);
  });

  it('8. the database refuses a result for an employee a live run already covers (SQLSTATE 23505)', async () => {
    await expectSqlState(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into payroll_result (client, result_id, run_id, personnel_number, currency, payable_days, total_days, covered_days, created_by)
      values (${tenant.client}, ${randomUUID()}, ${second.runId}, ${base[0]!}, ${fx.currency}, 0, 31, 0, ${PAYROLL_ACTOR})`)), '23505');
  });

  it('9. a run whose uncovered employees are all unready is still proposed, with the named reasons', async () => {
    first = await release((await propose(5)).runId);
    const unready = await employeeFrom('2025-05-01', undefined, false);
    const run = await propose(5);
    expect(run.status).toBe('PROPOSED');
    expect(run.employeeCount).toBe(0);
    expect(run.exceptions.find((e) => e.personnelNumber === unready)).toMatchObject({ reasonCode: 'NO_STRUCTURE', informational: false });
    await cancelPayrollRun({ client: tenant.client, runId: run.runId, reason: 'test', changedBy: PAYROLL_ACTOR }, RUN_AUTH);
    await assignStructure({ client: tenant.client, personnelNumber: unready, structureCode: STRUCTURE, baseAmount: '1000', currency: fx.currency, validFrom: '2025-05-01', changedBy: PAYROLL_ACTOR }, PAYROLL_AUTH);
  });
});

// ── B, C · Scope and capability ─────────────────────────────────────────────

describe('B, C · Company Code scope and the read services', () => {
  let outsider: Awaited<ReturnType<typeof createPayrollPoster>>;
  let insider: Awaited<ReturnType<typeof createPayrollPoster>>;
  let proposed: PayrollRunView;
  const asOutsider = () => ({ authorization: outsider.authorization });

  beforeAll(async () => {
    const capabilities = [PAYROLL_RUN_CAPABILITY, 'PEOPLE.PAYROLL.STRUCTURE.DEFINE'];
    outsider = await createPayrollPoster(tenant.client, { capabilities, companyScopes: ['ZZZZ'] });
    insider = await createPayrollPoster(tenant.client, { capabilities });
    proposed = await propose(6);
  }, 120_000);

  it('10. an actor scoped to another company is refused on propose, release and cancel', async () => {
    const proposeRefusal = await expectError(
      proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 7, changedBy: 'OUTSIDER' }, asOutsider()),
      PayrollRunError, 'COMPANY_SCOPE');
    expect(proposeRefusal.message).toContain(fx.companyCode);
    await expectError(releasePayrollRun({ client: tenant.client, runId: proposed.runId, changedBy: 'OUTSIDER' }, asOutsider()), PayrollRunError, 'COMPANY_SCOPE');
    await expectError(cancelPayrollRun({ client: tenant.client, runId: proposed.runId, reason: 'x', changedBy: 'OUTSIDER' }, asOutsider()), PayrollRunError, 'COMPANY_SCOPE');
    // The same services with a session in scope go through.
    const released = await releasePayrollRun({ client: tenant.client, runId: proposed.runId, changedBy: insider.username }, { authorization: insider.authorization });
    expect(released.status).toBe('RELEASED');
  });

  it('11. the same actor is refused on assignStructure and endAssignment', async () => {
    const pn = await payrollEmployee(fx, { positionFrom: '2025-08-01' });
    await expectError(assignStructure({
      client: tenant.client, personnelNumber: pn, structureCode: STRUCTURE, baseAmount: '1', currency: fx.currency, validFrom: '2025-08-01', changedBy: 'OUTSIDER',
    }, asOutsider()), PayrollStructureError, 'COMPANY_SCOPE');
    const made = await assignStructure({
      client: tenant.client, personnelNumber: pn, structureCode: STRUCTURE, baseAmount: '1', currency: fx.currency, validFrom: '2025-08-01', changedBy: insider.username,
    }, { authorization: insider.authorization });
    await expectError(endAssignment({ client: tenant.client, assignmentId: made.assignmentId, validTo: '2025-08-31', changedBy: 'OUTSIDER' }, asOutsider()), PayrollStructureError, 'COMPANY_SCOPE');
    // A structure is company-independent: the outsider may still read the catalogue.
    expect((await listStructures(tenant.client, asOutsider())).map((s) => s.code)).toContain(STRUCTURE);
  });

  it('12. listPayrollRuns returns only runs in scope, and does not refuse', async () => {
    expect(await listPayrollRuns(tenant.client, asOutsider())).toEqual([]);
    expect((await listPayrollRuns(tenant.client, { authorization: insider.authorization })).length).toBeGreaterThan(0);
  });

  it('13. getPayrollRun refuses an out-of-scope run, naming the company code', async () => {
    const refusal = await expectError(getPayrollRun(tenant.client, proposed.runId, asOutsider()), PayrollRunError, 'COMPANY_SCOPE');
    expect(refusal.message).toContain(fx.companyCode);
    await expectError(listResults(tenant.client, proposed.runId, undefined, asOutsider()), PayrollRunError, 'COMPANY_SCOPE');
  });

  it('14. a read service called without a valid session is refused, naming the capability', async () => {
    const forged = await expectError(
      getPayrollRun(tenant.client, proposed.runId, { authorization: { userId: randomUUID(), sessionId: randomUUID() } }),
      PayrollRunError, 'PAYROLL_AUTHORITY');
    expect(forged.message).toContain(PAYROLL_RUN_CAPABILITY);
    const none = await expectError(listPayrollRuns(tenant.client), PayrollRunError, 'PAYROLL_AUTHORITY');
    expect(none.message).toContain(PAYROLL_RUN_CAPABILITY);
    const structures = await expectError(listStructures(tenant.client), PayrollStructureError, 'PAYROLL_AUTHORITY');
    expect(structures.message).toContain('PEOPLE.PAYROLL.STRUCTURE.DEFINE');
    // A session that lacks the capability.
    const clerk = await createPayrollPoster(tenant.client, { capabilities: ['FIN.JOURNAL.POST'] });
    const lacking = await expectError(listPayrollRuns(tenant.client, { authorization: clerk.authorization }), PayrollRunError, 'PAYROLL_AUTHORITY');
    expect(lacking.message).toContain(PAYROLL_RUN_CAPABILITY);
  });
});

// ── D · Immutability ────────────────────────────────────────────────────────

describe('D · a released result is never deleted', () => {
  it('15, 16. deleting a result of a RELEASED or a POSTED run is refused by the trigger (SQLSTATE 23514)', async () => {
    const released = (await listPayrollRuns(tenant.client, RUN_AUTH)).find((r) => r.status === 'RELEASED')!;
    const posted = (await listPayrollRuns(tenant.client, RUN_AUTH)).find((r) => r.status === 'POSTED')!;
    expect(released && posted).toBeTruthy();
    await expectSqlState(deleteResultsOf(released.runId), '23514');
    await expectSqlState(deleteResultsOf(posted.runId), '23514');
    expect((await listResults(tenant.client, posted.runId, undefined, RUN_AUTH)).length).toBeGreaterThan(0);
  });

  it('17, 18. deleting a result of a PROPOSED run succeeds, and its lines go with it', async () => {
    const run = await propose(9);
    const counts = async () => withTenant(tenant.client, async (tx) => ((await tx.execute(sql`
      select (select count(*)::int from payroll_result where client = ${tenant.client} and run_id = ${run.runId}) as results,
             (select count(*)::int from payroll_result_line l
                join payroll_result r on r.client = l.client and r.result_id = l.result_id
               where l.client = ${tenant.client} and r.run_id = ${run.runId}) as lines,
             (select count(*)::int from payroll_result_line where client = ${tenant.client}) as all_lines`)) as unknown as Array<{ results: number; lines: number; all_lines: number }>)[0]!);
    const before = await counts();
    expect(before.results).toBeGreaterThan(0);
    expect(before.lines).toBeGreaterThan(0);
    await deleteResultsOf(run.runId);
    const after = await counts();
    expect(after).toMatchObject({ results: 0, lines: 0 });
    expect(after.all_lines).toBe(before.all_lines - before.lines);
  });
});

// ── E · Labels ──────────────────────────────────────────────────────────────

describe('E · posting event labels', () => {
  it('19. every event in POSTING_EVENTS has an acctDet.event.<EVENT> label', () => {
    const missing = POSTING_EVENTS.map((e) => `acctDet.event.${e.event}`).filter((key) => t(key) === key);
    expect(missing).toEqual([]);
  });
});
